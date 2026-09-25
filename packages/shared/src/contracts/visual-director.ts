import { z } from "zod";
import { AssetKind, Platform, PostType } from "../enums";
import { AspectRatio } from "../platform-rules";
import { BrandContext, FeedbackInput, PostRef } from "./common";
import { COPY_LIMITS, Script, Slide } from "./copywriter";

/*
 * Visual Director contracts (DESIGN §C). `direct` turns a post's copy into a shot list with provider
 * prompts; `review` looks at one render (the image travels next to the input as an image block, see
 * packages/agents RunAgentOptions.images) and accepts it or asks for a regeneration. Output
 * schemas follow the structured-output rules in ./common.ts; the business rules (one shot per scene
 * or slide, aspect ratios, durations within capabilities, a revised prompt on every regenerate)
 * live in the agents package's validators.
 */

export const VISUAL_LIMITS = {
  shotsMin: 1,
  /**
   * One shot per scene or slide: the longest script or carousel the Copywriter contract allows is
   * the most a post plans, so no copy that passed it can ask for more shots than this.
   */
  shotsMax: Math.max(COPY_LIMITS.scenesMax, COPY_LIMITS.slidesMax),
  scoreMin: 0,
  scoreMax: 10,
  /** The review call sees the render downscaled to this long edge, in pixels. */
  reviewImageMaxEdge: 1568,
} as const;

/** A weak take is regenerated at most this many times (as new Asset versions), then escalated. */
export const MAX_VISUAL_REGENERATIONS = 2;

/** Shot id within one post's shot list: "s1", "s2", … */
export const ShotId = z.string().regex(/^s\d+$/, 'Expected a shot id like "s1"');
export type ShotId = z.infer<typeof ShotId>;

const HexColorString = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Expected a #RRGGBB colour");

/** One render the Visual Director asks a provider for. */
export const Shot = z.object({
  shotId: ShotId,
  /** Script scene this shot illustrates (REEL, TIKTOK); null otherwise. */
  sceneIndex: z.int().nonnegative().nullable(),
  /** Carousel slide this shot illustrates (CAROUSEL); null otherwise. */
  slideIndex: z.int().nonnegative().nullable(),
  kind: AssetKind,
  aspectRatio: AspectRatio,
  /** Clip length for VIDEO shots; null for IMAGE. */
  durationSec: z.number().positive().nullable(),
  /** The provider prompt: subject, setting, composition, light, style. */
  prompt: z.string().min(1),
  /** What the render must not show; "" when nothing beyond the brand's avoid list. */
  negativePrompt: z.string(),
  /** Framing and camera movement, for the human reviewer and video providers. */
  cameraNote: z.string(),
  /** Fixed seed to keep a character or setting consistent across shots; null lets the provider pick. */
  seed: z.int().min(0).max(4_294_967_295).nullable(),
});
export type Shot = z.infer<typeof Shot>;

/** Where a shot (or an asset rendered from one) sits in its post. */
export interface ShotPosition {
  shotId: string | null;
  sceneIndex: number | null;
  slideIndex: number | null;
}

