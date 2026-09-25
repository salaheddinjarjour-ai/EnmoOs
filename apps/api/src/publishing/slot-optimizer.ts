import { TZDate } from "@date-fns/tz";
import type { DbClient, DbTransaction } from "@enmo/db";
import {
  bestTimePrior,
  blendSlotScore,
  HOURS_PER_DAY,
  PLATFORM_LABEL,
  SLOT_RULES,
  slotHourBucket,
  type Platform,
  type PublishStatus,
  type SlotCandidate,
} from "@enmo/shared";
import { calendarDay, DAY_MS, HOUR_MS, MINUTE_MS } from "../lib/clock";

/*
 * The slot optimizer (DESIGN §F "Slot optimizer"): hourly slots in the client's time zone, scored
 * by the platform's best-time prior blended with the client's learned SlotScore, inside the
 * campaign window, at least SLOT_RULES.minLeadMinutes from now, SLOT_RULES.minSpacingHours apart
 * and at most SLOT_RULES.maxPerDayPerClientPlatform a day per client and platform, never on top of
 * an existing job. candidates() feeds the Publisher agent; bestSlotOn() serves calendar drags
 * (deterministic, no LLM call).
 *
 * The ranking itself is pure (rankSlots, bestSlotOfDay, isSlotOpen over a SlotBoard); the exported
 * database functions only read the board. Inside a transaction they also take the client's slot
 * lock, held until the transaction ends, so two schedulers can't both hand out the same free slot
 * before either has written its job.
 */

type Db = DbClient | DbTransaction;

export interface SlotContext {
  clientId: string;
  platform: Platform;
  /** The client's IANA time zone: days, hours and priors are read in it. */
  timezone: string;
  now: Date;
  /** Left out of the spacing and collision checks: the job a calendar drag is moving. */
  excludeJobId?: string | null;
}

export interface CandidateRequest extends SlotContext {
  /** Client-local days (YYYY-MM-DD) the slot may fall on, inclusive: the campaign window. */
  window: { start: string; end: string };
  /** The plan's day for the post, when it has one. */
  targetDate: string | null;
  /** Defaults to SLOT_RULES.candidates. */
  limit?: number;
}

/** Jobs that hold their slot: waiting for it, going out, or already out. */
export const SLOT_HOLDING_STATUSES: readonly PublishStatus[] = [
  "SCHEDULED",
  "QUEUED",
  "PUBLISHING",
  "PUBLISHED",
];

/** How far either side of its target date a slot still counts as "on plan". */
export const TARGET_DATE_TOLERANCE_DAYS = 1;

/** A SlotScore row: what the client's past posts in one client-local day and bucket scored. */
export interface LearnedSlot {
  dayOfWeek: number;
  hourBucket: number;
  meanScore: number;
  samples: number;
}

