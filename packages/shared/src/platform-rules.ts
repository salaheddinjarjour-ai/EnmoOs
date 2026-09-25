import { z } from "zod";
import type { Platform, PostType, VariantFormat } from "./enums";
import { deepFreeze } from "./internal";

/*
 * Platform rules (DESIGN §F): the master every shot is rendered at, each post type's native frame
 * per platform, the platforms' publishing limits, and the best-time priors plus spacing rules the
 * slot optimizer schedules with. Phase 5 adds TikTok's publishing specifics on top of these.
 */

export const AspectRatio = z.enum(["9:16", "4:5", "1:1"]);
export type AspectRatio = z.infer<typeof AspectRatio>;

export interface PixelSize {
  width: number;
  height: number;
}

/** Output pixel size per aspect ratio: 1080 wide, the size every platform ingests natively. */
export const ASPECT_RATIO_SIZE: Readonly<Record<AspectRatio, Readonly<PixelSize>>> = {
  "9:16": { width: 1080, height: 1920 },
  "4:5": { width: 1080, height: 1350 },
  "1:1": { width: 1080, height: 1080 },
};

export function pixelSizeFor(aspectRatio: AspectRatio): PixelSize {
  const { width, height } = ASPECT_RATIO_SIZE[aspectRatio];
  return { width, height };
}

export const VARIANT_FORMAT_ASPECT_RATIO: Readonly<Record<VariantFormat, AspectRatio>> = {
  VERTICAL_9_16: "9:16",
  PORTRAIT_4_5: "4:5",
  SQUARE_1_1: "1:1",
};

export const ASPECT_RATIO_VARIANT_FORMAT: Readonly<Record<AspectRatio, VariantFormat>> = {
  "9:16": "VERTICAL_9_16",
  "4:5": "PORTRAIT_4_5",
  "1:1": "SQUARE_1_1",
};

/**
 * Every master shot is rendered 9:16 (1080×1920), whatever the post type (DESIGN "Phase 3" exit
 * test). The Adapter (Phase 5) cuts each platform's native frame from it by cropping around a focus
 * point: 4:5 and 1:1 for the feeds, 9:16 as is for reels, stories and TikTok's photo mode. A
 * shorter master would have to be upscaled to make those 9:16 frames.
 */
export const MASTER_ASPECT_RATIO: AspectRatio = "9:16";

/**
 * The aspect ratio a post of `postType` is rendered at for `platform`. Every shot is rendered as
 * one master, so every post type and platform gets the master's ratio; each platform's native
 * frame (platformVariantFormat, e.g. a STATIC post is 4:5 on Instagram and 1:1 on Facebook) is
 * cut from it by the Adapter in Phase 5.
 */
export function aspectRatioFor(_postType: PostType, _platform?: Platform): AspectRatio {
  return MASTER_ASPECT_RATIO;
}

/** The ratio a width×height matches exactly, or null (e.g. a provider returned an odd size). */
export function aspectRatioOf(width: number, height: number): AspectRatio | null {
  for (const ratio of AspectRatio.options) {
    const size = ASPECT_RATIO_SIZE[ratio];
    if (width * size.height === height * size.width) return ratio;
  }
  return null;
}

/* ─── Native formats (DESIGN §F "Adapter formats") ─────────────────────────────────────────── */

const VERTICAL_EVERYWHERE = {
  INSTAGRAM: "VERTICAL_9_16",
  FACEBOOK: "VERTICAL_9_16",
  TIKTOK: "VERTICAL_9_16",
} as const satisfies Record<Platform, VariantFormat>;

/** `null`: the platform has no such post (TikTok has no stories). */
const VARIANT_FORMATS: Readonly<
  Record<PostType, Readonly<Record<Platform, VariantFormat | null>>>
> = deepFreeze({
  REEL: { ...VERTICAL_EVERYWHERE },
  TIKTOK: { ...VERTICAL_EVERYWHERE },
  STORY: { INSTAGRAM: "VERTICAL_9_16", FACEBOOK: "VERTICAL_9_16", TIKTOK: null },
  // TikTok takes stills in photo mode, full-screen.
  STATIC: { INSTAGRAM: "PORTRAIT_4_5", FACEBOOK: "SQUARE_1_1", TIKTOK: "VERTICAL_9_16" },
  CAROUSEL: { INSTAGRAM: "PORTRAIT_4_5", FACEBOOK: "SQUARE_1_1", TIKTOK: "VERTICAL_9_16" },
});

