import { describe, expect, it } from "vitest";
import {
  BEST_TIME_PRIORS,
  CALENDAR_RANGE_MAX_DAYS,
  CalendarItemDto,
  CalendarQuery,
  CalendarResponse,
  DAYS_PER_WEEK,
  HOURS_PER_DAY,
  META_OAUTH_SCOPES,
  OAuthCallbackQuery,
  OAuthResultQuery,
  OAuthStartResponse,
  PLATFORM_LIMITS,
  PUBLISHER_LIMITS,
  PUBLISH_SCOPES,
  Platform,
  PostType,
  PublishJobDto,
  PublisherInput,
  PublisherOutput,
  ReschedulePublishJobBody,
  SLOT_HOUR_BUCKETS,
  SLOT_RULES,
  SocialAccountMeta,
  bestTimePrior,
  blendSlotScore,
  calendarGhostId,
  hashtagsIn,
  missingPublishScopes,
  oauthReturnPath,
  platformSupportsPostType,
  platformVariantFormat,
  publishedCaption,
  slotHourBucket,
  variantNeedsCrop,
} from "../src";

const now = "2026-10-06T08:00:00.000Z";

// This package compiles without DOM or Node types, so no structuredClone or URL here.
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function queryOf(path: string): Record<string, string> {
  const search = path.slice(path.indexOf("?") + 1);
  return Object.fromEntries(
    search.split("&").map((pair) => {
      const [key = "", value = ""] = pair.split("=");
      return [key, decodeURIComponent(value)];
    }),
  );
}

describe("platformVariantFormat", () => {
  it("follows the DESIGN §F adapter format table", () => {
    const table = Object.fromEntries(
      PostType.options.map((type) => [
        type,
        Platform.options.map((platform) => platformVariantFormat(type, platform)),
      ]),
    );
    // Columns: Instagram, Facebook, TikTok.
    expect(table).toEqual({
      REEL: ["VERTICAL_9_16", "VERTICAL_9_16", "VERTICAL_9_16"],
      TIKTOK: ["VERTICAL_9_16", "VERTICAL_9_16", "VERTICAL_9_16"],
      STORY: ["VERTICAL_9_16", "VERTICAL_9_16", null],
      STATIC: ["PORTRAIT_4_5", "SQUARE_1_1", "VERTICAL_9_16"],
      CAROUSEL: ["PORTRAIT_4_5", "SQUARE_1_1", "VERTICAL_9_16"],
    });
    expect(platformSupportsPostType("TIKTOK", "STORY")).toBe(false);
    expect(platformSupportsPostType("FACEBOOK", "STORY")).toBe(true);
  });

  it("flags the feed frames the Adapter crops from the master", () => {
    expect(variantNeedsCrop("STATIC", "INSTAGRAM")).toBe(true);
    expect(variantNeedsCrop("CAROUSEL", "FACEBOOK")).toBe(true);
    expect(variantNeedsCrop("REEL", "INSTAGRAM")).toBe(false);
    expect(variantNeedsCrop("STATIC", "TIKTOK")).toBe(false);
    expect(variantNeedsCrop("STORY", "TIKTOK")).toBe(false);
  });
});

describe("publishing limits", () => {
  it("keeps Instagram's documented limits", () => {
    expect(PLATFORM_LIMITS.INSTAGRAM).toMatchObject({
      captionMaxChars: 2200,
      hashtagsMax: 30,
      carouselMinItems: 2,
      carouselMaxItems: 10,
      postsPer24h: 100,
    });
    expect(Object.isFrozen(PLATFORM_LIMITS.FACEBOOK)).toBe(true);
  });

  it("composes the published caption with each hashtag once", () => {
    expect(
      publishedCaption("Cold brew after iftar #Iced  ", ["iced", "#ramadan", " ", "##qahwa"]),
    ).toBe("Cold brew after iftar #Iced\n\n#ramadan #qahwa");
    expect(publishedCaption("Plain", [])).toBe("Plain");
    expect(publishedCaption("", ["a"])).toBe("#a");
    expect(hashtagsIn("قهوة #قهوة_باردة and #iced, not a#b or &#35;")).toEqual([
      "#قهوة_باردة",
      "#iced",
    ]);
  });

  it("lists missing publish scopes", () => {
    expect(missingPublishScopes("INSTAGRAM", [...META_OAUTH_SCOPES])).toEqual([]);
    expect(missingPublishScopes("FACEBOOK", [...META_OAUTH_SCOPES])).toEqual([]);
    expect(missingPublishScopes("INSTAGRAM", ["instagram_basic"])).toEqual([
      "instagram_content_publish",
      "pages_read_engagement",
    ]);
    expect(PUBLISH_SCOPES.TIKTOK).toContain("video.publish");
  });
});

