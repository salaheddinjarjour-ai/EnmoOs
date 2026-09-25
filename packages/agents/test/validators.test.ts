import { describe, expect, it } from "vitest";
import {
  COPY_LIMITS,
  VISUAL_LIMITS,
  canonicalGraph,
  type CopywriterInput,
  type CopywriterOutput,
  type ManagerIntakeInput,
  type ManagerIntakeOutput,
  type ManagerPlanOutput,
  type ManagerQaInput,
  type ManagerQaOutput,
  type Script,
} from "@enmo/shared";
import {
  COPY_RULES,
  automatedCopyChecks,
  editedCopyIssues,
  validateCopy,
  validateIntake,
  validatePlan,
  validateQa,
} from "../src";
import { mockCopy } from "../src/llm/mock/copywriter";
import { QAHWA, TODAY, brand, brief, copyInput, intakeInput, post } from "./fixtures";

const paths = (issues: { path: string }[]) => issues.map((issue) => issue.path);

describe("validateCopy", () => {
  const reel = copyInput("REEL");
  const good = mockCopy(reel);
  const withScript = (script: Partial<Script>): CopywriterOutput => ({
    ...good,
    script: { ...good.script!, ...script },
  });
  const scenes = (spans: [start: number, duration: number][]) =>
    spans.map(([startSec, durationSec], index) => ({
      index,
      startSec,
      durationSec,
      voiceover: "Line.",
      overlayText: "Text",
      visualNote: "Note",
    }));

  it("accepts copy within every limit, tolerating ±0.25s of timing drift", () => {
    expect(validateCopy(good, reel)).toEqual([]);
    const drift = withScript({
      totalDurationSec: 10.2,
      hookTimestampSec: 1,
      scenes: scenes([
        [0, 3],
        [3.2, 4],
        [7.1, 3],
      ]),
    });
    expect(validateCopy(drift, reel)).toEqual([]);
  });

  it("requires contiguous scenes that add up to the total", () => {
    // Ends at 10.5s, but the durations only add up to 10s.
    const gap = withScript({
      totalDurationSec: 10.5,
      scenes: scenes([
        [0, 3],
        [3.5, 4],
        [7.5, 3],
      ]),
    });
    const issues = validateCopy(gap, reel);
    expect(paths(issues)).toEqual(["script.scenes[1].startSec", "script.totalDurationSec"]);
    expect(issues[0]!.message).toMatch(/scene 0 ends at 3s/);

    const late = withScript({
      totalDurationSec: 6,
      scenes: scenes([
        [1, 3],
        [4, 3],
      ]),
    });
    expect(paths(validateCopy(late, reel))).toContain("script.scenes[0].startSec");
  });

  it("wants the hook within 3s, inside the first scene, and by targetHookSec", () => {
    const slow = withScript({
      hookTimestampSec: 3.5,
      scenes: scenes([
        [0, 4],
        [4, 4],
      ]),
      totalDurationSec: 8,
    });
    expect(validateCopy(slow, reel)[0]!.message).toMatch(/within the first 3s/);

    const outside = withScript({
      hookTimestampSec: 2.5,
      scenes: scenes([
        [0, 2],
        [2, 4],
      ]),
      totalDurationSec: 6,
    });
    expect(validateCopy(outside, reel)[0]!.message).toMatch(/inside the first scene/);

    const strategic = { ...reel, post: post("REEL", { targetHookSec: 1 }) };
    const late = withScript({
      hookTimestampSec: 1.5,
      scenes: scenes([
        [0, 3],
        [3, 3],
      ]),
      totalDurationSec: 6,
    });
    expect(validateCopy(late, strategic)[0]!.message).toMatch(/by 1s/);
  });

  it("caps the script at 90s", () => {
    const long = withScript({
      totalDurationSec: 95,
      scenes: scenes([
        [0, 3],
        [3, 92],
      ]),
    });
    expect(paths(validateCopy(long, reel))).toEqual(["script.totalDurationSec"]);
  });

  it(`caps the script at ${COPY_LIMITS.scenesMax} scenes, the most shots a post can plan`, () => {
    expect(COPY_LIMITS.scenesMax).toBeLessThanOrEqual(VISUAL_LIMITS.shotsMax);
    const spans = (count: number) =>
      scenes(Array.from({ length: count }, (_, i): [number, number] => [i * 2.5, 2.5]));
    const most = withScript({
      totalDurationSec: COPY_LIMITS.scenesMax * 2.5,
      hookTimestampSec: 1,
      scenes: spans(COPY_LIMITS.scenesMax),
    });
    expect(validateCopy(most, reel)).toEqual([]);

    const thirteen = withScript({
      totalDurationSec: 13 * 2.5,
      hookTimestampSec: 1,
      scenes: spans(13),
    });
    const issues = validateCopy(thirteen, reel);
    expect(paths(issues)).toEqual(["script.scenes"]);
    expect(issues[0]!.message).toMatch(/13 scenes; use at most 12/);
    // A human edit is held to it too, and QA sees it as a failed script check.
    expect(paths(editedCopyIssues(thirteen, reel.post))).toEqual(["script.scenes"]);
    const timing = automatedCopyChecks(thirteen, reel).find((c) => c.name === "script_timing")!;
    expect(timing.passed).toBe(false);
  });

  it("checks the shape for each post type", () => {
    expect(paths(validateCopy({ ...good, script: null }, reel))).toEqual(["script"]);
    const carousel = copyInput("CAROUSEL");
    const twoSlides = {
      ...mockCopy(carousel),
      slides: [0, 1].map((index) => ({ index, headline: "H", body: "B" })),
    };
    expect(paths(validateCopy(twoSlides, carousel))).toEqual(["slides"]);
    const staticInput = copyInput("STATIC");
    const staticWithScript = { ...mockCopy(staticInput), script: good.script };
    expect(paths(validateCopy(staticWithScript, staticInput))).toEqual(["script"]);
    expect(
      paths(validateCopy({ ...mockCopy(staticInput), onScreenText: " " }, staticInput)),
    ).toEqual(["onScreenText"]);
  });

  it("wants exactly one caption per post platform", () => {
    const [instagram] = good.platformCaptions;
    const missing = { ...good, platformCaptions: [instagram!] };
    expect(validateCopy(missing, reel)[0]!.message).toMatch(/Add the Facebook caption/);
    const extra = {
      ...good,
      platformCaptions: [...good.platformCaptions, { platform: "TIKTOK" as const, caption: "Hi" }],
    };
    expect(paths(validateCopy(extra, reel))).toEqual(["platformCaptions[2].platform"]);
    const twice = {
      ...good,
      platformCaptions: [instagram!, instagram!, good.platformCaptions[1]!],
    };
    expect(validateCopy(twice, reel)[0]!.message).toMatch(/exactly one per platform/);
  });

  it("limits captions to 2200 characters and hashtags to 30 well-formed tags", () => {
    const long = { ...good, caption: "x".repeat(2201) };
    expect(validateCopy(long, reel)[0]).toMatchObject({ path: "caption" });
    const tags = { ...good, hashtags: Array.from({ length: 31 }, (_, i) => `#tag${i}`) };
    expect(paths(validateCopy(tags, reel))).toEqual(["hashtags"]);
    const malformed = { ...good, hashtags: ["#ok", "not a tag", "#OK"] };
    expect(paths(validateCopy(malformed, reel))).toEqual(["hashtags[1]", "hashtags[2]"]);
  });

  it("finds banned words in any text field, by path", () => {
    const input: CopywriterInput = {
      ...reel,
      brand: brand({ bannedWords: ["cheap", "free shipping"] }),
    };
    const copy = withScript({
      scenes: good.script!.scenes.map((scene, i) =>
        i === 1 ? { ...scene, voiceover: "So CHEAP." } : scene,
      ),
    });
    const dirty = { ...copy, hashtags: [...copy.hashtags, "#FreeShipping"] };
    const issues = validateCopy(dirty, input);
    expect(paths(issues)).toEqual([
      `hashtags[${copy.hashtags.length}]`,
      "script.scenes[1].voiceover",
    ]);
    expect(issues[0]!.message).toBe(
      'Uses the banned word "free shipping" (as "FreeShipping"). Rewrite without it.',
    );
    // A case-only difference isn't worth quoting back.
    expect(issues[1]!.message).toBe('Uses the banned word "cheap". Rewrite without it.');
  });

  it("rejects a revision that changes nothing", () => {
    const revision: CopywriterInput = {
      ...reel,
      revision: {
        feedback: { verbatim: "Shorter.", source: "HUMAN", decisionId: null },
        previous: good,
      },
    };
    expect(validateCopy(good, revision)[0]!.message).toMatch(/unchanged/);
  });

  it("holds each platform's caption, with the hashtags appended, to that platform's limits", () => {
    const tags = Array.from({ length: 10 }, (_, i) => `#tag${i}`);
    const appended = `\n\n${tags.join(" ")}`.length;
    const instagram = "i".repeat(COPY_LIMITS.captionMaxChars - appended + 1);
    const long: CopywriterOutput = {
      ...good,
      hashtags: tags,
      platformCaptions: [
        { platform: "INSTAGRAM", caption: instagram },
        { platform: "FACEBOOK", caption: "f".repeat(2150) },
      ],
    };
    // Each caption alone is within 2200; Instagram's published text is one over, Facebook takes it.
    const issues = validateCopy(long, reel);
    expect(paths(issues)).toEqual(["platformCaptions[0].caption"]);
    expect(issues[0]!.message).toContain(`${COPY_LIMITS.captionMaxChars + 1} characters`);
    const fits = {
      ...long,
      platformCaptions: [
        { ...long.platformCaptions[0]!, caption: "Short." },
        long.platformCaptions[1]!,
      ],
    };
    expect(validateCopy(fits, reel)).toEqual([]);

    // Hashtags written into the caption count with the appended ones: 25 + 10 is over 30.
    const inline = Array.from({ length: 25 }, (_, i) => `#inline${i}`).join(" ");
    const crowded = {
      ...fits,
      platformCaptions: [
        { platform: "INSTAGRAM" as const, caption: `Iced. ${inline}` },
        fits.platformCaptions[1]!,
      ],
    };
    const tagIssues = validateCopy(crowded, reel);
    expect(paths(tagIssues)).toEqual(["hashtags"]);
    expect(tagIssues[0]!.message).toMatch(/35 hashtags .* Instagram takes 30\. Drop 5\./);
    // The same rule for a human edit, and as a failed automated check QA sees.
    expect(paths(editedCopyIssues(crowded, reel.post))).toEqual(["hashtags"]);
    const check = automatedCopyChecks(crowded, reel).find((c) => c.name === "publish_limits")!;
    expect(check.passed).toBe(false);
  });

  it("reports the same rules as automated checks", () => {
    const input: CopywriterInput = { ...reel, brand: brand({ bannedWords: ["sip"] }) };
    const checks = automatedCopyChecks({ ...good, caption: "One sip." }, input);
    expect(checks.map((check) => check.name)).toEqual([...COPY_RULES]);
    const banned = checks.find((check) => check.name === "banned_words")!;
    expect(banned.passed).toBe(false);
    expect(banned.detail).toContain('caption: Uses the banned word "sip"');
    expect(checks.filter((check) => !check.passed)).toHaveLength(1);
  });
});

