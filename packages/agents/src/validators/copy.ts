import {
  COPY_LIMITS,
  COPY_SHAPE_BY_POST_TYPE,
  PLATFORM_LABEL,
  compileBannedWords,
  scanForBannedWords,
  type AutomatedCheck,
  type BannedWordMatcher,
  type CopyRevision,
  type CopywriterInput,
  type CopywriterOutput,
  type Issue,
  type PostContext,
  type Script,
  type Slide,
} from "@enmo/shared";

/*
 * Copywriter business rules (DESIGN §C), grouped by rule so the same code feeds the runner's retry
 * loop and the Manager's automated checks. Messages are written for the model to act on.
 */

export const COPY_RULES = [
  "shape",
  "script_timing",
  "slides",
  "captions",
  "platform_captions",
  "hashtags",
  "banned_words",
] as const;
export type CopyRule = (typeof COPY_RULES)[number];

/** Ignored by the banned-word scan: enum values, not prose. */
export const COPY_BANNED_SCAN_IGNORE = ["platform"] as const;

const TOLERANCE = COPY_LIMITS.durationToleranceSec;
const HASHTAG = /^#[\p{L}\p{N}_]+$/u;

const round = (seconds: number) => Math.round(seconds * 100) / 100;

function blank(text: string): boolean {
  return text.trim().length === 0;
}

function shapeIssues(copy: CopywriterOutput, post: PostContext): Issue[] {
  const issues: Issue[] = [];
  const shape = COPY_SHAPE_BY_POST_TYPE[post.type];
  const wantNull = (field: "script" | "slides" | "onScreenText") => {
    if (copy[field] !== null) {
      issues.push({ path: field, message: `A ${post.type} post has no ${field}; set it to null.` });
    }
  };
  switch (shape) {
    case "script":
      if (copy.script === null) {
        issues.push({
          path: "script",
          message: `A ${post.type} post needs a script (scenes, hook and timings).`,
        });
      }
      wantNull("slides");
      wantNull("onScreenText");
      break;
    case "slides":
      if (copy.slides === null) {
        issues.push({
          path: "slides",
          message: `A CAROUSEL post needs ${COPY_LIMITS.slidesMin}–${COPY_LIMITS.slidesMax} slides.`,
        });
      }
      wantNull("script");
      wantNull("onScreenText");
      break;
    case "onScreenText":
      if (copy.onScreenText === null || blank(copy.onScreenText)) {
        issues.push({
          path: "onScreenText",
          message: `A ${post.type} post needs onScreenText: the words on the image.`,
        });
      }
      wantNull("script");
      wantNull("slides");
      break;
  }
  return issues;
}

function scriptIssues(script: Script, post: PostContext): Issue[] {
  const issues: Issue[] = [];
  const { scenes } = script;

  if (script.totalDurationSec > COPY_LIMITS.scriptMaxSec) {
    issues.push({
      path: "script.totalDurationSec",
      message: `The script runs ${script.totalDurationSec}s; keep it to ${COPY_LIMITS.scriptMaxSec}s or less.`,
    });
  }
  if (blank(script.hookText)) {
    issues.push({ path: "script.hookText", message: "Write the hook line the first scene lands." });
  }
  if (scenes.length > COPY_LIMITS.scenesMax) {
    issues.push({
      path: "script.scenes",
      message: `The script has ${scenes.length} scenes; use at most ${COPY_LIMITS.scenesMax} (each scene gets its own shot), merging beats that share a visual.`,
    });
  }

  let expectedStart = 0;
  let total = 0;
  scenes.forEach((scene, i) => {
    if (scene.index !== i) {
      issues.push({
        path: `script.scenes[${i}].index`,
        message: `Scene indexes run 0, 1, 2…; this one should be ${i}.`,
      });
    }
    if (Math.abs(scene.startSec - expectedStart) > TOLERANCE) {
      issues.push({
        path: `script.scenes[${i}].startSec`,
        message:
          i === 0
            ? `The first scene must start at 0s, not ${scene.startSec}s.`
            : `Scene ${i} starts at ${scene.startSec}s but scene ${i - 1} ends at ${round(expectedStart)}s; scenes must be contiguous (±${TOLERANCE}s).`,
      });
    }
    if (blank(scene.voiceover) && blank(scene.overlayText)) {
      issues.push({
        path: `script.scenes[${i}]`,
        message: "Each scene needs voiceover or overlay text.",
      });
    }
    expectedStart = scene.startSec + scene.durationSec;
    total += scene.durationSec;
  });

  if (Math.abs(total - script.totalDurationSec) > TOLERANCE) {
    issues.push({
      path: "script.totalDurationSec",
      message: `The scene durations add up to ${round(total)}s but totalDurationSec is ${script.totalDurationSec}s (±${TOLERANCE}s).`,
    });
  }

  const hookLimit = COPY_LIMITS.hookMaxSec;
  if (script.hookTimestampSec > hookLimit) {
    issues.push({
      path: "script.hookTimestampSec",
      message: `The hook lands at ${script.hookTimestampSec}s; it must land within the first ${hookLimit}s.`,
    });
  } else if (
    post.targetHookSec !== null &&
    script.hookTimestampSec > post.targetHookSec + TOLERANCE
  ) {
    issues.push({
      path: "script.hookTimestampSec",
      message: `The hook lands at ${script.hookTimestampSec}s; the strategy calls for it by ${post.targetHookSec}s.`,
    });
  }
  const first = scenes[0];
  if (
    first &&
    (script.hookTimestampSec < first.startSec ||
      script.hookTimestampSec > first.startSec + first.durationSec)
  ) {
    issues.push({
      path: "script.hookTimestampSec",
      message: `The hook (${script.hookTimestampSec}s) must land inside the first scene (${first.startSec}s–${round(first.startSec + first.durationSec)}s).`,
    });
  }
  return issues;
}

