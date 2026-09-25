import type {
  CalendarGhostItem,
  CalendarJobItem,
  CalendarResponse,
  PublishJobDto,
} from "@enmo/shared";
import { describe, expect, it } from "vitest";
import {
  addDays,
  calendarQuery,
  calendarSearch,
  eventLabel,
  eventStatus,
  eventTime,
  formatDayLabel,
  formatMonth,
  formatShortDay,
  formatTimeIn,
  ghostNote,
  isCancellable,
  isReschedulable,
  isRetryable,
  liveUrlOf,
  monthGrid,
  monthOf,
  parseMonth,
  placeItems,
  shiftMonth,
  viewerToday,
  withJob,
} from "./calendar-model";

function job(overrides: Partial<CalendarJobItem> = {}): CalendarJobItem {
  return {
    kind: "job",
    id: "job-1",
    variantId: "variant-1",
    postId: "post-1",
    campaignId: "campaign-1",
    clientId: "client-1",
    clientName: "Qahwa Co",
    platform: "INSTAGRAM",
    postType: "REEL",
    date: "2026-10-01",
    timezone: "Asia/Riyadh",
    title: "Iced cardamom, in two seconds",
    thumbUrl: null,
    status: "SCHEDULED",
    // 19:00 in Riyadh (UTC+3)
    scheduledFor: "2026-10-01T16:00:00.000Z",
    publishedAt: null,
    liveUrl: null,
    dryRun: true,
    slotSource: "publisher",
    slotReason: "Peak hour",
    lastError: null,
    ...overrides,
  };
}

function ghost(overrides: Partial<CalendarGhostItem> = {}): CalendarGhostItem {
  return {
    kind: "ghost",
    id: "ghost:post-2:FACEBOOK",
    postId: "post-2",
    campaignId: "campaign-1",
    clientId: "client-1",
    clientName: "Qahwa Co",
    platform: "FACEBOOK",
    postType: "STATIC",
    date: "2026-10-01",
    timezone: "Asia/Riyadh",
    title: "p2",
    thumbUrl: null,
    postStatus: "PENDING_APPROVAL",
    ...overrides,
  };
}

function publishJob(overrides: Partial<PublishJobDto> = {}): PublishJobDto {
  return {
    id: "job-1",
    variantId: "variant-1",
    postId: "post-1",
    campaignId: "campaign-1",
    clientId: "client-1",
    platform: "INSTAGRAM",
    postType: "REEL",
    status: "SCHEDULED",
    scheduledFor: "2026-10-03T09:00:00.000Z",
    date: "2026-10-03",
    timezone: "Asia/Riyadh",
    slotSource: "optimizer",
    slotReason: "Best free hour that day",
    dryRun: true,
    attempts: 0,
    socialAccountId: null,
    externalId: null,
    liveUrl: null,
    lastError: null,
    publishedAt: null,
    createdAt: "2026-09-25T10:00:00.000Z",
    updatedAt: "2026-09-25T10:05:00.000Z",
    ...overrides,
  };
}

