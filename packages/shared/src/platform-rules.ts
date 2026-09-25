import { z } from "zod";
import type { Platform, PostType, VariantFormat } from "./enums";

/*
 * Platform rules (DESIGN §F). Phase 3 needs only the aspect ratio and pixel size of the one master
 * each shot is rendered at; Phase 4 adds limits and best-time priors, and Phase 5 the full
 * per-platform variant format map (IG/FB/TikTok native formats) on top of these.
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
 * The aspect ratio a post of `postType` is rendered at for `platform`. Phase 3 renders one master
 * per shot, so every post type and platform gets the master's ratio; Phase 5's variant format map
 * specialises it per platform (e.g. a STATIC post is 4:5 on Instagram and 1:1 on Facebook).
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
