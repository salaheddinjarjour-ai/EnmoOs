import {
  CANCELLABLE_PUBLISH_STATUSES,
  PLATFORM_LABEL,
  RESCHEDULABLE_PUBLISH_STATUSES,
  RETRYABLE_PUBLISH_STATUSES,
  type CalendarItemDto,
  type CalendarJobItem,
  type CalendarQuery,
  type CalendarResponse,
  type PublishJobDto,
  type SlotSource,
} from "@enmo/shared";
import { publishMark, type PublishMarkStatus } from "@/components/post/publishing";
import { formatDayTimeIn, formatTimeIn, joined, partsOf } from "./zoned-time";

export { formatDayTimeIn, formatTimeIn, viewerTimeZone } from "./zoned-time";

/*
 * The calendar's view model (DESIGN §E "calendar", §G MonthGrid, MASTER_PLAN §03 Calendar): the
 * month grid and the range it asks GET /calendar for, where each item sits (its client-local day,
 * or the day a drag is moving it to), how its time reads in the client's zone and the viewer's,
 * and the cache patch a finished reschedule applies. Days are ISO calendar dates ("2026-10-01"),
 * computed in UTC so no viewer time zone can shift them. Pure, so it is unit-tested.
 */

const DAY_MS = 86_400_000;
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** A month as the address carries it: "2026-10". */
export type MonthKey = string;

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