describe("best-time priors", () => {
  it("has a full hour-of-week table per platform", () => {
    for (const platform of Platform.options) {
      const table = BEST_TIME_PRIORS[platform];
      expect(table).toHaveLength(DAYS_PER_WEEK);
      for (const day of table) {
        expect(day).toHaveLength(HOURS_PER_DAY);
        for (const weight of day) expect(weight).toBeGreaterThan(0);
      }
    }
  });

  it("peaks where the heuristics say (client-local, 0 = Sunday)", () => {
    const tuesday = 2;
    const saturday = 6;
    expect(bestTimePrior("INSTAGRAM", tuesday, 12)).toBeGreaterThan(
      bestTimePrior("INSTAGRAM", tuesday, 16),
    );
    expect(bestTimePrior("INSTAGRAM", tuesday, 20)).toBe(bestTimePrior("INSTAGRAM", tuesday, 11));
    expect(bestTimePrior("INSTAGRAM", saturday, 12)).toBeLessThan(
      bestTimePrior("INSTAGRAM", tuesday, 12),
    );
    expect(bestTimePrior("FACEBOOK", 1, 9)).toBeGreaterThan(bestTimePrior("FACEBOOK", 1, 15));
    expect(bestTimePrior("TIKTOK", tuesday, 19)).toBeGreaterThan(bestTimePrior("TIKTOK", 3, 19));
    expect(bestTimePrior("TIKTOK", 0, 19)).toBeGreaterThan(bestTimePrior("TIKTOK", 0, 12));
    expect(bestTimePrior("INSTAGRAM", tuesday, 3)).toBeLessThan(
      bestTimePrior("INSTAGRAM", tuesday, 16),
    );
    expect(() => bestTimePrior("INSTAGRAM", 7, 0)).toThrow(RangeError);
    expect(() => bestTimePrior("INSTAGRAM", 0, 24)).toThrow(RangeError);
  });

  it("buckets hours and blends priors with learned scores", () => {
    expect(SLOT_RULES).toEqual({
      minLeadMinutes: 30,
      minSpacingHours: 4,
      maxPerDayPerClientPlatform: 2,
      bucketHours: 3,
      priorWeightK: 5,
      candidates: 5,
    });
    expect(SLOT_HOUR_BUCKETS).toBe(8);
    expect([0, 2, 3, 11, 12, 23].map(slotHourBucket)).toEqual([0, 0, 1, 3, 4, 7]);
    expect(blendSlotScore(1.2, 3, 0)).toBe(1.2);
    expect(blendSlotScore(1, 2, 5)).toBe(1.5);
    expect(blendSlotScore(1, 2, 95)).toBeCloseTo(1.95);
  });
});

describe("publisher contract", () => {
  const input = {
    campaign: { name: "Ramadan iced line", window: { start: "2027-02-01", end: "2027-02-28" } },
    briefSummary: "Push the iced line after iftar.",
    timezone: "Asia/Riyadh",
    items: [
      {
        variantId: "v1",
        platform: "INSTAGRAM",
        postType: "REEL",
        targetDate: "2027-02-10",
        candidates: [
          { slotStart: "2027-02-10T09:00:00.000Z", score: 1.25, reasons: ["weekday lunch peak"] },
        ],
      },
    ],
  };

  it("parses input with at most the optimizer's candidates", () => {
    expect(PublisherInput.parse(input)).toEqual(input);
    const tooMany = clone(input);
    const candidate = tooMany.items[0]!.candidates[0]!;
    tooMany.items[0]!.candidates = Array.from(
      { length: PUBLISHER_LIMITS.candidatesMax + 1 },
      () => candidate,
    );
    expect(PublisherInput.safeParse(tooMany).success).toBe(false);
    const none = clone(input);
    none.items[0]!.candidates = [];
    expect(PublisherInput.safeParse(none).success).toBe(false);
  });

  it("keeps membership in the candidates a business rule", () => {
    const output = {
      assignments: [{ variantId: "v1", slotStart: "not a candidate", reason: "Lunch peak." }],
    };
    expect(PublisherOutput.safeParse(output).success).toBe(true);
    expect(PublisherOutput.safeParse({ assignments: [{ variantId: "v1" }] }).success).toBe(false);
  });
});

