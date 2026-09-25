import { assertStorageKey, PublishError, renderJpegFrame, type Storage } from "@enmo/providers";
import {
  PLATFORM_LIMITS,
  type AssetKind,
  type PixelSize,
  type Platform,
  type PostType,
} from "@enmo/shared";

/*
 * What a take is published as where a platform won't fetch the master itself. Instagram fetches
 * images as JPEG only and its feed takes 4:5 to 1.91:1, while every master is a 9:16 PNG (Phase 3).
 * Until the Adapter (Phase 5) cuts native frames around the focus point, an Instagram image take
 * publishes as a JPEG rendition of its master: centre-cropped into the feed's range for feed posts
 * (STATIC, CAROUSEL), whole for a story. A rendition is a file next to its master in Storage, under
 * a key derived from the master's, so the payload can name it before it exists (and validate it
 * exactly as it will go out, dry run or live), a retry reuses it, and it is no Asset row: the
 * approval's content hash doesn't move.
 */

export interface Rendition {
  /** The master's storage key. */
  sourceKey: string;
  /** Where the rendition lives: `<master key without extension>-<platform>-<w>x<h>.jpg`. */
  key: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
}

export interface RenditionTake {
  kind: AssetKind;
  storageKey: string | null;
  mimeType: string | null;
  width: number;
  height: number;
}

const JPEG = "image/jpeg";

/** Post types whose Instagram images go into the feed (IG_IMAGE, IG_CAROUSEL). */
const FEED_POST_TYPES: ReadonlySet<PostType> = new Set(["STATIC", "CAROUSEL"]);

/** The largest centre crop of width×height whose ratio lies in [min, max]. */
export function cropInto(size: PixelSize, range: { min: number; max: number }): PixelSize {
  const ratio = size.width / size.height;
  if (ratio < range.min) {
    return { width: size.width, height: Math.floor(size.width / range.min) };
  }
  if (ratio > range.max) {
    return { width: Math.floor(size.height * range.max), height: size.height };
  }
  return { width: size.width, height: size.height };
}

/** How a take goes out on a platform: the master as it is, a rendition, or not at all. */
export type TakeFrame =
  | { kind: "master" }
  | { kind: "rendition"; rendition: Rendition }
  | { kind: "unavailable"; reason: string };

/**
 * What `platform` fetches for a take in a `postType` post: the master as it is (any video,
 * Facebook, a JPEG already in range) or a rendition of it.
 */
export function takeFrameOf(platform: Platform, postType: PostType, take: RenditionTake): TakeFrame {
  const limits = PLATFORM_LIMITS[platform];
  if (take.kind !== "IMAGE") return { kind: "master" };
  const aspect = FEED_POST_TYPES.has(postType) ? limits.feedImageAspect : null;
  const master = { width: take.width, height: take.height };
  const size = aspect ? cropInto(master, aspect) : master;
  const formatOk = !limits.imageMimeTypes || limits.imageMimeTypes.includes(take.mimeType ?? "");
  const sizeOk = size.width === master.width && size.height === master.height;
  if (formatOk && sizeOk) return { kind: "master" };
  if (!take.storageKey) {
    return { kind: "unavailable", reason: "it has no stored file to cut the platform's frame from" };
  }
  const stem = take.storageKey.replace(/\.[^./]*$/, "");
  return {
    kind: "rendition",
    rendition: {
      sourceKey: take.storageKey,
      key: assertStorageKey(`${stem}-${platform.toLowerCase()}-${size.width}x${size.height}.jpg`),
      mimeType: JPEG,
      width: size.width,
      height: size.height,
    },
  };
}

/**
 * Writes every rendition not in Storage yet (a retry, or a second platform, finds it there). A
 * master missing from Storage is final: nothing a retry could fix.
 */
export async function ensureRenditions(
  storage: Pick<Storage, "exists" | "get" | "put">,
  renditions: readonly Rendition[],
): Promise<void> {
  for (const rendition of renditions) {
    if (await storage.exists(rendition.key)) continue;
    const master = await storage.get(rendition.sourceKey);
    if (!master) {
      throw new PublishError(
        "MEDIA_FAILED",
        `The master ${rendition.sourceKey} is missing from storage, so its JPEG can't be made`,
        { retryable: false },
      );
    }
    const frame = await renderJpegFrame(master.body, rendition);
    await storage.put(rendition.key, frame, rendition.mimeType);
  }
}