/**
 * The native frame of a `postType` post on `platform` (PostVariant.format), or null when the
 * platform can't take that post type at all. Feed frames (4:5, 1:1) are crops of the 9:16 master
 * that the Adapter cuts in Phase 5; until then every variant publishes the master as it is (see
 * variantNeedsCrop).
 */
export function platformVariantFormat(
  postType: PostType,
  platform: Platform,
): VariantFormat | null {
  return VARIANT_FORMATS[postType][platform];
}

export function platformSupportsPostType(platform: Platform, postType: PostType): boolean {
  return platformVariantFormat(postType, platform) !== null;
}

/**
 * Whether the variant's native frame is a crop of the master rather than the master itself
 * (STATIC and CAROUSEL on Instagram and Facebook). Phase 4 publishes these as the uncropped 9:16
 * master: Facebook accepts any photo ratio, but Instagram's feed only takes 4:5 to 1.91:1
 * (PLATFORM_LIMITS.INSTAGRAM.feedImageAspect), so live Instagram feed posts need the Adapter's
 * crops (Phase 5). Payload validation therefore doesn't enforce the feed ratio yet.
 */
export function variantNeedsCrop(postType: PostType, platform: Platform): boolean {
  const format = platformVariantFormat(postType, platform);
  return format !== null && VARIANT_FORMAT_ASPECT_RATIO[format] !== MASTER_ASPECT_RATIO;
}

/* ─── Publishing limits ─────────────────────────────────────────────────────────────────────── */

export interface AspectRange {
  /** width / height */
  min: number;
  max: number;
}

export interface PlatformPublishLimits {
  /** The post text as published: the caption with its hashtags appended (publishedCaption). */
  captionMaxChars: number;
  /** Hashtags in that text; null when the platform sets no cap (the Copywriter's 30 still holds). */
  hashtagsMax: number | null;
  /** Items in one carousel (Instagram), multi-photo post (Facebook) or photo post (TikTok). */
  carouselMinItems: number;
  carouselMaxItems: number;
  /** Whether carousel items may be videos. */
  carouselVideos: boolean;
  /** Longest video inside a carousel, in seconds; null when carousels take no video. */
  carouselVideoMaxSec: number | null;
  /** Reel (feed video) length bounds, in seconds. */
  videoMinSec: number;
  videoMaxSec: number;
  /** Longest story video, in seconds; null when the platform has no stories. */
  storyVideoMaxSec: number | null;
  /** Feed image ratios the platform takes; null when it takes any. */
  feedImageAspect: AspectRange | null;
  /** API-published posts per account in a rolling 24-hour window; null when there's no fixed cap. */
  postsPer24h: number | null;
  /** A separate cap on API-published reels per 24 hours; null when reels share postsPer24h. */
  reelsPer24h: number | null;
}

/**
 * What each platform's publishing API accepts, as Meta and TikTok document it (Instagram Content
 * Publishing, Facebook Pages/Reels/Stories publishing, TikTok Content Posting API). Re-check them
 * on every Graph version upgrade. Instagram's cap is the one `content_publishing_limit` reports
 * (a carousel counts once). Not modelled here: Instagram fetches images as JPEG only, while the
 * Phase 3 masters are PNG, so a live Instagram publish needs a JPEG rendition of each image.
 */
