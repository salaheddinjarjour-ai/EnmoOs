import type { DbTransaction } from "@enmo/db";
import {
  hasUnconfirmedPost,
  PublishError,
  type DecryptedAccount,
  type PublishErrorCode,
  type PublishOutcome,
  type PublishPayload,
} from "@enmo/providers";
import { PLATFORM_LABEL, type Platform, type PublishStatus } from "@enmo/shared";
import type { Deps } from "../deps";
import {
  enqueuePublishPoll,
  enqueuePublishRun,
  enqueuePublisherSchedule,
  JOB,
  jobIds,
  publishPollDelayMs,
  publishPollMaxPolls,
  type PublishPollJob,
  type PublishRunJob,
  type QueueName,
  type RequeueToken,
} from "../jobs/queues";
import type { RunAttempt } from "../jobs/types";
import { MINUTE_MS } from "../lib/clock";
import { afterCommit } from "../orchestrator/after-commit";
import { lockReopenableRounds } from "../orchestrator/approval-round";
import { EventBatch } from "../orchestrator/events";
import { advance } from "../orchestrator/graph";
import { lockPost } from "../orchestrator/locks";
import { postUpdated } from "../orchestrator/post-status";
import {
  LIFECYCLE_CANCEL_MESSAGES,
  publishUpdated,
  syncPostPublishStatus,
} from "../orchestrator/publishing";
import {
  activeAccountOf,
  archivedOf,
  loadPublishJob,
  payloadOf,
  publisherFor,
  publishesLive,
  type PublishJobWithContext,
} from "./context";
import { checkPublishGuards, decryptAccount } from "./guards";
import {
  failJob,
  failJobIn,
  recordPublished,
  refuseIn,
  retryLater,
  type AttemptRef,
} from "./outcomes";
import { describeIssues } from "./payload";
import { ensureRenditions, type Rendition } from "./renditions";
import { UNSCHEDULED_ATTENTION_PREFIXES } from "./schedule";

/*
 * Publishing one job (DESIGN §F "Publishing safety", "Meta", "Dry-run"):
 *   tick.publish  due SCHEDULED jobs → QUEUED + publish.run; also re-drives what a lost enqueue or
 *                 a dead worker left behind (QUEUED without a run, PUBLISHING without a run or poll,
 *                 an APPROVED post whose publisher.schedule never ran)
 *   publish.run   under the post's locks: dry run or live settled for good (the publish mode and
 *                 account now), the guard, the payload, QUEUED → PUBLISHING; then the publisher
 *                 (a DryRunPublisher for a dry run), resuming the job's container
 *   publish.poll  media the platform is still processing, until it is live or PUBLISH_POLL_MAX_MIN
 * Automatic retries are new publish.run jobs, one per attempt, up to PUBLISH_MAX_ATTEMPTS per chain;
 * a manual retry (POST /publish-jobs/:id/retry) always gets its own attempt and starts a new chain.
 */

export type PublishStepResult =
  "stale" | "refused" | "published" | "processing" | "retrying" | "failed";

/**
 * The wait after the `failedTry`-th attempt of a chain of automatic retries (1 for the attempt
 * that began it): one poll interval, ×3 per try.
 */
export function publishRetryDelayMs(config: Deps["config"], failedTry: number): number {
  return publishPollDelayMs(config) * 3 ** Math.max(0, failedTry - 1);
}

const ERROR_VERB: Readonly<Record<PublishErrorCode, string>> = {
  INVALID_PAYLOAD: "can't take this post",
  AUTH: "refused the account's token",
  RATE_LIMITED: "is rate-limiting the account",
  MEDIA_FAILED: "couldn't process the media",
  UNAVAILABLE: "is unavailable",
  REJECTED: "rejected the post",
  NOT_CONFIGURED: "isn't set up for publishing",
  UNCONFIRMED: "may already have the post",
};

function describeError(error: PublishError, platform: Platform): string {
  return `${PLATFORM_LABEL[platform]} ${ERROR_VERB[error.code]}: ${error.message}`;
}

