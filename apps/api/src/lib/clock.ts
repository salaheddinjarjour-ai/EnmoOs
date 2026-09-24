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