function shotNumber(shotId: string | null): number {
  const match = shotId === null ? null : /^s(\d+)$/.exec(shotId);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

/** Orders shots the way the post reads: by scene or slide, then shot number ("s2" before "s10"). */
export function compareShotPosition(a: ShotPosition, b: ShotPosition): number {
  const place = (shot: ShotPosition) =>
    shot.sceneIndex ?? shot.slideIndex ?? Number.POSITIVE_INFINITY;
  const byPlace = place(a) - place(b);
  if (byPlace !== 0 && !Number.isNaN(byPlace)) return byPlace;
  const byNumber = shotNumber(a.shotId) - shotNumber(b.shotId);
  if (byNumber !== 0 && !Number.isNaN(byNumber)) return byNumber;
  return (a.shotId ?? "").localeCompare(b.shotId ?? "");
}

/** What every shot of one post shares, so the set reads as one piece. */
export const VisualConsistency = z.object({
  /** The recurring person or character, described identically for every shot; null when none. */
  characterDescription: z.string().nullable(),
  /** #RRGGBB colours, drawn from the brand palette. */
  palette: z.array(HexColorString),
  lighting: z.string(),
  styleKeywords: z.array(z.string()),
});
export type VisualConsistency = z.infer<typeof VisualConsistency>;

/* ─── VISUAL_DIRECTOR.direct ─────────────────────────────────────────────────────────────────── */

/** The post as the Visual Director sees it. */
export const VisualDirectPost = z.object({
  ref: PostRef,
  type: PostType,
  platforms: z.array(Platform).min(1),
});
export type VisualDirectPost = z.infer<typeof VisualDirectPost>;

/**
 * The parts of the copy that drive visuals (a script's scenes, slides, or on-screen text). Copy
 * that passed the Copywriter contract always fits the shot cap; longer copy is refused here, before
 * any model call, since no shot list could cover it.
 */
export const VisualDirectCopy = z.object({
  script: Script.extend({ scenes: Script.shape.scenes.max(COPY_LIMITS.scenesMax) }).nullable(),
  slides: z.array(Slide).max(COPY_LIMITS.slidesMax).nullable(),
  onScreenText: z.string().nullable(),
});
export type VisualDirectCopy = z.infer<typeof VisualDirectCopy>;

/** What the active visual provider can render (VisualProvider.capabilities()). */
export const VisualCapabilities = z.object({
  image: z.boolean(),
  video: z.boolean(),
  /** Longest clip it renders, in seconds; 0 when it renders no video. */
  maxVideoSec: z.number().nonnegative(),
});
export type VisualCapabilities = z.infer<typeof VisualCapabilities>;

export const VisualDirectInput = z.object({
  brand: BrandContext,
  post: VisualDirectPost,
  copy: VisualDirectCopy,
  /** Visual feedback (a reviewer's, QA's, or a Vault regenerate instruction), verbatim. */
  feedback: FeedbackInput,
  /** The shot list being revised, when this is a revision or a regenerate. */
  previousShots: z.array(Shot).nullable(),
  capabilities: VisualCapabilities,
});
export type VisualDirectInput = z.infer<typeof VisualDirectInput>;

export const VisualDirectOutput = z.object({
  consistency: VisualConsistency,
  /** One shot per script scene, per carousel slide, or a single shot for single-image posts. */
  shots: z.array(Shot).min(VISUAL_LIMITS.shotsMin).max(VISUAL_LIMITS.shotsMax),
});
export type VisualDirectOutput = z.infer<typeof VisualDirectOutput>;

/* ─── VISUAL_DIRECTOR.review ─────────────────────────────────────────────────────────────────── */

/** The render under review; the pixels themselves are sent as an image block beside the input. */
export const VisualRender = z.object({
  assetId: z.string().min(1),
  kind: AssetKind,
  width: z.int().positive(),
  height: z.int().positive(),
  durationSec: z.number().positive().nullable(),
  /**
   * A stand-in the provider drew instead of generating an image (MockProvider's branded card: the
   * palette as a gradient with the shot's words, its prompt and a "MOCK · s1 · v1" footer printed
   * on it). It can only get the frame and the palette right, so that is all the review judges.
   */
  placeholder: z.boolean(),
});
export type VisualRender = z.infer<typeof VisualRender>;

export const VisualReviewInput = z.object({
  shot: Shot,
  render: VisualRender,
  /** 1 for the first take; each regeneration adds one (at most `maxAttempts`). */
  attempt: z.int().positive(),
  /**
   * The shot's last take before the team decides: 1 + the regenerations the loop allows (the
   * API's MAX_VISUAL_REGENERATIONS, which may lower the shared constant's 2).
   */
  maxAttempts: z
    .int()
    .positive()
    .max(1 + MAX_VISUAL_REGENERATIONS),
  brand: BrandContext,
});
export type VisualReviewInput = z.infer<typeof VisualReviewInput>;

export const VisualReviewVerdict = z.enum(["accept", "regenerate"]);
export type VisualReviewVerdict = z.infer<typeof VisualReviewVerdict>;

export const VisualReviewOutput = z.object({
  verdict: VisualReviewVerdict,
  /** 0–10: on brief, on brand, technically clean. */
  score: z.number().min(VISUAL_LIMITS.scoreMin).max(VISUAL_LIMITS.scoreMax),
  /** What is wrong with the take, one problem per entry; [] for a clean accept. */
  issues: z.array(z.string()),
  /** The prompt for the next take (regenerate only); null on accept. */
  revisedPrompt: z.string().nullable(),
});
export type VisualReviewOutput = z.infer<typeof VisualReviewOutput>;
