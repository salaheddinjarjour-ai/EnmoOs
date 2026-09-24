import type { AgentTask, DbClient, DbTransaction, Post } from "@enmo/db";
import {
  ACTION_AGENT,
  type Feedback,
  type FeedbackTarget,
  type PerPostAction,
  type PipelineAction,
  type QaIssue,
} from "@enmo/shared";
import { requireTransition } from "./post-status";

/*
 * Routing feedback back to the agents (DESIGN §D "Request Changes"). A human's REQUEST_CHANGES or
 * a QA "revise" appends a revision subgraph to the post's graph: one task per action to redo,
 * nodeKey "<planned node>.r<N>" (N = the post's new revision), chained, ending in QA, which opens
 * the next approval round. The first task carries the feedback byte-for-byte; the agent input is
 * built from it (AgentTask.feedback → CopywriterInput.revision.feedback).
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
  feedback: Feedback;
  enabledActions: readonly PipelineAction[];
}

/** Appends the revision chain as PENDING tasks; advance() queues its first task. */
export async function appendRevision(
  tx: DbTransaction,
  request: RevisionRequest,
): Promise<AgentTask[]> {
  const planned = await tx.agentTask.findMany({
    where: { graphId: request.graphId, postId: request.post.id, revision: 0 },
    select: { nodeKey: true, action: true },
    orderBy: { createdAt: "asc" },
  });
  const plannedKey = new Map(planned.map((task) => [task.action, task.nodeKey]));
  const anchor = planned[0]?.nodeKey ?? request.post.ref;

  const created: AgentTask[] = [];
  for (const action of revisionActions(request.target, request.enabledActions)) {
    const base = plannedKey.get(action) ?? `${anchor}-${action}`;
    const previous = created.at(-1);
    created.push(
      await tx.agentTask.create({
        data: {
          graphId: request.graphId,
          nodeKey: `${base}.r${request.revision}`,
          agent: ACTION_AGENT[action],
          action,
          postId: request.post.id,
          dependsOn: previous ? [previous.id] : [],
          revision: request.revision,
          ...(previous ? {} : { feedback: request.feedback }),
        },
      }),
    );
  }
  return created;
}

/** The graph the post's planned tasks belong to. */
export async function graphOfPost(tx: DbTransaction, postId: string): Promise<string> {
  const task = await tx.agentTask.findFirst({
    where: { postId },
    orderBy: { createdAt: "asc" },
    select: { graphId: true },
  });
  if (!task) throw new Error(`Post ${postId} has no tasks to revise`);
  return task.graphId;
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

/** How many automatic QA revisions the post has had. */
export async function qaRevisionCount(
  db: DbClient | DbTransaction,
  postId: string,
): Promise<number> {
  const revisions = await db.agentTask.findMany({
    where: { postId, revision: { gt: 0 } },
    select: { feedback: true },
  });
  return revisions.filter(
    (task) =>
      typeof task.feedback === "object" &&
      task.feedback !== null &&
      (task.feedback as { source?: unknown }).source === "QA",
  ).length;
}