function refOf(job: Pick<PublishJobWithContext, "id" | "variant">, attempt: number): AttemptRef {
  return { jobId: job.id, postId: job.variant.postId, attempt };
}

/** Persists a container as soon as the platform assigns it, so a retry resumes it. */
async function saveContainer(deps: Deps, ref: AttemptRef, containerId: string): Promise<void> {
  await deps.prisma.publishJob.updateMany({
    where: { id: ref.jobId, status: "PUBLISHING", attempts: ref.attempt },
    data: { containerId },
  });
}

/**
 * A PublishError decides the job's fate (AUTH also marks the account); anything else is an
 * infrastructure error BullMQ retries, and its last attempt fails the job. `firstAttempt` began
 * the chain of automatic retries this attempt belongs to.
 */
async function handleFailure(
  deps: Deps,
  ref: AttemptRef,
  platform: Platform,
  error: unknown,
  run: RunAttempt,
  firstAttempt: number = ref.attempt,
): Promise<PublishStepResult> {
  if (error instanceof PublishError) {
    const message = describeError(error, platform);
    if (error.code === "AUTH") {
      await failJob(deps, ref, message, { accountStatus: "EXPIRED" });
      return "failed";
    }
    const tries = ref.attempt - firstAttempt + 1;
    if (error.retryable && tries < deps.config.PUBLISH_MAX_ATTEMPTS) {
      await retryLater(deps, ref, message, publishRetryDelayMs(deps.config, tries), firstAttempt);
      return "retrying";
    }
    const final = error.retryable ? `${message} (gave up after ${tries} attempts)` : message;
    await failJob(deps, ref, final);
    return "failed";
  }
  if (run.isLast) {
    const reason = error instanceof Error ? error.message : String(error);
    await failJob(deps, ref, `publishing stopped on an unexpected error: ${reason}`);
  }
  throw error;
}

/** Published → recorded; still processing → the first (or next) publish.poll. */
async function settle(
  deps: Deps,
  ref: AttemptRef,
  outcome: PublishOutcome,
  poll: number,
): Promise<PublishStepResult> {
  if (outcome.status === "published") {
    await recordPublished(deps, ref, outcome);
    return "published";
  }
  await saveContainer(deps, ref, outcome.containerId);
  await enqueuePublishPoll(
    deps.queues,
    { publishJobId: ref.jobId, attempt: ref.attempt, poll: poll + 1 },
    { delayMs: publishPollDelayMs(deps.config) },
  );
  return "processing";
}

type Claim =
  | { kind: "stale" }
  | { kind: "settled"; revisedGraph: string | null }
  | {
      kind: "claimed";
      job: PublishJobWithContext;
      payload: PublishPayload;
      renditions: Rendition[];
      account: DecryptedAccount | null;
    };

/** How a job goes out: PublishJob.dryRun and socialAccountId as its claim stores them. */
interface PublishMode {
  dryRun: boolean;
  socialAccountId: string | null;
}

/**
 * Dry run or live, settled when the job starts publishing (DESIGN §F "Dry-run": dry unless
 * PUBLISH_MODE is live, the platform has credentials and there is an account). Scheduling only
 * forecast it, so a kill switch (PUBLISH_MODE=dry-run, credentials removed) never passes a
 * simulated post off as live, and a post scheduled before its account was connected goes out for
 * real. The account is the job's own, or else the client's current one. A job scheduled live
 * whose account is gone stays live: the token guard fails it, so people reconnect rather than
 * find a simulated post. A job already PUBLISHING (a BullMQ retry after a crash) keeps what its
 * first claim settled: that attempt may have media at the platform already.
 */
async function publishModeOf(
  tx: DbTransaction,
  deps: Deps,
  job: PublishJobWithContext,
): Promise<PublishMode> {
  const stored = { dryRun: job.dryRun, socialAccountId: job.socialAccountId };
  if (job.status === "PUBLISHING") return stored;
  if (!publishesLive(deps, job.platform)) return { ...stored, dryRun: true };
  if (job.socialAccountId) return { ...stored, dryRun: false };
  const account = await activeAccountOf(tx, job.variant.post.clientId, job.platform);
  return account ? { dryRun: false, socialAccountId: account.id } : stored;
}

