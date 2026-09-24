import { describe, expect, it } from "vitest";
import { nextUtcMidnight, utcDay, utcDayStart } from "./budget";

describe("UTC day helpers", () => {
  const lateEvening = new Date("2026-09-24T23:59:59.999Z");

  it("cut days at UTC midnight", () => {
    expect(utcDay(lateEvening)).toBe("2026-09-24");
    expect(utcDayStart(lateEvening).toISOString()).toBe("2026-09-24T00:00:00.000Z");
    expect(nextUtcMidnight(lateEvening).toISOString()).toBe("2026-09-25T00:00:00.000Z");
    expect(utcDay(new Date("2026-09-25T00:00:00.000Z"))).toBe("2026-09-25");
  });

  it("roll over months and years", () => {
    expect(nextUtcMidnight(new Date("2026-12-31T12:00:00Z")).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });
});