describe("editedCopyIssues", () => {
  const reel = copyInput("REEL");
  const good = mockCopy(reel);

  it("holds a human edit to the contract validateCopy holds the agent to", () => {
    expect(editedCopyIssues(good, reel.post)).toEqual([]);
    const [instagram] = good.platformCaptions;
    const broken: CopywriterOutput = {
      ...good,
      caption: "x".repeat(2201),
      hashtags: Array.from({ length: 31 }, (_, i) => `#tag${i}`),
      platformCaptions: [instagram!],
      script: null,
    };
    expect(paths(editedCopyIssues(broken, reel.post))).toEqual([
      "script",
      "caption",
      "platformCaptions",
      "hashtags",
    ]);
    const late = { ...good, script: { ...good.script!, hookTimestampSec: 4 } };
    expect(editedCopyIssues(late, reel.post)[0]!.message).toMatch(/within the first 3s/);
    const carousel = copyInput("CAROUSEL");
    const twoSlides = { ...mockCopy(carousel), slides: mockCopy(carousel).slides!.slice(0, 2) };
    expect(paths(editedCopyIssues(twoSlides, carousel.post))).toEqual(["slides"]);
  });

  it("leaves banned words and the unchanged-revision check to their own callers", () => {
    const input: CopywriterInput = {
      ...reel,
      brand: brand({ bannedWords: ["cheap"] }),
      revision: {
        feedback: { verbatim: "Shorter.", source: "HUMAN", decisionId: null },
        previous: good,
      },
    };
    const cheap = { ...good, cta: "Cheap tonight" };
    expect(paths(validateCopy(cheap, input))).toEqual(["cta"]);
    expect(editedCopyIssues(cheap, input.post)).toEqual([]);
    expect(editedCopyIssues(good, input.post)).toEqual([]);
  });
});

