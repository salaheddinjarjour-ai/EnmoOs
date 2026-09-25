import type { DbClient, DbTransaction, Post, Prisma } from "@enmo/db";
import {
  inferFailedStage,
  postPlacement,
  type PipelineAction,
  type PostStatus,
  type PostUpdatedPayload,
} from "@enmo/shared";
import type { EventBatch } from "./events";

/*
 * Every Post.status change goes through transitionPost(), which only moves a post along an edge of
 * this table (DESIGN §B/§D). The update is conditional on the current status, so two writers racing
 * on one post can't both win, and a stale job can't drag a post backwards.
 */

type Db = DbClient | DbTransaction;

/** For each target status, the statuses a post may move there from. */
export const POST_TRANSITIONS: Readonly<Record<PostStatus, readonly PostStatus[]>> = {
  // Posts are born IDEA when a plan is approved.
  IDEA: [],
  // A write task starts: first draft, a human revision, a QA revision or a re-run.
  DRAFTING: ["IDEA", "DRAFTING", "CHANGES_REQUESTED", "QA", "FAILED"],
  VISUALIZING: ["IDEA", "DRAFTING", "VISUALIZING", "CHANGES_REQUESTED", "QA", "FAILED"],
  ADAPTING: ["DRAFTING", "VISUALIZING", "ADAPTING", "CHANGES_REQUESTED", "QA", "FAILED"],
  QA: ["DRAFTING", "VISUALIZING", "ADAPTING", "QA", "FAILED"],
  // QA opened a round, or a human edit reopened approval (a new round replaces the old one).
  PENDING_APPROVAL: ["QA", "PENDING_APPROVAL", "APPROVED", "SCHEDULED"],
  CHANGES_REQUESTED: ["PENDING_APPROVAL"],
  // Final approval, or every publish job called off (orchestrator/publishing.ts postStatusForJobs).
  APPROVED: ["PENDING_APPROVAL", "SCHEDULED", "PUBLISHING", "FAILED"],
  // Publish jobs waiting for their slots: scheduled, a retry queued, or a retryable error waiting.
  SCHEDULED: ["APPROVED", "SCHEDULED", "PUBLISHING", "FAILED"],
  // A variant is going out (or is out while another still waits); a retry while one is out.
  PUBLISHING: ["SCHEDULED", "PUBLISHING", "FAILED"],
  LIVE: ["PUBLISHING"],
  SCORED: ["LIVE", "SCORED"],
  FAILED: [
    "IDEA",
    "DRAFTING",
    "VISUALIZING",
    "ADAPTING",
    "QA",
    "APPROVED",
    "SCHEDULED",
    "PUBLISHING",
  ],
};

/** Posts whose visuals are out in the world (or failed there) and can't change any more. */
export const FROZEN_POST_STATUSES: ReadonlySet<PostStatus> = new Set([
  "PUBLISHING",
  "LIVE",
  "SCORED",
  "FAILED",
]);

export function canTransition(from: PostStatus, to: PostStatus): boolean {
  return POST_TRANSITIONS[to].includes(from);
}

/** The status a post enters when a task of `action` starts working on it. */
export const ACTION_POST_STATUS: Readonly<Record<PipelineAction, PostStatus | null>> = {
  // The campaign-wide strategy node touches no single post.
  strategy: null,
  write: "DRAFTING",
  direct: "VISUALIZING",
  adapt: "ADAPTING",
  qa: "QA",
};

export class IllegalPostTransition extends Error {
  override readonly name = "IllegalPostTransition";
  constructor(
    readonly postId: string,
    readonly to: PostStatus,
  ) {
    super(`Post ${postId} can't move to ${to} from its current status`);
  }
}

/** Fields that may change together with the status (never `status` itself). */
export type PostTransitionData = Omit<Prisma.PostUpdateManyMutationInput, "status">;

/**
 * Moves the post to `to` when its current status allows it; returns the updated row, or null when
 * the post is missing or in a status with no edge to `to`.
 */
export async function transitionPost(
  db: Db,
  postId: string,
  to: PostStatus,
  data: PostTransitionData = {},
): Promise<Post | null> {
  const [row] = await db.post.updateManyAndReturn({
    where: { id: postId, status: { in: [...POST_TRANSITIONS[to]] } },
    data: { ...data, status: to },
  });
  return row ?? null;
}

/** transitionPost() for transitions that must happen: throws (rolling the transaction back). */
export async function requireTransition(
  db: Db,
  postId: string,
  to: PostStatus,
  data: PostTransitionData = {},
): Promise<Post> {
  const row = await transitionPost(db, postId, to, data);
  if (!row) throw new IllegalPostTransition(postId, to);
  return row;
}

type PostEventFields = Pick<
  Post,
  "id" | "campaignId" | "clientId" | "status" | "needsAttention" | "liveAt" | "approvedAt" | "copy"
>;

export function postUpdatedPayload(post: PostEventFields): PostUpdatedPayload {
  const placement = postPlacement(post.status, inferFailedStage(post));
  return {
    postId: post.id,
    campaignId: post.campaignId,
    clientId: post.clientId,
    status: post.status,
    column: placement.column,
    pill: placement.pill,
    needsAttention: post.needsAttention,
  };
}

export function postUpdated(events: EventBatch, post: PostEventFields): EventBatch {
  return events.global("post.updated", postUpdatedPayload(post));
}