describe("months and days", () => {
  it("parses only well-formed months", () => {
    expect(parseMonth("2026-10")).toBe("2026-10");
    expect(parseMonth("2026-13")).toBeNull();
    expect(parseMonth("2026-1")).toBeNull();
    expect(parseMonth("")).toBeNull();
    expect(parseMonth(null)).toBeNull();
  });

  it("moves across years", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-10", 0)).toBe("2026-10");
    expect(shiftMonth("2026-10", -22)).toBe("2024-12");
  });

  it("adds days in UTC, across month ends and DST changes alike", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(monthOf("2026-10-31")).toBe("2026-10");
  });

  it("covers the month with whole Monday-to-Sunday weeks", () => {
    // October 2026 starts on a Thursday and ends on a Saturday.
    const grid = monthGrid("2026-10");
    expect(grid.from).toBe("2026-09-28");
    expect(grid.to).toBe("2026-11-01");
    expect(grid.weeks).toHaveLength(5);
    for (const week of grid.weeks) expect(week).toHaveLength(7);
    expect(grid.weeks[0]![3]).toBe("2026-10-01");
    expect(grid.weeks.flat()).toContain("2026-10-31");
  });

  it("needs six weeks for a month that starts late in the week", () => {
    // August 2026 starts on a Saturday and has 31 days.
    const grid = monthGrid("2026-08");
    expect(grid.weeks).toHaveLength(6);
    expect(grid.from).toBe("2026-07-27");
    expect(grid.to).toBe("2026-09-06");
  });

  it("asks the API for exactly the grid's days", () => {
    const grid = monthGrid("2026-10");
    expect(calendarQuery(grid, null)).toEqual({ from: "2026-09-28", to: "2026-11-01" });
    expect(calendarQuery(grid, "client-1")).toEqual({
      from: "2026-09-28",
      to: "2026-11-01",
      clientId: "client-1",
    });
  });

  it("labels months and days without shifting them", () => {
    expect(formatMonth("2026-10")).toBe("October 2026");
    expect(formatDayLabel("2026-10-01")).toBe("Thursday 1 October 2026");
    expect(formatShortDay("2026-10-01")).toBe("Thu 1 Oct");
  });

  it("reads today from the viewer's own clock", () => {
    expect(viewerToday(new Date(2026, 8, 5, 23, 59))).toBe("2026-09-05");
  });

  it("keeps only non-default choices in the address", () => {
    expect(calendarSearch({ month: "2026-10", clientId: null }, "2026-10")).toBe("");
    expect(calendarSearch({ month: "2026-11", clientId: "c1" }, "2026-10")).toBe(
      "?month=2026-11&client=c1",
    );
    expect(calendarSearch({ month: "2026-10", clientId: "c1" }, "2026-10")).toBe("?client=c1");
  });
});

describe("times", () => {
  it("reads the slot in the client's zone", () => {
    expect(formatTimeIn("2026-10-01T16:00:00.000Z", "Asia/Riyadh")).toBe("19:00");
    expect(formatTimeIn("2026-10-01T16:00:00.000Z", "Not/A_Zone")).toBe("16:00");
  });

  it("adds the viewer's time only when it differs", () => {
    const same = eventTime("2026-10-01T16:00:00.000Z", "Asia/Riyadh", "Asia/Riyadh");
    expect(same).toMatchObject({ local: "19:00", viewer: null });
    expect(same.tooltip).toContain("also your time");

    const apart = eventTime("2026-10-01T16:00:00.000Z", "Asia/Riyadh", "America/New_York");
    expect(apart.local).toBe("19:00");
    expect(apart.viewer).toBe("Thu 1 Oct, 12:00");
    expect(apart.tooltip).toBe(
      "Thu 1 Oct, 19:00 client time (Asia/Riyadh) · Thu 1 Oct, 12:00 your time (America/New_York)",
    );
  });
});

