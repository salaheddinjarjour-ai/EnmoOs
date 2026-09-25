import type { DbTransaction, Prisma, PublishJob } from "@enmo/db";
import {
  AUDIT_ACTIONS,
  CANCELLABLE_PUBLISH_STATUSES,
  PLATFORM_LABEL,
  RESCHEDULABLE_PUBLISH_STATUSES,
  RETRYABLE_PUBLISH_STATUSES,
  SlotSource,
  type KnownAuditAction,
  type PostStatus,
  type PublishJobDto,
  type PublishStatus,
} from "@enmo/shared";
import type { Deps } from "../deps";
import { enqueuePublishRun } from "../jobs/queues";
import { calendarDay } from "../lib/clock";
import { conflict, notFound } from "../lib/errors";
import { parseStored } from "../lib/stored";
import { afterCommit } from "../orchestrator/after-commit";
import { EventBatch } from "../orchestrator/events";
import { lockPost } from "../orchestrator/locks";
import { publishUpdated, syncPostPublishStatus } from "../orchestrator/publishing";
import { bestSlotOn } from "../publishing/slot-optimizer";
import type { ServiceUser } from "./actor";
import { recordAudit } from "./audit";

export { listCalendar } from "./calendar";

/*
 * The publish-job controls behind the calendar (DESIGN §E "calendar", §F "Slot optimizer"):
 *   reschedule  a SCHEDULED job to the best free hour of a client-local day (slot-optimizer
 *               bestSlotOn, no LLM call; slotSource "manual"), audited publish.reschedule
 *   retry       a FAILED job QUEUED again for its next attempt with a publish.run, going out now;
 *               publish.run re-runs the publish guard, audited publish.retry
 *   cancel      a job that hasn't started publishing CANCELLED, audited publish.cancel
 * Each runs under the post's lock (the one publish.run and every edit take), re-checks the job's
 * status in its conditional update, emits publish.updated and lets syncPostPublishStatus move the
 * post along (a cancel of its last job leaves it APPROVED, a retry takes it out of FAILED).
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
          client: { select: { timezone: true } },
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
    await syncPostPublishStatus(tx, events, postId);
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
 * client's current account on the platform. CONFLICT unless the job is RETRYABLE and its post
 * still stands approved; NOT_FOUND when missing.
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
    const now = deps.clock.now();
    const account =
      !job.dryRun && job.socialAccountId === null
        ? await tx.socialAccount.findFirst({
            where: { clientId: post.clientId, platform: job.platform, status: "ACTIVE" },
            orderBy: { createdAt: "desc" },
            select: { id: true },
          })
        : null;
    const moved = job.scheduledFor.getTime() < now.getTime();
    const rows = await tx.publishJob.updateManyAndReturn({
      where: { id: job.id, status: { in: [...RETRYABLE_PUBLISH_STATUSES] } },
      data: {
        status: "QUEUED",
        lastError: null,
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

/** POST /publish-jobs/:id/cancel. CONFLICT unless the job is CANCELLABLE; NOT_FOUND when missing. */
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
        data: { previousStatus: job.status, scheduledFor: job.scheduledFor.toISOString() },
      },
    };
  });
}