function slideIssues(slides: readonly Slide[]): Issue[] {
  const issues: Issue[] = [];
  if (slides.length < COPY_LIMITS.slidesMin || slides.length > COPY_LIMITS.slidesMax) {
    issues.push({
      path: "slides",
      message: `A carousel has ${COPY_LIMITS.slidesMin}–${COPY_LIMITS.slidesMax} slides; this one has ${slides.length}.`,
    });
  }
  slides.forEach((slide, i) => {
    if (slide.index !== i) {
      issues.push({
        path: `slides[${i}].index`,
        message: `Slide indexes run 0, 1, 2…; this one should be ${i}.`,
      });
    }
    if (blank(slide.headline)) {
      issues.push({ path: `slides[${i}].headline`, message: "Every slide needs a headline." });
    }
  });
  return issues;
}

function captionLengthIssue(path: string, caption: string): Issue | null {
  if (blank(caption)) return { path, message: "The caption is empty." };
  if (caption.length > COPY_LIMITS.captionMaxChars) {
    return {
      path,
      message: `The caption is ${caption.length} characters; the limit is ${COPY_LIMITS.captionMaxChars}.`,
    };
  }
  return null;
}

function captionIssues(copy: CopywriterOutput): Issue[] {
  const issues: Issue[] = [];
  const captionIssue = captionLengthIssue("caption", copy.caption);
  if (captionIssue) issues.push(captionIssue);
  if (blank(copy.cta)) issues.push({ path: "cta", message: "Write the call to action." });
  if (blank(copy.altText))
    issues.push({ path: "altText", message: "Write alt text describing the visual." });
  return issues;
}

function platformCaptionIssues(copy: CopywriterOutput, post: PostContext): Issue[] {
  const issues: Issue[] = [];
  const wanted = new Set(post.platforms);
  const seen = new Set<string>();
  copy.platformCaptions.forEach((entry, i) => {
    if (!wanted.has(entry.platform)) {
      issues.push({
        path: `platformCaptions[${i}].platform`,
        message: `This post isn't going to ${PLATFORM_LABEL[entry.platform]}; write captions only for ${post.platforms.map((p) => PLATFORM_LABEL[p]).join(", ")}.`,
      });
    } else if (seen.has(entry.platform)) {
      issues.push({
        path: `platformCaptions[${i}].platform`,
        message: `There is already a ${PLATFORM_LABEL[entry.platform]} caption; write exactly one per platform.`,
      });
    }
    seen.add(entry.platform);
    const lengthIssue = captionLengthIssue(`platformCaptions[${i}].caption`, entry.caption);
    if (lengthIssue) issues.push(lengthIssue);
  });
  for (const platform of wanted) {
    if (!seen.has(platform)) {
      issues.push({
        path: "platformCaptions",
        message: `Add the ${PLATFORM_LABEL[platform]} caption: one per platform.`,
      });
    }
  }
  return issues;
}

