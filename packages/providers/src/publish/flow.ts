import type { PublishPayload } from "./types";

/**
 * The platform API flow a payload goes through (DESIGN §F):
 * - Instagram: an image, REELS, STORIES or CAROUSEL container, polled until FINISHED, then
 *   media_publish;
 * - Facebook: /photos, a video_reels upload, photo_stories / video_stories, or unpublished photos
 *   attached to one /feed post;
 * - TikTok (Phase 5): a pulled video, or photo mode.
 */
export type PublishFlow =
  | "IG_IMAGE"
  | "IG_REEL"
  | "IG_STORY"
  | "IG_CAROUSEL"
  | "FB_PHOTO"
  | "FB_REEL"
  | "FB_PHOTO_STORY"
  | "FB_VIDEO_STORY"
  | "FB_MULTI_PHOTO"
  | "TIKTOK_VIDEO"
  | "TIKTOK_PHOTO";

export function publishFlowOf(payload: PublishPayload): PublishFlow {
  switch (payload.platform) {
    case "INSTAGRAM":
      switch (payload.postType) {
        case "REEL":
        case "TIKTOK":
          return "IG_REEL";
        case "STORY":
          return "IG_STORY";
        case "STATIC":
          return "IG_IMAGE";
        case "CAROUSEL":
          return "IG_CAROUSEL";
      }
      break;
    case "FACEBOOK":
      switch (payload.postType) {
        case "REEL":
        case "TIKTOK":
          return "FB_REEL";
        case "STORY":
          return payload.media[0]?.kind === "VIDEO" ? "FB_VIDEO_STORY" : "FB_PHOTO_STORY";
        case "STATIC":
          return "FB_PHOTO";
        case "CAROUSEL":
          return "FB_MULTI_PHOTO";
      }
      break;
    case "TIKTOK":
      switch (payload.postType) {
        case "REEL":
        case "TIKTOK":
          return "TIKTOK_VIDEO";
        case "STATIC":
        case "CAROUSEL":
          return "TIKTOK_PHOTO";
      }
  }
}
