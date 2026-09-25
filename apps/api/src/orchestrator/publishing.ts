import type { DbTransaction, Post, PublishJob } from "@enmo/db";
import { CANCELLABLE_PUBLISH_STATUSES, type PostStatus, type PublishStatus } from "@enmo/shared";
import type { Deps } from "../deps";
import { enqueuePublisherSchedule } from "../jobs/queues";
import type { EventBatch } from "./events";
import { postUpdated, transitionPost, type PostTransitionData } from "./post-status";

/*
 * Where the approval lifecycle meets publishing (DESIGN §D, §F "Publishing safety"): a post's final
 * approval hands it to the Publisher (publisher.schedule), and any change after approval (a copy
 * edit, a visual revision, a Vault take replacing an approved one) calls its scheduled publishing
 * off before approval reopens. The approval, posts, assets and Vault services call these hooks, so
 * the publishing code can grow without touching them.
 */

/** Why scheduled publishing was called off; the message lands on PublishJob.lastError. */
export const PUBLISH_CANCEL_REASONS = {
  copyEdited: "Cancelled: the copy was edited after approval",
  visualRevision: "Cancelled: the visuals went back to the Visual Director after approval",
  takeReplaced: "Cancelled: a new take replaced one the approval covered",
  // The publish guard (publishing/guards.ts) refused the post when its slot came.
  approvalWithdrawn: "Cancelled at publish time: the post's approval no longer stands",
  contentChanged: "Cancelled at publish time: the content changed after it was approved",
  bannedWords: "Cancelled at publish time: the content uses the client's banned words",
} as const;
export type PublishCancelReason = keyof typeof PUBLISH_CANCEL_REASONS;

/** PublishJob.lastError values that mean "called off by the approval lifecycle", not by a person. */
export const LIFECYCLE_CANCEL_MESSAGES: ReadonlySet<string> = new Set(
  Object.values(PUBLISH_CANCEL_REASONS),
);

/** The approval that just ended APPROVED: its post and round. */
export interface ApprovedPost {
  postId: string;
  round: number;
}

/**
 * After the transaction that approved the post's final chain step has committed: queues
 * publisher.schedule, which picks the slots and creates the PublishJobs. Callers run it through
 * afterCommit, so a queue outage never fails the approval itself (tick.publish re-drives it).
 */
export async function onPostApproved(
  deps: Pick<Deps, "queues">,
  approved: ApprovedPost,
): Promise<void> {
  await enqueuePublisherSchedule(deps.queues, approved);
}

/** Queues `publish.updated` for a job whose status or slot changed. */
export function publishUpdated(
  events: EventBatch,
  job: Pick<PublishJob, "id" | "variantId" | "platform" | "status" | "scheduledFor" | "liveUrl">,
  postId: string,
): EventBatch {
  return events.global("publish.updated", {
    jobId: job.id,
    variantId: job.variantId,
    postId,
    platform: job.platform,
    status: job.status,
    scheduledFor: job.scheduledFor.toISOString(),
    liveUrl: job.liveUrl,
  });
}

/**
 * Inside the transaction that reopens a post's approval (or sends it back to an agent): every
 * PublishJob of the post that hasn't started publishing is CANCELLED with the reason, and a
 * `publish.updated` is queued for each. Jobs already PUBLISHING or done are left alone: the
 * publish guard re-checks the approval and content hash before anything goes out. Returns how many
 * jobs were cancelled.
 */
export async function cancelScheduledForPost(
  tx: DbTransaction,
  events: EventBatch,
  postId: string,
  reason: PublishCancelReason,
): Promise<number> {
  const cancelled = await tx.publishJob.updateManyAndReturn({
    where: { variant: { postId }, status: { in: [...CANCELLABLE_PUBLISH_STATUSES] } },
    data: { status: "CANCELLED", lastError: PUBLISH_CANCEL_REASONS[reason] },
  });
  for (const job of cancelled) publishUpdated(events, job, postId);
  return cancelled.length;
}

/** Post statuses its publish jobs decide; earlier ones belong to the approval lifecycle. */
const PUBLISH_DRIVEN_STATUSES: ReadonlySet<PostStatus> = new Set([
  "APPROVED",
  "SCHEDULED",
  "PUBLISHING",
  "LIVE",
  "FAILED",
]);

export type PublishDrivenStatus = Extract<
  PostStatus,
  "APPROVED" | "SCHEDULED" | "PUBLISHING" | "LIVE" | "FAILED"
>;

/**
 * Where a post's publish jobs put it (cancelled jobs don't count):
 * - none left → APPROVED (approved, nothing scheduled);
 * - all PUBLISHED → LIVE;
 * - any FAILED → FAILED (people retry it);
 * - any PUBLISHING or PUBLISHED → PUBLISHING (part of it is going or gone out);
 * - otherwise every job waits for its slot (SCHEDULED, or QUEUED for publish.run) → SCHEDULED.
 */
export function postStatusForJobs(statuses: readonly PublishStatus[]): PublishDrivenStatus {
  const active = statuses.filter((status) => status !== "CANCELLED");
  if (active.length === 0) return "APPROVED";
  if (active.every((status) => status === "PUBLISHED")) return "LIVE";
  if (active.includes("FAILED")) return "FAILED";
  if (active.some((status) => status === "PUBLISHING" || status === "PUBLISHED")) {
    return "PUBLISHING";
  }
  return "SCHEDULED";
}

export interface SyncPostOptions {
  /** Post.attentionReason when the post becomes FAILED. */
  attentionReason?: string;
}

/**
 * Brings the post's status in line with its PublishJobs after one of them changed (scheduled,
 * rescheduled, cancelled, retried, published or failed) and queues post.updated when it moved.
 * A post outside the publishing statuses (back in approval, say) is left alone. LIVE stamps
 * liveAt with the moment its last variant went out; FAILED flags the post for attention, and
 * leaving FAILED (a retry) clears the flag. Returns the post when its status changed, else null.
 */
export async function syncPostPublishStatus(
  tx: DbTransaction,
  events: EventBatch,
  postId: string,
  options: SyncPostOptions = {},
): Promise<Post | null> {
  const post = await tx.post.findUnique({ where: { id: postId }, select: { status: true } });
  if (!post || !PUBLISH_DRIVEN_STATUSES.has(post.status)) return null;
  const jobs = await tx.publishJob.findMany({
    where: { variant: { postId } },
    select: { status: true, publishedAt: true },
  });
  const target = postStatusForJobs(jobs.map((job) => job.status));
  if (target === post.status) return null;

  const data: PostTransitionData = {};
  if (target === "LIVE") {
    const times = jobs.flatMap((job) => (job.publishedAt ? [job.publishedAt.getTime()] : []));
    data.liveAt = times.length > 0 ? new Date(Math.max(...times)) : null;
  }
  if (target === "FAILED") {
    data.needsAttention = true;
    data.attentionReason = options.attentionReason ?? "Publishing failed";
  } else if (post.status === "FAILED") {
    data.needsAttention = false;
    data.attentionReason = null;
  }
  const moved = await transitionPost(tx, postId, target, data);
  if (moved) postUpdated(events, moved);
  return moved;
}