describe("validateIntake", () => {
  const input: ManagerIntakeInput = intakeInput();
  const briefOutput = (overrides: Parameters<typeof brief>[0] = {}): ManagerIntakeOutput => ({
    result: { kind: "brief", brief: brief(overrides), confirmation: "Locked." },
  });

  it("accepts a sound brief", () => {
    expect(validateIntake(briefOutput(), input)).toEqual([]);
  });

  it("checks the mix sum, window, client and platforms", () => {
    const issues = validateIntake(
      briefOutput({
        postCount: 10,
        window: { start: "2026-09-01", end: "2026-08-01" },
        platforms: ["INSTAGRAM", "INSTAGRAM"],
      }),
      input,
    );
    expect(paths(issues)).toEqual([
      "result.brief.postMix",
      "result.brief.window.start",
      "result.brief.window.end",
      "result.brief.platforms[1]",
    ]);
    expect(issues[1]!.message).toContain(TODAY);

    const unknown = validateIntake(briefOutput({ clientId: "nope" }), input);
    expect(unknown[0]!.message).toMatch(/Qahwa Co \(client_qahwa\)/);

    const instagramOnly = intakeInput({ clients: [{ ...QAHWA, enabledPlatforms: ["INSTAGRAM"] }] });
    const disabled = validateIntake(briefOutput(), instagramOnly);
    expect(disabled).toEqual([
      {
        path: "result.brief.platforms[1]",
        message: "Facebook is not enabled for Qahwa Co (enabled: Instagram).",
      },
    ]);
  });

  it("holds the brief to the client the campaign was started for", () => {
    const other = { id: "client_b", name: "Bloom", enabledPlatforms: QAHWA.enabledPlatforms };
    const selected = intakeInput({ clients: [QAHWA, other], selectedClientId: "client_b" });
    expect(paths(validateIntake(briefOutput(), selected))).toEqual(["result.brief.clientId"]);
  });

  it("allows one consolidated clarify, only while the question is available", () => {
    const clarify = (question: string): ManagerIntakeOutput => ({
      result: {
        kind: "clarify",
        question,
        missing: ["platforms", "window"],
        draft: {
          clientId: QAHWA.id,
          title: null,
          objective: null,
          productFocus: null,
          audience: null,
          keyMessages: null,
          platforms: null,
          postCount: 12,
          postMix: null,
          window: null,
          cadenceNotes: null,
          constraints: null,
          assumptions: null,
        },
      },
    });
    expect(validateIntake(clarify("Which platforms and dates?"), input)).toEqual([]);
    expect(paths(validateIntake(clarify("Which platforms? And which dates?"), input))).toEqual([
      "result.question",
    ]);
    expect(
      paths(
        validateIntake(clarify("Which platforms and dates?"), { ...input, allowClarify: false }),
      ),
    ).toEqual(["result.kind"]);
  });
});

