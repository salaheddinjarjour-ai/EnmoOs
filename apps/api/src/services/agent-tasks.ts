import type { Prisma } from "@enmo/db";
import { Feedback, type AgentTaskDto, type ResolveAgentTaskRequest } from "@enmo/shared";
import type { Deps } from "../deps";
import { conflict, notFound } from "../lib/errors";
import { parseStored } from "../lib/stored";
import { EventBatch } from "../orchestrator/events";
import { postUpdated } from "../orchestrator/post-status";
import { requeueTask } from "../orchestrator/sweeper";
import { taskAction } from "../orchestrator/tasks";
import { acceptBestTake } from "../orchestrator/visuals";
import type { ServiceUser } from "./actor";

/*
 * AgentTasks as people see them: the campaign's task list and the escalation "resolve" action
 * (DESIGN §D).
 */

const TASK_INCLUDE = {
  post: { select: { ref: true } },
  graph: { select: { version: true } },
} as const satisfies Prisma.AgentTaskInclude;

type TaskRow = Prisma.AgentTaskGetPayload<{ include: typeof TASK_INCLUDE }>;

export function toAgentTaskDto(row: TaskRow): AgentTaskDto {
  return {
    id: row.id,
    graphId: row.graphId,
    nodeKey: row.nodeKey,
    agent: row.agent,
    action: taskAction(row),
    postId: row.postId,
    postRef: row.post?.ref ?? null,
    dependsOn: row.dependsOn,
    status: row.status,
    revision: row.revision,
    contractAttempts: row.contractAttempts,
    feedback:
      row.feedback === null
        ? null
        : parseStored(Feedback, row.feedback, `AgentTask ${row.id}.feedback`),
    error: row.error,
    queuedAt: row.queuedAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** "n12.r1" → [12, 1]: planned nodes in plan order, each followed by its revisions. */
export function nodeKeyOrder(nodeKey: string): [number, number] {
  const match = /^n(\d+)(?:.*\.r(\d+))?$/.exec(nodeKey);
  return match ? [Number(match[1]), Number(match[2] ?? 0)] : [Number.MAX_SAFE_INTEGER, 0];
}

function compareTasks(a: TaskRow, b: TaskRow): number {
  const [aNode, aRev] = nodeKeyOrder(a.nodeKey);
  const [bNode, bRev] = nodeKeyOrder(b.nodeKey);
  return (
    a.graph.version - b.graph.version ||
    aNode - bNode ||
    aRev - bRev ||
    a.createdAt.getTime() - b.createdAt.getTime()
  );
}

/** GET /campaigns/:id/tasks: every task of the campaign's graphs, in graph then node order. */
export async function listCampaignTasks(deps: Deps, campaignId: string): Promise<AgentTaskDto[]> {
  const campaign = await deps.prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true },
  });
  if (!campaign) throw notFound("Campaign");
  const rows = await deps.prisma.agentTask.findMany({
    where: { graph: { campaignId } },
    include: TASK_INCLUDE,
  });
  return rows.sort(compareTasks).map(toAgentTaskDto);
}

async function getAgentTask(deps: Deps, taskId: string): Promise<AgentTaskDto> {
  const row = await deps.prisma.agentTask.findUnique({
    where: { id: taskId },
    include: TASK_INCLUDE,
  });
  if (!row) throw notFound("Task");
  return toAgentTaskDto(row);
}

/**
 * POST /agent-tasks/:id/resolve for an ESCALATED or FAILED task. `retry` re-queues it with fresh
 * contract attempts and clears the post's needsAttention; `accept_best` (visual review
 * escalations) keeps each shot's best take so far (orchestrator/visuals.ts). CONFLICT for a task
 * in any other status, or for `accept_best` on a task that renders nothing; NOT_FOUND when
 * missing.
 */
export async function resolveTask(
  deps: Deps,
  _user: ServiceUser,
  taskId: string,
  action: ResolveAgentTaskRequest["action"],
): Promise<AgentTaskDto> {
  const task = await deps.prisma.agentTask.findUnique({
    where: { id: taskId },
    select: {
      status: true,
      agent: true,
      action: true,
      postId: true,
      graph: { select: { status: true, campaign: { select: { status: true } } } },
    },
  });
  if (!task) throw notFound("Task");
  if (task.status !== "ESCALATED" && task.status !== "FAILED") {
    throw conflict(`Only an escalated or failed task can be resolved; this one is ${task.status}`);
  }
  if (task.graph.campaign.status === "ARCHIVED") throw conflict("The campaign is archived");

  switch (action) {
    case "accept_best":
      // Takes are the Visual Director's renders; no other task has any.
      if (task.agent !== "VISUAL_DIRECTOR" || task.action !== "direct") {
        throw conflict("This task has no takes to accept; retry it instead");
      }
      await acceptBestTake(deps, taskId);
      return getAgentTask(deps, taskId);
    case "retry":
      await retryTask(deps, taskId, task.postId);
      return getAgentTask(deps, taskId);
  }
}

async function retryTask(deps: Deps, taskId: string, postId: string | null): Promise<void> {
  const now = deps.clock.now();
  const requeued = await requeueTask(deps, taskId, ["ESCALATED", "FAILED"], {
    token: `retry-${now.getTime().toString(36)}`,
    error: null,
    resetAttempts: true,
  });
  if (!requeued) throw conflict("The task was resolved by someone else meanwhile");
  if (!postId) return;

  // The post still needs attention while another of its tasks is escalated or failed.
  const stillStuck = await deps.prisma.agentTask.count({
    where: { postId, status: { in: ["ESCALATED", "FAILED"] } },
  });
  if (stillStuck > 0) return;
  const post = await deps.prisma.post.update({
    where: { id: postId },
    data: { needsAttention: false, attentionReason: null },
  });
  await postUpdated(new EventBatch(), post).publish(deps);
}