describe("items", () => {
  it("drags, cancels and retries only in the states the API allows", () => {
    expect(isReschedulable(job())).toBe(true);
    expect(isReschedulable(job({ status: "QUEUED" }))).toBe(false);
    expect(isReschedulable(ghost())).toBe(false);
    expect(isCancellable(job({ status: "QUEUED" }))).toBe(true);
    // A platform that keeps refusing the post can be dropped.
    expect(isCancellable(job({ status: "FAILED" }))).toBe(true);
    expect(isCancellable(job({ status: "PUBLISHING" }))).toBe(false);
    expect(isCancellable(job({ status: "PUBLISHED" }))).toBe(false);
    expect(isRetryable(job({ status: "FAILED" }))).toBe(true);
    expect(isRetryable(job())).toBe(false);
  });

  it("explains a ghost by where its post stands", () => {
    expect(ghostNote(ghost())).toMatch(/^The campaign plan puts this post here; .*approved/);
    expect(ghostNote(ghost({ postStatus: "SCHEDULED" }))).toMatch(
      /^The post is approved, but nothing is scheduled on Facebook: .*approve it again/,
    );
    expect(ghostNote(ghost({ postStatus: "FAILED" }))).toMatch(/Retry or cancel that one first/);
    expect(ghostNote(ghost({ postStatus: "LIVE" }))).toBe(
      "The post went out without Facebook: nothing is scheduled there, and a post that is out can't be scheduled again.",
    );
  });

  it("links only published jobs to their live post", () => {
    const url = "https://dryrun.enmo.marketing/instagram/variant-1";
    expect(liveUrlOf(job({ status: "PUBLISHED", liveUrl: url }))).toBe(url);
    expect(liveUrlOf(job({ liveUrl: url }))).toBeNull();
    expect(liveUrlOf(ghost())).toBeNull();
  });

  it("shows a published job as LIVE and a ghost as planned", () => {
    expect(eventStatus(job({ status: "PUBLISHED" }))).toEqual({ label: "LIVE", tone: "live" });
    expect(eventStatus(job({ status: "FAILED" }))).toEqual({ label: "FAILED", tone: "failed" });
    expect(eventStatus(ghost())).toEqual({ label: "PLANNED", tone: "planned" });
  });

  it("names a chip by client, platform, time, state and title", () => {
    expect(eventLabel(job(), "19:00")).toBe(
      "Qahwa Co · Instagram · 19:00 · SCHEDULED · Iced cardamom, in two seconds",
    );
    expect(eventLabel(job(), null)).toBe(
      "Qahwa Co · Instagram · moving · SCHEDULED · Iced cardamom, in two seconds",
    );
    expect(eventLabel(ghost(), null)).toBe("Qahwa Co · Facebook · planned · p2");
  });
});

describe("placing items", () => {
  it("puts each item on its client-local day", () => {
    const items = [job(), ghost(), job({ id: "job-2", date: "2026-10-02" })];
    const byDay = placeItems(items, []);
    expect(byDay.get("2026-10-01")?.map((entry) => entry.item.id)).toEqual([
      "job-1",
      "ghost:post-2:FACEBOOK",
    ]);
    expect(byDay.get("2026-10-02")?.map((entry) => entry.moving)).toEqual([false]);
  });

  it("draws a job being moved on its target day, after that day's items", () => {
    const items = [job(), job({ id: "job-2", date: "2026-10-05" })];
    const byDay = placeItems(items, [
      { jobId: "job-1", date: "2026-10-04" },
      { jobId: "job-1", date: "2026-10-05" },
    ]);
    expect(byDay.get("2026-10-01")).toBeUndefined();
    expect(byDay.get("2026-10-04")).toBeUndefined();
    expect(byDay.get("2026-10-05")?.map((entry) => [entry.item.id, entry.moving])).toEqual([
      ["job-2", false],
      ["job-1", true],
    ]);
  });

  it("never moves a ghost", () => {
    const byDay = placeItems([ghost()], [{ jobId: "ghost:post-2:FACEBOOK", date: "2026-10-09" }]);
    expect(byDay.get("2026-10-01")).toHaveLength(1);
  });
});

describe("withJob", () => {
  const range: CalendarResponse = {
    from: "2026-09-28",
    to: "2026-11-01",
    items: [
      job(),
      ghost(),
      job({ id: "job-3", date: "2026-10-03", scheduledFor: "2026-10-03T15:00:00.000Z" }),
    ],
  };

  it("moves the job to its new day and time, keeping the API's order", () => {
    const moved = withJob(range, publishJob());
    expect(moved.items.map((item) => item.id)).toEqual(["ghost:post-2:FACEBOOK", "job-1", "job-3"]);
    expect(moved.items[1]).toMatchObject({
      date: "2026-10-03",
      scheduledFor: "2026-10-03T09:00:00.000Z",
      slotSource: "optimizer",
      slotReason: "Best free hour that day",
      title: "Iced cardamom, in two seconds",
    });
  });

  it("drops a job that moved out of the range, or was cancelled", () => {
    expect(withJob(range, publishJob({ date: "2026-11-02" })).items).toHaveLength(2);
    expect(withJob(range, publishJob({ status: "CANCELLED" })).items).toHaveLength(2);
  });

  it("leaves a range without the job alone", () => {
    expect(withJob(range, publishJob({ id: "elsewhere" }))).toBe(range);
  });
});
