import type { DbTransaction } from "@enmo/db";
import { AUDIT_ACTIONS, type TaskNode } from "@enmo/shared";
import type { Deps } from "../deps";
import { enqueueTaskRun } from "../jobs/queues";
import { conflict, notFound } from "../lib/errors";
import type { ServiceUser } from "../services/actor";
import { recordAudit } from "../services/audit";
import { afterCommit } from "./after-commit";
import { dateFromIsoDate, storedBrief, storedPlan } from "./context";
import { EventBatch } from "./events";
import { lockCampaign } from "./locks";
import { postUpdated } from "./post-status";
import { reportProgress } from "./progress";

/*
 * Graph lifecycle (DESIGN §D): approving a plan turns it into Post and AgentTask rows in one
 * transaction, and advance() queues whatever became ready. The DAG is scheduled from Postgres:
 * a task is ready once every task in its dependsOn has SUCCEEDED. Queueing happens after the
 * commit, so it can be lost (a crash, a failed follow-up); the sweeper advances any approved graph
 * that still has ready PENDING tasks.
 */

const TRANSACTION_OPTIONS = { timeout: 20_000, maxWait: 10_000 } as const;

/** Nodes ordered so each comes after its dependencies (the plan was validated acyclic). */
export function topologicalOrder(nodes: readonly TaskNode[]): TaskNode[] {
  const placed = new Set<string>();
  const ordered: TaskNode[] = [];
  let remaining = [...nodes];
  while (remaining.length > 0) {
    const ready = remaining.filter((node) => node.deps.every((dep) => placed.has(dep)));
    if (ready.length === 0) throw new Error("Task graph has a cycle or an unknown dependency");
    for (const node of ready) {
      placed.add(node.id);
      ordered.push(node);
    }
    remaining = remaining.filter((node) => !placed.has(node.id));
  }
  return ordered;
}

/**
 * POST /task-graphs/:id/approve (DESIGN §D "approvePlan"). The graph becomes APPROVED, older
 * PROPOSED versions SUPERSEDED and the campaign PRODUCING; each planned post becomes a Post (IDEA)
 * and each node an AgentTask whose dependsOn holds task ids. The first spend happens only after
 * this commits, when advance() queues the ready tasks. The approval stands once committed, so
 * what follows it never fails the request.
 */
export async function approveGraph(deps: Deps, user: ServiceUser, graphId: string): Promise<void> {
  const events = new EventBatch();
  await deps.prisma.$transaction(
    (tx) => createGraphRows(deps, tx, user, graphId, events),
    TRANSACTION_OPTIONS,
  );
  await afterCommit(deps, "publishing the plan approval", () => events.publish(deps));
  await afterCommit(deps, "starting the approved plan", () => advanceOrRecount(deps, graphId));
}