describe("validatePlan", () => {
  const input = {
    brief: brief(),
    brand: brand(),
    today: TODAY,
    enabledActions: ["write", "qa"] as const,
    busyDates: [],
    changeRequest: null,
    previousGraph: null,
  };
  const posts = Array.from({ length: 12 }, (_, i) => ({
    ref: `p${i + 1}`,
    type: (["REEL", "CAROUSEL", "STATIC"] as const)[i % 3]!,
    platforms: ["INSTAGRAM" as const],
    targetDate: `2027-03-${String(i + 1).padStart(2, "0")}`,
    angle: `Angle ${i + 1}`,
    pillarHint: null,
  }));
  const plan: ManagerPlanOutput = {
    summary: "Plan.",
    posts,
    nodes: canonicalGraph(posts, ["write", "qa"]),
  };

  it("accepts the canonical graph and applies validateTaskGraph", () => {
    expect(validatePlan(plan, { ...input, enabledActions: ["write", "qa"] })).toEqual([]);
    const broken = { ...plan, nodes: plan.nodes.slice(1) };
    expect(
      validatePlan(broken, { ...input, enabledActions: ["write", "qa"] }).length,
    ).toBeGreaterThan(0);
  });

  it("flags posts dated before today", () => {
    const later = {
      ...input,
      enabledActions: ["write", "qa"] as ("write" | "qa")[],
      today: "2027-03-05",
    };
    expect(paths(validatePlan(plan, later))).toEqual([
      "posts[0].targetDate",
      "posts[1].targetDate",
      "posts[2].targetDate",
      "posts[3].targetDate",
    ]);
  });
});

