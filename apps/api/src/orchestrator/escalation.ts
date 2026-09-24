import type { AgentEscalation, BudgetExceeded, InvalidAgentInput } from "@enmo/agents";
import type { AlertKind, Issue, TaskStatus } from "@enmo/shared";
import type { Deps } from "../deps";
import { getBudget } from "../services/budget";
import { EventBatch } from "./events";
import { createAgentMessage, messageCreated } from "./messages";
import { postUpdated } from "./post-status";
import { reportProgress } from "./progress";
import { describeTask, loadTask, type TaskWithContext } from "./tasks";

/*
 * When a task can't finish on its own (DESIGN §D "task.run"): an AgentEscalation or a task that
 * failed for good becomes ESCALATED/FAILED, its post needs attention, the Manager signs an
 * ESCALATION message in the thread and an `alert` goes out. A budget stop is not a failure: the
 * task waits in BLOCKED_BUDGET for the sweeper.
 */

/** Why a task was handed to a human, as the ESCALATION message and alert report it. */
export interface HandOff {
  /** AgentEscalation.reason, or FAILED / STUCK / BANNED_WORDS for handoffs the runner didn't raise. */
  reason: string;
  issues: Issue[];
  /** One sentence for people. */
  message: string;
}

const REASON_TEXT: Readonly<Record<string, string>> = {
  INVALID_OUTPUT: "kept returning output that breaks its contract",
  REFUSED: "refused the request",
  TRUNCATED: "ran out of output tokens",
  API_ERROR: "had its request rejected by the model provider",
};

/** Ends `text` with exactly one full stop (issue messages often bring their own). */
export function asSentence(text: string): string {
  const trimmed = text.trim().replace(/[.\s]+$/u, "");
  return /[!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function handOff(reason: string, why: string, issues: Issue[]): HandOff {
  const first = issues.slice(0, 3).map((issue) => issue.message.replace(/[.\s]+$/u, ""));
  return {
    reason,
    issues,
    message: asSentence(first.length > 0 ? `${why}: ${first.join("; ")}` : why),
  };
}

export function handOffFromEscalation(error: AgentEscalation): HandOff {
  return handOff(
    error.reason,
    REASON_TEXT[error.reason] ?? error.reason.toLowerCase(),
    error.issues,
  );
}

/** The orchestrator built an input the agent's contract rejects: a bug, not a model failure. */
export function handOffFromInvalidInput(error: InvalidAgentInput): HandOff {
  return handOff("INVALID_INPUT", "was given an input that breaks its contract (a bug to report)", [
    ...error.issues,
  ]);
}

export function escalateTask(deps: Deps, taskId: string, handOff: HandOff): Promise<boolean> {
  return handOffTask(deps, taskId, "ESCALATED", handOff, "escalated");
}

/** `alert` is "stuck" when the sweeper gives up on a task that stopped making progress. */
export function failTask(
  deps: Deps,
  taskId: string,
  handOff: HandOff,
  alert: Extract<AlertKind, "failed" | "stuck"> = "failed",
): Promise<boolean> {
  return handOffTask(deps, taskId, "FAILED", handOff, alert);
}

/**
 * Moves a queued or running task to `status` and tells people. Returns false when the task had
 * already left those states (cancelled with its campaign, or handled by another worker).
 */
async function handOffTask(
  deps: Deps,
  taskId: string,
  status: Extract<TaskStatus, "ESCALATED" | "FAILED">,
  handOff: HandOff,
  alert: Extract<AlertKind, "escalated" | "failed" | "stuck">,
): Promise<boolean> {
  const task = await loadTask(deps.prisma, taskId);
  if (!task) return false;
  const events = new EventBatch();
  const text = asSentence(`${describeTask(task)} ${handOff.message}`);

  const changed = await deps.prisma.$transaction(async (tx) => {
    const { count } = await tx.agentTask.updateMany({
      where: { id: task.id, status: { in: ["QUEUED", "RUNNING"] } },
      data: { status, error: text.slice(0, 2000), finishedAt: deps.clock.now() },
    });
    if (count === 0) return false;

    if (task.postId) {
      const post = await tx.post.update({
        where: { id: task.postId },
        data: { needsAttention: true, attentionReason: text.slice(0, 500) },
      });
      postUpdated(events, post);
    }

    const threadId = task.graph.campaign.thread?.id;
    if (threadId) {
      const message = await createAgentMessage(tx, {
        threadId,
        agent: "MANAGER",
        kind: "ESCALATION",
        content: `${text} It needs a human: retry it from the task list once the cause is fixed.`,
        payload: {
          taskId: task.id,
          agent: task.agent,
          action: task.action,
          postId: task.postId,
          postRef: task.post?.ref ?? null,
          reason: handOff.reason,
          issues: handOff.issues,
        },
      });
      messageCreated(events, message);
    }

    events.alert({
      kind: alert,
      entityType: "AgentTask",
      entityId: task.id,
      message: text,
      clientId: task.graph.campaign.clientId,
      campaignId: task.graph.campaignId,
    });
    return true;
  });
  if (!changed) return false;

  await events.publish(deps);
  await reportTransition(deps, task, "escalated");
  return true;
}

/*
 * One key for every budget block, so they happen one at a time: each sees the tasks blocked before
 * it, and exactly one of several tasks hitting the cap together finds none and sends the alert.
 */
const BUDGET_BLOCK_LOCK = "enmo:budget-block";

/** BudgetExceeded: the task waits in BLOCKED_BUDGET until the sweeper finds room in the budget. */
export async function blockTaskOnBudget(
  deps: Deps,
  taskId: string,
  error: BudgetExceeded,
): Promise<boolean> {
  const task = await loadTask(deps.prisma, taskId);
  if (!task) return false;
  const outcome = await deps.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${BUDGET_BLOCK_LOCK}))`;
    const { count } = await tx.agentTask.updateMany({
      where: { id: task.id, status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "BLOCKED_BUDGET", error: error.message },
    });
    if (count === 0) return null;
    // One alert when the budget first bites, not one per task that runs into it afterwards.
    const alreadyBlocked = await tx.agentTask.count({
      where: { status: "BLOCKED_BUDGET", id: { not: task.id } },
    });
    return { first: alreadyBlocked === 0 };
  });
  if (!outcome) return false;

  const events = new EventBatch();
  if (outcome.first) {
    events.alert({
      kind: "budget",
      entityType: "AgentTask",
      entityId: task.id,
      message: `Daily token budget reached (${error.used.toLocaleString("en-US")}/${error.cap.toLocaleString("en-US")} tokens on ${error.day}). Agent work resumes after UTC midnight.`,
      clientId: task.graph.campaign.clientId,
      campaignId: task.graph.campaignId,
    });
  }
  events.global("budget.updated", await getBudget(deps));
  await events.publish(deps);
  await reportTransition(deps, task, "waiting");
  return true;
}

function reportTransition(
  deps: Deps,
  task: TaskWithContext,
  state: "escalated" | "waiting",
): Promise<void> {
  return reportProgress(deps, task.graphId, [
    { taskId: task.id, agent: task.agent, postRef: task.post?.ref ?? null, state },
  ]);
}
