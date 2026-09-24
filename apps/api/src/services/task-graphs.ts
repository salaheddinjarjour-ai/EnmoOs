import type { Prisma } from "@enmo/db";
import { ManagerPlanOutput, PlanEstimate, type TaskGraphDto } from "@enmo/shared";
import type { Deps } from "../deps";
import { conflict, notFound } from "../lib/errors";
import { parseStored } from "../lib/stored";
import { EventBatch } from "../orchestrator/events";
import { approveGraph } from "../orchestrator/graph";
import { createMessage, messageCreated } from "../orchestrator/messages";
import { enqueuePlanDraft, isPlanBeingDrafted } from "../orchestrator/plan";
import type { ServiceUser } from "./actor";

/*
 * Plans (DESIGN §D "Graph lifecycle"): the Manager's TaskGraph for a campaign, which a human
 * approves before any generation spend.
 */

const GRAPH_INCLUDE = {
  approvedBy: { select: { id: true, name: true } },
} as const satisfies Prisma.TaskGraphInclude;

type GraphRow = Prisma.TaskGraphGetPayload<{ include: typeof GRAPH_INCLUDE }>;

export function toTaskGraphDto(row: GraphRow): TaskGraphDto {
  const plan = parseStored(ManagerPlanOutput, row.graph, `TaskGraph ${row.id}.graph`);
  return {
    id: row.id,
    campaignId: row.campaignId,
    version: row.version,
    status: row.status,
    summary: row.summary,
    posts: plan.posts,
    nodes: plan.nodes,
    estimate: parseStored(PlanEstimate, row.estimate, `TaskGraph ${row.id}.estimate`),
    changeRequest: row.changeRequest,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** GET /task-graphs/:id (the PlanCard). NOT_FOUND when missing. */
export async function getTaskGraph(deps: Deps, graphId: string): Promise<TaskGraphDto> {
  const row = await deps.prisma.taskGraph.findUnique({
    where: { id: graphId },
    include: GRAPH_INCLUDE,
  });
  if (!row) throw notFound("Plan");
  return toTaskGraphDto(row);
}

/**
 * POST /task-graphs/:id/approve. One transaction: the graph becomes APPROVED (approvedBy/At),
 * older PROPOSED graphs SUPERSEDED, the campaign PRODUCING; Post rows (IDEA) and AgentTask rows
 * are created with postRef → postId and deps → task ids; a plan.approve AuditLog row is written.
 * After commit, advance(graphId) queues the ready tasks. CONFLICT unless the graph is PROPOSED
 * (so a double click can't create posts twice); NOT_FOUND when missing.
 */
export async function approvePlan(
  deps: Deps,
  user: ServiceUser,
  graphId: string,
): Promise<TaskGraphDto> {
  await approveGraph(deps, user, graphId);
  return getTaskGraph(deps, graphId);
}

/**
 * POST /task-graphs/:id/request-changes. Enqueues manager.plan for version n+1 with `feedback`
 * byte-for-byte as its changeRequest; the new version supersedes this one once it is proposed.
 * The feedback also goes into the thread as the user's message, so the conversation reads in
 * order. Returns this graph. CONFLICT unless the graph is PROPOSED; NOT_FOUND when missing.
 */
export async function requestPlanChanges(
  deps: Deps,
  user: ServiceUser,
  graphId: string,
  feedback: string,
): Promise<TaskGraphDto> {
  const graph = await deps.prisma.taskGraph.findUnique({
    where: { id: graphId },
    include: {
      ...GRAPH_INCLUDE,
      campaign: { select: { status: true, thread: { select: { id: true } } } },
    },
  });
  if (!graph) throw notFound("Plan");
  if (graph.campaign.status === "ARCHIVED") throw conflict("The campaign is archived");
  if (graph.status !== "PROPOSED") {
    throw conflict(`Only a proposed plan can be changed; this one is ${graph.status}`);
  }
  const version = graph.version + 1;
  if (await isPlanBeingDrafted(deps, graph.campaignId, version)) {
    throw conflict("A revised plan is already being drafted");
  }
  const threadId = graph.campaign.thread?.id;

  const message = threadId
    ? await createMessage(deps.prisma, {
        threadId,
        role: "USER",
        kind: "TEXT",
        userId: user.id,
        content: feedback,
        payload: null,
      })
    : null;
  try {
    await enqueuePlanDraft(
      deps,
      { campaignId: graph.campaignId, version, changeRequest: feedback, previousGraphId: graph.id },
      message?.id ?? deps.clock.now().getTime().toString(36),
    );
  } catch (error) {
    if (message) await deps.prisma.chatMessage.delete({ where: { id: message.id } });
    throw error;
  }
  if (message) await messageCreated(new EventBatch(), message).publish(deps);
  return toTaskGraphDto(graph);
}
