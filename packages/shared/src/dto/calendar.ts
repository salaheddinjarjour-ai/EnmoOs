import { z } from "zod";
import { Platform, PostStatus, PostType, PublishStatus } from "../enums";
import { Id, IsoDate, IsoDateTime } from "./common";
import { SlotSource } from "./publish-job";

/*
 * The calendar (DESIGN §E "calendar", §G MonthGrid): every client's publish jobs across a range of
 * days, plus ghost slots for planned posts that have no job yet. Each item sits on a day of its
 * client's calendar (`date`, in `timezone`): the day a drag reschedules to is the same kind of day.
 */

/** A month grid spans six weeks; a little more is allowed, not arbitrarily wide scans. */
export const CALENDAR_RANGE_MAX_DAYS = 62;

const DAY_MS = 86_400_000;

function daySpan(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** GET /v1/calendar: days `from` to `to` inclusive, all clients unless `clientId` names one. */
export const CalendarQuery = z
  .object({
    from: IsoDate,
    to: IsoDate,
    clientId: Id.optional(),
  })
  .refine((query) => query.from <= query.to, {
    message: "`to` can't be before `from`",
    path: ["to"],
  })
  .refine((query) => daySpan(query.from, query.to) < CALENDAR_RANGE_MAX_DAYS, {
    message: `At most ${CALENDAR_RANGE_MAX_DAYS} days at a time`,
    path: ["to"],
  });
export type CalendarQuery = z.infer<typeof CalendarQuery>;

const CalendarItemBase = z.object({
  postId: Id,
  campaignId: Id,
  clientId: Id,
  clientName: z.string(),
  platform: Platform,
  postType: PostType,
  /** The day it sits on, in the client's calendar. */
  date: IsoDate,
  /** The client's IANA time zone. */
  timezone: z.string(),
  /** Short label for the cell: the post's hook, else its angle, else its ref. */
  title: z.string(),
  /** The post's first current take (poster for video); null until one is ready. */
  thumbUrl: z.string().nullable(),
});

/** A variant's PublishJob, scheduled or done. */
export const CalendarJobItem = CalendarItemBase.extend({
  kind: z.literal("job"),
  /** The PublishJob id (PATCH/POST /v1/publish-jobs/:id). */
  id: Id,
  variantId: Id,
  status: PublishStatus,
  scheduledFor: IsoDateTime,
  publishedAt: IsoDateTime.nullable(),
  liveUrl: z.string().nullable(),
  dryRun: z.boolean(),
  slotSource: SlotSource,
  slotReason: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type CalendarJobItem = z.infer<typeof CalendarJobItem>;

/**
 * A planned post on one of its platforms with no job yet: its targetDate from the plan, drawn
 * dashed at 40% opacity and never draggable.
 */
export const CalendarGhostItem = CalendarItemBase.extend({
  kind: z.literal("ghost"),
  /** `ghost:<postId>:<platform>`, stable across refetches. */
  id: z.string(),
  postStatus: PostStatus,
});
export type CalendarGhostItem = z.infer<typeof CalendarGhostItem>;

export function calendarGhostId(postId: string, platform: Platform): string {
  return `ghost:${postId}:${platform}`;
}

export const CalendarItemDto = z.discriminatedUnion("kind", [CalendarJobItem, CalendarGhostItem]);
export type CalendarItemDto = z.infer<typeof CalendarItemDto>;

/** Items ordered by date, then time (jobs by scheduledFor, ghosts after the day's jobs). */
export const CalendarResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  items: z.array(CalendarItemDto),
});
export type CalendarResponse = z.infer<typeof CalendarResponse>;
