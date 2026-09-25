import { blendSlotScore, SLOT_RULES } from "@enmo/shared";
import { describe, expect, it } from "vitest";
import {
  bestSlotOfDay,
  daysOf,
  isSlotOpen,
  openSlotsOn,
  rankSlots,
  remainingWindowDays,
  type SlotBoard,
} from "./slot-optimizer";

/*
 * The slot optimizer's ranking (DESIGN §F "Slot optimizer"), on hand-built boards: priors in the
 * client's own time zone, the SlotScore blend, the spacing, daily-cap and lead-time rules, the
 * target-date preference, and daylight-saving days.
 */

// Asia/Riyadh is UTC+3 all year: 11:00 local is 08:00Z.
const RIYADH = "Asia/Riyadh";
// Monday 2027-03-01 03:00 in Riyadh.
const MONDAY_NIGHT = new Date("2027-03-01T00:00:00Z");

function board(overrides: Partial<SlotBoard> = {}): SlotBoard {
  return {
    platform: "INSTAGRAM",
    timezone: RIYADH,
    now: MONDAY_NIGHT,
    taken: [],
    learned: [],
    ...overrides,
  };
}

const at = (iso: string) => new Date(iso);
const starts = (slots: { slotStart: string }[]) => slots.map((slot) => slot.slotStart);

describe("rankSlots", () => {
  it("offers Instagram's weekday peaks first, read in the client's time zone", () => {
    const ranked = rankSlots(board(), { days: ["2027-03-02"], targetDate: null, limit: 5 });
    expect(ranked).toHaveLength(SLOT_RULES.candidates);
    // Tuesday 11:00, 12:00, 19:00, 20:00 Riyadh (1.25), then the earliest shoulder hour (10:00, 1.0).
    expect(starts(ranked)).toEqual([
      "2027-03-02T08:00:00.000Z",
      "2027-03-02T09:00:00.000Z",
      "2027-03-02T16:00:00.000Z",
      "2027-03-02T17:00:00.000Z",
      "2027-03-02T07:00:00.000Z",
    ]);
    expect(ranked.map((slot) => slot.score)).toEqual([1.25, 1.25, 1.25, 1.25, 1]);
    expect(ranked[0]!.reasons[0]).toBe("Instagram peak hour: Tue 11:00 Asia/Riyadh (prior 1.25)");
  });

  it("follows the client's clock, not UTC", () => {
    const [nyTop] = rankSlots(board({ timezone: "America/New_York" }), {
      days: ["2027-03-02"],
      targetDate: null,
      limit: 1,
    });
    // 11:00 in New York (EST, UTC-5) is 16:00Z.
    expect(nyTop!.slotStart).toBe("2027-03-02T16:00:00.000Z");
  });

  it("keeps to the target date ±1 day while it has room, nearest day first among equals", () => {
    const days = daysOf({ start: "2027-03-01", end: "2027-03-12" });
    const ranked = rankSlots(board(), { days, targetDate: "2027-03-10", limit: 5 });
    const localDays = ranked.map((slot) => slot.slotStart.slice(0, 10));
    expect(new Set(localDays)).toEqual(new Set(["2027-03-10", "2027-03-09"]));
    expect(ranked[0]!.slotStart).toBe("2027-03-10T08:00:00.000Z");
    expect(ranked[0]!.reasons).toContain("On the plan's target date");
    expect(ranked[4]!.reasons).toContain("1 day before the plan's target date");
  });

  it("falls back to the whole window when nothing is open near the target date", () => {
    const ranked = rankSlots(board(), {
      days: ["2027-03-02", "2027-03-03"],
      targetDate: "2027-03-20",
      limit: 2,
    });
    // Equal scores still lean towards the target: Wednesday before Tuesday.
    expect(starts(ranked)).toEqual(["2027-03-03T08:00:00.000Z", "2027-03-03T09:00:00.000Z"]);
    expect(ranked[0]!.reasons.at(-1)).toBe("17 days before the plan's target date");
  });

  it("blends the prior with what the client's own posts scored in that day and bucket", () => {
    // Tuesday (2), bucket 6 = 18:00–20:59, five posts averaging 3.0.
    const learned = [{ dayOfWeek: 2, hourBucket: 6, meanScore: 3, samples: 5 }];
    const [top, second] = rankSlots(board({ learned }), {
      days: ["2027-03-02"],
      targetDate: null,
      limit: 2,
    });
    expect(top!.slotStart).toBe("2027-03-02T16:00:00.000Z"); // 19:00 local
    expect(top!.score).toBeCloseTo(blendSlotScore(1.25, 3, 5));
    expect(top!.reasons[1]).toBe("5 past posts on Tue 18:00–20:59 scored 3.00 on average");
    expect(second!.slotStart).toBe("2027-03-02T17:00:00.000Z"); // 20:00 local
  });

  it("returns nothing when the days have no open slot", () => {
    const past = board({ now: at("2027-03-05T00:00:00Z") });
    expect(rankSlots(past, { days: ["2027-03-02"], targetDate: null, limit: 5 })).toEqual([]);
  });
});

