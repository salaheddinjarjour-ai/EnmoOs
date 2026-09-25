import {
  PLATFORM_LIMITS,
  hashtagsIn,
  issuesFromZodError,
  publishedCaption,
  type AssetKind,
  type Issue,
} from "@enmo/shared";
import { PublishError } from "./errors";
import { publishFlowOf, type PublishFlow } from "./flow";
import { isPublicHttpsUrl } from "./public-url";
import { PublishPayload, type PublishMedia } from "./types";

/*
 * Payload validation shared by every publisher: the dry run checks exactly what a live publish
 * would, so a dry-run PUBLISHED means the platform would take the post. Limits come from
 * PLATFORM_LIMITS. Live publishers also require public https media URLs (requirePublicUrls), which
 * dry runs can't: local storage serves http://localhost. Instagram's feed image ratio (4:5–1.91:1)
 * isn't enforced yet: Phase 4 publishes the 9:16 master as is, and the Adapter's crops (Phase 5)
 * bring feed posts inside it.
 */

interface MediaRule {
  minItems: number;
  maxItems: number;
  kinds: readonly AssetKind[];
  /** Bounds for any video in the post, in seconds. */
  videoMinSec: number;
  videoMaxSec: number;
  /** How the post reads in a message ("A reel", "A carousel"). */
  label: string;
}

function mediaRule(flow: PublishFlow, payload: PublishPayload): MediaRule {
  const limits = PLATFORM_LIMITS[payload.platform];
  const single = { minItems: 1, maxItems: 1, videoMinSec: limits.videoMinSec };
  const carousel = {
    minItems: limits.carouselMinItems,
    maxItems: limits.carouselMaxItems,
    videoMinSec: limits.videoMinSec,
  };
  const story = { ...single, videoMaxSec: limits.storyVideoMaxSec ?? 0, label: "A story" };
  switch (flow) {
    case "IG_IMAGE":
    case "FB_PHOTO":
      return { ...single, kinds: ["IMAGE"], videoMaxSec: 0, label: "A single-image post" };
    case "IG_REEL":
    case "FB_REEL":
    case "TIKTOK_VIDEO":
      return { ...single, kinds: ["VIDEO"], videoMaxSec: limits.videoMaxSec, label: "A reel" };
    case "IG_STORY":
      return { ...story, kinds: ["IMAGE", "VIDEO"] };
    case "FB_PHOTO_STORY":
      return { ...story, kinds: ["IMAGE"] };
    case "FB_VIDEO_STORY":
      return { ...story, kinds: ["VIDEO"] };
    case "IG_CAROUSEL":
    case "FB_MULTI_PHOTO":
      return {
        ...carousel,
        kinds: limits.carouselVideos ? ["IMAGE", "VIDEO"] : ["IMAGE"],
        videoMaxSec: limits.carouselVideoMaxSec ?? 0,
        label: "A carousel",
      };
    case "TIKTOK_PHOTO":
      return payload.postType === "CAROUSEL"
        ? { ...carousel, kinds: ["IMAGE"], videoMaxSec: 0, label: "A photo post" }
        : { ...single, kinds: ["IMAGE"], videoMaxSec: 0, label: "A photo post" };
  }
}

function mediaIssues(rule: MediaRule, media: readonly PublishMedia[]): Issue[] {
  const issues: Issue[] = [];
  if (media.length < rule.minItems || media.length > rule.maxItems) {
    const want =
      rule.minItems === rule.maxItems
        ? `exactly ${rule.minItems}`
        : `${rule.minItems} to ${rule.maxItems}`;
    const noun = rule.maxItems === 1 ? "media file" : "media files";
    issues.push({
      path: "media",
      message: `${rule.label} takes ${want} ${noun}, not ${media.length}.`,
    });
  }
  media.forEach((item, index) => {
    if (!rule.kinds.includes(item.kind)) {
      issues.push({
        path: `media[${index}].kind`,
        message: `${rule.label} takes ${rule.kinds.join(" or ")}, not ${item.kind}.`,
      });
      return;
    }
    const duration = item.durationSec;
    if (item.kind !== "VIDEO" || duration === undefined) return;
    if (duration < rule.videoMinSec || duration > rule.videoMaxSec) {
      issues.push({
        path: `media[${index}].durationSec`,
        message: `${rule.label}'s video must run ${rule.videoMinSec}–${rule.videoMaxSec}s, not ${duration}s.`,
      });
    }
  });
  return issues;
}

function captionIssues(payload: PublishPayload): Issue[] {
  const limits = PLATFORM_LIMITS[payload.platform];
  const text = publishedCaption(payload.caption, payload.hashtags);
  const issues: Issue[] = [];
  if (text.length > limits.captionMaxChars) {
    issues.push({
      path: "caption",
      message: `The caption with its hashtags runs ${text.length} characters; the platform takes ${limits.captionMaxChars}.`,
    });
  }
  const tags = hashtagsIn(text).length;
  if (limits.hashtagsMax !== null && tags > limits.hashtagsMax) {
    issues.push({
      path: "hashtags",
      message: `${tags} hashtags; the platform takes ${limits.hashtagsMax}.`,
    });
  }
  return issues;
}

function urlIssues(payload: PublishPayload): Issue[] {
  const issues: Issue[] = [];
  const check = (path: string, url: string) => {
    if (!isPublicHttpsUrl(url)) {
      issues.push({
        path,
        message: `The platform fetches media itself, so ${url} must be a public https URL.`,
      });
    }
  };
  payload.media.forEach((item, index) => check(`media[${index}].url`, item.url));
  if (payload.coverUrl !== undefined) check("coverUrl", payload.coverUrl);
  return issues;
}

export interface PublishValidationOptions {
  /**
   * A live publish: the platform pulls every media file (and the cover) by URL, so each must be
   * https on a public host. Dry runs leave it out, since local storage serves http://localhost.
   */
  requirePublicUrls?: boolean;
}

/** Every rule the payload breaks, at its payload path; [] when the platform would take it. */
export function validatePublishPayload(
  payload: unknown,
  options: PublishValidationOptions = {},
): Issue[] {
  const parsed = PublishPayload.safeParse(payload);
  if (!parsed.success) return issuesFromZodError(parsed.error);
  const value = parsed.data;
  return [
    ...captionIssues(value),
    ...mediaIssues(mediaRule(publishFlowOf(value), value), value.media),
    ...(options.requirePublicUrls ? urlIssues(value) : []),
  ];
}

/** The parsed payload, or a PublishError(INVALID_PAYLOAD) listing every broken rule. */
export function assertPublishable(
  payload: unknown,
  options: PublishValidationOptions = {},
): PublishPayload {
  const issues = validatePublishPayload(payload, options);
  if (issues.length > 0) {
    const summary = issues
      .map((issue) => `${issue.path || "payload"}: ${issue.message}`)
      .join("; ");
    throw new PublishError("INVALID_PAYLOAD", `Not publishable: ${summary}`, { issues });
  }
  return PublishPayload.parse(payload);
}
