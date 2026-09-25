import {
  ASPECT_RATIO_SIZE,
  type AspectRatio,
  type AssetKind,
  type AssetStatus,
  type AssetThumbDto,
  type PixelSize,
} from "@enmo/shared";
import type { CSSProperties } from "react";

/*
 * How a take (an Asset) is shown, shared by the Vault and the post card's preview. Pure, so it is
 * unit-tested. A take has a still once its file exists: the poster of a video, the file itself for
 * an image (MockProvider's "video" is a poster PNG, so it is both). Takes the Visual Director
 * rejected keep their file, so the lineage can still show them.
 */

/** The fields every view of a take reads (AssetThumbDto and AssetDto both have them). */
export type TakeMedia = Pick<
  AssetThumbDto,
  "kind" | "status" | "url" | "posterUrl" | "mimeType" | "width" | "height" | "durationSec"
>;

const IN_FLIGHT: ReadonlySet<AssetStatus> = new Set(["QUEUED", "RENDERING"]);

/** Queued or rendering: the frame shimmers until the file lands. */
export function isRendering(status: AssetStatus): boolean {
  return IN_FLIGHT.has(status);
}

/** The image to draw for a take, or null while there is none (still rendering, or failed). */
export function stillUrlOf(take: TakeMedia): string | null {
  if (isRendering(take.status)) return null;
  if (take.posterUrl) return take.posterUrl;
  if (take.url && (take.mimeType === null || take.mimeType.startsWith("image/"))) return take.url;
  return null;
}

/** A real clip to play (Higgsfield video); null for images and MockProvider's poster-only video. */
export function playableVideoUrl(take: TakeMedia): string | null {
  return take.status === "READY" && take.url && take.mimeType?.startsWith("video/")
    ? take.url
    : null;
}

/** Whether the take stands for a clip, so it wears the video badge. */
export function isVideoTake(take: { kind: AssetKind; params?: { mockVideo: boolean } }): boolean {
  return take.kind === "VIDEO" || take.params?.mockVideo === true;
}

/**
 * The shape to frame a take in: its planned aspect ratio, else its measured pixels, else the
 * fallback (the post type's master ratio), so a take that hasn't rendered yet already has its shape.
 */
export function frameSizeOf(
  take: Pick<TakeMedia, "width" | "height"> & { aspectRatio?: AspectRatio | null },
  fallback: AspectRatio,
): PixelSize {
  if (take.aspectRatio) return ASPECT_RATIO_SIZE[take.aspectRatio];
  if (take.width && take.height) return { width: take.width, height: take.height };
  return ASPECT_RATIO_SIZE[fallback];
}

/**
 * Inline style for a box of `size`'s proportions, as large as fits inside a size container
 * (`[container-type:size]`): width is capped by the container's width and by its height × ratio.
 * One rule for every frame, whatever the container's own shape.
 */
export function fitStyle({ width, height }: PixelSize): CSSProperties {
  return {
    aspectRatio: `${width} / ${height}`,
    width: `min(100cqw, calc(100cqh * ${width} / ${height}))`,
  };
}

export type PreviewVisual =
  | { mode: "image"; take: AssetThumbDto; index: number; count: number }
  | { mode: "rendering"; lead: AssetThumbDto; count: number }
  | { mode: "none" };

/**
 * What a post preview draws from PostDto.currentAssets (in shot order): the first shot's still;
 * the shimmer while it renders; if the first shot failed, the next shot with a still; otherwise
 * nothing, and the preview falls back to the text frame.
 */
export function previewVisual(takes: readonly AssetThumbDto[]): PreviewVisual {
  const count = takes.length;
  const [lead] = takes;
  if (!lead) return { mode: "none" };
  if (isRendering(lead.status)) return { mode: "rendering", lead, count };
  const index = takes.findIndex((take) => stillUrlOf(take) !== null);
  if (index >= 0) return { mode: "image", take: takes[index]!, index, count };
  const rendering = takes.find((take) => isRendering(take.status));
  if (rendering) return { mode: "rendering", lead: rendering, count };
  return { mode: "none" };
}
