import { describe, expect, it } from "vitest";
import { calendarDay, DAY_MS, FakeClock, MINUTE_MS, systemClock } from "./clock";

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

describe("calendarDay", () => {
  it("is the day on the wall calendar of the zone, not the UTC day", () => {
    // 21:00 in New York on Sept 24 is already Sept 25 in UTC; 06:00 in Dubai is still Sept 24.
    const evening = new Date("2026-09-25T01:00:00.000Z");
    expect(calendarDay(evening, "UTC")).toBe("2026-09-25");
    expect(calendarDay(evening, "America/New_York")).toBe("2026-09-24");
    const morning = new Date("2026-09-24T02:00:00.000Z");
    expect(calendarDay(morning, "Asia/Dubai")).toBe("2026-09-24");
    expect(calendarDay(new Date("2026-09-23T21:00:00.000Z"), "Asia/Dubai")).toBe("2026-09-24");
    expect(calendarDay(new Date("2026-12-31T23:30:00.000Z"), "Pacific/Kiritimati")).toBe(
      "2027-01-01",
    );
  });

  it("rejects an unknown zone", () => {
    expect(() => calendarDay(new Date(0), "Mars/Olympus_Mons")).toThrow(RangeError);
  });
});
