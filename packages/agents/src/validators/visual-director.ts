import {
  COPY_SHAPE_BY_POST_TYPE,
  aspectRatioFor,
  compileBannedWords,
  type AutomatedCheck,
  type BannedWordMatcher,
  type Issue,
  type Shot,
  type VisualDirectCopy,
  type VisualDirectInput,
  type VisualDirectOutput,
  type VisualDirectPost,
  type VisualReviewInput,
  type VisualReviewOutput,
} from "@enmo/shared";

/*
 * Business rules of the Visual Director contracts (DESIGN §C). A shot list fills the post's slots
 * exactly (one shot per script scene, per carousel slide, or the single image) with unique shot
 * ids, at the master aspect ratio, within what the provider can render, and without the
 * brand's banned words. A regenerate always carries the prompt for the next take. Messages are
 * written for the model to act on.
 */

/** A place in the post one shot fills: a script scene, a carousel slide, or the single image. */
export interface ShotSlot {
  sceneIndex: number | null;
  slideIndex: number | null;
}

/** Enum-like values of a shot list, not prose: skipped by the banned-word scan. */
export const VISUAL_BANNED_SCAN_IGNORE = ["shotId", "kind", "aspectRatio", "palette"] as const;

export function slotKey(slot: ShotSlot): string {
  return `${slot.sceneIndex ?? "-"}/${slot.slideIndex ?? "-"}`;
}

export function slotLabel(slot: ShotSlot): string {
  if (slot.sceneIndex !== null) return `scene ${slot.sceneIndex}`;
  if (slot.slideIndex !== null) return `slide ${slot.slideIndex}`;
  return "the post's single image";
}

/** Every slot of the post, in reading order, as its copy defines them. */
export function postShotSlots(
  post: Pick<VisualDirectPost, "type">,
  copy: VisualDirectCopy,
): ShotSlot[] {
  const shape = COPY_SHAPE_BY_POST_TYPE[post.type];
  if (shape === "script" && copy.script && copy.script.scenes.length > 0) {
    return copy.script.scenes.map((scene) => ({ sceneIndex: scene.index, slideIndex: null }));
  }
  if (shape === "slides" && copy.slides && copy.slides.length > 0) {
    return copy.slides.map((slide) => ({ sceneIndex: null, slideIndex: slide.index }));
  }
  return [{ sceneIndex: null, slideIndex: null }];
}

/**
 * Where a post's current shots are out of step with its copy: a slot the copy has that no shot
 * fills, a slot filled twice, or a shot of a slot the copy no longer has (a revision or an edit
 * added or dropped a slide or scene). [] when every slot has exactly one shot.
 */
export function shotCoverageIssues(
  post: Pick<VisualDirectPost, "type">,
  copy: VisualDirectCopy,
  shots: readonly (ShotSlot & { shotId: string | null })[],
): Issue[] {
  const wanted = postShotSlots(post, copy);
  const wantedKeys = new Set(wanted.map(slotKey));
  const bySlot = new Map<string, string[]>();
  for (const shot of shots) {
    const key = slotKey(shot);
    bySlot.set(key, [...(bySlot.get(key) ?? []), shot.shotId ?? "a shot"]);
  }
  const issues: Issue[] = [];
  for (const slot of wanted) {
    const filled = bySlot.get(slotKey(slot)) ?? [];
    if (filled.length === 0) {
      issues.push({ path: "shots", message: `${capitalize(slotLabel(slot))} has no shot.` });
    } else if (filled.length > 1) {
      issues.push({
        path: "shots",
        message: `${capitalize(slotLabel(slot))} has ${filled.length} shots (${filled.join(", ")}).`,
      });
    }
  }
  for (const shot of shots) {
    if (!wantedKeys.has(slotKey(shot))) {
      issues.push({
        path: "shots",
        message: `${shot.shotId ?? "A shot"} is for ${slotLabel(shot)}, which the copy no longer has.`,
      });
    }
  }
  return issues;
}

/** The automated check QA reads next to the copy: shotCoverageIssues of the post's current takes. */
export const SHOTS_CHECK = "shots";