describe("validateQa", () => {
  const reel = copyInput("REEL");
  const input: ManagerQaInput = {
    brief: reel.brief,
    brand: reel.brand,
    post: reel.post,
    copy: mockCopy(reel),
    visuals: null,
    variants: null,
    automatedChecks: [{ name: "captions", passed: true, detail: null }],
  };
  const issue = {
    target: "COPYWRITER" as const,
    field: "script.scenes[0].voiceover",
    problem: "Flat.",
    instruction: "Sharpen it.",
  };
  const output = (overrides: Partial<ManagerQaOutput>): ManagerQaOutput => ({
    verdict: "pass",
    issues: [],
    summaryForReviewer: "Good to go.",
    ...overrides,
  });

  it("accepts consistent verdicts", () => {
    expect(validateQa(output({}), input)).toEqual([]);
    expect(validateQa(output({ verdict: "revise", issues: [issue] }), input)).toEqual([]);
  });

  it("keeps the verdict and issues consistent", () => {
    expect(paths(validateQa(output({ verdict: "revise" }), input))).toEqual(["issues"]);
    expect(paths(validateQa(output({ issues: [issue] }), input))).toEqual(["issues"]);
    expect(paths(validateQa(output({ summaryForReviewer: "  " }), input))).toEqual([
      "summaryForReviewer",
    ]);
  });

  it("never passes a failed automated check", () => {
    const failing = {
      ...input,
      automatedChecks: [{ name: "banned_words", passed: false, detail: "cheap" }],
    };
    expect(paths(validateQa(output({}), failing))).toEqual(["verdict"]);
  });

  it("routes issues only to specialists with work under review, at real fields", () => {
    const issues = validateQa(
      output({
        verdict: "revise",
        issues: [
          { ...issue, target: "VISUAL_DIRECTOR" },
          { ...issue, target: "ADAPTER" },
          { ...issue, field: "headline" },
        ],
      }),
      input,
    );
    expect(paths(issues)).toEqual(["issues[0].target", "issues[1].target", "issues[2].field"]);
    const withVisuals = {
      ...input,
      visuals: [
        {
          assetId: "a1",
          shotId: "s1",
          sceneIndex: 0,
          slideIndex: null,
          prompt: "p",
          url: null,
          reviewScore: 0.8,
        },
      ],
    };
    expect(
      validateQa(
        output({ verdict: "revise", issues: [{ ...issue, target: "VISUAL_DIRECTOR" }] }),
        withVisuals,
      ),
    ).toEqual([]);
  });
});
