import { COPY_BANNED_SCAN_IGNORE } from "@enmo/agents";
import type { AccountStatus, DbTransaction } from "@enmo/db";
import { PLATFORM_LABEL, scanForBannedWords } from "@enmo/shared";
import type { Deps } from "../deps";
import { enqueuePublishRun } from "../jobs/queues";
import { afterCommit } from "../orchestrator/after-commit";
import {
  approvalCreated,
  approvalResolved,
  cancelOpenRounds,
  openApprovalRound,
} from "../orchestrator/approval-round";
import { EventBatch } from "../orchestrator/events";
import { bannedWordIssues, plannedGraphOf, routeCopyRevision } from "../orchestrator/feedback";
import { lockPost } from "../orchestrator/locks";
import { postUpdated, requireTransition } from "../orchestrator/post-status";
import {
  cancelScheduledForPost,
  PUBLISH_CANCEL_REASONS,
  publishUpdated,
  syncPostPublishStatus,
  type PublishCancelReason,
} from "../orchestrator/publishing";
import {
  accountAlert,
  jobAlert,
  loadPublishJob,
  publisherNote,
  variantLabel,
  type PublishJobWithContext,
} from "./context";
import type { GuardFailure, GuardName } from "./guards";

/*
 * How a publish attempt ends (DESIGN §F): PUBLISHED with its live URL (the post LIVE once every
 * variant is), QUEUED again for an automatic retry, FAILED with an alert (an expired token also
 * marks the account), or CANCELLED when the publish guard refuses it: archived work is held back,
 * and refused content goes back to its approval (banned copy to the Copywriter first). Each write
 * is conditional on the job still being on the attempt that decided it, so a late or duplicate
 * job can't overwrite a newer state.
 */

/** A job on one publish attempt (PublishRunJob.attempt). */
export interface AttemptRef {
  jobId: string;
  postId: string;
  attempt: number;
}

/** The job is running this attempt, or (a failure before it started) still queued for it. */
function onAttempt(ref: AttemptRef) {
  return {
    id: ref.jobId,
    OR: [
      { status: "PUBLISHING" as const, attempts: ref.attempt },
      { status: "QUEUED" as const, attempts: ref.attempt - 1 },
    ],
  };
}

/** A message as the middle of a sentence: no trailing full stop. */
function clause(message: string): string {
  return message.trim().replace(/[.\s]+$/u, "");
}

function labelOf(job: PublishJobWithContext): string {
  return variantLabel(job.variant.post.ref, PLATFORM_LABEL[job.platform]);
}

/** The variant is live: PUBLISHED with its id, URL and time; the post LIVE once all of it is. */
export async function recordPublished(
  deps: Deps,
  ref: AttemptRef,
  published: { externalId: string; liveUrl: string },
): Promise<boolean> {
  const events = new EventBatch();
  const done = await deps.prisma.$transaction(async (tx) => {
    await lockPost(tx, ref.postId);
    const [job] = await tx.publishJob.updateManyAndReturn({
      where: { id: ref.jobId, status: "PUBLISHING", attempts: ref.attempt },
      data: {
        status: "PUBLISHED",
        externalId: published.externalId,
        liveUrl: published.liveUrl,
        publishedAt: deps.clock.now(),
        lastError: null,
      },
    });
    if (!job) return false;
    publishUpdated(events, job, ref.postId);
    const moved = await syncPostPublishStatus(tx, events, ref.postId);
    if (moved?.status === "LIVE") await announceLive(tx, events, ref.postId);
    return true;
  });
  await events.publish(deps);
  return done;
}

/** The Publisher's "p1 is live." note with each live URL, once the post's last variant is out. */
export async function announceLive(
  tx: DbTransaction,
  events: EventBatch,
  postId: string,
): Promise<void> {
  const post = await tx.post.findUniqueOrThrow({
    where: { id: postId },
    select: {
      ref: true,
      campaign: { select: { thread: { select: { id: true } } } },
      variants: {
        select: {
          platform: true,
          publishJob: { select: { status: true, liveUrl: true, dryRun: true } },
        },
      },
    },
  });
  const lines = post.variants.flatMap((variant) => {
    const job = variant.publishJob;
    if (job?.status !== "PUBLISHED" || !job.liveUrl) return [];
    return [`${PLATFORM_LABEL[variant.platform]}: ${job.liveUrl}${job.dryRun ? " (dry run)" : ""}`];
  });
  await publisherNote(
    tx,
    events,
    post.campaign.thread?.id,
    [`${post.ref} is live.`, ...lines].join("\n"),
  );
}

export interface FailOptions {
  /** What the job's account turned out to be (an expired or undecryptable token). */
  accountStatus?: AccountStatus | null;
  /** "stuck" when publishing stalled rather than failed outright. */
  alert?: "failed" | "stuck";
}

