import type { AgentTask, ApprovalRequest, DbClient, DbTransaction, Post } from "@enmo/db";
import {
  ACTION_AGENT,
  type Feedback,
  type FeedbackTarget,
  type PerPostAction,
  type PipelineAction,
  type QaIssue,
} from "@enmo/shared";
import { cancelOpenRounds } from "./approval-round";
import type { EventBatch } from "./events";
import { requireTransition } from "./post-status";
import { cancelScheduledForPost, type PublishCancelReason } from "./publishing";

/*
 * Routing feedback back to the agents (DESIGN §D "Request Changes"). A human's REQUEST_CHANGES or
 * a QA "revise" appends a revision subgraph to the post's graph: one task per action to redo,
 * nodeKey "<planned node>.r<N>" (N = the post's new revision), chained, ending in QA, which opens
 * the next approval round. The first task carries the feedback byte-for-byte; the agent input is
 * built from it (AgentTask.feedback → CopywriterInput.revision.feedback). The Visual Director's
 * `direct` carries it too when it isn't first (a BOTH revision): the visual half of the feedback
 * must reach it verbatim as well (AgentTask.feedback → VisualDirectInput.feedback).
 *
 * The post's takes follow its copy: one per scene or slide. A COPY revision whose new copy adds or
 * drops one gets a direct.rN spliced in after its write (spliceDirectAfter), and a human copy edit
 * that does the same goes back through the Visual Director (routeVisualRevision), so no round opens
 * on visuals that no longer match the copy.
 */

const REDO_BY_TARGET: Readonly<Record<FeedbackTarget, readonly PerPostAction[]>> = {
  COPY: ["write", "adapt", "qa"],
  VISUAL: ["direct", "adapt", "qa"],
  BOTH: ["write", "direct", "adapt", "qa"],
};

/**
 * The actions a revision re-runs, limited to the enabled pipeline. A VISUAL change with no Visual
 * Director in the pipeline yet (Phase 2) re-runs the copy chain, so the feedback still reaches an
 * agent and a new approval round.
 */
export function revisionActions(
  target: FeedbackTarget,
  enabledActions: readonly PipelineAction[],
): PerPostAction[] {
  const enabled = new Set(enabledActions);
  const effective = target === "VISUAL" && !enabled.has("direct") ? "COPY" : target;
  const chain = REDO_BY_TARGET[effective].filter((action) => enabled.has(action));
  // Whatever else is disabled, a revision always ends in QA (it opens the next round).
  return chain.at(-1) === "qa" ? chain : [...chain, "qa"];
}

/** Which specialists a QA verdict sends the post back to. */
export function qaRevisionTarget(issues: readonly QaIssue[]): FeedbackTarget {
  const copy = issues.some((issue) => issue.target === "COPYWRITER");
  const visual = issues.some((issue) => issue.target === "VISUAL_DIRECTOR");
  if (copy && visual) return "BOTH";
  return visual ? "VISUAL" : "COPY";
}

/** QA's instructions as the revision feedback the specialist reads. */
export function qaFeedbackText(issues: readonly QaIssue[], summary: string): string {
  if (issues.length === 0) return summary;
  return issues
    .map((issue) => `${issue.field}: ${issue.problem} → ${issue.instruction}`)
    .join("\n");
}

export interface RevisionRequest {
  graphId: string;
  post: Pick<Post, "id" | "ref">;
  /** The post's new revision number. */
  revision: number;
  target: FeedbackTarget;
  /** Null for a Vault regenerate without an instruction. */
  feedback: Feedback | null;
  enabledActions: readonly PipelineAction[];
}

/**
 * How a revision task of the post is keyed: "<planned node>.r<N>", or "<first planned node>-<action>
 * .r<N>" for an action the plan didn't have (a Visual Director the pipeline has gained since).
 */