describe("isSlotOpen", () => {
  it("keeps SLOT_RULES.minLeadMinutes between now and the slot", () => {
    const now = at("2027-03-02T07:45:00Z"); // 10:45 local
    expect(isSlotOpen(board({ now }), at("2027-03-02T08:00:00Z"))).toBe(false);
    expect(isSlotOpen(board({ now }), at("2027-03-02T08:15:00Z"))).toBe(true);
  });

  it("keeps four hours between two posts of the client on the platform, and never stacks them", () => {
    const taken = [at("2027-03-02T08:00:00Z")];
    expect(isSlotOpen(board({ taken }), at("2027-03-02T08:00:00Z"))).toBe(false);
    expect(isSlotOpen(board({ taken }), at("2027-03-02T11:00:00Z"))).toBe(false);
    expect(isSlotOpen(board({ taken }), at("2027-03-02T04:30:00Z"))).toBe(false);
    expect(isSlotOpen(board({ taken }), at("2027-03-02T12:00:00Z"))).toBe(true);
    expect(isSlotOpen(board({ taken }), at("2027-03-02T04:00:00Z"))).toBe(true);
  });

  it("allows two posts per client-local day", () => {
    // 01:00 and 11:00 Wednesday in Riyadh; 22:00Z Tuesday is already Wednesday there.
    const taken = [at("2027-03-02T22:00:00Z"), at("2027-03-03T08:00:00Z")];
    expect(isSlotOpen(board({ taken }), at("2027-03-03T16:00:00Z"))).toBe(false);
    // Tuesday 19:00 local is 5h before the first: that day has room.
    expect(isSlotOpen(board({ taken }), at("2027-03-02T16:00:00Z"))).toBe(true);
    expect(openSlotsOn(board({ taken }), "2027-03-03")).toEqual([]);
  });
});

describe("daylight saving", () => {
  const newYork = board({ timezone: "America/New_York", now: at("2027-03-01T00:00:00Z") });

  it("has no 02:00 slot on the spring-forward day and puts noon at 16:00Z (EDT)", () => {
    const slots = openSlotsOn(newYork, "2027-03-14");
    expect(slots).toHaveLength(23);
    const noon = slots.find((slot) => slot.reasons[0]!.includes("Sun 12:00"));
    expect(noon!.slotStart).toBe("2027-03-14T16:00:00.000Z");
  });

  it("lists each hour once on the fall-back day", () => {
    const slots = openSlotsOn(newYork, "2027-11-07");
    expect(slots).toHaveLength(24);
    expect(new Set(starts(slots)).size).toBe(24);
  });
});

describe("bestSlotOfDay", () => {
  it("picks the day's best open hour, the earliest of equals, the same every time", () => {
    const taken = [at("2027-03-02T08:00:00Z")];
    const first = bestSlotOfDay(board({ taken }), "2027-03-02");
    expect(first!.slotStart).toBe("2027-03-02T16:00:00.000Z");
    expect(bestSlotOfDay(board({ taken }), "2027-03-02")).toEqual(first);
    // A Saturday has no peaks: its earliest ordinary daytime hour.
    expect(bestSlotOfDay(board(), "2027-03-06")!.slotStart).toBe("2027-03-06T04:00:00.000Z");
  });

  it("is null when the day is full", () => {
    const taken = [at("2027-03-02T05:00:00Z"), at("2027-03-02T12:00:00Z")];
    expect(bestSlotOfDay(board({ taken }), "2027-03-02")).toBeNull();
  });
});

describe("remainingWindowDays", () => {
  it("starts at the client's today and is empty once the window has passed", () => {
    // 22:00Z on 1 March is already 2 March in Riyadh.
    const now = at("2027-03-01T22:00:00Z");
    expect(remainingWindowDays({ start: "2027-02-20", end: "2027-03-04" }, RIYADH, now)).toEqual([
      "2027-03-02",
      "2027-03-03",
      "2027-03-04",
    ]);
    expect(remainingWindowDays({ start: "2027-02-20", end: "2027-03-01" }, RIYADH, now)).toEqual(
      [],
    );
  });
});