/**
 * Inside a transaction that holds the post: the job FAILED on this attempt with `message`, the
 * account marked when its token is the problem, the post FAILED (it needs a retry from people),
 * an alert and a Publisher note. Returns false when the job had already left the attempt.
 */
export async function failJobIn(
  tx: DbTransaction,
  deps: Deps,
  events: EventBatch,
  job: PublishJobWithContext,
  ref: AttemptRef,
  message: string,
  options: FailOptions = {},
): Promise<boolean> {
  const [failed] = await tx.publishJob.updateManyAndReturn({
    where: onAttempt(ref),
    data: { status: "FAILED", attempts: ref.attempt, lastError: message },
  });
  if (!failed) return false;
  const post = job.variant.post;
  publishUpdated(events, failed, ref.postId);
  if (options.accountStatus && job.socialAccountId) {
    const [account] = await tx.socialAccount.updateManyAndReturn({
      where: { id: job.socialAccountId, status: "ACTIVE" },
      data: { status: options.accountStatus, lastCheckedAt: deps.clock.now() },
      select: { id: true, clientId: true, handle: true },
    });
    if (account) {
      accountAlert(
        events,
        account,
        `${PLATFORM_LABEL[job.platform]} account ${account.handle} is ${options.accountStatus.toLowerCase()}: reconnect it, then retry the post.`,
      );
    }
  }
  await syncPostPublishStatus(tx, events, ref.postId, { attentionReason: message });
  const label = labelOf(job);
  const why = clause(message);
  jobAlert(events, options.alert ?? "failed", failed, post, `Publishing ${label} failed: ${why}.`);
  await publisherNote(
    tx,
    events,
    post.campaign.thread?.id,
    `I couldn't publish ${label}: ${why}. Retry it from the calendar once that's sorted.`,
  );
  return true;
}

/** failJobIn in its own transaction (the job is reloaded under the post lock). */
export async function failJob(
  deps: Deps,
  ref: AttemptRef,
  message: string,
  options: FailOptions = {},
): Promise<boolean> {
  const events = new EventBatch();
  const done = await deps.prisma.$transaction(async (tx) => {
    await lockPost(tx, ref.postId);
    const job = await loadPublishJob(tx, ref.jobId);
    return job ? failJobIn(tx, deps, events, job, ref, message, options) : false;
  });
  await events.publish(deps);
  return done;
}

/**
 * A retryable failure with automatic attempts left: the job waits QUEUED (the post back to
 * SCHEDULED unless the attempt reached the platform or another variant is out: countedPublishStatus)
 * and publish.run comes back for the next attempt after
 * `delayMs`, in the same chain of retries as `firstAttempt`. A lost enqueue is re-driven by
 * tick.publish.
 */
export async function retryLater(
  deps: Deps,
  ref: AttemptRef,
  message: string,
  delayMs: number,
  firstAttempt: number = ref.attempt,
): Promise<boolean> {
  const events = new EventBatch();
  const queued = await deps.prisma.$transaction(async (tx) => {
    await lockPost(tx, ref.postId);
    const [job] = await tx.publishJob.updateManyAndReturn({
      where: { id: ref.jobId, status: "PUBLISHING", attempts: ref.attempt },
      data: { status: "QUEUED", lastError: message },
    });
    if (!job) return false;
    publishUpdated(events, job, ref.postId);
    await syncPostPublishStatus(tx, events, ref.postId);
    return true;
  });
  await events.publish(deps);
  if (queued) {
    await afterCommit(deps, "queueing an automatic publish retry", () =>
      enqueuePublishRun(
        deps.queues,
        { publishJobId: ref.jobId, attempt: ref.attempt + 1, firstAttempt },
        { delayMs },
      ),
    );
  }
  return queued;
}

const CANCEL_REASON: Readonly<
  Record<Exclude<GuardName, "token" | "archived">, PublishCancelReason>
> = {
  approval: "approvalWithdrawn",
  contentHash: "contentChanged",
  bannedWords: "bannedWords",
};

/** What a refusal leaves for after its transaction commits. */
export interface Refusal {
  /** The graph a revision was appended to: advance() it once committed. */
  revisedGraph: string | null;
}

const NOTHING_TO_ADVANCE: Refusal = { revisedGraph: null };

/**
 * Archived work never goes out, and nobody has to act on it: the job and every other waiting job
 * of the post are CANCELLED (the archive's own reason, so nothing schedules them again), the post
 * settles on what is left, and the thread is told.
 */
async function holdBackArchivedIn(
  tx: DbTransaction,
  events: EventBatch,
  job: PublishJobWithContext,
  ref: AttemptRef,
  failure: GuardFailure,
): Promise<void> {
  const post = job.variant.post;
  const reason = post.campaign.status === "ARCHIVED" ? "campaignArchived" : "clientArchived";
  const [cancelled] = await tx.publishJob.updateManyAndReturn({
    where: onAttempt(ref),
    data: { status: "CANCELLED", lastError: PUBLISH_CANCEL_REASONS[reason] },
  });
  if (!cancelled) return;
  publishUpdated(events, cancelled, ref.postId);
  await cancelScheduledForPost(tx, events, ref.postId, reason);
  await syncPostPublishStatus(tx, events, ref.postId);
  await publisherNote(
    tx,
    events,
    post.campaign.thread?.id,
    `I held back ${labelOf(job)}: ${clause(failure.message)}.`,
  );
}

