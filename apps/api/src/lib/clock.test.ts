import { describe, expect, it } from "vitest";
import { DAY_MS, FakeClock, MINUTE_MS, systemClock } from "./clock";

describe("FakeClock", () => {
  it("starts at the given instant and only moves when told to", () => {
    const clock = new FakeClock("2026-01-05T09:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-01-05T09:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-01-05T09:00:00.000Z");

    clock.advance(30 * MINUTE_MS);
    expect(clock.now().toISOString()).toBe("2026-01-05T09:30:00.000Z");

    expect(clock.set(new Date("2026-02-01T00:00:00.000Z")).getTime()).toBe(
      Date.parse("2026-02-01T00:00:00.000Z"),
    );
    expect(clock.advance(DAY_MS).toISOString()).toBe("2026-02-02T00:00:00.000Z");
  });

  it("returns a fresh Date each time so callers cannot mutate its time", () => {
    const clock = new FakeClock(0);
    clock.now().setTime(123_456);
    expect(clock.now().getTime()).toBe(0);
  });

  it("defaults to the real current time", () => {
    const before = systemClock.now().getTime();
    const now = new FakeClock().now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it("rejects invalid instants and durations", () => {
    expect(() => new FakeClock("not a date")).toThrow(RangeError);
    expect(() => new FakeClock().advance(Number.NaN)).toThrow(RangeError);
  });
});