/** Everything the ranking reads, for one client and platform. */
export interface SlotBoard {
  platform: Platform;
  timezone: string;
  now: Date;
  /** When the client's other posts on this platform go (or went) out. */
  taken: readonly Date[];
  learned: readonly LearnedSlot[];
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const SPACING_MS = SLOT_RULES.minSpacingHours * HOUR_MS;

const hh = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

function priorLabel(prior: number): string {
  if (prior >= 1.2) return "peak hour";
  if (prior >= 1) return "hour next to a peak";
  if (prior >= 0.8) return "ordinary daytime hour";
  return "night hour";
}

function bucketLabel(bucket: number): string {
  const from = bucket * SLOT_RULES.bucketHours;
  return `${hh(from)}–${String(from + SLOT_RULES.bucketHours - 1).padStart(2, "0")}:59`;
}

/** Days from `from` to `to` (both YYYY-MM-DD), negative when `to` comes first. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** `date` (YYYY-MM-DD) moved by whole calendar days. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Every day of an inclusive range, in order. */
export function daysOf(range: { start: string; end: string }): string[] {
  const days: string[] = [];
  for (let day = range.start; day <= range.end; day = addDays(day, 1)) days.push(day);
  return days;
}

/** The start of a client-local day as an instant (midnight, or the first hour a DST gap leaves). */
function startOfLocalDay(date: string, timezone: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new TZDate(year, month - 1, day, 0, timezone).getTime();
}

function scoreSlot(board: SlotBoard, start: TZDate): SlotCandidate {
  const day = start.getDay();
  const hour = start.getHours();
  const prior = bestTimePrior(board.platform, day, hour);
  const bucket = slotHourBucket(hour);
  const learned = board.learned.find(
    (slot) => slot.dayOfWeek === day && slot.hourBucket === bucket && slot.samples > 0,
  );
  const reasons = [
    `${PLATFORM_LABEL[board.platform]} ${priorLabel(prior)}: ${WEEKDAY_NAMES[day]} ${hh(hour)} ${board.timezone} (prior ${prior.toFixed(2)})`,
  ];
  let score = prior;
  if (learned) {
    score = blendSlotScore(prior, learned.meanScore, learned.samples);
    const posts = learned.samples === 1 ? "1 past post" : `${learned.samples} past posts`;
    reasons.push(
      `${posts} on ${WEEKDAY_NAMES[day]} ${bucketLabel(bucket)} scored ${learned.meanScore.toFixed(2)} on average`,
    );
  }
  return {
    slotStart: new Date(start.getTime()).toISOString(),
    score: Math.round(score * 1000) / 1000,
    reasons,
  };
}

/** The board with each taken slot's client-local day worked out once. */
interface BoardIndex {
  board: SlotBoard;
  earliest: number;
  takenMs: number[];
  perDay: Map<string, number>;
}

function indexBoard(board: SlotBoard): BoardIndex {
  const perDay = new Map<string, number>();
  for (const taken of board.taken) {
    const day = calendarDay(taken, board.timezone);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  return {
    board,
    earliest: board.now.getTime() + SLOT_RULES.minLeadMinutes * MINUTE_MS,
    takenMs: board.taken.map((taken) => taken.getTime()),
    perDay,
  };
}

function openAt(index: BoardIndex, at: number, day: string): boolean {
  if (at < index.earliest) return false;
  if (index.takenMs.some((taken) => Math.abs(taken - at) < SPACING_MS)) return false;
  return (index.perDay.get(day) ?? 0) < SLOT_RULES.maxPerDayPerClientPlatform;
}

/**
 * Whether a slot starting at `start` may be used: late enough, at least minSpacingHours from every
 * other post of the client on the platform (which also rules out two at the same time), and on a
 * client-local day that isn't full yet.
 */
export function isSlotOpen(board: SlotBoard, start: Date): boolean {
  return openAt(indexBoard(board), start.getTime(), calendarDay(start, board.timezone));
}

function openSlotsIndexed(index: BoardIndex, date: string): SlotCandidate[] {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const slots: SlotCandidate[] = [];
  for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
    const start = new TZDate(year, month - 1, day, hour, index.board.timezone);
    // A daylight-saving gap skips this hour: the date lands an hour later, already listed.
    if (start.getHours() !== hour) continue;
    if (!openAt(index, start.getTime(), date)) continue;
    slots.push(scoreSlot(index.board, start));
  }
  return slots;
}

/** The open hourly slots of one client-local day, scored, in time order. */
export function openSlotsOn(board: SlotBoard, date: string): SlotCandidate[] {
  return openSlotsIndexed(indexBoard(board), date);
}

function byScoreThenTime(a: SlotCandidate, b: SlotCandidate): number {
  return b.score - a.score || Date.parse(a.slotStart) - Date.parse(b.slotStart);
}

function withTargetReason(candidate: SlotCandidate, offset: number): SlotCandidate {
  const days = Math.abs(offset) === 1 ? "1 day" : `${Math.abs(offset)} days`;
  const where =
    offset === 0
      ? "On the plan's target date"
      : `${days} ${offset < 0 ? "before" : "after"} the plan's target date`;
  return { ...candidate, reasons: [...candidate.reasons, where] };
}

export interface RankRequest {
  /** Client-local days the slot may fall on, in order. */
  days: readonly string[];
  targetDate: string | null;
  limit: number;
}

/**
 * The best open slots, best first (at most `limit`). With a target date, only slots within
 * TARGET_DATE_TOLERANCE_DAYS of it are offered while any is open, and equal scores go to the day
 * nearest the target; without one (or with none open near it) the whole range competes on score.
 */
export function rankSlots(board: SlotBoard, request: RankRequest): SlotCandidate[] {
  const index = indexBoard(board);
  const open = request.days.flatMap((day) =>
    openSlotsIndexed(index, day).map((slot) => ({
      slot,
      offset: request.targetDate === null ? null : daysBetween(request.targetDate, day),
    })),
  );
  const near = open.filter(
    (entry) => entry.offset !== null && Math.abs(entry.offset) <= TARGET_DATE_TOLERANCE_DAYS,
  );
  const pool = near.length > 0 ? near : open;
  return pool
    .sort(
      (a, b) =>
        b.slot.score - a.slot.score ||
        Math.abs(a.offset ?? 0) - Math.abs(b.offset ?? 0) ||
        Date.parse(a.slot.slotStart) - Date.parse(b.slot.slotStart),
    )
    .slice(0, request.limit)
    .map((entry) =>
      entry.offset === null ? entry.slot : withTargetReason(entry.slot, entry.offset),
    );
}

/** The best open slot of one client-local day (the earliest of equals), or null. */
export function bestSlotOfDay(board: SlotBoard, date: string): SlotCandidate | null {
  return openSlotsOn(board, date).sort(byScoreThenTime)[0] ?? null;
}

/** The window's days from the client's today on (none when the window has passed). */
export function remainingWindowDays(
  window: { start: string; end: string },
  timezone: string,
  now: Date,
): string[] {
  const today = calendarDay(now, timezone);
  const start = window.start > today ? window.start : today;
  return start > window.end ? [] : daysOf({ start, end: window.end });
}

/* ─── database ───────────────────────────────────────────────────────────────────────────────── */

/**
 * Serialises slot assignment for one client until the transaction ends (a no-op outside one):
 * every writer of PublishJob.scheduledFor reads the board through this module.
 */
async function lockClientSlots(db: Db, clientId: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`publish-slots:${clientId}`}))`;
}

/** Reads the client's board for the instants in [from, to] (spacing margins included). */
async function loadBoard(
  db: Db,
  context: SlotContext,
  range: { from: number; to: number },
): Promise<SlotBoard> {
  await lockClientSlots(db, context.clientId);
  const from = new Date(range.from - DAY_MS);
  const to = new Date(range.to + DAY_MS);
  // Sequential: `db` is often a transaction, which runs one query at a time.
  const jobs = await db.publishJob.findMany({
    where: {
      platform: context.platform,
      status: { in: [...SLOT_HOLDING_STATUSES] },
      variant: { post: { clientId: context.clientId } },
      ...(context.excludeJobId ? { id: { not: context.excludeJobId } } : {}),
      OR: [{ scheduledFor: { gte: from, lte: to } }, { publishedAt: { gte: from, lte: to } }],
    },
    select: { scheduledFor: true, publishedAt: true },
  });
  const learned = await db.slotScore.findMany({
    where: { clientId: context.clientId, platform: context.platform },
    select: { dayOfWeek: true, hourBucket: true, meanScore: true, samples: true },
  });
  return {
    platform: context.platform,
    timezone: context.timezone,
    now: context.now,
    // A published post occupies the moment it actually went out.
    taken: jobs.map((job) => job.publishedAt ?? job.scheduledFor),
    learned,
  };
}

function rangeOfDays(days: readonly string[], timezone: string): { from: number; to: number } {
  const first = days[0]!;
  const last = days[days.length - 1]!;
  return {
    from: startOfLocalDay(first, timezone),
    to: startOfLocalDay(addDays(last, 1), timezone),
  };
}

/** The best slots for one variant, best first (at most `limit`); empty when none is free. */
export async function candidates(db: Db, request: CandidateRequest): Promise<SlotCandidate[]> {
  const days = remainingWindowDays(request.window, request.timezone, request.now);
  if (days.length === 0) return [];
  const board = await loadBoard(db, request, rangeOfDays(days, request.timezone));
  return rankSlots(board, {
    days,
    targetDate: request.targetDate,
    limit: request.limit ?? SLOT_RULES.candidates,
  });
}

/** The best free slot on `date` (a client-local YYYY-MM-DD), or null when that day has none. */
export async function bestSlotOn(
  db: Db,
  context: SlotContext,
  date: string,
): Promise<SlotCandidate | null> {
  const board = await loadBoard(db, context, rangeOfDays([date], context.timezone));
  return bestSlotOfDay(board, date);
}

/** Whether `slotStart` is still free for the client and platform (re-checked before writing). */
export async function slotIsFree(db: Db, context: SlotContext, slotStart: Date): Promise<boolean> {
  const at = slotStart.getTime();
  const board = await loadBoard(db, context, { from: at, to: at });
  return isSlotOpen(board, slotStart);
}