async function revisionNodeKeys(
  tx: DbTransaction,
  graphId: string,
  post: Pick<Post, "id" | "ref">,
): Promise<(action: PerPostAction, revision: number) => string> {
  const planned = await tx.agentTask.findMany({
    where: { graphId, postId: post.id, revision: 0 },
    select: { nodeKey: true, action: true },
    orderBy: { createdAt: "asc" },
  });
  const plannedKey = new Map(planned.map((task) => [task.action, task.nodeKey]));
  const anchor = planned[0]?.nodeKey ?? post.ref;
  return (action, revision) => `${plannedKey.get(action) ?? `${anchor}-${action}`}.r${revision}`;
}

/** Appends the revision chain as PENDING tasks; advance() queues its first task. */
export async function appendRevision(
  tx: DbTransaction,
  request: RevisionRequest,
): Promise<AgentTask[]> {
  const nodeKey = await revisionNodeKeys(tx, request.graphId, request.post);
  const created: AgentTask[] = [];
  for (const action of revisionActions(request.target, request.enabledActions)) {
    const previous = created.at(-1);
    created.push(
      await tx.agentTask.create({
        data: {
          graphId: request.graphId,
          nodeKey: nodeKey(action, request.revision),
          agent: ACTION_AGENT[action],
          action,
          postId: request.post.id,
          dependsOn: previous ? [previous.id] : [],
          revision: request.revision,
          ...(request.feedback && (!previous || action === "direct")
            ? { feedback: request.feedback }
            : {}),
        },
      }),
    );
  }
  return created;
}

/**
 * Splices direct.rN into `write`'s revision chain right after it, unless the chain already has one:
 * the tasks that waited on the write wait on the Visual Director instead. For a COPY revision whose
 * rewritten copy no longer has the scenes or slides the post's takes fill (DESIGN §C "one shot per
 * scene, per slide"): the Visual Director re-plans against the new copy before QA sees the post.
 * It carries no feedback: the reviewer's words were for the Copywriter, the new copy is the brief.
 */
export async function spliceDirectAfter(
  tx: DbTransaction,
  write: Pick<AgentTask, "id" | "graphId" | "postId" | "revision">,
  post: Pick<Post, "id" | "ref">,
): Promise<AgentTask | null> {
  const chain = await tx.agentTask.findMany({
    where: { graphId: write.graphId, postId: post.id, revision: write.revision },
  });
  if (chain.some((task) => task.action === "direct")) return null;
  const nodeKey = await revisionNodeKeys(tx, write.graphId, post);
  const direct = await tx.agentTask.create({
    data: {
      graphId: write.graphId,
      nodeKey: nodeKey("direct", write.revision),
      agent: ACTION_AGENT.direct,
      action: "direct",
      postId: post.id,
      dependsOn: [write.id],
      revision: write.revision,
    },
  });
  for (const next of chain.filter((task) => task.dependsOn.includes(write.id))) {
    await tx.agentTask.update({
      where: { id: next.id },
      data: { dependsOn: next.dependsOn.map((id) => (id === write.id ? direct.id : id)) },
    });
  }
  return direct;
}

export interface VisualRevisionRequest {
  postId: string;
  graphId: string;
  /** For the Visual Director, verbatim: a Vault instruction; null when there is none. */
  feedback: Feedback | null;
  enabledActions: readonly PipelineAction[];
  now: Date;
  /** Collects the publish.updated of each PublishJob the revision cancels. */
  events: EventBatch;
  /** Why its scheduled publishing is called off. */
  cancelReason: PublishCancelReason;
}

export interface VisualRevision {
  post: Post;
  /** The rounds it cancelled (open, or approved and not yet published). */
  cancelled: ApprovalRequest[];
  /** The revision chain's direct task. */
  direct: AgentTask;
}

/**
 * Sends a planned post that waits on (or is past) its approval back through the Visual Director:
 * its open or approved rounds and scheduled PublishJobs are cancelled, the post goes to
 * CHANGES_REQUESTED with revision + 1, and a VISUAL chain (direct.rN → [adapt] → qa.rN) is
 * appended whose direct carries `feedback`, with the Visual Director in it even when the pipeline
 * has dropped it since; QA opens the next round. For a Vault regenerate, and for a copy edit that
 * changed the scenes or slides the post's takes fill. The caller holds the campaign, round and post
 * locks (locks.ts) and has checked the post waits on or is past its approval
 * (PENDING_APPROVAL, APPROVED or SCHEDULED); advance() queues the chain once committed.
 */