/**
 * The guard refused the job (inside the publish transaction, rounds and post locked). A token
 * problem fails it like a platform AUTH error: people reconnect and retry. Archived work is simply
 * held back. Anything about the content cancels it with every other waiting job of the post and,
 * while the post is only approved or scheduled, sends it back: banned words to the Copywriter
 * (the gate before an approval round, as QA's is: reviewers never get copy that can't go out),
 * anything else to its approval, reopened on what the post holds now. A post already partly out,
 * or banned copy outside any plan, stays where it is, flagged. A retry resuming what an earlier
 * attempt sent the platform fails instead: the post may be out there, and a job called off would
 * be scheduled anew from scratch, so a person checks the platform before cancelling it.
 */
export async function refuseIn(
  tx: DbTransaction,
  deps: Deps,
  events: EventBatch,
  job: PublishJobWithContext,
  ref: AttemptRef,
  failure: GuardFailure,
): Promise<Refusal> {
  if (failure.guard === "token") {
    await failJobIn(tx, deps, events, job, ref, failure.message, {
      accountStatus: failure.accountStatus,
    });
    return NOTHING_TO_ADVANCE;
  }
  if (failure.guard === "archived") {
    await holdBackArchivedIn(tx, events, job, ref, failure);
    return NOTHING_TO_ADVANCE;
  }
  if (job.containerId !== null) {
    const platform = PLATFORM_LABEL[job.platform];
    await failJobIn(
      tx,
      deps,
      events,
      job,
      ref,
      `${clause(failure.message)}, and an earlier attempt already reached ${platform}, so the post may be there: check ${platform}, then cancel this job`,
    );
    return NOTHING_TO_ADVANCE;
  }
  const reason = CANCEL_REASON[failure.guard];
  const [cancelled] = await tx.publishJob.updateManyAndReturn({
    where: onAttempt(ref),
    data: { status: "CANCELLED", lastError: PUBLISH_CANCEL_REASONS[reason] },
  });
  if (!cancelled) return NOTHING_TO_ADVANCE;
  publishUpdated(events, cancelled, ref.postId);
  await cancelScheduledForPost(tx, events, ref.postId, reason);

  const post = job.variant.post;
  const context = { campaignId: post.campaignId, clientId: post.clientId };
  const current = await tx.post.findUniqueOrThrow({ where: { id: ref.postId } });
  const waiting = current.status === "APPROVED" || current.status === "SCHEDULED";
  const graphId =
    waiting && failure.guard === "bannedWords" ? await plannedGraphOf(tx, ref.postId) : null;
  let next = "";
  let revisedGraph: string | null = null;
  if (graphId) {
    const hits = scanForBannedWords(post.copy, post.client.bannedWords, {
      ignoreKeys: COPY_BANNED_SCAN_IGNORE,
      limit: 20,
    });
    const revision = await routeCopyRevision(tx, {
      postId: ref.postId,
      graphId,
      issues: bannedWordIssues(hits),
      summary: `${clause(failure.message)}. Rewrite the copy without them.`,
      enabledActions: deps.config.PIPELINE_ACTIONS,
      now: deps.clock.now(),
      events,
      cancelReason: reason,
    });
    for (const round of revision.cancelled) approvalResolved(events, round, context);
    postUpdated(events, revision.post);
    revisedGraph = graphId;
    next = " It's back with the Copywriter.";
  } else if (waiting && failure.guard !== "bannedWords") {
    const rounds = await cancelOpenRounds(tx, ref.postId, deps.clock.now());
    const updated = await requireTransition(tx, ref.postId, "PENDING_APPROVAL", {
      approvedAt: null,
      needsAttention: true,
      attentionReason: failure.message,
    });
    const request = await openApprovalRound(tx, updated);
    for (const round of rounds) approvalResolved(events, round, context);
    approvalCreated(events, request, context);
    postUpdated(events, updated);
    next = " Its approval is open again.";
  } else {
    await syncPostPublishStatus(tx, events, ref.postId);
    postUpdated(
      events,
      await tx.post.update({
        where: { id: ref.postId },
        data: { needsAttention: true, attentionReason: failure.message },
      }),
    );
    if (waiting) next = " Edit the copy to drop them; that reopens its approval.";
  }

  const label = labelOf(job);
  const why = clause(failure.message);
  jobAlert(events, "failed", cancelled, post, `Held back ${label}: ${why}.`);
  await publisherNote(tx, events, post.campaign.thread?.id, `I held back ${label}: ${why}.${next}`);
  return { revisedGraph };
}
