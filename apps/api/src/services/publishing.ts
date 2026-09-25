import type { DbTransaction, Prisma, PublishJob } from "@enmo/db";
import { withoutPostingMarker } from "@enmo/providers";
import {
  AUDIT_ACTIONS,
  CANCELLABLE_PUBLISH_STATUSES,
  PLATFORM_LABEL,
  platformVariantFormat,
  RESCHEDULABLE_PUBLISH_STATUSES,
  RETRYABLE_PUBLISH_STATUSES,
  SlotSource,
  type KnownAuditAction,
  type PostStatus,
  type PublishJobDto,
  type PublishStatus,
  type SchedulePublishJobBody,
} from "@enmo/shared";
import type { Deps } from "../deps";
import { enqueuePublishRun } from "../jobs/queues";
import { calendarDay } from "../lib/clock";
import { conflict, notFound, unprocessable } from "../lib/errors";
import { parseStored } from "../lib/stored";
import { afterCommit } from "../orchestrator/after-commit";
import { lockReopenableRounds } from "../orchestrator/approval-round";
import { EventBatch } from "../orchestrator/events";
import { lockPost } from "../orchestrator/locks";
import { postUpdated } from "../orchestrator/post-status";
import { publishUpdated, syncPostPublishStatus } from "../orchestrator/publishing";
import { activeAccountOf, copyOf, currentTakesOf } from "../publishing/context";
import { announceLive } from "../publishing/outcomes";
import { isUnscheduledAttention, variantProblem } from "../publishing/schedule";
import { bestSlotOn } from "../publishing/slot-optimizer";
import type { ServiceUser } from "./actor";
import { recordAudit } from "./audit";
import { publishingAccountUnchosen } from "./social-accounts";

export { listCalendar } from "./calendar";

/*
 * The publish-job controls behind the calendar (DESIGN §E "calendar", §F "Slot optimizer"):
 *   schedule    a platform of an approved post with nothing scheduled there onto the best free
 *               hour of a client-local day (the Publisher keeps to the campaign window; a day
 *               outside it is a teammate's call), audited publish.schedule
 *   reschedule  a SCHEDULED job to the best free hour of a client-local day (slot-optimizer
 *               bestSlotOn, no LLM call; slotSource "manual"), audited publish.reschedule
 *   retry       a FAILED job QUEUED again for its next attempt with a publish.run, going out now;
 *               publish.run re-runs the publish guard, audited publish.retry
 *   cancel      a job that hasn't started publishing, or that failed, CANCELLED, audited
 *               publish.cancel
 * Each runs under the post's lock (the one publish.run and every edit take), re-checks the job's
 * status in its conditional update, emits publish.updated and lets syncPostPublishStatus move the
 * post along (a cancel of its last job leaves it APPROVED, a retry takes it out of FAILED, and
 * dropping a failed platform while the rest is out makes it LIVE).
 */

const AUDITED_ENTITY = "PublishJob";

/** Post statuses that follow their publish jobs; any other means it went back to approval. */
const PUBLISHING_POST_STATUSES: ReadonlySet<PostStatus> = new Set([
  "APPROVED",
  "SCHEDULED",
  "PUBLISHING",
  "LIVE",
  "FAILED",
]);

const JOB_DTO_INCLUDE = {
  variant: {
    select: {
      postId: true,
      post: {
        select: {
          campaignId: true,
          clientId: true,
          type: true,
          status: true,
          campaign: { select: { status: true } },
          client: { select: { timezone: true, archivedAt: true } },
        },
      },
    },
  },
} as const satisfies Prisma.PublishJobInclude;

type JobRow = Prisma.PublishJobGetPayload<{ include: typeof JOB_DTO_INCLUDE }>;

const iso = (date: Date | null) => date?.toISOString() ?? null;