async function createGraphRows(
  deps: Deps,
  tx: DbTransaction,
  user: ServiceUser,
  graphId: string,
  events: EventBatch,
): Promise<void> {
  const now = deps.clock.now();
  const graph = await tx.taskGraph.findUnique({
    where: { id: graphId },
    include: { campaign: true },
  });
  if (!graph) throw notFound("Plan");
  if (graph.campaign.status === "ARCHIVED") throw conflict("The campaign is archived");
  // A re-plan finishing right now must either land before this (and be superseded) or see it.
  await lockCampaign(tx, graph.campaignId);

  const { count } = await tx.taskGraph.updateMany({
    where: { id: graphId, status: "PROPOSED" },
    data: { status: "APPROVED", approvedById: user.id, approvedAt: now },
  });
  if (count === 0) {
    throw conflict(`Only a proposed plan can be approved; this one is ${graph.status}`);
  }

  const plan = storedPlan(graph);
  const brief = storedBrief(graph.campaign);
  const clientId = graph.campaign.clientId ?? brief.clientId;

  await tx.taskGraph.updateMany({
    where: { campaignId: graph.campaignId, status: "PROPOSED", id: { not: graphId } },
    data: { status: "SUPERSEDED" },
  });
  await tx.campaign.update({
    where: { id: graph.campaignId },
    data: { status: "PRODUCING", clientId },
  });

  const posts = await tx.post.createManyAndReturn({
    data: plan.posts.map((planned) => ({
      campaignId: graph.campaignId,
      clientId,
      ref: planned.ref,
      type: planned.type,
      platforms: planned.platforms,
      status: "IDEA" as const,
      targetDate: dateFromIsoDate(planned.targetDate),
      angle: planned.angle,
      pillar: planned.pillarHint,
    })),
  });
  const postIdByRef = new Map(posts.map((post) => [post.ref, post.id]));
  for (const post of posts) postUpdated(events, post);

  const taskIdByNode = new Map<string, string>();
  for (const node of topologicalOrder(plan.nodes)) {
    const task = await tx.agentTask.create({
      data: {
        graphId,
        nodeKey: node.id,
        agent: node.agent,
        action: node.action,
        postId: node.postRef ? (postIdByRef.get(node.postRef) ?? null) : null,
        dependsOn: node.deps.map((dep) => {
          const id = taskIdByNode.get(dep);
          if (!id) throw new Error(`Node ${node.id} depends on unknown node ${dep}`);
          return id;
        }),
      },
      select: { id: true },
    });
    taskIdByNode.set(node.id, task.id);
  }

  await recordAudit(tx, {
    actorId: user.id,
    ip: user.ip,
    action: AUDIT_ACTIONS.planApprove,
    entityType: "TaskGraph",
    entityId: graphId,
    data: {
      campaignId: graph.campaignId,
      version: graph.version,
      posts: posts.length,
      tasks: taskIdByNode.size,
      estimate: graph.estimate as object,
    },
  });
}

/**
 * Queues every PENDING task of the graph whose dependencies have all SUCCEEDED. Idempotent: the
 * PENDING → QUEUED update is conditional, so concurrent callers queue each task once, and the
 * job id `task-<id>-r<revision>` makes a repeated enqueue a no-op. A task left QUEUED without a
 * job (Redis down between the two steps) is re-queued by the sweeper, so an enqueue failure is
 * logged rather than thrown, and so is a failed progress recount once tasks are queued. Returns
 * how many tasks this call queued.
 */
export async function advance(deps: Deps, graphId: string): Promise<number> {
  const graph = await deps.prisma.taskGraph.findUnique({
    where: { id: graphId },
    select: { status: true, campaign: { select: { status: true } } },
  });
  if (!graph || graph.status !== "APPROVED" || graph.campaign.status === "ARCHIVED") return 0;

  const tasks = await deps.prisma.agentTask.findMany({
    where: { graphId },
    select: { id: true, status: true, dependsOn: true },
  });
  const succeeded = new Set(tasks.filter((t) => t.status === "SUCCEEDED").map((t) => t.id));
  const ready = tasks
    .filter((t) => t.status === "PENDING" && t.dependsOn.every((dep) => succeeded.has(dep)))
    .map((t) => t.id);
  if (ready.length === 0) return 0;

  const queued = await deps.prisma.agentTask.updateManyAndReturn({
    where: { id: { in: ready }, status: "PENDING" },
    data: { status: "QUEUED", queuedAt: deps.clock.now() },
    select: { id: true, revision: true, agent: true, post: { select: { ref: true } } },
  });
  if (queued.length === 0) return 0;

  for (const task of queued) {
    try {
      await enqueueTaskRun(deps.queues, {
        taskId: task.id,
        revision: task.revision,
        requeue: null,
      });
    } catch (error) {
      // The task stays QUEUED; the sweeper re-queues tasks that have no live job.
      deps.logger.warn({ err: error, taskId: task.id }, "could not enqueue a ready task");
    }
  }
  await afterCommit(deps, "recounting progress for queued tasks", () =>
    reportProgress(
      deps,
      graphId,
      queued.map((task) => ({
        taskId: task.id,
        agent: task.agent,
        postRef: task.post?.ref ?? null,
        state: "queued" as const,
      })),
    ),
  );
  return queued.length;
}

/**
 * advance(), plus a recount when nothing became ready, so the thread's progress reflects the
 * change just committed either way (advance recounts whatever it queues).
 */
export async function advanceOrRecount(deps: Deps, graphId: string): Promise<void> {
  if ((await advance(deps, graphId)) === 0) await reportProgress(deps, graphId, []);
}
