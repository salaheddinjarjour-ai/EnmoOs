import { describe, expect, it } from "vitest";
import {
  MAX_VISUAL_REGENERATIONS,
  type PostType,
  type Shot,
  type VisualCapabilities,
  type VisualDirectInput,
  type VisualDirectOutput,
  type VisualReviewInput,
  type VisualReviewOutput,
} from "@enmo/shared";
import {
  AgentEscalation,
  MockLlm,
  VISUAL_DIRECTOR_DIRECT_PROMPT_VERSION,
  VISUAL_DIRECTOR_REVIEW_PROMPT_VERSION,
  runAgent,
  shotCoverageIssues,
  validateVisualDirect,
  validateVisualReview,
  visualDirectorDirect,
  visualDirectorReview,
  type LlmImageBlock,
} from "../src";
import { mockCopy } from "../src/llm/mock/copywriter";
import {
  mockVisualDirect,
  mockVisualReview,
  pngSize,
  promptForTake,
  visualReviewSubject,
} from "../src/llm/mock/visual-director";
import { expectedShotSlots, isPartialRegenerate } from "../src/validators/visual-director";
import { brand, copyInput, post, recordingHooks } from "./fixtures";

const IMAGES_ONLY: VisualCapabilities = { image: true, video: false, maxVideoSec: 0 };
const WITH_VIDEO: VisualCapabilities = { image: true, video: true, maxVideoSec: 5 };

const paths = (issues: { path: string }[]) => issues.map((issue) => issue.path);

function directInput(
  type: PostType,
  overrides: Partial<VisualDirectInput> = {},
  ref = "p3",
): VisualDirectInput {
  const copy = mockCopy(copyInput(type, { post: post(type, { ref }) }));
  const context = post(type, { ref });
  return {
    brand: brand(),
    post: { ref: context.ref, type, platforms: context.platforms },
    copy: { script: copy.script, slides: copy.slides, onScreenText: copy.onScreenText },
    feedback: null,
    previousShots: null,
    capabilities: IMAGES_ONLY,
    ...overrides,
  };
}

/** The first bytes of a PNG of width × height: enough for a header reader. */
function pngHeader(width: number, height: number): string {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "ascii");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head.toString("base64");
}

function image(width: number, height: number): LlmImageBlock {
  return { type: "image", mediaType: "image/png", data: pngHeader(width, height) };
}

function reviewInput(shot: Shot, overrides: Partial<VisualReviewInput> = {}): VisualReviewInput {
  return {
    shot,
    render: {
      assetId: "asset_1",
      kind: shot.kind,
      width: 1080,
      height: 1920,
      durationSec: null,
      placeholder: true,
    },
    attempt: 1,
    maxAttempts: 1 + MAX_VISUAL_REGENERATIONS,
    brand: brand(),
    ...overrides,
  };
}

