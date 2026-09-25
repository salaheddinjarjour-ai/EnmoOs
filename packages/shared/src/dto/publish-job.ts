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
   * A teammate's call: a calendar drag, or a platform nothing was scheduled on put on a day (they
   * chose the day, the optimizer that day's best free hour), or a retry after its slot had passed
   * (now).
   */
  "manual",
]);
export type SlotSource = z.infer<typeof SlotSource>;

/** Only a job still waiting for its slot can be moved (the calendar drags only these). */
export const RESCHEDULABLE_PUBLISH_STATUSES: readonly PublishStatus[] = ["SCHEDULED"];
/** Jobs waiting for their slot or their run: what reopening a post's approval calls off. */
export const WAITING_PUBLISH_STATUSES: readonly PublishStatus[] = ["SCHEDULED", "QUEUED"];
/**
 * What a teammate can call off: a job that hasn't started publishing, or one that failed, so a
 * platform that keeps refusing the post can be dropped and the post settle on the rest (LIVE when
 * they are out, APPROVED and editable again when nothing is).
 */
export const CANCELLABLE_PUBLISH_STATUSES: readonly PublishStatus[] = [
  ...WAITING_PUBLISH_STATUSES,
  "FAILED",
];
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
  /**
   * Simulated: validated like a real publish, with a https://dryrun.enmo.marketing/… live URL.
   * Forecast when the job is scheduled, then settled when it starts publishing, from the publish
   * mode and the client's account at that moment.
   */
  dryRun: z.boolean(),
  /**
   * Publish runs over the job's whole life. Never reset when the job is scheduled again, so each
   * run keeps a queue id of its own.
   */
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

/**
 * POST /v1/publish-jobs → PublishJobDto (201). Schedules one platform of an approved post that has
 * nothing scheduled there (the Publisher found no free slot inside the campaign window, the window
 * had passed, or its job was cancelled) at the best free hour of `date` in the client's calendar,
 * picked by the slot optimizer (slotSource "manual"): the day may lie outside the campaign window,
 * as a teammate's decision. 409 when the post can't be scheduled there or the day has no free slot,
 * 422 when the post breaks the platform's publishing rules.
 */
export const SchedulePublishJobBody = z.object({
  postId: Id,
  platform: Platform,
  date: IsoDate,
});
export type SchedulePublishJobBody = z.infer<typeof SchedulePublishJobBody>;

export const SchedulePublishJobResponse = PublishJobDto;
export type SchedulePublishJobResponse = PublishJobDto;

/** POST /v1/publish-jobs/:id/retry → the job, QUEUED again (409 unless it FAILED). */
export const RetryPublishJobResponse = PublishJobDto;
export type RetryPublishJobResponse = PublishJobDto;

/** POST /v1/publish-jobs/:id/cancel → the job, CANCELLED (409 once it started publishing). */
export const CancelPublishJobResponse = PublishJobDto;
export type CancelPublishJobResponse = PublishJobDto;
