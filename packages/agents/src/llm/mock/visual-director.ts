import {
  COPY_SHAPE_BY_POST_TYPE,
  aspectRatioFor,
  compileBannedWords,
  type Shot,
  type VisualConsistency,
  type VisualDirectInput,
  type VisualDirectOutput,
  type VisualReviewInput,
  type VisualReviewOutput,
} from "@enmo/shared";
import {
  VISUAL_BANNED_SCAN_IGNORE,
  expectedShotSlots,
  slotKey,
  type ShotSlot,
} from "../../validators/visual-director";
import type { MockCall } from "./call";
import { createRng, hashOf, type Rng } from "./seed";
import { clip, scrubBannedWords } from "./text";

/*
 * VISUAL_DIRECTOR.direct and .review for MockLlm (registered in ./index.ts).
 *
 * direct: one shot per slot the contract asks for, prompts built from the scene, slide or on-screen
 * words plus the brand's visual style, VIDEO for script scenes when the provider renders video, and
 * a seed unique to the post and shot. A revision quotes the feedback in every prompt it rewrites;
 * a regenerate without feedback re-rolls the seed.
 *
 * review: accepts a take whose image matches the shot's aspect ratio (it reads the PNG header of
 * the image the call carried) and asks for another take otherwise. Fault counts are kept per
 * subject: the review subject is the shot's place and seed, which every take of one shot keeps
 * (a regeneration changes only the prompt), so "VISUAL_DIRECTOR.review:weak*3" gives each shot
 * two regenerations and then an escalation.
 */

const FEEDBACK_QUOTE_MAX = 200;
const PROMPT_TEXT_MAX = 160;

const CAMERA_NOTES = [
  "Slow push-in, eye level",
  "Locked-off, low angle",
  "Gentle handheld drift, close",
  "Overhead, static",
  "Slow lateral dolly, medium shot",
];
const DEFAULT_KEYWORDS = ["cinematic", "intimate", "considered"];
const DEFAULT_LIGHTING = "Warm, low directional light with soft falloff";

/** The words a shot illustrates (never printed on the image). */
function slotWords(input: VisualDirectInput, slot: ShotSlot): string {
  const { copy } = input;
  if (slot.sceneIndex !== null) {
    const scene = copy.script?.scenes.find((candidate) => candidate.index === slot.sceneIndex);
    if (scene) return `${scene.visualNote} It carries the line "${scene.voiceover}".`;
  }
  if (slot.slideIndex !== null) {
    const slide = copy.slides?.find((candidate) => candidate.index === slot.slideIndex);
    if (slide) return `An image for the carousel slide "${slide.headline}": ${slide.body}`;
  }
  return copy.onScreenText
    ? `A hero image for the words "${copy.onScreenText}".`
    : "A hero image of the product in its best moment.";
}

function consistencyOf(input: VisualDirectInput): VisualConsistency {
  const style = input.brand.visualStyle;
  const { primary, secondary, accent, background } = style.palette;
  return {
    characterDescription: null,
    palette: [...new Set([primary, secondary, accent, background].map((c) => c.toUpperCase()))],
    lighting: style.lighting || DEFAULT_LIGHTING,
    styleKeywords: style.keywords.length > 0 ? style.keywords.slice(0, 6) : DEFAULT_KEYWORDS,
  };
}

function shotSeed(input: VisualDirectInput, shotId: string, previous: Shot | undefined): number {
  const base = { clientId: input.brand.clientId, ref: input.post.ref, type: input.post.type };
  // A regenerate with nothing to change must still render something new.
  const reroll = previous && input.feedback === null ? { reroll: previous.seed } : {};
  return hashOf({ ...base, shotId, ...reroll });
}

