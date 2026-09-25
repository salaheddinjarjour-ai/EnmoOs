import type { PostPlatformPublishDto } from "@enmo/shared";
import { describe, expect, it } from "vitest";
import { hasPublishing, publishLine, publishMark } from "./publishing";

function entry(overrides: Partial<PostPlatformPublishDto> = {}): PostPlatformPublishDto {
  return {
    platform: "INSTAGRAM",
    variantId: "variant-1",
    jobId: "job-1",
    status: "SCHEDULED",
    // 19:00 in Riyadh (UTC+3)
    scheduledFor: "2026-10-01T16:00:00.000Z",
    publishedAt: null,
    liveUrl: null,
    dryRun: true,
    lastError: null,
    ...overrides,
  };
}

const UNSCHEDULED = entry({
  variantId: null,
  jobId: null,
  status: null,
  scheduledFor: null,
  dryRun: null,
});

describe("publishMark", () => {
  it("reads a published job as LIVE, with the live indicator", () => {
    expect(publishMark("PUBLISHED")).toEqual({ label: "LIVE", tone: "live" });
  });

  it("shows the Publisher at work, and failures", () => {
    expect(publishMark("QUEUED").tone).toBe("working");
    expect(publishMark("PUBLISHING").tone).toBe("working");
    expect(publishMark("FAILED")).toEqual({ label: "FAILED", tone: "failed" });
    expect(publishMark("SCHEDULED")).toEqual({ label: "SCHEDULED", tone: "waiting" });
  });
});

describe("publishLine", () => {
  it("says when a scheduled job goes out, in the client's time", () => {
    expect(publishLine(entry(), "Asia/Riyadh")).toEqual({
      mark: { label: "SCHEDULED", tone: "waiting" },
      when: "Thu 1 Oct, 19:00",
      liveUrl: null,
      dryRun: true,
      error: null,
    });
  });

  it("links a live post and says when it went out", () => {
    const live = publishLine(
      entry({
        status: "PUBLISHED",
        publishedAt: "2026-10-01T16:00:05.000Z",
        liveUrl: "https://dryrun.enmo.marketing/instagram/variant-1",
      }),
      "Asia/Riyadh",
    );
    expect(live).toMatchObject({
      mark: { label: "LIVE" },
      when: "Thu 1 Oct, 19:00",
      liveUrl: "https://dryrun.enmo.marketing/instagram/variant-1",
    });
  });

  it("carries a failure's reason, and no link", () => {
    const failed = publishLine(
      entry({ status: "FAILED", lastError: "Token expired", liveUrl: "https://x" }),
      "UTC",
    );
    expect(failed).toMatchObject({ error: "Token expired", liveUrl: null });
  });

  it("marks a platform with no job yet", () => {
    expect(publishLine(UNSCHEDULED, "UTC")).toMatchObject({
      mark: { label: "NOT SCHEDULED" },
      when: null,
      dryRun: false,
    });
  });
});

describe("hasPublishing", () => {
  it("is true once any platform has a job", () => {
    expect(hasPublishing([])).toBe(false);
    expect(hasPublishing([UNSCHEDULED])).toBe(false);
    expect(hasPublishing([UNSCHEDULED, entry({ platform: "FACEBOOK" })])).toBe(true);
  });
});