export async function routeVisualRevision(
  tx: DbTransaction,
  request: VisualRevisionRequest,
): Promise<VisualRevision> {
  const cancelled = await cancelOpenRounds(tx, request.postId, request.now);
  await cancelScheduledForPost(tx, request.events, request.postId, request.cancelReason);
  const { status } = await tx.post.findUniqueOrThrow({
    where: { id: request.postId },
    select: { status: true },
  });
  if (status !== "PENDING_APPROVAL") {
    await requireTransition(tx, request.postId, "PENDING_APPROVAL");
  }
  const post = await requireTransition(tx, request.postId, "CHANGES_REQUESTED", {
    revision: { increment: 1 },
    approvedAt: null,
    needsAttention: false,
    attentionReason: null,
    qaNotes: null,
  });
  const actions: PipelineAction[] = request.enabledActions.includes("direct")
    ? [...request.enabledActions]
    : [...request.enabledActions, "direct"];
  const chain = await appendRevision(tx, {
    graphId: request.graphId,
    post,
    revision: post.revision,
    target: "VISUAL",
    feedback: request.feedback,
    enabledActions: actions,
  });
  const direct = chain.find((task) => task.action === "direct");
  if (!direct) throw new Error(`The visual revision of post ${post.id} has no direct task`);
  return { post, cancelled, direct };
}

/** The graph the post's planned tasks belong to, or null for a post outside any plan. */
export async function plannedGraphOf(tx: DbTransaction, postId: string): Promise<string | null> {
  const task = await tx.agentTask.findFirst({
    where: { postId },
    orderBy: { createdAt: "asc" },
    select: { graphId: true },
  });
  return task?.graphId ?? null;
}

/** The graph the post's planned tasks belong to. */
export async function graphOfPost(tx: DbTransaction, postId: string): Promise<string> {
  const graphId = await plannedGraphOf(tx, postId);
  if (!graphId) throw new Error(`Post ${postId} has no tasks to revise`);
  return graphId;
}

export interface HumanChangeRequest {
  postId: string;
  decisionId: string;
  /** Verbatim, exactly as the reviewer typed it. */
  feedback: string;
  target: FeedbackTarget;
  enabledActions: readonly PipelineAction[];
}

/**
 * REQUEST_CHANGES on a round: the post moves to CHANGES_REQUESTED with revision + 1 and a revision
 * chain is appended whose first task carries {verbatim, source: HUMAN, decisionId}.
 */
export async function routeHumanFeedback(
  tx: DbTransaction,
  change: HumanChangeRequest,
): Promise<{ post: Post; graphId: string; tasks: AgentTask[] }> {
  const post = await requireTransition(tx, change.postId, "CHANGES_REQUESTED", {
    revision: { increment: 1 },
    needsAttention: false,
    attentionReason: null,
    qaNotes: null,
  });
  const graphId = await graphOfPost(tx, post.id);
  const tasks = await appendRevision(tx, {
    graphId,
    post,
    revision: post.revision,
    target: change.target,
    feedback: { verbatim: change.feedback, source: "HUMAN", decisionId: change.decisionId },
    enabledActions: change.enabledActions,
  });
  return { post, graphId, tasks };
}

/** How many automatic QA revisions the post has had (a BOTH revision has two tasks carrying it). */
export async function qaRevisionCount(
  db: DbClient | DbTransaction,
  postId: string,
): Promise<number> {
  const revisions = await db.agentTask.findMany({
    where: { postId, revision: { gt: 0 } },
    select: { feedback: true, revision: true },
  });
  const fromQa = revisions.filter(
    (task) =>
      typeof task.feedback === "object" &&
      task.feedback !== null &&
      (task.feedback as { source?: unknown }).source === "QA",
  );
  return new Set(fromQa.map((task) => task.revision)).size;
}