function hashtagIssues(hashtags: readonly string[]): Issue[] {
  const issues: Issue[] = [];
  if (hashtags.length > COPY_LIMITS.hashtagsMax) {
    issues.push({
      path: "hashtags",
      message: `There are ${hashtags.length} hashtags; use at most ${COPY_LIMITS.hashtagsMax}.`,
    });
  }
  const seen = new Set<string>();
  hashtags.forEach((tag, i) => {
    if (!HASHTAG.test(tag)) {
      issues.push({
        path: `hashtags[${i}]`,
        message: `"${tag}" is not a hashtag: write "#" followed by letters, digits or underscores, with no spaces.`,
      });
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) issues.push({ path: `hashtags[${i}]`, message: `${tag} is listed twice.` });
    seen.add(key);
  });
  return issues;
}

function bannedWordIssues(copy: CopywriterOutput, matcher: BannedWordMatcher): Issue[] {
  return scanForBannedWords(copy, matcher, { ignoreKeys: COPY_BANNED_SCAN_IGNORE }).map((hit) => ({
    path: hit.path,
    message: `Uses the banned word "${hit.term}"${hit.match.toLowerCase() === hit.term.toLowerCase() ? "" : ` (as "${hit.match}")`}. Rewrite without it.`,
  }));
}

function revisionIssues(copy: CopywriterOutput, revision: CopyRevision | null): Issue[] {
  if (!revision || JSON.stringify(copy) !== JSON.stringify(revision.previous)) return [];
  return [
    { path: "", message: "This is the previous copy unchanged; apply the reviewer's feedback." },
  ];
}

type ContentRule = Exclude<CopyRule, "banned_words">;
const CONTENT_RULES = COPY_RULES.filter((rule): rule is ContentRule => rule !== "banned_words");

/** Every rule but banned words: what the copy must look like for this post. */
function contentIssuesByRule(
  copy: CopywriterOutput,
  post: PostContext,
): Record<ContentRule, Issue[]> {
  return {
    shape: shapeIssues(copy, post),
    script_timing: copy.script ? scriptIssues(copy.script, post) : [],
    slides: copy.slides ? slideIssues(copy.slides) : [],
    captions: captionIssues(copy),
    platform_captions: platformCaptionIssues(copy, post),
    hashtags: hashtagIssues(copy.hashtags),
  };
}

/** Issues per rule group; every group is present (empty when it passes). */
export function copyIssuesByRule(
  copy: CopywriterOutput,
  context: Pick<CopywriterInput, "post" | "brand">,
): Record<CopyRule, Issue[]> {
  const matcher = compileBannedWords(context.brand.bannedWords);
  return {
    ...contentIssuesByRule(copy, context.post),
    banned_words: bannedWordIssues(copy, matcher),
  };
}

/**
 * The Copywriter contract for a human edit (PATCH /posts/:id/copy): the same rules as
 * validateCopy, so stored copy always honours it, except banned words, which the API reports
 * with their offsets, and the unchanged-revision check, which only applies to the agent.
 */
export function editedCopyIssues(copy: CopywriterOutput, post: PostContext): Issue[] {
  const byRule = contentIssuesByRule(copy, post);
  return CONTENT_RULES.flatMap((rule) => byRule[rule]);
}

/** COPYWRITER.write business rules; [] when the copy can move on. */
export function validateCopy(copy: CopywriterOutput, input: CopywriterInput): Issue[] {
  const byRule = copyIssuesByRule(copy, input);
  return [...COPY_RULES.flatMap((rule) => byRule[rule]), ...revisionIssues(copy, input.revision)];
}

/** The same rules as AutomatedCheck rows for manager.qa (one per rule group). */
export function automatedCopyChecks(
  copy: CopywriterOutput,
  context: Pick<CopywriterInput, "post" | "brand">,
): AutomatedCheck[] {
  const byRule = copyIssuesByRule(copy, context);
  return COPY_RULES.map((name) => {
    const issues = byRule[name];
    return {
      name,
      passed: issues.length === 0,
      detail:
        issues.length === 0
          ? null
          : issues.map((issue) => `${issue.path || "copy"}: ${issue.message}`).join("; "),
    };
  });
}
