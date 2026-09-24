import { describe, expect, it } from "vitest";
import { addMonths, formatRange, parseWindow } from "../src/llm/mock/dates";

const TODAY = "2026-09-24";

describe("parseWindow", () => {
  it.each([
    ["March 1–30", { start: "2027-03-01", end: "2027-03-30" }],
    ["Mar 1 - 30", { start: "2027-03-01", end: "2027-03-30" }],
    ["from October 5th to November 2nd", { start: "2026-10-05", end: "2026-11-02" }],
    ["Dec 20 – Jan 5", { start: "2026-12-20", end: "2027-01-05" }],
    ["1–30 March", { start: "2027-03-01", end: "2027-03-30" }],
    ["10 October to 3 November 2027", { start: "2027-10-10", end: "2027-11-03" }],
    ["2026-10-01 to 2026-10-31", { start: "2026-10-01", end: "2026-10-31" }],
    ["over the next 2 weeks", { start: "2026-09-25", end: "2026-10-08" }],
    ["the next ten days", { start: "2026-09-25", end: "2026-10-04" }],
    ["next week", { start: "2026-09-25", end: "2026-10-01" }],
    ["next month", { start: "2026-10-01", end: "2026-10-31" }],
    ["the coming 2 months", { start: "2026-09-25", end: "2026-11-24" }],
    ["all of February", { start: "2027-02-01", end: "2027-02-28" }],
    ["in November 2026", { start: "2026-11-01", end: "2026-11-30" }],
    ["this month", { start: TODAY, end: "2026-09-30" }],
    ["Feb 1-31", { start: "2027-02-01", end: "2027-02-28" }],
  ])("reads %j", (text, window) => {
    expect(parseWindow(text, TODAY)).toEqual(window);
  });

  it("ignores text without a date phrase", () => {
    expect(
      parseWindow("Ramadan campaign for the coffee client — 12 posts, push the iced line", TODAY),
    ).toBeNull();
    expect(parseWindow("next level coffee", TODAY)).toBeNull();
  });

  it("keeps this year's range while it is still running", () => {
    expect(parseWindow("September 20–30", TODAY)).toEqual({
      start: "2026-09-20",
      end: "2026-09-30",
    });
  });
});

describe("date helpers", () => {
  it("adds months, clamping to the month's length", () => {
    expect(addMonths("2027-01-31", 1)).toBe("2027-02-28");
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
  });

  it("formats ranges within and across years", () => {
    expect(formatRange("2027-03-01", "2027-03-30")).toBe("Mar 1 – Mar 30, 2027");
    expect(formatRange("2026-12-20", "2027-01-05")).toBe("Dec 20, 2026 – Jan 5, 2027");
  });
});