/** QUEUED for this attempt, or already PUBLISHING on it (a BullMQ retry after a crash). */
function onThisAttempt(job: { status: string; attempts: number }, attempt: number): boolean {
  return (
    (job.status === "QUEUED" && job.attempts === attempt - 1) ||
    (job.status === "PUBLISHING" && job.attempts === attempt)
  );
}

/**
 * One transaction under the locks an edit takes (rounds, then the post): the publish mode, the
 * guard, the payload, then QUEUED → PUBLISHING with the mode stored. From then on the post is
 * PUBLISHING, which no edit touches, so what the guard passed is what goes out.
 */
async function claim(deps: Deps, data: PublishRunJob): Promise<Claim> {
  const events = new EventBatch();
  const result = await deps.prisma.$transaction(async (tx): Promise<Claim> => {
    const head = await tx.publishJob.findUnique({
      where: { id: data.publishJobId },
      select: { variant: { select: { postId: true } } },
    });
    if (!head) return { kind: "stale" };
    await lockReopenableRounds(tx, head.variant.postId);
    await lockPost(tx, head.variant.postId);
    const job = await loadPublishJob(tx, data.publishJobId);
    if (!job || !onThisAttempt(job, data.attempt)) return { kind: "stale" };
    const ref = refOf(job, data.attempt);
    const post = job.variant.post;
    const mode = await publishModeOf(tx, deps, job);

    const guard = await checkPublishGuards(tx, deps.tokenCipher, {
      postId: post.id,
      archived: archivedOf(job),
      copy: post.copy,
      bannedWords: post.client.bannedWords,
      variant: {
        platform: job.platform,
        caption: job.variant.caption,
        hashtags: job.variant.hashtags,
      },
      job: mode,
      now: deps.clock.now(),
    });
    if (!guard.ok) {
      const refusal = await refuseIn(tx, deps, events, job, ref, guard.failure);
      return { kind: "settled", revisedGraph: refusal.revisedGraph };
    }
    const prepared = payloadOf(deps, job);
    if (!prepared.ok) {
      const message = `${PLATFORM_LABEL[job.platform]} ${ERROR_VERB.INVALID_PAYLOAD}: ${describeIssues(prepared.issues)}`;
      await failJobIn(tx, deps, events, job, ref, message);
      return { kind: "settled", revisedGraph: null };
    }
    const [claimed] = await tx.publishJob.updateManyAndReturn({
      where: { id: job.id, status: { in: ["QUEUED", "PUBLISHING"] } },
      data: { status: "PUBLISHING", attempts: data.attempt, ...mode },
    });
    if (!claimed) return { kind: "stale" };
    if (job.status === "QUEUED") {
      publishUpdated(events, claimed, post.id);
      await syncPostPublishStatus(tx, events, post.id);
    }
    return {
      kind: "claimed",
      job: { ...job, ...mode },
      payload: prepared.payload,
      renditions: prepared.renditions,
      account: guard.account,
    };
  });
  await events.publish(deps);
  return result;
}

/** The job is live, but its platform's publisher no longer is: nothing may fake the rest. */
function switchedOff(platform: Platform): string {
  const label = PLATFORM_LABEL[platform];
  return `${label} publishing was switched to dry run (PUBLISH_MODE or its credentials) while this live publish was under way; check the ${label} account, then retry it`;
}

/**
 * The claim, or on BullMQ's last attempt the job FAILED with an alert when it keeps throwing (the
 * database down for longer than the backoff, a transaction timeout): nothing else would move a
 * QUEUED job whose run gave up, so it would sit there without anyone knowing.
 */