export const PLATFORM_LIMITS: Readonly<Record<Platform, Readonly<PlatformPublishLimits>>> =
  deepFreeze({
    INSTAGRAM: {
      captionMaxChars: 2200,
      hashtagsMax: 30,
      carouselMinItems: 2,
      carouselMaxItems: 10,
      carouselVideos: true,
      carouselVideoMaxSec: 60,
      videoMinSec: 3,
      videoMaxSec: 900,
      storyVideoMaxSec: 60,
      feedImageAspect: { min: 4 / 5, max: 1.91 },
      postsPer24h: 100,
      reelsPer24h: null,
    },
    FACEBOOK: {
      captionMaxChars: 63_206,
      hashtagsMax: null,
      // Facebook takes more photos per post; 10 keeps a carousel in step with its Instagram twin.
      carouselMinItems: 2,
      carouselMaxItems: 10,
      carouselVideos: false,
      carouselVideoMaxSec: null,
      videoMinSec: 3,
      videoMaxSec: 90,
      storyVideoMaxSec: 60,
      feedImageAspect: null,
      postsPer24h: null,
      reelsPer24h: 30,
    },
    TIKTOK: {
      // The video title; photo posts split it into a title (90) and a description (4000).
      captionMaxChars: 2200,
      hashtagsMax: null,
      carouselMinItems: 1,
      carouselMaxItems: 35,
      carouselVideos: false,
      carouselVideoMaxSec: null,
      // The real maximum is per creator (creator_info.max_video_post_duration_sec).
      videoMinSec: 3,
      videoMaxSec: 600,
      storyVideoMaxSec: null,
      feedImageAspect: null,
      // Approximate and shared by every app posting for the creator.
      postsPer24h: 15,
      reelsPer24h: null,
    },
  });

/* ─── Permissions ───────────────────────────────────────────────────────────────────────────── */

/** What the Meta consent screen asks for (DESIGN §F "Meta OAuth"): publishing plus insights. */
export const META_OAUTH_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_insights",
  "read_insights",
  "business_management",
] as const;

/** The scopes an account's token needs before anything can publish through it. */
export const PUBLISH_SCOPES: Readonly<Record<Platform, readonly string[]>> = deepFreeze({
  INSTAGRAM: ["instagram_basic", "instagram_content_publish", "pages_read_engagement"],
  FACEBOOK: ["pages_manage_posts", "pages_read_engagement"],
  TIKTOK: ["user.info.basic", "video.publish"],
});

/** The publishing scopes `granted` lacks, in PUBLISH_SCOPES order ([] when it can publish). */
export function missingPublishScopes(platform: Platform, granted: readonly string[]): string[] {
  const have = new Set(granted);
  return PUBLISH_SCOPES[platform].filter((scope) => !have.has(scope));
}

