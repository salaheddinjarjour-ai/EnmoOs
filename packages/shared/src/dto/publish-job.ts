import { z } from "zod";
import { Platform, PostType, PublishStatus } from "../enums";
import { Id, IsoDate, IsoDateTime } from "./common";

/*
 * Publish jobs (DESIGN §B PublishJob, §E "calendar"). One job per post variant: it is SCHEDULED at
 * a slot, the publish tick QUEUEs it when the slot comes, the publisher takes it through
 * PUBLISHING to PUBLISHED (with its live URL) or FAILED. Any edit after approval CANCELLED it.
 */

/** Who picked PublishJob.scheduledFor. */
export const SlotSource = z.enum([
  /** The Publisher agent chose among the optimizer's candidates. */
  "publisher",
  /** The optimizer's top candidate (the Publisher failed, or the slot it picked was taken meanwhile). */
  "optimizer",
  /**
   * A teammate moved it: a calendar drag (they chose the day, the optimizer that day's best free
   * hour) or a retry after its slot had passed (now).
   */
  "manual",
]);
export type SlotSource = z.infer<typeof SlotSource>;

/** Only a job still waiting for its slot can be moved (the calendar drags only these). */
export const RESCHEDULABLE_PUBLISH_STATUSES: readonly PublishStatus[] = ["SCHEDULED"];
/** A job that hasn't started publishing can be called off. */
export const CANCELLABLE_PUBLISH_STATUSES: readonly PublishStatus[] = ["SCHEDULED", "QUEUED"];
/** A failed job can be tried again (it resumes its media container when it has one). */
export const RETRYABLE_PUBLISH_STATUSES: readonly PublishStatus[] = ["FAILED"];

export const PublishJobDto = z.object({
  id: Id,
  variantId: Id,
  postId: Id,
  campaignId: Id,
  clientId: Id,
  platform: Platform,
  postType: PostType,
  status: PublishStatus,
  scheduledFor: IsoDateTime,
  /** scheduledFor's day in the client's time zone (the calendar cell it sits in). */
  date: IsoDate,
  /** The client's IANA time zone. */
  timezone: z.string(),
  slotSource: SlotSource,
  slotReason: z.string().nullable(),
  /** Simulated: validated like a real publish, with a https://dryrun.enmo.marketing/… live URL. */
  dryRun: z.boolean(),
  attempts: z.int().nonnegative(),
  /** Null only in dry-run. */
  socialAccountId: Id.nullable(),
  /** The platform's id of the published media. */
  externalId: z.string().nullable(),
  liveUrl: z.string().nullable(),
  lastError: z.string().nullable(),
  publishedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PublishJobDto = z.infer<typeof PublishJobDto>;

/**
 * PATCH /v1/publish-jobs/:id → PublishJobDto. Moves a SCHEDULED job to the best free hour of
 * `date` (a day in the client's calendar), picked by the slot optimizer without an LLM call
 * (slotSource "manual": the day was a teammate's call). 409 when the job can't move or the day
 * has no free slot.
 */
export const ReschedulePublishJobBody = z.object({
  date: IsoDate,
});
export type ReschedulePublishJobBody = z.infer<typeof ReschedulePublishJobBody>;

export const ReschedulePublishJobResponse = PublishJobDto;
export type ReschedulePublishJobResponse = PublishJobDto;

/** POST /v1/publish-jobs/:id/retry → the job, QUEUED again (409 unless it FAILED). */
export const RetryPublishJobResponse = PublishJobDto;
export type RetryPublishJobResponse = PublishJobDto;

/** POST /v1/publish-jobs/:id/cancel → the job, CANCELLED (409 once it started publishing). */
export const CancelPublishJobResponse = PublishJobDto;
export type CancelPublishJobResponse = PublishJobDto;
