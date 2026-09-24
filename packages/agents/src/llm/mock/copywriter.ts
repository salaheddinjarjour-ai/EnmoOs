import {
  COPY_LIMITS,
  COPY_SHAPE_BY_POST_TYPE,
  compileBannedWords,
  type CopywriterInput,
  type CopywriterOutput,
  type Platform,
  type PlatformCaption,
  type Scene,
  type Script,
  type Slide,
} from "@enmo/shared";
import { COPY_BANNED_SCAN_IGNORE } from "../../validators/copy";
import { createRng, hashOf, type Rng } from "./seed";
import { capitalize, clip, hashtag, scrubBannedWords, sentence, titleCase } from "./text";

/*
 * copywriter.write for MockLlm: on-brief, brand-named copy in the right shape for the post type,
 * scene timings built in tenths of a second so they are exactly contiguous, the hook landing by
 * targetHookSec (or within 3s) inside the first scene, and every banned word scrubbed out. A
 * revision is re-seeded by the feedback, prefixed "[rev] " and quotes the feedback it applied.
 */

export const REVISION_PREFIX = "[rev] ";

const FEEDBACK_QUOTE_MAX = 280;

interface CopyContext {
  rng: Rng;
  brand: string;
  focus: string;
  occasion: string | null;
  /** The angle as a caption line: planned angles read "Label: idea", captions want the idea. */
  angleLine: string;
  message: string | null;
  hook: string;
  cta: string;
}

const HOOKS: readonly ((c: Pick<CopyContext, "focus" | "occasion">) => string)[] = [
  (c) => `This is what ${c.occasion ?? "tonight"} tastes like.`,
  (c) => `Stop scrolling: the ${c.focus} just landed.`,
  () => "One sip and the evening slows down.",
  (c) => `You've waited all day for the ${c.focus}.`,
  (c) => `The ${c.focus}, exactly as it should be.`,
];
const CTAS = [
  "Order ahead in the app",
  "Find it at your nearest store",
  "Tap the link in bio to order",
  "Save this for your next visit",
  "Tag who you're sharing it with",
];
const SLIDES: readonly { headline: string; body: (c: CopyContext) => string }[] = [
  { headline: "Why it works", body: (c) => c.angleLine },
  {
    headline: "How we make it",
    body: (c) => `Crafted by ${c.brand}, one considered step at a time.`,
  },
  {
    headline: "When to enjoy it",
    body: (c) => c.message ?? "When the day slows down and you want something considered.",
  },
  { headline: "Pair it with", body: () => "Good company, something sweet and no rush." },
  { headline: "The detail", body: (c) => `Every part of the ${c.focus} is there on purpose.` },
];

function context(input: CopywriterInput): CopyContext {
  const { brief, brand, post, revision } = input;
  const rng = createRng(
    hashOf({
      clientId: brief.clientId,
      title: brief.title,
      post,
      feedback: revision?.feedback.verbatim ?? null,
    }),
  );
  const idea = post.angle.includes(": ")
    ? post.angle.slice(post.angle.indexOf(": ") + 2)
    : post.angle;
  const base = {
    brand: brand.name,
    focus: brief.productFocus ?? "signature range",
    occasion: brief.title.includes(" — ") ? brief.title.split(" — ")[0]! : null,
    angleLine: sentence(capitalize(idea)),
    message: brief.keyMessages.length > 0 ? sentence(rng.pick(brief.keyMessages)) : null,
  };
  return { ...base, rng, hook: post.hook ?? rng.pick(HOOKS)(base), cta: rng.pick(CTAS) };
}

function caption(c: CopyContext, feedback: string | null): string {
  const lines = [
    c.hook,
    "",
    c.angleLine,
    c.message,
    feedback === null ? null : `Reworked per your note: "${clip(feedback, FEEDBACK_QUOTE_MAX)}"`,
    "",
    `${c.cta}.`,
  ];
  return clip(
    lines.filter((line) => line !== null).join("\n"),
    COPY_LIMITS.captionMaxChars - REVISION_PREFIX.length,
  );
}

function platformCaptions(
  platforms: readonly Platform[],
  full: string,
  c: CopyContext,
): PlatformCaption[] {
  return [...new Set(platforms)].map((platform) => {
    switch (platform) {
      case "INSTAGRAM":
        return { platform, caption: full };
      case "FACEBOOK":
        return {
          platform,
          caption: clip(
            `${full}\n\nShare it with someone who'd love it.`,
            COPY_LIMITS.captionMaxChars,
          ),
        };
      case "TIKTOK":
        return { platform, caption: clip(`${c.hook} ${c.cta}.`, 150) };
    }
  });
}