const HASHTAG = /(?<![\p{L}\p{M}\p{N}_&#])#[\p{L}\p{M}\p{N}_]+/gu;

/** Hashtags written in a text ("#iced", "#قهوة"), in order. */
export function hashtagsIn(text: string): string[] {
  return text.match(HASHTAG) ?? [];
}

/** "iced", "#iced" and " ##iced " all become "#iced"; blank tags become "". */
export function normalizeHashtag(tag: string): string {
  const bare = tag.trim().replace(/^#+/, "");
  return bare ? `#${bare}` : "";
}

/**
 * The text a post goes out with: the caption, then a blank line and the hashtags it doesn't
 * already contain (compared case-insensitively). Limits apply to this text, not the caption alone.
 */
export function publishedCaption(caption: string, hashtags: readonly string[]): string {
  const body = caption.trimEnd();
  const present = new Set(hashtagsIn(body).map((tag) => tag.toLocaleLowerCase()));
  const appended: string[] = [];
  for (const raw of hashtags) {
    const tag = normalizeHashtag(raw);
    const key = tag.toLocaleLowerCase();
    if (!tag || present.has(key)) continue;
    present.add(key);
    appended.push(tag);
  }
  if (appended.length === 0) return body;
  return body ? `${body}\n\n${appended.join(" ")}` : appended.join(" ");
}

/* ─── Best-time priors and slot rules (DESIGN §F "Slot optimizer") ─────────────────────────── */

export const DAYS_PER_WEEK = 7;
export const HOURS_PER_DAY = 24;

/**
 * Weights indexed `[dayOfWeek][hour]` in the client's own time zone: dayOfWeek 0 = Sunday …
 * 6 = Saturday (Date#getDay order, as SlotScore.dayOfWeek), hour 0–23 for the slot starting then.
 */
export type HourOfWeekWeights = readonly (readonly number[])[];

export const SLOT_RULES = {
  /** A slot starts at least this long after now. */
  minLeadMinutes: 30,
  /** Between two posts of one client on one platform. */
  minSpacingHours: 4,
  /** Per client, platform and client-local day. */
  maxPerDayPerClientPlatform: 2,
  /** SlotScore.hourBucket width: 0 = 00:00–02:59 … 7 = 21:00–23:59. */
  bucketHours: 3,
  /** How many posts' worth of evidence the prior counts for in blendSlotScore. */
  priorWeightK: 5,
  /** Top candidates handed to the Publisher agent per variant. */
  candidates: 5,
} as const;

export const SLOT_HOUR_BUCKETS = HOURS_PER_DAY / SLOT_RULES.bucketHours;

const WEEKDAYS = [1, 2, 3, 4, 5] as const;
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6] as const;

/** Hours [from, to) on the given days score `weight`; where windows overlap the highest wins. */
interface PriorWindow {
  days: readonly number[];
  from: number;
  to: number;
  weight: number;
}

/*
 * Weights are on the score scale (engagement rate / the account's baseline, DESIGN §F "Scoring"):
 * 1.0 is an ordinary slot, so blendSlotScore can mix a prior with learned SlotScore means directly.
 * Night (00:00–06:59) is a poor bet everywhere, the rest of the day ordinary-minus; peaks lift a
 * slot 20–35% and the hour either side of a peak counts as ordinary.
 */
const NIGHT_UNTIL = 7;
const NIGHT_WEIGHT = 0.3;
const DAY_WEIGHT = 0.8;
const SHOULDER_WEIGHT = 1;

function peak(days: readonly number[], from: number, to: number, weight: number): PriorWindow[] {
  return [
    { days, from: from - 1, to: from, weight: SHOULDER_WEIGHT },
    { days, from: to, to: to + 1, weight: SHOULDER_WEIGHT },
    { days, from, to, weight },
  ];
}

function hourOfWeek(windows: readonly PriorWindow[]): number[][] {
  return EVERY_DAY.map((day) =>
    Array.from({ length: HOURS_PER_DAY }, (_, hour) => {
      let weight = hour < NIGHT_UNTIL ? NIGHT_WEIGHT : DAY_WEIGHT;
      for (const window of windows) {
        if (window.days.includes(day) && hour >= window.from && hour < window.to) {
          weight = Math.max(weight, window.weight);
        }
      }
      return weight;
    }),
  );
}

/**
 * Best-time priors per platform, in client-local time. They are industry heuristics, not
 * measurements of any client: the consensus of the annual best-time-to-post studies (Sprout
 * Social, Hootsuite, Later), reduced to Instagram weekdays 11–13 and 19–21, Facebook weekdays
 * 9–13, and TikTok every evening 18–22 with Tuesday and Thursday strongest. The learned SlotScore
 * outweighs them as a client's own results come in (blendSlotScore).
 */
export const BEST_TIME_PRIORS: Readonly<Record<Platform, HourOfWeekWeights>> = deepFreeze({
  INSTAGRAM: hourOfWeek([...peak(WEEKDAYS, 11, 13, 1.25), ...peak(WEEKDAYS, 19, 21, 1.25)]),
  FACEBOOK: hourOfWeek(peak(WEEKDAYS, 9, 13, 1.25)),
  TIKTOK: hourOfWeek([...peak(EVERY_DAY, 18, 22, 1.2), ...peak([2, 4], 18, 22, 1.35)]),
});

function assertIndex(value: number, size: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= size) {
    throw new RangeError(`${name} must be an integer from 0 to ${size - 1}, got ${value}`);
  }
}

/** The prior weight of the slot starting at `hour` on `dayOfWeek`, both client-local. */
export function bestTimePrior(platform: Platform, dayOfWeek: number, hour: number): number {
  assertIndex(dayOfWeek, DAYS_PER_WEEK, "dayOfWeek");
  assertIndex(hour, HOURS_PER_DAY, "hour");
  return BEST_TIME_PRIORS[platform][dayOfWeek]![hour]!;
}

/** SlotScore.hourBucket of a client-local hour. */
export function slotHourBucket(hour: number): number {
  assertIndex(hour, HOURS_PER_DAY, "hour");
  return Math.floor(hour / SLOT_RULES.bucketHours);
}

/**
 * A slot's expected score: the prior blended with what the client's own posts in that
 * day-and-bucket scored, `(prior·K + mean·n) / (K + n)` with K = SLOT_RULES.priorWeightK. With no
 * samples it is the prior; after K posts the evidence weighs as much as the prior.
 */
export function blendSlotScore(prior: number, meanScore: number, samples: number): number {
  const n = Math.max(0, samples);
  const k = SLOT_RULES.priorWeightK;
  return (prior * k + meanScore * n) / (k + n);
}