function buildShot(
  input: VisualDirectInput,
  slot: ShotSlot,
  shotId: string,
  consistency: VisualConsistency,
  rng: Rng,
  previous: Shot | undefined,
): Shot {
  const style = input.brand.visualStyle;
  const scripted = COPY_SHAPE_BY_POST_TYPE[input.post.type] === "script";
  const { video, maxVideoSec } = input.capabilities;
  const scene =
    slot.sceneIndex === null
      ? undefined
      : input.copy.script?.scenes.find((candidate) => candidate.index === slot.sceneIndex);
  const asVideo = scripted && video && maxVideoSec > 0;
  const duration = asVideo
    ? Math.max(1, Math.min(maxVideoSec, Math.round((scene?.durationSec ?? 3) * 10) / 10))
    : null;

  const feedback = input.feedback?.verbatim ?? null;
  const prompt = [
    clip(slotWords(input, slot), PROMPT_TEXT_MAX * 2),
    `Shot for ${input.brand.name}.`,
    style.imagery ? clip(style.imagery, PROMPT_TEXT_MAX) : null,
    `${consistency.lighting}.`,
    `Palette ${consistency.palette.join(", ")}; ${consistency.styleKeywords.join(", ")}.`,
    `${aspectRatioFor(input.post.type)} frame with calm negative space for text set later.`,
    feedback === null ? null : `Revision: ${clip(feedback, FEEDBACK_QUOTE_MAX)}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");

  return {
    shotId,
    sceneIndex: slot.sceneIndex,
    slideIndex: slot.slideIndex,
    kind: asVideo ? "VIDEO" : "IMAGE",
    aspectRatio: aspectRatioFor(input.post.type),
    durationSec: duration,
    prompt,
    negativePrompt: ["text", "watermarks", "logos", ...style.avoid].join(", "),
    cameraNote: rng.pick(CAMERA_NOTES),
    seed: shotSeed(input, shotId, previous),
  };
}

/** One post's direction, stable across its revisions (so a retried post doesn't fault again). */
export function visualDirectSubject(input: VisualDirectInput): unknown {
  return { clientId: input.brand.clientId, post: [input.post.ref, input.post.type] };
}

export function mockVisualDirect(input: VisualDirectInput, _call: MockCall): VisualDirectOutput {
  const rng = createRng(
    hashOf({
      clientId: input.brand.clientId,
      post: input.post,
      feedback: input.feedback?.verbatim ?? null,
    }),
  );
  const consistency = consistencyOf(input);
  const previousBySlot = new Map((input.previousShots ?? []).map((s) => [slotKey(s), s]));
  // A place the previous list didn't have gets the first id none of its shots uses.
  const used = new Set((input.previousShots ?? []).map((shot) => shot.shotId));
  let counter = 0;
  const freshId = (): string => {
    do counter += 1;
    while (used.has(`s${counter}`));
    used.add(`s${counter}`);
    return `s${counter}`;
  };
  const shots = expectedShotSlots(input).map((slot) => {
    const previous = previousBySlot.get(slotKey(slot));
    return buildShot(input, slot, previous?.shotId ?? freshId(), consistency, rng, previous);
  });
  const output: VisualDirectOutput = { consistency, shots };
  return scrubBannedWords(
    output,
    compileBannedWords(input.brand.bannedWords),
    VISUAL_BANNED_SCAN_IGNORE,
  );
}

/** A shot list with the brand's first banned word in a prompt; null falls back to `invalid`. */
export function mockVisualDirectWithBannedWord(
  input: VisualDirectInput,
): VisualDirectOutput | null {
  const term = input.brand.bannedWords.map((word) => word.trim().replace(/^#+/, "")).find(Boolean);
  if (!term) return null;
  const output = mockVisualDirect(input, { images: [] });
  const [first, ...rest] = output.shots;
  if (!first) return null;
  return { ...output, shots: [{ ...first, prompt: `${first.prompt} ${term}` }, ...rest] };
}

/* ─── review ─────────────────────────────────────────────────────────────────────────────────── */

/** Every take of one shot shares its place and seed; only the prompt changes between takes. */
export function visualReviewSubject(input: VisualReviewInput): unknown {
  const { shot } = input;
  return {
    clientId: input.brand.clientId,
    place: [shot.shotId, shot.sceneIndex, shot.slideIndex],
    seed: shot.seed,
  };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from a base64 PNG's IHDR chunk; null for anything else. */
export function pngSize(base64: string): { width: number; height: number } | null {
  const head = Buffer.from(base64.slice(0, 44), "base64");
  if (head.length < 24 || PNG_SIGNATURE.some((byte, i) => head[i] !== byte)) return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

const RATIO_VALUE: Readonly<Record<Shot["aspectRatio"], number>> = {
  "9:16": 9 / 16,
  "4:5": 4 / 5,
  "1:1": 1,
};

/** The render the call carried; a review without one never saw the take. */
function renderOf(call: MockCall): MockCall["images"][number] {
  const image = call.images[0];
  if (!image) {
    throw new Error(
      "MockLlm VISUAL_DIRECTOR.review got no image: the render never reached the model",
    );
  }
  return image;
}

/** The prompt for take `take`: the base prompt plus one note, replacing an earlier take's note. */
export function promptForTake(prompt: string, take: number, note: string): string {
  const base = prompt.replace(/ — take \d+: [^—]*$/u, "").trimEnd();
  return `${base} — take ${take}: ${note}`;
}

function score(input: VisualReviewInput, low: number, high: number): number {
  const rng = createRng(hashOf({ subject: visualReviewSubject(input), prompt: input.shot.prompt }));
  return Math.round((low + rng.next() * (high - low)) * 10) / 10;
}

export function mockVisualReview(input: VisualReviewInput, call: MockCall): VisualReviewOutput {
  const image = renderOf(call);
  const size = image.mediaType === "image/png" ? pngSize(image.data) : null;
  if (size && Math.abs(size.width / size.height - RATIO_VALUE[input.shot.aspectRatio]) > 0.01) {
    return {
      verdict: "regenerate",
      score: score(input, 2, 4),
      issues: [
        `The render is ${size.width}×${size.height}, not the ${input.shot.aspectRatio} frame the shot asks for.`,
      ],
      revisedPrompt: promptForTake(
        input.shot.prompt,
        input.attempt + 1,
        `compose for a ${input.shot.aspectRatio} frame`,
      ),
    };
  }
  return { verdict: "accept", score: score(input, 7.6, 9.2), issues: [], revisedPrompt: null };
}

/** A valid `regenerate` verdict (the `weak` fault). */
export function mockWeakVisualReview(input: VisualReviewInput, call: MockCall): VisualReviewOutput {
  renderOf(call);
  return {
    verdict: "regenerate",
    score: score(input, 3.5, 4.9),
    issues: [
      "The subject sits too small in the frame and gets lost against the background.",
      "Contrast is flat: the brand's accent colour barely reads.",
    ],
    revisedPrompt: promptForTake(
      input.shot.prompt,
      input.attempt + 1,
      "tighter framing so the subject fills two thirds of the frame, deeper contrast, the accent colour on the key object",
    ),
  };
}
