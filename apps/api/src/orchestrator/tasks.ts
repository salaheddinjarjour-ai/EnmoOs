import type { DbClient, DbTransaction, Prisma } from "@enmo/db";
import { AGENT_LABEL, PipelineAction, type AgentName, type TaskStatus } from "@enmo/shared";

/*
 * Loading an AgentTask with everything its processor needs, plus small shared helpers for talking
 * about a task in messages and alerts.
 */

type Db = DbClient | DbTransaction;

export const TASK_CONTEXT_INCLUDE = {
  post: true,
  graph: {
    select: {
      id: true,
      version: true,
      status: true,
      graph: true,
      campaignId: true,
      campaign: {
        select: {
          id: true,
          name: true,
          status: true,
          brief: true,
          clientId: true,
          client: true,
          thread: { select: { id: true } },
        },
      },
    },
  },
} as const satisfies Prisma.AgentTaskInclude;

export type TaskWithContext = Prisma.AgentTaskGetPayload<{ include: typeof TASK_CONTEXT_INCLUDE }>;

export function loadTask(db: Db, taskId: string): Promise<TaskWithContext | null> {
  return db.agentTask.findUnique({ where: { id: taskId }, include: TASK_CONTEXT_INCLUDE });
}

/** Statuses a task.run job may (still) act on. */
export const RUNNABLE_STATUSES: readonly TaskStatus[] = ["QUEUED", "RUNNING"];

/** Statuses from which a task can still reach SUCCEEDED without a human. */
export const UNFINISHED_STATUSES: readonly TaskStatus[] = [
  "PENDING",
  "QUEUED",
  "RUNNING",
  "WAITING",
  "BLOCKED_BUDGET",
];

export function taskAction(task: { id: string; action: string }): PipelineAction {
  const parsed = PipelineAction.safeParse(task.action);
  if (!parsed.success) throw new Error(`AgentTask ${task.id} has unknown action "${task.action}"`);
  return parsed.data;
}

/** "Copywriter (write, p3)". */
export function describeTask(task: {
  agent: AgentName;
  action: string;
  post?: { ref: string } | null;
}): string {
  const where = task.post ? `, ${task.post.ref}` : "";
  return `${AGENT_LABEL[task.agent]} (${task.action}${where})`;
}

/** The thread and ids an event about this task needs. */
export function taskScope(task: TaskWithContext) {
  return {
    graphId: task.graphId,
    campaignId: task.graph.campaignId,
    clientId: task.graph.campaign.clientId,
    threadId: task.graph.campaign.thread?.id ?? null,
  };
}
