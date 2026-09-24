import { z } from "zod";
import { AGENT_LABEL, AgentName, type TaskStatus } from "./enums";

/** One agent's share of a task graph, counted from its AgentTask rows. */
export const ProgressEntry = z.object({
  agent: AgentName,
  done: z.int().nonnegative(),
  /** Every task of this agent that is not CANCELLED, revisions included. */
  total: z.int().nonnegative(),
  /** QUEUED or RUNNING: in flight. */
  running: z.int().nonnegative(),
  /** WAITING on async work (renders). */
  waiting: z.int().nonnegative(),
  /** ESCALATED or FAILED: needs a human. */
  escalated: z.int().nonnegative(),
  /**
   * PENDING behind an ESCALATED, FAILED or CANCELLED task (directly or further upstream): it can't
   * run until a human resolves that task. Absent from payloads stored before it was counted.
   */
  blocked: z.int().nonnegative().default(0),
});
export type ProgressEntry = z.infer<typeof ProgressEntry>;

export const ProgressAggregate = z.array(ProgressEntry);
export type ProgressAggregate = z.infer<typeof ProgressAggregate>;

/** Pipeline order, so the line reads the way work flows (QA is the Manager's step). */
const AGENT_ORDER: readonly AgentName[] = [
  "STRATEGIST",
  "COPYWRITER",
  "VISUAL_DIRECTOR",
  "ADAPTER",
  "MANAGER",
  "PUBLISHER",
  "ANALYST",
];

/** What an agent is doing while its tasks are in flight. */
export const AGENT_PROGRESS_VERB: Readonly<Record<AgentName, string>> = {
  MANAGER: "reviewing",
  STRATEGIST: "planning",
  COPYWRITER: "writing",
  VISUAL_DIRECTOR: "rendering",
  ADAPTER: "adapting",
  ANALYST: "analysing",
  PUBLISHER: "scheduling",
};

/** An AgentTask as progress counts it; `id` and `dependsOn` let it tell blocked PENDING tasks. */
export interface ProgressTask {
  id?: string;
  agent: AgentName;
  status: TaskStatus;
  dependsOn?: readonly string[];
}

/** Statuses a task never leaves on its own: only a human's retry (or nothing) moves it on. */
const STOPPED: ReadonlySet<TaskStatus> = new Set(["ESCALATED", "FAILED", "CANCELLED"]);

/**
 * Ids of the PENDING tasks that can't run until a human acts: a task they depend on, directly or
 * further upstream, is ESCALATED, FAILED or CANCELLED. advance() never queues them, so a batch
 * that waits for them would never settle.
 */
export function blockedTaskIds(tasks: readonly ProgressTask[]): Set<string> {
  const statusById = new Map<string, TaskStatus>();
  for (const task of tasks) if (task.id !== undefined) statusById.set(task.id, task.status);
  const blocked = new Set<string>();
  const stopped = (id: string) => {
    const status = statusById.get(id);
    return blocked.has(id) || (status !== undefined && STOPPED.has(status));
  };
  // Deps usually come first, but nothing guarantees the order: repeat until nothing changes.
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (task.status !== "PENDING" || task.id === undefined || blocked.has(task.id)) continue;
      if ((task.dependsOn ?? []).some(stopped)) {
        blocked.add(task.id);
        changed = true;
      }
    }
  }
  return blocked;
}

/**
 * Counts AgentTask rows per agent (DESIGN §D progress). BLOCKED_BUDGET and PENDING only add to
 * total, except PENDING tasks stuck behind a stopped task, which also count as `blocked`.
 */
export function aggregateProgress(tasks: readonly ProgressTask[]): ProgressAggregate {
  const blocked = blockedTaskIds(tasks);
  const byAgent = new Map<AgentName, ProgressEntry>();
  for (const { id, agent, status } of tasks) {
    if (status === "CANCELLED") continue;
    let entry = byAgent.get(agent);
    if (!entry) {
      entry = { agent, done: 0, total: 0, running: 0, waiting: 0, escalated: 0, blocked: 0 };
      byAgent.set(agent, entry);
    }
    entry.total += 1;
    if (status === "SUCCEEDED") entry.done += 1;
    else if (status === "QUEUED" || status === "RUNNING") entry.running += 1;
    else if (status === "WAITING") entry.waiting += 1;
    else if (status === "ESCALATED" || status === "FAILED") entry.escalated += 1;
    else if (id !== undefined && blocked.has(id)) entry.blocked += 1;
  }
  return sortByPipeline([...byAgent.values()]);
}

function sortByPipeline(entries: ProgressEntry[]): ProgressEntry[] {
  return entries.sort((a, b) => AGENT_ORDER.indexOf(a.agent) - AGENT_ORDER.indexOf(b.agent));
}

function formatEntry(entry: ProgressEntry): string {
  const label = AGENT_LABEL[entry.agent];
  const count = `${entry.done}/${entry.total}`;
  const escalated = entry.escalated > 0 ? ` · ${entry.escalated} escalated` : "";
  if (entry.done >= entry.total) return `${label} ✓ ${count}`;
  if (entry.running + entry.waiting > 0) {
    return `${label} ${AGENT_PROGRESS_VERB[entry.agent]} ${count}${escalated}…`;
  }
  if (entry.done === 0 && entry.escalated === 0) return `${label} queued ${count}`;
  return `${label} ${count}${escalated}`;
}

/**
 * The single live progress line posted in the thread, e.g.
 * `Copywriter ✓ 12/12 — Visual Director rendering 2/4…`. Agents appear in pipeline order; agents
 * with no tasks are left out, so an empty aggregate gives "".
 */
export function formatProgress(aggregate: readonly ProgressEntry[]): string {
  return sortByPipeline(aggregate.filter((entry) => entry.total > 0).map((entry) => ({ ...entry })))
    .map(formatEntry)
    .join(" — ");
}