describe("calendar and publish-job DTOs", () => {
  it("bounds the calendar range", () => {
    expect(CalendarQuery.parse({ from: "2027-02-01", to: "2027-03-14" })).toEqual({
      from: "2027-02-01",
      to: "2027-03-14",
    });
    expect(CalendarQuery.safeParse({ from: "2027-02-10", to: "2027-02-01" }).success).toBe(false);
    const limit = new Date(Date.UTC(2027, 0, 1 + CALENDAR_RANGE_MAX_DAYS))
      .toISOString()
      .slice(0, 10);
    expect(CalendarQuery.safeParse({ from: "2027-01-01", to: limit }).success).toBe(false);
  });

  it("carries jobs and ghost slots", () => {
    const base = {
      postId: "post1",
      campaignId: "camp1",
      clientId: "c1",
      clientName: "Qahwa Co",
      platform: "INSTAGRAM",
      postType: "REEL",
      date: "2027-02-10",
      timezone: "Asia/Riyadh",
      title: "The first sip after iftar",
      thumbUrl: null,
    };
    const job = {
      ...base,
      kind: "job",
      id: "job1",
      variantId: "v1",
      status: "SCHEDULED",
      scheduledFor: "2027-02-10T09:00:00.000Z",
      publishedAt: null,
      liveUrl: null,
      dryRun: true,
      slotSource: "publisher",
      slotReason: "Weekday lunch peak.",
      lastError: null,
    };
    const ghost = {
      ...base,
      kind: "ghost",
      platform: "FACEBOOK",
      id: calendarGhostId("post1", "FACEBOOK"),
      postStatus: "APPROVED",
    };
    const response = CalendarResponse.parse({
      from: "2027-02-01",
      to: "2027-02-28",
      items: [job, ghost],
    });
    expect(response.items.map((item) => item.kind)).toEqual(["job", "ghost"]);
    expect(ghost.id).toBe("ghost:post1:FACEBOOK");
    expect(CalendarItemDto.safeParse({ ...job, slotSource: "llm" }).success).toBe(false);
  });

  it("describes a job without its resume handle", () => {
    const dto = PublishJobDto.parse({
      id: "job1",
      variantId: "v1",
      postId: "post1",
      campaignId: "camp1",
      clientId: "c1",
      platform: "FACEBOOK",
      postType: "STATIC",
      status: "PUBLISHED",
      scheduledFor: now,
      date: "2026-10-06",
      timezone: "Asia/Riyadh",
      slotSource: "optimizer",
      slotReason: null,
      dryRun: true,
      attempts: 1,
      socialAccountId: null,
      externalId: "dryrun_v1",
      liveUrl: "https://dryrun.enmo.marketing/facebook/v1",
      lastError: null,
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
      containerId: "ignored",
    });
    expect(dto).not.toHaveProperty("containerId");
    expect(ReschedulePublishJobBody.safeParse({ date: "2027-02-11" }).success).toBe(true);
    expect(ReschedulePublishJobBody.safeParse({ date: "2027-02-11T10:00:00Z" }).success).toBe(
      false,
    );
  });
});

describe("OAuth DTOs", () => {
  it("parses a start response and the provider's callback", () => {
    expect(
      OAuthStartResponse.safeParse({
        authorizeUrl: "https://www.facebook.com/v26.0/dialog/oauth?x=1",
      }).success,
    ).toBe(true);
    expect(
      OAuthCallbackQuery.parse({
        error: "access_denied",
        error_reason: "user_denied",
        error_description: "Permissions error",
        state: "s1",
      }),
    ).toMatchObject({ error: "access_denied", state: "s1" });
  });

  it("round-trips the result query through the return path", () => {
    const path = oauthReturnPath("c 1", { oauth: "meta", outcome: "connected", connected: 2 });
    expect(path).toBe("/clients/c%201?tab=accounts&oauth=meta&outcome=connected&connected=2");
    expect(OAuthResultQuery.parse(queryOf(path))).toEqual({
      oauth: "meta",
      outcome: "connected",
      connected: 2,
    });
    expect(
      oauthReturnPath("c1", { oauth: "meta", outcome: "error", message: "You declined & left" }),
    ).toContain("message=You%20declined%20%26%20left");
  });

  it("keeps Meta's page and Instagram ids in account meta", () => {
    expect(
      SocialAccountMeta.parse({
        pageId: "p1",
        pageName: "Qahwa",
        igUserId: "ig1",
        source: "oauth",
      }),
    ).toEqual({ pageId: "p1", pageName: "Qahwa", igUserId: "ig1", source: "oauth" });
    expect(SocialAccountMeta.safeParse({ source: "sso" }).success).toBe(false);
  });
});