/** Tenths of a second, so starts and durations add up exactly. */
function script(c: CopyContext, targetHookSec: number | null): Script {
  const hookTenths = Math.round(
    Math.min(COPY_LIMITS.hookMaxSec, Math.max(0, targetHookSec ?? c.rng.pick([1, 1.5, 2]))) * 10,
  );
  const firstTenths = Math.max(25, hookTenths + 10);
  const middle = [
    {
      voiceover: c.angleLine,
      overlay: titleCase(c.focus),
      note: `Macro detail of the ${c.focus}, soft directional light.`,
    },
    {
      voiceover: c.message ?? `Made by ${c.brand}, with intent.`,
      overlay: c.brand,
      note: "Hands at work, shallow depth of field.",
    },
    {
      voiceover: `Every detail, considered.`,
      overlay: "Every detail",
      note: "Slow push-in on the finished product.",
    },
  ].slice(0, c.rng.int(2, 3));
  const beats = [
    {
      voiceover: c.hook,
      overlay: clip(c.hook.split(/[:.!?]/)[0]!, 40),
      note: `Open on the ${c.focus} mid-motion: the hook must read without sound.`,
      tenths: firstTenths,
    },
    ...middle.map((beat) => ({ ...beat, tenths: c.rng.pick([30, 35, 40, 50]) })),
    {
      voiceover: `${c.cta}.`,
      overlay: c.cta,
      note: `End card: ${c.brand} logo, product centred.`,
      tenths: 30,
    },
  ];

  let start = 0;
  const scenes: Scene[] = beats.map((beat, index) => {
    const scene = {
      index,
      startSec: start / 10,
      durationSec: beat.tenths / 10,
      voiceover: beat.voiceover,
      overlayText: beat.overlay,
      visualNote: beat.note,
    };
    start += beat.tenths;
    return scene;
  });
  return {
    totalDurationSec: start / 10,
    hookTimestampSec: hookTenths / 10,
    hookText: c.hook,
    scenes,
  };
}

function slides(c: CopyContext): Slide[] {
  const middle = SLIDES.slice(0, c.rng.int(2, 4)).map((slide) => ({
    headline: slide.headline,
    body: slide.body(c),
  }));
  return [
    { headline: c.hook, body: `Swipe for the ${c.focus} story.` },
    ...middle,
    { headline: "Your move", body: `${c.cta}.` },
  ].map((slide, index) => ({ index, ...slide }));
}

function hashtags(c: CopyContext): string[] {
  const tags = [
    hashtag(c.brand),
    c.occasion ? hashtag(c.occasion) : null,
    hashtag(c.focus),
    "#MadeWithIntent",
  ];
  const seen = new Set<string>();
  return tags.filter((tag): tag is string => {
    if (!tag || seen.has(tag.toLowerCase())) return false;
    seen.add(tag.toLowerCase());
    return true;
  });
}

function withRevisionPrefix(copy: CopywriterOutput): CopywriterOutput {
  return {
    ...copy,
    caption: REVISION_PREFIX + copy.caption,
    platformCaptions: copy.platformCaptions.map((pc) => ({
      ...pc,
      caption: clip(REVISION_PREFIX + pc.caption, COPY_LIMITS.captionMaxChars),
    })),
  };
}

export function mockCopy(input: CopywriterInput): CopywriterOutput {
  const c = context(input);
  const feedback = input.revision?.feedback.verbatim ?? null;
  const full = caption(c, feedback);
  const shape = COPY_SHAPE_BY_POST_TYPE[input.post.type];

  const draft: CopywriterOutput = {
    caption: full,
    hashtags: hashtags(c),
    cta: c.cta,
    altText: clip(`The ${c.focus} from ${c.brand}. ${c.angleLine}`, 250),
    platformCaptions: platformCaptions(input.post.platforms, full, c),
    script: shape === "script" ? script(c, input.post.targetHookSec) : null,
    slides: shape === "slides" ? slides(c) : null,
    onScreenText:
      shape === "onScreenText"
        ? input.post.type === "STORY"
          ? `${titleCase(c.focus)}. ${c.cta}.`
          : `${titleCase(c.focus)}. ${c.occasion ? `${c.occasion} nights.` : "Made with intent."}`
        : null,
  };

  const matcher = compileBannedWords(input.brand.bannedWords);
  const clean = scrubBannedWords(draft, matcher, COPY_BANNED_SCAN_IGNORE);
  return feedback === null ? clean : withRevisionPrefix(clean);
}

/** The copy with the brand's first banned word slipped into the caption (the `banned` fault). */
export function mockCopyWithBannedWord(input: CopywriterInput): CopywriterOutput | null {
  const term = input.brand.bannedWords.map((word) => word.trim().replace(/^#+/, "")).find(Boolean);
  if (!term) return null;
  const copy = mockCopy(input);
  return {
    ...copy,
    caption: `${clip(copy.caption, COPY_LIMITS.captionMaxChars - term.length - 1)} ${term}`,
  };
}