export function toPublishJobDto(row: JobRow): PublishJobDto {
  const { post } = row.variant;
  return {
    id: row.id,
    variantId: row.variantId,
    postId: row.variant.postId,
    campaignId: post.campaignId,
    clientId: post.clientId,
    platform: row.platform,
    postType: post.type,
    status: row.status,
    scheduledFor: row.scheduledFor.toISOString(),
    date: calendarDay(row.scheduledFor, post.client.timezone),
    timezone: post.client.timezone,
    slotSource: parseStored(SlotSource, row.slotSource, `PublishJob ${row.id}.slotSource`),
    slotReason: row.slotReason,
    dryRun: row.dryRun,
    attempts: row.attempts,
    socialAccountId: row.socialAccountId,
    externalId: row.externalId,
    liveUrl: row.liveUrl,
    lastError: row.lastError,
    publishedAt: iso(row.publishedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadJob(tx: DbTransaction, jobId: string): Promise<JobRow | null> {
  return tx.publishJob.findUnique({ where: { id: jobId }, include: JOB_DTO_INCLUDE });
}

const STATUS_WORDS: Readonly<Record<PublishStatus, string>> = {
  SCHEDULED: "is scheduled",
  QUEUED: "is queued to publish",
  PUBLISHING: "is publishing right now",
  PUBLISHED: "is already published",
  FAILED: "failed",
  CANCELLED: "was cancelled",
};

function wrongStatus(job: Pick<PublishJob, "platform" | "status">, action: string): Error {
  const what = `This ${PLATFORM_LABEL[job.platform]} job ${STATUS_WORDS[job.status]}`;
  return conflict(`${what}, so it can't be ${action}`, { status: job.status });
}

interface Change {
  /** The job as it ends up. */
  job: PublishJob;
  audit: { action: KnownAuditAction; data: Prisma.InputJsonObject };
}

/**
 * The shared frame of the three controls: one transaction holding the post's lock, in which
 * `change` re-reads the job and writes it (or throws CONFLICT); then publish.updated, the post's
 * status brought in line, and the audit row, with the events published once it commits.
 */
async function changeJob(
  deps: Deps,
  user: ServiceUser,
  jobId: string,
  change: (tx: DbTransaction, job: JobRow) => Promise<Change>,
): Promise<PublishJobDto> {
  const head = await deps.prisma.publishJob.findUnique({
    where: { id: jobId },
    select: { variant: { select: { postId: true } } },
  });
  if (!head) throw notFound("Publish job");
  const { postId } = head.variant;

  const events = new EventBatch();
  const dto = await deps.prisma.$transaction(async (tx) => {
    await lockPost(tx, postId);
    const job = await loadJob(tx, jobId);
    if (!job) throw notFound("Publish job");
    const { job: changed, audit } = await change(tx, job);
    publishUpdated(events, changed, postId);
    const moved = await syncPostPublishStatus(tx, events, postId);
    if (moved?.status === "LIVE") await announceLive(tx, events, postId);
    await recordAudit(tx, {
      actorId: user.id,
      ip: user.ip,
      action: audit.action,
      entityType: AUDITED_ENTITY,
      entityId: jobId,
      data: { postId, platform: job.platform, ...audit.data },
    });
    const updated = await loadJob(tx, jobId);
    if (!updated) throw notFound("Publish job");
    return toPublishJobDto(updated);
  });
  await afterCommit(deps, "announcing the publish job change", () => events.publish(deps));
  return dto;
}

/**
 * The job's row after a conditional update, or CONFLICT naming the status it moved to meanwhile
 * (tick.publish queues due jobs without the post's lock).
 */
async function expectUpdated(
  tx: DbTransaction,
  rows: PublishJob[],
  job: Pick<PublishJob, "id" | "platform" | "status">,
  action: string,
): Promise<PublishJob> {
  const [row] = rows;
  if (row) return row;
  const now = await tx.publishJob.findUnique({ where: { id: job.id }, select: { status: true } });
  throw wrongStatus({ platform: job.platform, status: now?.status ?? job.status }, action);
}

/** Post statuses a platform can still be scheduled from: approved, and none of it out yet. */
const SCHEDULABLE_POST_STATUSES: ReadonlySet<PostStatus> = new Set(["APPROVED", "SCHEDULED"]);

/** Every platform of the post that takes its type has a job that counts (not CANCELLED). */
async function fullyScheduled(tx: DbTransaction, postId: string): Promise<boolean> {
  const post = await tx.post.findUniqueOrThrow({
    where: { id: postId },
    select: {
      type: true,
      platforms: true,
      variants: { select: { platform: true, publishJob: { select: { status: true } } } },
    },
  });
  return post.platforms.every((platform) => {
    if (platformVariantFormat(post.type, platform) === null) return true;
    const job = post.variants.find((variant) => variant.platform === platform)?.publishJob;
    return job != null && job.status !== "CANCELLED";
  });
}

/**
 * POST /publish-jobs {postId, platform, date}: a platform of an approved post with nothing
 * scheduled there, put at the best free hour of `date` in the client's calendar (bestSlotOn, no
 * LLM; slotSource "manual"). This is how a post the Publisher couldn't place inside its campaign
 * window (full, or already over) goes out: the day, even one outside the window, is the teammate's
 * call. The variant is checked as the Publisher checks it (publishing rules, banned words), and
 * scheduling the post's last unscheduled platform answers the Publisher's flag. Audited
 * publish.schedule. CONFLICT unless the post stands approved with nothing of it out and the
 * platform has no job that counts, or when the day has no free slot; UNPROCESSABLE when the
 * variant can't go out; NOT_FOUND when the post is missing.
 */
export async function schedule(
  deps: Deps,
  user: ServiceUser,
  input: SchedulePublishJobBody,
): Promise<PublishJobDto> {
  const { postId, platform, date } = input;
  const label = PLATFORM_LABEL[platform];
  const events = new EventBatch();
  const dto = await deps.prisma.$transaction(async (tx) => {
    await lockReopenableRounds(tx, postId);
    await lockPost(tx, postId);
    const post = await tx.post.findUnique({
      where: { id: postId },
      include: {
        client: { select: { timezone: true, bannedWords: true, archivedAt: true } },
        campaign: { select: { status: true } },
        approvalRequests: { orderBy: { round: "desc" }, take: 1, select: { status: true } },
        variants: { where: { platform }, include: { publishJob: true } },
      },
    });
    if (!post) throw notFound("Post");
    if (post.campaign.status === "ARCHIVED" || post.client.archivedAt) {
      throw conflict(
        `The ${post.client.archivedAt ? "client" : "campaign"} is archived, so nothing of it publishes any more`,
      );
    }
    if (!SCHEDULABLE_POST_STATUSES.has(post.status) || post.approvalRequests[0]?.status !== "APPROVED") {
      throw conflict(
        `Only an approved post with nothing out yet can be scheduled; this one is ${post.status.toLowerCase().replace(/_/g, " ")}`,
        { postStatus: post.status },
      );
    }
    if (!post.platforms.includes(platform) || !platformVariantFormat(post.type, platform)) {
      throw conflict(`This post isn't going to ${label}`, { platform });
    }
    const [variant] = post.variants;
    if (!variant) {
      throw conflict(
        `The Publisher hasn't prepared this post for ${label} yet; try again in a minute`,
        { platform },
      );
    }
    const current = variant.publishJob;
    if (current && current.status !== "CANCELLED") {
      throw conflict(`This post is already scheduled on ${label}; move that job instead`, {
        jobId: current.id,
        status: current.status,
      });
    }
    const copy = copyOf(post);
    const problem = copy
      ? variantProblem(deps, {
          platform,
          postType: post.type,
          variantId: variant.id,
          caption: variant.caption,
          hashtags: variant.hashtags,
          copy,
          takes: await currentTakesOf(tx, post.id),
          bannedWords: post.client.bannedWords,
        })
      : "the post has no copy to publish";
    if (problem) throw unprocessable(`It can't go out on ${label}: ${problem}`, { platform });

    const now = deps.clock.now();
    const slot = await bestSlotOn(
      tx,
      { clientId: post.clientId, platform, timezone: post.client.timezone, now },
      date,
    );
    if (!slot) {
      throw conflict(
        `${date} has no free ${label} slot left for this client (${post.client.timezone}); pick another day`,
        { date },
      );
    }
    const account = await activeAccountOf(tx, post.clientId, platform);
    const liveMode = deps.publishers[platform].mode === "live";
    if (liveMode && !account && (await publishingAccountUnchosen(tx, post.clientId, platform))) {
      throw conflict(
        `Several ${label} accounts are connected to this client and none is chosen to publish through; choose one in the client's accounts first`,
        { platform },
      );
    }
    const fields = {
      socialAccountId: account?.id ?? null,
      platform,
      status: "SCHEDULED" as const,
      scheduledFor: new Date(slot.slotStart),
      slotSource: "manual" satisfies SlotSource,
      slotReason: `Scheduled on ${date} by ${user.name}, at the day's best free hour. ${slot.reasons.join(". ")}`,
      // A forecast: the claim settles it with the mode and account there are at the slot.
      dryRun: !liveMode || !account,
      // Never back to an attempt whose run id BullMQ may still hold (see publisher.schedule).
      attempts: current ? current.attempts + 1 : 0,
      containerId: null,
      externalId: null,
      liveUrl: null,
      lastError: null,
      publishedAt: null,
    };
    const job = current
      ? await tx.publishJob.update({ where: { id: current.id }, data: fields })
      : await tx.publishJob.create({ data: { variantId: variant.id, ...fields } });
    publishUpdated(events, job, postId);
    await syncPostPublishStatus(tx, events, postId);
    if (
      post.needsAttention &&
      isUnscheduledAttention(post.attentionReason) &&
      (await fullyScheduled(tx, postId))
    ) {
      const answered = await tx.post.update({
        where: { id: postId },
        data: { needsAttention: false, attentionReason: null },
      });
      postUpdated(events, answered);
    }
    await recordAudit(tx, {
      actorId: user.id,
      ip: user.ip,
      action: AUDIT_ACTIONS.publishSchedule,
      entityType: AUDITED_ENTITY,
      entityId: job.id,
      data: { postId, platform, date, to: job.scheduledFor.toISOString(), score: slot.score },
    });
    const stored = await loadJob(tx, job.id);
    if (!stored) throw notFound("Publish job");
    return toPublishJobDto(stored);
  });
  await afterCommit(deps, "announcing the scheduled job", () => events.publish(deps));
  return dto;
}

/**
 * PATCH /publish-jobs/:id {date}: the best free hour of `date` in the client's calendar.
 * CONFLICT unless the job is RESCHEDULABLE or the day has a free slot; NOT_FOUND when missing.
 */
export function reschedule(
  deps: Deps,
  user: ServiceUser,
  jobId: string,
  date: string,
): Promise<PublishJobDto> {
  return changeJob(deps, user, jobId, async (tx, job) => {
    if (!RESCHEDULABLE_PUBLISH_STATUSES.includes(job.status)) throw wrongStatus(job, "moved");
    const { post } = job.variant;
    const slot = await bestSlotOn(
      tx,
      {
        clientId: post.clientId,
        platform: job.platform,
        timezone: post.client.timezone,
        now: deps.clock.now(),
        excludeJobId: job.id,
      },
      date,
    );
    if (!slot) {
      throw conflict(
        `${date} has no free ${PLATFORM_LABEL[job.platform]} slot left for this client (${post.client.timezone}); pick another day`,
        { date },
      );
    }
    const scheduledFor = new Date(slot.slotStart);
    const rows = await tx.publishJob.updateManyAndReturn({
      where: { id: job.id, status: { in: [...RESCHEDULABLE_PUBLISH_STATUSES] } },
      data: {
        scheduledFor,
        // The day is the teammate's call; the optimizer only picks its hour.
        slotSource: "manual" satisfies SlotSource,
        slotReason: `Moved to ${date} by ${user.name}, at the day's best free hour. ${slot.reasons.join(". ")}`,
      },
    });
    return {
      job: await expectUpdated(tx, rows, job, "moved"),
      audit: {
        action: AUDIT_ACTIONS.publishReschedule,
        data: {
          date,
          from: job.scheduledFor.toISOString(),
          to: scheduledFor.toISOString(),
          score: slot.score,
        },
      },
    };
  });
}

/**
 * POST /publish-jobs/:id/retry: the job QUEUED for its next attempt, going out now (its slot moves
 * to now when it has passed, as a teammate's call), and a publish.run queued once it commits; a
 * lost enqueue is re-driven by tick.publish. A live job whose account was disconnected takes the
 * client's current account on the platform. The retry is the teammate's word that the platform
 * doesn't have the post: a publishing call that went out unanswered may go out again. CONFLICT
 * unless the job is RETRYABLE and its post still stands approved; NOT_FOUND when missing.
 */
export async function retry(deps: Deps, user: ServiceUser, jobId: string): Promise<PublishJobDto> {
  const dto = await changeJob(deps, user, jobId, async (tx, job) => {
    if (!RETRYABLE_PUBLISH_STATUSES.includes(job.status)) throw wrongStatus(job, "retried");
    const { post } = job.variant;
    if (!PUBLISHING_POST_STATUSES.has(post.status)) {
      throw conflict(
        "The post went back to approval after this job failed; it gets scheduled again once it's approved",
        { postStatus: post.status },
      );
    }
    if (post.campaign.status === "ARCHIVED" || post.client.archivedAt) {
      throw conflict(
        `The ${post.client.archivedAt ? "client" : "campaign"} is archived, so nothing of it publishes any more`,
      );
    }
    const now = deps.clock.now();
    const account =
      !job.dryRun && job.socialAccountId === null
        ? await activeAccountOf(tx, post.clientId, job.platform)
        : null;
    const moved = job.scheduledFor.getTime() < now.getTime();
    const rows = await tx.publishJob.updateManyAndReturn({
      where: { id: job.id, status: { in: [...RETRYABLE_PUBLISH_STATUSES] } },
      data: {
        status: "QUEUED",
        lastError: null,
        // A teammate retrying has checked the platform: a publishing call that went out
        // unanswered may be sent again (the resumed container keeps everything else).
        ...(job.containerId ? { containerId: withoutPostingMarker(job.containerId) } : {}),
        ...(account ? { socialAccountId: account.id } : {}),
        ...(moved
          ? {
              scheduledFor: now,
              slotSource: "manual" satisfies SlotSource,
              slotReason: `Retried by ${user.name}: publishing now.`,
            }
          : {}),
      },
    });
    return {
      job: await expectUpdated(tx, rows, job, "retried"),
      audit: {
        action: AUDIT_ACTIONS.publishRetry,
        data: {
          attempt: job.attempts + 1,
          previousError: job.lastError,
          ...(account ? { socialAccountId: account.id } : {}),
        },
      },
    };
  });
  await afterCommit(deps, "queueing the publish retry", () =>
    enqueuePublishRun(deps.queues, { publishJobId: dto.id, attempt: dto.attempts + 1 }),
  );
  return dto;
}

/**
 * POST /publish-jobs/:id/cancel: a waiting job called off, or a failed one dropped (a platform that
 * keeps refusing the post), so the post settles on its other variants. CONFLICT unless the job is
 * CANCELLABLE; NOT_FOUND when missing.
 */
export function cancel(deps: Deps, user: ServiceUser, jobId: string): Promise<PublishJobDto> {
  return changeJob(deps, user, jobId, async (tx, job) => {
    if (!CANCELLABLE_PUBLISH_STATUSES.includes(job.status)) throw wrongStatus(job, "cancelled");
    const rows = await tx.publishJob.updateManyAndReturn({
      where: { id: job.id, status: { in: [...CANCELLABLE_PUBLISH_STATUSES] } },
      // Not one of the lifecycle reasons: tick.publish never schedules a person's cancel again.
      data: { status: "CANCELLED", lastError: `Cancelled by ${user.name}` },
    });
    return {
      job: await expectUpdated(tx, rows, job, "cancelled"),
      audit: {
        action: AUDIT_ACTIONS.publishCancel,
        data: {
          previousStatus: job.status,
          scheduledFor: job.scheduledFor.toISOString(),
          // The cancel's own message replaces it on the job; the audit keeps why it failed.
          ...(job.lastError ? { previousError: job.lastError } : {}),
        },
      },
    };
  });
}