async function claimOrFail(deps: Deps, data: PublishRunJob, run: RunAttempt): Promise<Claim> {
  try {
    return await claim(deps, data);
  } catch (error) {
    if (run.isLast) {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        await failQueuedRun(deps, data, reason);
      } catch (failure) {
        // tick.publish finds the job without a run and deals with it (driveOrphans).
        deps.logger.error(
          { err: failure, publishJobId: data.publishJobId },
          "could not fail a publish job whose run gave up",
        );
      }
    }
    throw error;
  }
}

/** A QUEUED job whose run for `data.attempt` gave up before it could start publishing: FAILED. */
async function failQueuedRun(deps: Deps, data: PublishRunJob, reason: string): Promise<boolean> {
  const head = await deps.prisma.publishJob.findUnique({
    where: { id: data.publishJobId },
    select: { variant: { select: { postId: true } } },
  });
  if (!head) return false;
  return failJob(
    deps,
    { jobId: data.publishJobId, postId: head.variant.postId, attempt: data.attempt },
    `publishing couldn't start (${clip(reason)}); retry it`,
    { alert: "stuck" },
  );
}

function clip(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** publish.run: one attempt at publishing a job. */
export async function runPublish(
  deps: Deps,
  data: PublishRunJob,
  run: RunAttempt,
): Promise<PublishStepResult> {
  const claimed = await claimOrFail(deps, data, run);
  if (claimed.kind === "stale") return "stale";
  if (claimed.kind === "settled") {
    const graphId = claimed.revisedGraph;
    if (graphId) {
      // The sweeper queues the revision if this is lost.
      await afterCommit(deps, "starting the copy revision", () => advance(deps, graphId));
    }
    return "refused";
  }
  const { job, payload, renditions, account } = claimed;
  const ref = refOf(job, data.attempt);
  const publisher = publisherFor(deps, job);
  if (!publisher) {
    await failJob(deps, ref, switchedOff(job.platform));
    return "failed";
  }
  let outcome: PublishOutcome;
  try {
    // A dry run writes them too: the files a live publish would hand the platform exist.
    await ensureRenditions(deps.storage, renditions);
    outcome = await publisher.publish(payload, account, {
      containerId: job.containerId,
      onContainer: (containerId) => saveContainer(deps, ref, containerId),
    });
  } catch (error) {
    return handleFailure(deps, ref, job.platform, error, run, data.firstAttempt);
  }
  return settle(deps, ref, outcome, 0);
}

/** The live account of a job for a poll (the guard already passed when it started). */
async function pollAccount(
  deps: Deps,
  job: PublishJobWithContext,
): Promise<DecryptedAccount | null | "unusable"> {
  if (job.dryRun) return null;
  const row = job.socialAccountId
    ? await deps.prisma.socialAccount.findUnique({ where: { id: job.socialAccountId } })
    : null;
  return (row && decryptAccount(row, deps.tokenCipher)) ?? "unusable";
}

/** publish.poll: checks media the platform is still processing, then publishes it. */
export async function pollPublish(
  deps: Deps,
  data: PublishPollJob,
  run: RunAttempt,
): Promise<PublishStepResult> {
  const job = await loadPublishJob(deps.prisma, data.publishJobId);
  if (!job || job.status !== "PUBLISHING" || job.attempts !== data.attempt || !job.containerId) {
    return "stale";
  }
  const ref = refOf(job, data.attempt);
  const label = PLATFORM_LABEL[job.platform];
  const prepared = payloadOf(deps, job);
  if (!prepared.ok) {
    await failJob(
      deps,
      ref,
      `${label} ${ERROR_VERB.INVALID_PAYLOAD}: ${describeIssues(prepared.issues)}`,
    );
    return "failed";
  }
  const publisher = publisherFor(deps, job);
  if (!publisher) {
    await failJob(deps, ref, switchedOff(job.platform));
    return "failed";
  }
  const account = await pollAccount(deps, job);
  if (account === "unusable") {
    await failJob(
      deps,
      ref,
      `the ${label} account is gone or its token can't be decrypted; reconnect it`,
      {
        accountStatus: "ERROR",
      },
    );
    return "failed";
  }

  let outcome: PublishOutcome;
  try {
    outcome = await publisher.poll(job.containerId, account, prepared.payload);
  } catch (error) {
    // A transient error while checking just means another look later.
    if (!(error instanceof PublishError && error.retryable)) {
      return handleFailure(deps, ref, job.platform, error, run);
    }
    outcome = { status: "processing", containerId: job.containerId };
  }
  if (outcome.status === "processing" && data.poll >= publishPollMaxPolls(deps.config)) {
    await failJob(
      deps,
      ref,
      `${label} was still processing the media after ${deps.config.PUBLISH_POLL_MAX_MIN} min`,
    );
    return "failed";
  }
  return settle(deps, ref, outcome, data.poll);
}

/* ─── tick.publish ───────────────────────────────────────────────────────────────────────────── */

/** An APPROVED post is left alone this long before tick.publish decides its schedule was lost. */
export const SCHEDULE_REDRIVE_AFTER_MS = 5 * MINUTE_MS;
/** The requeue token of a re-driven publisher.schedule (one per round, however many ticks). */
export const SCHEDULE_REDRIVE_TOKEN = "sweep";
/** The requeue token of a re-driven publish.run (one per attempt, however many ticks). */
export const RUN_REDRIVE_TOKEN = "sweep";

/** BullMQ states in which a job will still run (or is running). */
const LIVE_JOB_STATES = [
  "active",
  "waiting",
  "delayed",
  "prioritized",
  "waiting-children",
] as const;

export interface PublishTickReport {
  /** Due jobs handed to publish.run. */
  queued: number;
  /** QUEUED jobs whose publish.run was lost (or gave up once), queued again. */
  redriven: number;
  /**
   * Jobs nothing will work on any more, FAILED with an alert: PUBLISHING ones no run or poll is
   * on, and QUEUED ones whose re-driven run gave up too.
   */
  stalled: number;
  /** APPROVED posts whose publisher.schedule was lost (or gave up once), queued again. */
  rescheduled: number;
}

/** Ids of PublishJobs with a publish.run or publish.poll still to run. */
async function jobsInFlight(deps: Deps): Promise<Set<string>> {
  const jobs = await deps.queues.queue("ops").getJobs([...LIVE_JOB_STATES]);
  const ids = new Set<string>();
  for (const job of jobs) {
    const data: unknown = job?.data;
    if (
      (job?.name === JOB.publishRun || job?.name === JOB.publishPoll) &&
      data &&
      typeof data === "object" &&
      "publishJobId" in data
    ) {
      ids.add(String(data.publishJobId));
    }
  }
  return ids;
}

async function enqueueRun(
  deps: Deps,
  job: { id: string; attempts: number },
  requeue: RequeueToken | null = null,
): Promise<boolean> {
  try {
    await enqueuePublishRun(
      deps.queues,
      { publishJobId: job.id, attempt: job.attempts + 1 },
      { requeue },
    );
    return true;
  } catch (error) {
    // Left QUEUED without a run: the next tick queues it again.
    deps.logger.warn({ err: error, publishJobId: job.id }, "could not queue publish.run");
    return false;
  }
}

/** A BullMQ job's state by id, or null when there is none (never added, or removed). */
async function runState(deps: Deps, queue: QueueName, id: string): Promise<string | null> {
  const job = await deps.queues.queue(queue).getJob(id);
  if (!job) return null;
  const state = await job.getState();
  return state === "unknown" ? null : state;
}

/** Why the run with this id gave up, as BullMQ kept it. */
async function failedReasonOf(deps: Deps, queue: QueueName, id: string): Promise<string> {
  const job = await deps.queues.queue(queue).getJob(id);
  return job?.failedReason?.trim() || "an unexpected error";
}

async function queueDue(deps: Deps): Promise<number> {
  const due = await deps.prisma.publishJob.updateManyAndReturn({
    where: { status: "SCHEDULED", scheduledFor: { lte: deps.clock.now() } },
    data: { status: "QUEUED" },
    include: { variant: { select: { postId: true } } },
  });
  const events = new EventBatch();
  for (const job of due) publishUpdated(events, job, job.variant.postId);
  await events.publish(deps);
  for (const job of due) await enqueueRun(deps, job);
  return due.length;
}

interface OrphanRow {
  id: string;
  status: PublishStatus;
  attempts: number;
  platform: Platform;
  containerId: string | null;
  variant: { postId: string };
}

/**
 * A QUEUED job with no run in flight. Its run's id is deterministic, and BullMQ ignores an add
 * whose id it still keeps (a failed run for a week), so what to do depends on that run:
 * - none (the enqueue was lost, or the run was removed): queue it;
 * - it gave up (or finished) without starting the job: queue it once more under
 *   RUN_REDRIVE_TOKEN, since what broke it (a database outage, say) may be over;
 * - that one gave up too: FAILED with an alert, for a person to look at and retry, rather than
 *   a job sitting QUEUED for good.
 */
async function redriveQueued(deps: Deps, row: OrphanRow, report: PublishTickReport) {
  const data = { publishJobId: row.id, attempt: row.attempts + 1 };
  const first = await runState(deps, "ops", jobIds.publishRun(data));
  if (first === null) {
    if (await enqueueRun(deps, row)) report.redriven += 1;
    return;
  }
  // Queued after all (a retry racing this tick): a second run of one attempt must never start.
  if (first !== "failed" && first !== "completed") return;
  const sweepId = jobIds.publishRun(data, RUN_REDRIVE_TOKEN);
  const sweep = await runState(deps, "ops", sweepId);
  if (sweep === null) {
    if (await enqueueRun(deps, row, RUN_REDRIVE_TOKEN)) report.redriven += 1;
    return;
  }
  if (sweep !== "failed" && sweep !== "completed") return;
  const reason = sweep === "failed" ? await failedReasonOf(deps, "ops", sweepId) : "it ended early";
  const failed = await failJob(
    deps,
    { jobId: row.id, postId: row.variant.postId, attempt: data.attempt },
    `publishing couldn't start (${clip(reason)}); retry it`,
    { alert: "stuck" },
  );
  if (failed) report.stalled += 1;
}

/** Why a PUBLISHING job nothing works on any more is FAILED, and what a person does about it. */
function stalledMessage(row: OrphanRow): string {
  if (hasUnconfirmedPost(row.containerId)) {
    const label = PLATFORM_LABEL[row.platform];
    return `publishing stalled right after ${label} was sent the post, so it may be live already: check ${label}, then retry to post it again, or cancel the job`;
  }
  return "publishing stalled with nothing left working on it; retry it to resume";
}

/** QUEUED jobs without a run, and PUBLISHING ones nothing is running or polling any more. */
async function driveOrphans(deps: Deps, report: PublishTickReport): Promise<void> {
  // Rows first, queue second: a run that finishes in between has moved its row on.
  const rows = await deps.prisma.publishJob.findMany({
    where: { status: { in: ["QUEUED", "PUBLISHING"] } },
    select: {
      id: true,
      status: true,
      attempts: true,
      platform: true,
      containerId: true,
      variant: { select: { postId: true } },
    },
  });
  if (rows.length === 0) return;
  const inFlight = await jobsInFlight(deps);
  for (const row of rows) {
    if (inFlight.has(row.id)) continue;
    if (row.status === "QUEUED") {
      await redriveQueued(deps, row, report);
      continue;
    }
    const stalled = await failJob(
      deps,
      { jobId: row.id, postId: row.variant.postId, attempt: row.attempts },
      stalledMessage(row),
      { alert: "stuck" },
    );
    if (stalled) report.stalled += 1;
  }
}

/**
 * What became of publisher.schedule for this round: "handled" (queued, running or done), "lost"
 * (never queued, or it failed: queue it once more under SCHEDULE_REDRIVE_TOKEN), or "gave up"
 * (that re-driven job failed too) with BullMQ's reason.
 */
type ScheduleFate = { kind: "handled" } | { kind: "lost" } | { kind: "gaveUp"; reason: string };

async function scheduleFate(deps: Deps, postId: string, round: number): Promise<ScheduleFate> {
  const first = await runState(deps, "agents", jobIds.publisherSchedule({ postId, round }));
  if (first !== null && first !== "failed") return { kind: "handled" };
  const sweepId = jobIds.publisherSchedule({ postId, round }, SCHEDULE_REDRIVE_TOKEN);
  const sweep = await runState(deps, "agents", sweepId);
  if (sweep === null) return { kind: "lost" };
  if (sweep !== "failed") return { kind: "handled" };
  return { kind: "gaveUp", reason: await failedReasonOf(deps, "agents", sweepId) };
}

/**
 * The post's schedule gave up twice: flagged with an alert, so people see it and pick its days on
 * the calendar, and tick.publish stops looking at it (it only re-drives posts not flagged).
 */
async function flagUnscheduled(deps: Deps, postId: string, reason: string): Promise<void> {
  const events = new EventBatch();
  await deps.prisma.$transaction(async (tx) => {
    await lockPost(tx, postId);
    const [post] = await tx.post.updateManyAndReturn({
      where: { id: postId, status: "APPROVED", needsAttention: false },
      data: {
        needsAttention: true,
        attentionReason: clip(`${UNSCHEDULED_ATTENTION_PREFIXES[1]}${reason}`, 500),
      },
    });
    if (!post) return;
    postUpdated(events, post);
    events.alert({
      kind: "failed",
      entityType: "Post",
      entityId: post.id,
      message: `The Publisher couldn't schedule ${post.ref}: ${clip(reason)}. Pick its days on the calendar.`,
      clientId: post.clientId,
      campaignId: post.campaignId,
    });
  });
  await events.publish(deps);
}

/**
 * APPROVED posts that nothing ever scheduled on their approved round: the post-commit enqueue was
 * lost (Redis down) or its job failed. A round that did schedule leaves jobs behind that are
 * still waiting, out, or cancelled by a person, so a teammate's cancel is never undone here.
 */
async function redriveLostSchedules(deps: Deps): Promise<number> {
  const cutoff = new Date(deps.clock.now().getTime() - SCHEDULE_REDRIVE_AFTER_MS);
  const posts = await deps.prisma.post.findMany({
    where: {
      status: "APPROVED",
      needsAttention: false,
      approvedAt: { lte: cutoff },
      campaign: { status: { not: "ARCHIVED" } },
      client: { archivedAt: null },
    },
    select: {
      id: true,
      approvalRequests: {
        orderBy: { round: "desc" },
        take: 1,
        select: { round: true, status: true },
      },
      variants: { select: { publishJob: { select: { status: true, lastError: true } } } },
    },
  });
  let count = 0;
  for (const post of posts) {
    const round = post.approvalRequests[0];
    if (round?.status !== "APPROVED") continue;
    const jobs = post.variants.flatMap((variant) =>
      variant.publishJob ? [variant.publishJob] : [],
    );
    const scheduledThisRound = jobs.some(
      (job) => job.status !== "CANCELLED" || !LIFECYCLE_CANCEL_MESSAGES.has(job.lastError ?? ""),
    );
    if (scheduledThisRound) continue;
    const fate = await scheduleFate(deps, post.id, round.round);
    if (fate.kind === "handled") continue;
    if (fate.kind === "gaveUp") {
      await flagUnscheduled(deps, post.id, fate.reason);
      continue;
    }
    try {
      await enqueuePublisherSchedule(
        deps.queues,
        { postId: post.id, round: round.round },
        { requeue: SCHEDULE_REDRIVE_TOKEN },
      );
      count += 1;
    } catch (error) {
      deps.logger.warn({ err: error, postId: post.id }, "could not re-queue publisher.schedule");
    }
  }
  return count;
}

/** tick.publish. */
export async function publishTick(deps: Deps): Promise<PublishTickReport> {
  const report: PublishTickReport = { queued: 0, redriven: 0, stalled: 0, rescheduled: 0 };
  report.queued = await queueDue(deps);
  await driveOrphans(deps, report);
  report.rescheduled = await redriveLostSchedules(deps);
  return report;
}