function dayMs(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00Z`);
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  return isoDay(dayMs(isoDate) + days * DAY_MS);
}

/** Monday = 0 … Sunday = 6 (the grid starts its weeks on Monday, ISO style). */
function mondayIndex(isoDate: string): number {
  return (new Date(dayMs(isoDate)).getUTCDay() + 6) % 7;
}

/** The viewer's own calendar day: where the today marker goes. */
export function viewerToday(now: Date = new Date()): string {
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function monthOf(isoDate: string): MonthKey {
  return isoDate.slice(0, 7);
}

/** A well-formed "YYYY-MM", else null. */
export function parseMonth(value: string | null | undefined): MonthKey | null {
  return value && MONTH_PATTERN.test(value) ? value : null;
}

export function shiftMonth(month: MonthKey, delta: number): MonthKey {
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  const index = year * 12 + (monthNumber - 1) + delta;
  return `${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1)}`;
}

function lastDayOf(month: MonthKey): string {
  return addDays(`${shiftMonth(month, 1)}-01`, -1);
}

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export interface MonthGrid {
  month: MonthKey;
  /** Whole Monday-to-Sunday weeks covering the month (4 to 6 of them). */
  weeks: string[][];
  from: string;
  to: string;
}

export function monthGrid(month: MonthKey): MonthGrid {
  const first = `${month}-01`;
  const last = lastDayOf(month);
  const from = addDays(first, -mondayIndex(first));
  const to = addDays(last, 6 - mondayIndex(last));
  const weeks: string[][] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (mondayIndex(day) === 0) weeks.push([]);
    weeks.at(-1)!.push(day);
  }
  return { month, weeks, from, to };
}

/** GET /calendar for the grid: all of its days, one client or all. */
export function calendarQuery(grid: MonthGrid, clientId: string | null): CalendarQuery {
  return { from: grid.from, to: grid.to, ...(clientId ? { clientId } : {}) };
}

const MONTH_LABEL = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const DAY_LABEL = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const SHORT_DAY = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/** "2026-10" → "October 2026" */
export function formatMonth(month: MonthKey): string {
  return joined(partsOf(MONTH_LABEL, dayMs(`${month}-01`)), ["month", "year"]);
}

/** "2026-10-01" → "Thursday 1 October 2026" (a day cell's accessible name). */
export function formatDayLabel(isoDate: string): string {
  return joined(partsOf(DAY_LABEL, dayMs(isoDate)), ["weekday", "day", "month", "year"]);
}

/** "2026-10-01" → "Thu 1 Oct" */
export function formatShortDay(isoDate: string): string {
  return joined(partsOf(SHORT_DAY, dayMs(isoDate)), ["weekday", "day", "month"]);
}

/** The address of a calendar view; the current month and "all clients" are left out. */
export function calendarSearch(
  view: { month: MonthKey; clientId: string | null },
  currentMonth: MonthKey,
): string {
  const params = new URLSearchParams();
  if (view.month !== currentMonth) params.set("month", view.month);
  if (view.clientId) params.set("client", view.clientId);
  const search = params.toString();
  return search ? `?${search}` : "";
}

/* ── Times: the client's zone first, the viewer's on hover ───────────────────────────────────── */

export interface EventTime {
  /** "19:00", in the client's zone: the cell's day is the client's day too. */
  local: string;
  /** "Thu 1 Oct, 19:00" in the viewer's zone, or null when it reads the same as the client's. */
  viewer: string | null;
  /** Both, spelled out for a tooltip. */
  tooltip: string;
}

export function eventTime(scheduledFor: string, clientZone: string, viewerZone: string): EventTime {
  const local = formatTimeIn(scheduledFor, clientZone);
  const clientDayTime = formatDayTimeIn(scheduledFor, clientZone);
  const viewerDayTime = formatDayTimeIn(scheduledFor, viewerZone);
  const viewer = viewerDayTime === clientDayTime ? null : viewerDayTime;
  const tooltip = viewer
    ? `${clientDayTime} client time (${clientZone}) · ${viewer} your time (${viewerZone})`
    : `${clientDayTime} (${clientZone}, also your time)`;
  return { local, viewer, tooltip };
}

/* ── Items ──────────────────────────────────────────────────────────────────────────────────── */

export function isReschedulable(item: CalendarItemDto): item is CalendarJobItem {
  return item.kind === "job" && RESCHEDULABLE_PUBLISH_STATUSES.includes(item.status);
}

export function isCancellable(item: CalendarItemDto): item is CalendarJobItem {
  return item.kind === "job" && CANCELLABLE_PUBLISH_STATUSES.includes(item.status);
}

export function isRetryable(item: CalendarItemDto): item is CalendarJobItem {
  return item.kind === "job" && RETRYABLE_PUBLISH_STATUSES.includes(item.status);
}

/** A published job with somewhere to go: its chip links to the live post. */
export function liveUrlOf(item: CalendarItemDto): string | null {
  return item.kind === "job" && item.status === "PUBLISHED" ? item.liveUrl : null;
}

/** A job's publish state (a published one reads LIVE); a ghost is PLANNED. */
export function eventStatus(item: CalendarItemDto): PublishMarkStatus {
  return item.kind === "ghost" ? { label: "PLANNED", tone: "planned" } : publishMark(item.status);
}

export const SLOT_SOURCE_LABEL: Readonly<Record<SlotSource, string>> = {
  publisher: "Picked by the Publisher",
  optimizer: "The optimizer's best hour",
  manual: "Set by a teammate",
};

/**
 * A chip's accessible name: who, where, when, what state, then the post's title. A chip being
 * moved has no time yet (the optimizer picks the hour on the new day).
 */
export function eventLabel(item: CalendarItemDto, time: string | null): string {
  const where = `${item.clientName} · ${PLATFORM_LABEL[item.platform]}`;
  if (item.kind === "ghost") return `${where} · planned · ${item.title}`;
  const when = time ?? "moving";
  return `${where} · ${when} · ${eventStatus(item).label} · ${item.title}`;
}

/** An item where the grid draws it: on its own day, or on the day a pending drag moves it to. */
export interface CalendarEntry {
  item: CalendarItemDto;
  date: string;
  /** A reschedule of this job is in flight: it sits on the target day, hour still unknown. */
  moving: boolean;
}

export interface PendingMove {
  jobId: string;
  date: string;
}

/**
 * Places every item by day, with in-flight reschedules drawn on their target day (the latest move
 * of a job wins). Moving items go after the day's others: their hour is still being picked.
 */
export function placeItems(
  items: readonly CalendarItemDto[],
  moves: readonly PendingMove[],
): Map<string, CalendarEntry[]> {
  const target = new Map<string, string>();
  for (const move of moves) target.set(move.jobId, move.date);
  const byDay = new Map<string, CalendarEntry[]>();
  const moving: CalendarEntry[] = [];
  for (const item of items) {
    const movedTo = item.kind === "job" ? target.get(item.id) : undefined;
    const entry: CalendarEntry = movedTo
      ? { item, date: movedTo, moving: true }
      : { item, date: item.date, moving: false };
    if (entry.moving) moving.push(entry);
    else pushTo(byDay, entry);
  }
  for (const entry of moving) pushTo(byDay, entry);
  return byDay;
}

function pushTo(byDay: Map<string, CalendarEntry[]>, entry: CalendarEntry): void {
  const day = byDay.get(entry.date);
  if (day) day.push(entry);
  else byDay.set(entry.date, [entry]);
}

/** The API's order: by day, a day's jobs by time before its ghosts. */
function compareItems(a: CalendarItemDto, b: CalendarItemDto): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.kind !== b.kind) return a.kind === "job" ? -1 : 1;
  if (a.kind === "job" && b.kind === "job" && a.scheduledFor !== b.scheduledFor) {
    return Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor);
  }
  return 0;
}

/**
 * A cached calendar range once the API has answered a reschedule, retry or cancel with the job:
 * the item takes the job's day, time and state, and leaves the range when its new day is outside
 * it. A CANCELLED job leaves the calendar (its platform shows as a ghost again after the refetch).
 */
export function withJob(response: CalendarResponse, job: PublishJobDto): CalendarResponse {
  const current = response.items.find((item) => item.kind === "job" && item.id === job.id);
  if (!current || current.kind !== "job") return response;
  const others = response.items.filter((item) => item !== current);
  const stays = job.status !== "CANCELLED" && job.date >= response.from && job.date <= response.to;
  if (!stays) return { ...response, items: others };
  const updated: CalendarJobItem = {
    ...current,
    date: job.date,
    timezone: job.timezone,
    status: job.status,
    scheduledFor: job.scheduledFor,
    publishedAt: job.publishedAt,
    liveUrl: job.liveUrl,
    dryRun: job.dryRun,
    slotSource: job.slotSource,
    slotReason: job.slotReason,
    lastError: job.lastError,
  };
  return { ...response, items: [...others, updated].sort(compareItems) };
}