export function automatedShotCheck(issues: readonly Issue[]): AutomatedCheck {
  return {
    name: SHOTS_CHECK,
    passed: issues.length === 0,
    detail: issues.length === 0 ? null : issues.map((issue) => issue.message).join(" "),
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A regenerate of some of the post's shots (a Vault "Regenerate"): previousShots names fewer
 * slots than the post has, all of them real. The shot list then re-plans exactly those shots.
 */
export function isPartialRegenerate(input: VisualDirectInput): boolean {
  const previous = input.previousShots;
  if (!previous || previous.length === 0) return false;
  const slots = postShotSlots(input.post, input.copy);
  const known = new Set(slots.map(slotKey));
  return previous.length < slots.length && previous.every((shot) => known.has(slotKey(shot)));
}

/** The slots this call's shot list must fill, one shot each. */
export function expectedShotSlots(input: VisualDirectInput): ShotSlot[] {
  if (isPartialRegenerate(input)) {
    const seen = new Set<string>();
    return (input.previousShots ?? [])
      .map((shot) => ({ sceneIndex: shot.sceneIndex, slideIndex: shot.slideIndex }))
      .filter((slot) => !seen.has(slotKey(slot)) && seen.add(slotKey(slot)));
  }
  return postShotSlots(input.post, input.copy);
}

function blank(text: string): boolean {
  return text.trim().length === 0;
}

function kindIssues(shot: Shot, i: number, input: VisualDirectInput): Issue[] {
  const issues: Issue[] = [];
  const { capabilities } = input;
  const scripted = COPY_SHAPE_BY_POST_TYPE[input.post.type] === "script";
  if (shot.kind === "VIDEO") {
    if (!capabilities.video) {
      issues.push({
        path: `shots[${i}].kind`,
        message: "The visual provider renders no video; make this an IMAGE shot.",
      });
    } else if (!scripted) {
      issues.push({
        path: `shots[${i}].kind`,
        message: `A ${input.post.type} post is a still image; make this an IMAGE shot.`,
      });
    }
    if (shot.durationSec === null) {
      issues.push({
        path: `shots[${i}].durationSec`,
        message: "A VIDEO shot needs durationSec: the clip length in seconds.",
      });
    } else if (capabilities.video && shot.durationSec > capabilities.maxVideoSec) {
      issues.push({
        path: `shots[${i}].durationSec`,
        message: `The clip runs ${shot.durationSec}s; the provider renders at most ${capabilities.maxVideoSec}s per clip.`,
      });
    }
  } else {
    if (!capabilities.image) {
      issues.push({
        path: `shots[${i}].kind`,
        message: "The visual provider renders no still images; make this a VIDEO shot.",
      });
    }
    if (shot.durationSec !== null) {
      issues.push({
        path: `shots[${i}].durationSec`,
        message: "An IMAGE shot has no duration; set durationSec to null.",
      });
    }
  }
  return issues;
}

function joinPath(prefix: string, path: string): string {
  if (!prefix || !path) return prefix || path;
  return path.startsWith("[") ? `${prefix}${path}` : `${prefix}.${path}`;
}

function bannedWordIssues(value: unknown, matcher: BannedWordMatcher, prefix = ""): Issue[] {
  return matcher.scan(value, { ignoreKeys: VISUAL_BANNED_SCAN_IGNORE }).map((hit) => ({
    path: joinPath(prefix, hit.path),
    message: `Uses the banned word "${hit.term}"${hit.match.toLowerCase() === hit.term.toLowerCase() ? "" : ` (as "${hit.match}")`}. Rewrite without it.`,
  }));
}

/** A revision that returns the shots it was asked to change, prompts untouched. */
function unchangedRevisionIssues(output: VisualDirectOutput, input: VisualDirectInput): Issue[] {
  if (input.feedback === null || !input.previousShots?.length) return [];
  const previous = new Map(input.previousShots.map((shot) => [slotKey(shot), shot.prompt.trim()]));
  const unchanged = output.shots.every(
    (shot) => previous.get(slotKey(shot)) === shot.prompt.trim(),
  );
  return unchanged
    ? [{ path: "shots", message: "These are the previous prompts unchanged; apply the feedback." }]
    : [];
}

/** VISUAL_DIRECTOR.direct business rules; [] when the shot list can go to the provider. */
export function validateVisualDirect(
  output: VisualDirectOutput,
  input: VisualDirectInput,
): Issue[] {
  const issues: Issue[] = [];
  const expected = expectedShotSlots(input);
  const wanted = new Map(expected.map((slot) => [slotKey(slot), slot]));
  const wantedList = expected.map(slotLabel).join(", ");
  const ratio = aspectRatioFor(input.post.type);
  const ids = new Map<string, number>();
  const filled = new Map<string, string>();

  output.shots.forEach((shot, i) => {
    const firstWithId = ids.get(shot.shotId);
    if (firstWithId !== undefined) {
      issues.push({
        path: `shots[${i}].shotId`,
        message: `${shot.shotId} is already the id of shots[${firstWithId}]; give every shot its own id.`,
      });
    } else {
      ids.set(shot.shotId, i);
    }

    const key = slotKey(shot);
    if (!wanted.has(key)) {
      issues.push({
        path: `shots[${i}]`,
        message: `This shot is for ${slotLabel(shot)}, which isn't one to plan here; plan exactly one shot for each of: ${wantedList} (sceneIndex and slideIndex set accordingly, the other null).`,
      });
    } else if (filled.has(key)) {
      issues.push({
        path: `shots[${i}]`,
        message: `${slotLabel(shot)} already has a shot (${filled.get(key)}); plan exactly one shot per ${shot.sceneIndex !== null ? "scene" : shot.slideIndex !== null ? "slide" : "post"}.`,
      });
    } else {
      filled.set(key, shot.shotId);
    }

    if (shot.aspectRatio !== ratio) {
      issues.push({
        path: `shots[${i}].aspectRatio`,
        message: `Every master shot of a ${input.post.type} post is rendered ${ratio}; use "${ratio}".`,
      });
    }
    issues.push(...kindIssues(shot, i, input));
    if (blank(shot.prompt)) {
      issues.push({
        path: `shots[${i}].prompt`,
        message: "Write the provider prompt: subject, setting, composition, light and style.",
      });
    }
  });

  const missing = expected.filter((slot) => !filled.has(slotKey(slot)));
  if (missing.length > 0) {
    issues.push({
      path: "shots",
      message: `Add a shot for ${missing.map(slotLabel).join(", ")}: every one of ${wantedList} needs exactly one.`,
    });
  }

  issues.push(...bannedWordIssues(output, compileBannedWords(input.brand.bannedWords)));
  issues.push(...unchangedRevisionIssues(output, input));
  return issues;
}

/** VISUAL_DIRECTOR.review business rules; [] when the verdict can be acted on. */
export function validateVisualReview(
  output: VisualReviewOutput,
  input: VisualReviewInput,
): Issue[] {
  const issues: Issue[] = [];
  if (output.verdict === "regenerate") {
    if (output.revisedPrompt === null || blank(output.revisedPrompt)) {
      issues.push({
        path: "revisedPrompt",
        message: "A regenerate verdict needs revisedPrompt: the complete prompt for the next take.",
      });
    } else if (output.revisedPrompt.trim() === input.shot.prompt.trim()) {
      issues.push({
        path: "revisedPrompt",
        message:
          "revisedPrompt is this take's prompt unchanged; rewrite it to fix what the issues describe.",
      });
    }
    if (output.issues.every(blank)) {
      issues.push({
        path: "issues",
        message: "Say what is wrong with the take: a regenerate verdict needs at least one issue.",
      });
    }
  } else if (output.revisedPrompt !== null) {
    issues.push({
      path: "revisedPrompt",
      message: "An accept verdict has no next take; set revisedPrompt to null.",
    });
  }
  const matcher = compileBannedWords(input.brand.bannedWords);
  issues.push(
    ...bannedWordIssues(output.revisedPrompt, matcher, "revisedPrompt"),
    ...bannedWordIssues(output.issues, matcher, "issues"),
  );
  return issues;
}
