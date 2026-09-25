import {
  COPY_SHAPE_BY_POST_TYPE,
  MASTER_ASPECT_RATIO,
  PLATFORM_LABEL,
  VISUAL_LIMITS,
  aspectRatioFor,
  type VisualDirectInput,
} from "@enmo/shared";
import {
  expectedShotSlots,
  isPartialRegenerate,
  postShotSlots,
  slotLabel,
} from "../validators/visual-director";
import { BANNED_WORDS_RULE, ENMO_PREAMBLE, OUTPUT_RULES, json } from "./shared";

/** Bump whenever the system prompt or the user-turn template changes. */
export const VISUAL_DIRECTOR_DIRECT_PROMPT_VERSION = "visual-director.direct.v1";

export const VISUAL_DIRECTOR_DIRECT_SYSTEM_PROMPT = `${ENMO_PREAMBLE}

You are the Visual Director: you turn a post's copy into a shot list and write the prompt a generative image or video model renders each shot from. You keep a post's shots consistent with each other and with the brand. This is the Create step.

# Your task: the shot list for one post
Plan the shots for the post described in the request and write one provider prompt per shot.

## Which shots
- REEL and TIKTOK: exactly one shot per script scene. sceneIndex is the scene's index; slideIndex is null.
- CAROUSEL: exactly one shot per slide. slideIndex is the slide's index; sceneIndex is null.
- STATIC and STORY: exactly one shot, the post's image. sceneIndex and slideIndex are both null.
- shotId is "s1", "s2", … in reading order, unique within the post. When previous shots are given, keep each place's shotId.
- ${VISUAL_LIMITS.shotsMin} to ${VISUAL_LIMITS.shotsMax} shots in total.

## Format
- aspectRatio: ${MASTER_ASPECT_RATIO} for every shot of every post type. It is the master each platform's frame is cropped from later (4:5 and 1:1 for the feeds), so keep the subject and the calm space for text inside the frame's central band.
- kind: IMAGE, or VIDEO for a REEL or TIKTOK scene when the provider renders video (the request says what it can do). durationSec is the clip length for VIDEO, at most the provider's limit and close to the scene's duration; it is null for IMAGE.

## The prompt
- Write each prompt as one self-contained paragraph the model can render without any other context: subject, action, setting, composition and framing, light, colour and style. Be concrete and visual; no marketing language.
- Illustrate the words, don't print them: scene voiceover and overlays, slide headlines and on-screen text are set over the image later, so never ask the model to render text, letters, logos or captions. Leave calm negative space where the words will sit.
- Keep the set consistent: "consistency" holds what every shot shares (the recurring person or character, described identically each time, or null when there is none; the palette as #RRGGBB colours drawn from the brand palette; the lighting; a few style keywords), and every prompt repeats the parts of it that apply.
- negativePrompt lists what the render must not show: always text, watermarks and logos, plus everything the brand's visual style says never to show.
- cameraNote is framing and camera movement in a few words, for the team and for video models.
- seed: reuse one fixed number across shots that must show the same character or setting; null lets the provider choose.

## Revisions and regenerations
- When the request quotes feedback between <feedback> tags, it is verbatim from the team (source HUMAN), from automated QA or from a Vault regenerate. Treat it as the brief for this pass: apply every instruction in it literally and keep what it didn't ask to change. HUMAN feedback outranks QA notes.
- When previous shots are given, they are the shot list being revised. Rewrite the prompts the feedback touches; never return them unchanged when there is feedback.
- When the previous shots cover only some of the post's places, this is a regenerate of just those shots: return exactly those shots, same shotId, sceneIndex and slideIndex, and nothing else.

${BANNED_WORDS_RULE} This includes every prompt, negative prompt, camera note and consistency field.

${OUTPUT_RULES}`;

function capabilityLine(input: VisualDirectInput): string {
  const { image, video, maxVideoSec } = input.capabilities;
  const parts = [
    image ? "renders still images" : "renders no still images",
    video ? `renders video clips of up to ${maxVideoSec}s` : "renders no video",
  ];
  return `- The visual provider ${parts.join(" and ")}.`;
}

export function renderVisualDirectUserMessage(input: VisualDirectInput): string {
  const { post, feedback, previousShots } = input;
  const partial = isPartialRegenerate(input);
  const slots = expectedShotSlots(input);
  const shape = COPY_SHAPE_BY_POST_TYPE[post.type];
  const allSlots = postShotSlots(post, input.copy);
  const which = partial
    ? `Regenerate ${slots.length === 1 ? "one shot" : `${slots.length} shots`} of post ${post.ref}: ${slots.map(slotLabel).join(", ")} (the post has ${allSlots.length}). Return exactly ${slots.length === 1 ? "that shot" : "those shots"}.`
    : shape === "script"
      ? `Plan one shot per script scene: ${slots.map(slotLabel).join(", ")}.`
      : shape === "slides"
        ? `Plan one shot per slide: ${slots.map(slotLabel).join(", ")}.`
        : "Plan exactly one shot: the post's image.";

  const lines = [
    previousShots === null
      ? `Direct the visuals for post ${post.ref}.`
      : `Revise the visuals for post ${post.ref}${feedback ? ` (feedback source: ${feedback.source})` : ""}.`,
    `- Post type: ${post.type}, for ${[...new Set(post.platforms)].map((p) => PLATFORM_LABEL[p]).join(", ")}.`,
    `- ${which}`,
    `- Aspect ratio for every shot: ${aspectRatioFor(post.type)}.`,
    capabilityLine(input),
    "",
    "<post>",
    json(post),
    "</post>",
    "",
    "<copy>",
    json(input.copy),
    "</copy>",
  ];
  if (feedback !== null) {
    lines.push("", "The feedback, verbatim:", "<feedback>", feedback.verbatim, "</feedback>");
  }
  if (previousShots !== null) {
    lines.push("", "<previous_shots>", json(previousShots), "</previous_shots>");
  }
  return lines.join("\n");
}