describe("VISUAL_DIRECTOR.direct: MockLlm through the runner", () => {
  it.each([
    ["REEL", WITH_VIDEO, "9:16"],
    ["REEL", IMAGES_ONLY, "9:16"],
    ["TIKTOK", WITH_VIDEO, "9:16"],
    ["CAROUSEL", WITH_VIDEO, "9:16"],
    ["STATIC", IMAGES_ONLY, "9:16"],
    ["STORY", WITH_VIDEO, "9:16"],
  ] as const)("plans a valid %s shot list (%o)", async (type, capabilities, ratio) => {
    const input = directInput(type, { capabilities });
    const hooks = recordingHooks();
    const { output } = await runAgent(visualDirectorDirect, input, {
      llm: new MockLlm(),
      ...hooks,
    });

    expect(validateVisualDirect(output, input)).toEqual([]);
    expect(hooks.runs[0]!.promptVersion).toBe(VISUAL_DIRECTOR_DIRECT_PROMPT_VERSION);
    const slots = expectedShotSlots(input);
    expect(output.shots).toHaveLength(slots.length);
    expect(output.shots.map((shot) => shot.shotId)).toEqual(slots.map((_, i) => `s${i + 1}`));
    for (const shot of output.shots) {
      expect(shot.aspectRatio).toBe(ratio);
      const video = capabilities.video && (type === "REEL" || type === "TIKTOK");
      expect(shot.kind).toBe(video ? "VIDEO" : "IMAGE");
      if (video) expect(shot.durationSec).toBeLessThanOrEqual(capabilities.maxVideoSec);
      expect(shot.negativePrompt).toContain("text");
      expect(shot.seed).not.toBeNull();
    }
    if (type === "CAROUSEL") {
      expect(output.shots.map((shot) => shot.slideIndex)).toEqual(
        input.copy.slides!.map((s) => s.index),
      );
    }
  });

  it("gives every post's shots their own seeds, stable across calls", () => {
    const a = mockVisualDirect(directInput("REEL", {}, "p1"), { images: [] });
    const again = mockVisualDirect(directInput("REEL", {}, "p1"), { images: [] });
    const b = mockVisualDirect(directInput("REEL", {}, "p2"), { images: [] });
    expect(again).toEqual(a);
    const seeds = [...a.shots, ...b.shots].map((shot) => shot.seed);
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it("keeps banned words out of every prompt", () => {
    const input = directInput("STATIC", {
      brand: brand({ bannedWords: ["hero", "calm"] }),
      feedback: { verbatim: "Make it calm and heroic", source: "HUMAN", decisionId: null },
      previousShots: mockVisualDirect(directInput("STATIC"), { images: [] }).shots,
    });
    const output = mockVisualDirect(input, { images: [] });
    expect(validateVisualDirect(output, input)).toEqual([]);
  });

  it("escalates after two retries when every reply uses a banned word", async () => {
    const input = directInput("STATIC", { brand: brand({ bannedWords: ["cheap"] }) });
    const error = await runAgent(visualDirectorDirect, input, {
      llm: new MockLlm({ faults: "VISUAL_DIRECTOR.direct:banned*3" }),
      ...recordingHooks(),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentEscalation);
    expect((error as AgentEscalation).issues[0]!.message).toContain('banned word "cheap"');
  });
});

describe("VISUAL_DIRECTOR.direct: revisions and regenerates", () => {
  const original = mockVisualDirect(directInput("CAROUSEL"), { images: [] });

  it("revises every shot with the feedback, keeping ids and places", () => {
    const input = directInput("CAROUSEL", {
      feedback: { verbatim: "  Warmer light, please.\n", source: "HUMAN", decisionId: "d1" },
      previousShots: original.shots,
    });
    expect(isPartialRegenerate(input)).toBe(false);
    const revised = mockVisualDirect(input, { images: [] });
    expect(validateVisualDirect(revised, input)).toEqual([]);
    expect(revised.shots.map((s) => s.shotId)).toEqual(original.shots.map((s) => s.shotId));
    for (const shot of revised.shots) expect(shot.prompt).toContain("Warmer light, please.");
  });

  it("regenerates just the shots named in previousShots (a Vault regenerate)", () => {
    const target = original.shots[1]!;
    const withNote = directInput("CAROUSEL", {
      feedback: { verbatim: "Show the glass up close", source: "HUMAN", decisionId: null },
      previousShots: [target],
    });
    expect(isPartialRegenerate(withNote)).toBe(true);
    const regenerated = mockVisualDirect(withNote, { images: [] });
    expect(validateVisualDirect(regenerated, withNote)).toEqual([]);
    expect(regenerated.shots).toHaveLength(1);
    expect(regenerated.shots[0]).toMatchObject({
      shotId: target.shotId,
      slideIndex: target.slideIndex,
      sceneIndex: null,
    });
    expect(regenerated.shots[0]!.prompt).toContain("Show the glass up close");

    // No instruction: the same prompt re-rolled with a new seed.
    const reroll = directInput("CAROUSEL", { previousShots: [target] });
    const [rolled] = mockVisualDirect(reroll, { images: [] }).shots;
    expect(rolled!.prompt).toBe(target.prompt);
    expect(rolled!.seed).not.toBe(target.seed);

    // The whole post is still one shot per slide.
    expect(paths(validateVisualDirect(original, withNote))).toContain("shots[0]");
  });

  it("tells the model what it is regenerating, with the feedback verbatim", () => {
    const target = original.shots[0]!;
    const input = directInput("CAROUSEL", {
      feedback: { verbatim: "  Show the glass up close\n", source: "HUMAN", decisionId: null },
      previousShots: [target],
    });
    const message = visualDirectorDirect.userMessage(input) as string;
    expect(message).toContain(`Regenerate one shot of post p3: slide ${target.slideIndex}`);
    expect(message).toContain("<feedback>\n  Show the glass up close\n\n</feedback>");
    expect(message).toContain(JSON.stringify(target.prompt));
    // Every master is 9:16, whatever the post type; the Adapter crops the feed frames later.
    expect(visualDirectorDirect.systemPrompt).toContain(
      "aspectRatio: 9:16 for every shot of every post type",
    );
    expect(message).toContain("- Aspect ratio for every shot: 9:16.");
  });
});

describe("shotCoverageIssues", () => {
  const slides = (count: number) => ({
    script: null,
    slides: Array.from({ length: count }, (_, index) => ({
      index,
      headline: `H${index}`,
      body: "",
    })),
    onScreenText: null,
  });
  const onSlide = (slideIndex: number, shotId = `s${slideIndex + 1}`) => ({
    shotId,
    sceneIndex: null,
    slideIndex,
  });

  it("is empty when every scene or slide has exactly one shot", () => {
    const copy = slides(3);
    expect(
      shotCoverageIssues(
        { type: "CAROUSEL" },
        copy,
        [0, 1, 2].map((i) => onSlide(i)),
      ),
    ).toEqual([]);
    const single = { script: null, slides: null, onScreenText: "Iced" };
    expect(
      shotCoverageIssues({ type: "STATIC" }, single, [
        { shotId: "s1", sceneIndex: null, slideIndex: null },
      ]),
    ).toEqual([]);
  });

  it("names a slide without a shot, a slide shot twice and a shot the copy dropped", () => {
    expect(
      shotCoverageIssues(
        { type: "CAROUSEL" },
        slides(4),
        [0, 1, 2].map((i) => onSlide(i)),
      ),
    ).toEqual([{ path: "shots", message: "Slide 3 has no shot." }]);
    expect(
      shotCoverageIssues(
        { type: "CAROUSEL" },
        slides(2),
        [0, 1, 2].map((i) => onSlide(i)),
      ),
    ).toEqual([{ path: "shots", message: "s3 is for slide 2, which the copy no longer has." }]);
    expect(
      shotCoverageIssues({ type: "CAROUSEL" }, slides(2), [
        onSlide(0),
        onSlide(1),
        onSlide(1, "s9"),
      ]),
    ).toEqual([{ path: "shots", message: "Slide 1 has 2 shots (s2, s9)." }]);
    const reel = directInput("REEL");
    const scenes = reel.copy.script!.scenes;
    const shots = scenes.map((scene, i) => ({
      shotId: `s${i + 1}`,
      sceneIndex: scene.index,
      slideIndex: null,
    }));
    expect(shotCoverageIssues({ type: "REEL" }, reel.copy, shots)).toEqual([]);
    expect(shotCoverageIssues({ type: "REEL" }, reel.copy, shots.slice(1))).toEqual([
      { path: "shots", message: `Scene ${scenes[0]!.index} has no shot.` },
    ]);
  });
});

describe("validateVisualDirect", () => {
  const reel = directInput("REEL", { capabilities: WITH_VIDEO });
  const good = mockVisualDirect(reel, { images: [] });
  const withShot = (i: number, patch: Partial<Shot>): VisualDirectOutput => ({
    ...good,
    shots: good.shots.map((shot, j) => (j === i ? { ...shot, ...patch } : shot)),
  });

  it("needs exactly one shot per scene", () => {
    expect(paths(validateVisualDirect({ ...good, shots: good.shots.slice(1) }, reel))).toEqual([
      "shots",
    ]);
    const doubled = withShot(1, { sceneIndex: 0 });
    expect(paths(validateVisualDirect(doubled, reel))).toEqual(["shots[1]", "shots"]);
    const stray = withShot(0, { sceneIndex: null, slideIndex: 0 });
    expect(paths(validateVisualDirect(stray, reel))).toContain("shots[0]");
  });

  it("needs unique ids, the post type's ratio and a real prompt", () => {
    expect(paths(validateVisualDirect(withShot(1, { shotId: "s1" }), reel))).toEqual([
      "shots[1].shotId",
    ]);
    expect(paths(validateVisualDirect(withShot(0, { aspectRatio: "1:1" }), reel))).toEqual([
      "shots[0].aspectRatio",
    ]);
    expect(paths(validateVisualDirect(withShot(0, { prompt: "   " }), reel))).toEqual([
      "shots[0].prompt",
    ]);
  });

  it("keeps kinds and durations within the provider's capabilities", () => {
    expect(paths(validateVisualDirect(withShot(0, { durationSec: 9 }), reel))).toEqual([
      "shots[0].durationSec",
    ]);
    expect(paths(validateVisualDirect(withShot(0, { durationSec: null }), reel))).toEqual([
      "shots[0].durationSec",
    ]);
    const imagesOnly = { ...reel, capabilities: IMAGES_ONLY };
    expect(paths(validateVisualDirect(withShot(0, {}), imagesOnly))).toContain("shots[0].kind");
    expect(
      paths(validateVisualDirect(withShot(0, { kind: "IMAGE", durationSec: 3 }), reel)),
    ).toEqual(["shots[0].durationSec"]);

    const still = directInput("STATIC", { capabilities: WITH_VIDEO });
    const [shot] = mockVisualDirect(still, { images: [] }).shots;
    const asVideo = { ...good, shots: [{ ...shot!, kind: "VIDEO" as const, durationSec: 3 }] };
    expect(paths(validateVisualDirect(asVideo, still))).toEqual(["shots[0].kind"]);
  });

  it("flags banned words anywhere in the shot list", () => {
    const input = { ...reel, brand: brand({ bannedWords: ["dusk"] }) };
    const output: VisualDirectOutput = {
      ...withShot(1, { cameraNote: "Dusk light, slow pan" }),
      consistency: { ...good.consistency, styleKeywords: ["dusk"] },
    };
    expect(paths(validateVisualDirect(output, input))).toEqual([
      "consistency.styleKeywords[0]",
      "shots[1].cameraNote",
    ]);
  });

  it("refuses a revision that returns the previous prompts unchanged", () => {
    const input = {
      ...reel,
      feedback: { verbatim: "Brighter", source: "QA" as const, decisionId: null },
      previousShots: good.shots,
    };
    expect(validateVisualDirect(good, input)).toEqual([
      { path: "shots", message: expect.stringContaining("unchanged") as unknown },
    ]);
  });
});

describe("VISUAL_DIRECTOR.review: MockLlm through the runner", () => {
  const [shot] = mockVisualDirect(directInput("REEL"), { images: [] }).shots;

  it("sees the render and accepts a take in the shot's frame", async () => {
    const input = reviewInput(shot!);
    const hooks = recordingHooks();
    const { output } = await runAgent(visualDirectorReview, input, {
      llm: new MockLlm(),
      ...hooks,
      images: [image(882, 1568)],
    });
    expect(output).toMatchObject({ verdict: "accept", issues: [], revisedPrompt: null });
    expect(output.score).toBeGreaterThanOrEqual(7);
    expect(hooks.runs[0]!.promptVersion).toBe(VISUAL_DIRECTOR_REVIEW_PROMPT_VERSION);
    expect(validateVisualReview(output, input)).toEqual([]);
  });

  it("asks for another take when the render is the wrong shape", () => {
    const input = reviewInput(shot!);
    const output = mockVisualReview(input, { images: [image(1080, 1080)] });
    expect(output.verdict).toBe("regenerate");
    expect(output.issues[0]).toContain("1080×1080");
    expect(validateVisualReview(output, input)).toEqual([]);
  });

  it("refuses to review without the image", () => {
    expect(() => mockVisualReview(reviewInput(shot!), { images: [] })).toThrow(/no image/);
  });

  it("tells the model a placeholder is judged only on its frame and palette", () => {
    const { systemPrompt } = visualDirectorReview;
    // The rubric a real image would fail on a placeholder by design is lifted for placeholders.
    expect(systemPrompt).toContain("## Placeholder takes");
    expect(systemPrompt).toMatch(/Its printed words, footer and missing subject are never issues/);
    expect(systemPrompt).toMatch(/only when the frame or the palette is wrong/);

    const placeholder = visualDirectorReview.userMessage(reviewInput(shot!)) as string;
    expect(placeholder).toContain("It is a placeholder (see Placeholder takes)");
    expect(placeholder).toContain('"placeholder": true');

    const generated = reviewInput(shot!);
    const real = visualDirectorReview.userMessage({
      ...generated,
      render: { ...generated.render, placeholder: false },
    }) as string;
    expect(real).not.toContain("It is a placeholder");
    expect(real).toContain('"placeholder": false');
  });

  it("tells the model which take is the shot's last, as the loop is configured", () => {
    // The system prompt names no number: the configured limit reaches the model with each take.
    expect(visualDirectorReview.systemPrompt).not.toMatch(/at most \d+ regenerations|take \d+ is/);
    const opening = (attempt: number, maxAttempts: number) =>
      (
        visualDirectorReview.userMessage(reviewInput(shot!, { attempt, maxAttempts })) as string
      ).split("\n")[0];
    expect(opening(1, 3)).toBe(
      `Review take 1 of shot ${shot!.shotId} (take 3 is the last before the team decides).`,
    );
    expect(opening(3, 3)).toContain("(the last take before the team decides)");
    // MAX_VISUAL_REGENERATIONS=1: take 2 is the last.
    expect(opening(1, 2)).toContain("(take 2 is the last before the team decides)");
    expect(opening(2, 2)).toContain("(the last take before the team decides)");
    // MAX_VISUAL_REGENERATIONS=0: the first take is the only one.
    expect(opening(1, 1)).toContain("(the last take before the team decides)");
  });

  it("weak*3 regenerates one shot twice and then keeps rejecting it: the subject survives takes", async () => {
    const llm = new MockLlm({
      faults: `VISUAL_DIRECTOR.review:weak*${MAX_VISUAL_REGENERATIONS + 1}`,
    });
    const verdicts: VisualReviewOutput[] = [];
    let current = shot!;
    for (let attempt = 1; attempt <= MAX_VISUAL_REGENERATIONS + 2; attempt++) {
      const input = reviewInput(current, { attempt });
      const { output } = await runAgent(visualDirectorReview, input, {
        llm,
        ...recordingHooks(),
        images: [image(1080, 1920)],
      });
      expect(validateVisualReview(output, input)).toEqual([]);
      verdicts.push(output);
      if (output.revisedPrompt) {
        const next = { ...current, prompt: output.revisedPrompt };
        expect(visualReviewSubject(reviewInput(next))).toEqual(visualReviewSubject(input));
        current = next;
      }
    }
    expect(verdicts.map((v) => v.verdict)).toEqual([
      "regenerate",
      "regenerate",
      "regenerate",
      "accept",
    ]);
    expect(current.prompt.match(/— take/g)).toHaveLength(1);
    expect(current.prompt).toContain("— take 4:");

    // Another shot of the post has its own count.
    const [other] = mockVisualDirect(directInput("REEL"), { images: [] }).shots.slice(1);
    const { output } = await runAgent(visualDirectorReview, reviewInput(other!), {
      llm,
      ...recordingHooks(),
      images: [image(1080, 1920)],
    });
    expect(output.verdict).toBe("regenerate");
  });
});

describe("validateVisualReview", () => {
  const [shot] = mockVisualDirect(directInput("STATIC"), { images: [] }).shots;
  const input = reviewInput(shot!);
  const regenerate: VisualReviewOutput = {
    verdict: "regenerate",
    score: 4,
    issues: ["Too dark"],
    revisedPrompt: promptForTake(shot!.prompt, 2, "brighter"),
  };

  it("needs a new prompt and a reason on every regenerate", () => {
    expect(validateVisualReview(regenerate, input)).toEqual([]);
    expect(paths(validateVisualReview({ ...regenerate, revisedPrompt: null }, input))).toEqual([
      "revisedPrompt",
    ]);
    expect(
      paths(validateVisualReview({ ...regenerate, revisedPrompt: ` ${shot!.prompt}` }, input)),
    ).toEqual(["revisedPrompt"]);
    expect(paths(validateVisualReview({ ...regenerate, issues: [] }, input))).toEqual(["issues"]);
  });

  it("has no next take on accept, and no banned words", () => {
    const accept: VisualReviewOutput = { ...regenerate, verdict: "accept", score: 8 };
    expect(paths(validateVisualReview(accept, input))).toEqual(["revisedPrompt"]);
    const banned = { ...input, brand: brand({ bannedWords: ["brighter", "dark"] }) };
    expect(paths(validateVisualReview(regenerate, banned))).toEqual(["revisedPrompt", "issues[0]"]);
  });
});

describe("pngSize", () => {
  it("reads PNG dimensions and ignores other data", () => {
    expect(pngSize(pngHeader(1080, 1350))).toEqual({ width: 1080, height: 1350 });
    expect(pngSize(Buffer.from("not a png at all, really not").toString("base64"))).toBeNull();
  });
});
