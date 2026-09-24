/*
 * Every time-dependent decision (session expiry, invite TTL, slot scheduling, metric capture) reads
 * the injected Clock, so tests can move time forward instead of sleeping.
 */

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/**
 * "YYYY-MM-DD": the calendar day `instant` falls on in the IANA `timeZone` (RangeError for an
 * unknown zone). A client's "today" is this in its own time zone, not the UTC day.
 */
export function calendarDay(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}

type Instant = Date | string | number;

function toEpochMs(instant: Instant): number {
  const ms = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  if (Number.isNaN(ms)) throw new RangeError(`Invalid instant: ${String(instant)}`);
  return ms;
}

/** Manually driven clock for tests. Starts at the real current time unless told otherwise. */
export class FakeClock implements Clock {
  #epochMs: number;

  constructor(start: Instant = Date.now()) {
    this.#epochMs = toEpochMs(start);
  }

  now(): Date {
    return new Date(this.#epochMs);
  }

  set(instant: Instant): Date {
    this.#epochMs = toEpochMs(instant);
    return this.now();
  }

  advance(ms: number): Date {
    if (!Number.isFinite(ms)) throw new RangeError(`Invalid duration: ${ms}`);
    this.#epochMs += ms;
    return this.now();
  }
}
