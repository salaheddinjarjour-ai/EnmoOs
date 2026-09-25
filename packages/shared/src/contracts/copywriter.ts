import { z } from "zod";
import { Platform, type PostType } from "../enums";
import { BrandContext, Brief, Feedback, PostContext } from "./common";

/** Limits the Copywriter validator enforces (and the web CopyEditor warns about). */
export const COPY_LIMITS = {
  captionMaxChars: 2200,
  hashtagsMax: 30,
  scriptMaxSec: 90,
  /** The hook must land by this second, inside the first scene. */
  hookMaxSec: 3,
  /** Allowed gap/overlap between contiguous scenes and between Σ durations and the total. */
  durationToleranceSec: 0.25,
  /**
   * The Visual Director plans one shot per scene and at most VISUAL_LIMITS.shotsMax shots, which
   * is derived from this: a longer script could never get its visuals.
   */
  scenesMax: 12,
  slidesMin: 3,
  slidesMax: 10,
} as const;

/** Which body a post type needs besides the caption. */
export type CopyShape = "script" | "slides" | "onScreenText";

export const COPY_SHAPE_BY_POST_TYPE: Readonly<Record<PostType, CopyShape>> = {
  REEL: "script",
  TIKTOK: "script",
  CAROUSEL: "slides",
  STATIC: "onScreenText",
  STORY: "onScreenText",
};

export const Scene = z.object({
  index: z.int().nonnegative(),
  startSec: z.number().nonnegative(),
  durationSec: z.number().positive(),
  voiceover: z.string(),
  overlayText: z.string(),
  /** Direction for the Visual Director; never shown to the audience. */
  visualNote: z.string(),
});
export type Scene = z.infer<typeof Scene>;

export const Script = z.object({
  totalDurationSec: z.number().positive(),
  hookTimestampSec: z.number().nonnegative(),
  hookText: z.string(),
  scenes: z.array(Scene).min(1),
});
export type Script = z.infer<typeof Script>;

export const Slide = z.object({
  index: z.int().nonnegative(),
  headline: z.string(),
  body: z.string(),
});
export type Slide = z.infer<typeof Slide>;

export const PlatformCaption = z.object({
  platform: Platform,
  caption: z.string(),
});
export type PlatformCaption = z.infer<typeof PlatformCaption>;

/** Copywriter output; also stored as Post.copy and edited by humans (PATCH /posts/:id/copy). */
export const CopywriterOutput = z.object({
  caption: z.string(),
  hashtags: z.array(z.string()),
  cta: z.string(),
  altText: z.string(),
  /** Exactly one per post platform. */
  platformCaptions: z.array(PlatformCaption),
  /** REEL and TIKTOK only. */
  script: Script.nullable(),
  /** CAROUSEL only (3–10). */
  slides: z.array(Slide).nullable(),
  /** STATIC and STORY only. */
  onScreenText: z.string().nullable(),
});
export type CopywriterOutput = z.infer<typeof CopywriterOutput>;

/** A revision round: the feedback (verbatim) plus the copy it is about. */
export const CopyRevision = z.object({
  feedback: Feedback,
  previous: CopywriterOutput,
});
export type CopyRevision = z.infer<typeof CopyRevision>;

export const CopywriterInput = z.object({
  brief: Brief,
  brand: BrandContext,
  post: PostContext,
  revision: CopyRevision.nullable(),
});
export type CopywriterInput = z.infer<typeof CopywriterInput>;
