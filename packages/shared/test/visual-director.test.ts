import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ASPECT_RATIO_SIZE,
  ASPECT_RATIO_VARIANT_FORMAT,
  AssetDetailDto,
  AssetDto,
  AssetListQuery,
  AssetListResponse,
  AssetParams,
  AspectRatio,
  COPY_LIMITS,
  EDITED_COPY_BOUNDS,
  MASTER_ASPECT_RATIO,
  MAX_VISUAL_REGENERATIONS,
  PostType,
  RegenerateAssetBody,
  VARIANT_FORMAT_ASPECT_RATIO,
  VISUAL_LIMITS,
  VisualDirectInput,
  VisualDirectOutput,
  VisualReviewInput,
  VisualReviewOutput,
  aspectRatioFor,
  aspectRatioOf,
  compareShotPosition,
  defaultVisualStyle,
  pixelSizeFor,
  type Shot,
} from "../src";

const now = "2026-09-24T10:00:00.000Z";

const brand = {
  clientId: "c1",
  name: "Qahwa Co",
  timezone: "Asia/Riyadh",
  brandVoice: "Warm, unhurried.",
  bannedWords: ["cheap"],
  visualStyle: defaultVisualStyle(),
  platforms: ["INSTAGRAM" as const, "TIKTOK" as const],
};

const shot: Shot = {
  shotId: "s1",
  sceneIndex: 0,
  slideIndex: null,
  kind: "IMAGE",
  aspectRatio: "9:16",
  durationSec: null,
  prompt: "Iced coffee on a dusk-lit table after iftar, condensation on the glass",
  negativePrompt: "text, logos",
  cameraNote: "Slow push-in, eye level",
  seed: 42,
};

const consistency = {
  characterDescription: null,
  palette: ["#F5F5F4", "#8b8b90"],
  lighting: "Warm dusk, low sun",
  styleKeywords: ["cinematic", "intimate"],
};

describe("platform rules", () => {
  it("renders every post type's master 9:16, 1080×1920 (DESIGN Phase 3 exit test)", () => {
    expect(MASTER_ASPECT_RATIO).toBe("9:16");
    for (const type of PostType.options) {
      expect(aspectRatioFor(type), type).toBe("9:16");
      expect(pixelSizeFor(aspectRatioFor(type)), type).toEqual({ width: 1080, height: 1920 });
    }
    // Phase 3 renders one master per shot: no platform gets a ratio of its own yet.
    expect(aspectRatioFor("STATIC", "FACEBOOK")).toBe("9:16");
    expect(aspectRatioFor("CAROUSEL", "INSTAGRAM")).toBe("9:16");
  });

  it("sizes every ratio 1080 wide", () => {
    expect(pixelSizeFor("9:16")).toEqual({ width: 1080, height: 1920 });
    expect(pixelSizeFor("4:5")).toEqual({ width: 1080, height: 1350 });
    expect(pixelSizeFor("1:1")).toEqual({ width: 1080, height: 1080 });
    const copy = pixelSizeFor("1:1");
    copy.width = 1;
    expect(ASPECT_RATIO_SIZE["1:1"].width).toBe(1080);
  });

  it("recognises a ratio from pixel sizes", () => {
    expect(aspectRatioOf(1080, 1920)).toBe("9:16");
    expect(aspectRatioOf(540, 960)).toBe("9:16");
    expect(aspectRatioOf(1080, 1350)).toBe("4:5");
    expect(aspectRatioOf(2048, 2048)).toBe("1:1");
    expect(aspectRatioOf(1920, 1080)).toBeNull();
  });

  it("maps variant formats and ratios both ways", () => {
    for (const ratio of AspectRatio.options) {
      expect(VARIANT_FORMAT_ASPECT_RATIO[ASPECT_RATIO_VARIANT_FORMAT[ratio]]).toBe(ratio);
    }
  });
});

describe("visual director contracts", () => {
  const directInput = {
    brand,
    post: { ref: "p1", type: "REEL", platforms: ["INSTAGRAM"] },
    copy: { script: null, slides: null, onScreenText: "Cold brew, after iftar." },
    feedback: { verbatim: "  Warmer light, please.\n", source: "HUMAN", decisionId: null },
    previousShots: [shot],
    capabilities: { image: true, video: false, maxVideoSec: 0 },
  };

  it("parses a direct input and keeps feedback verbatim", () => {
    const parsed = VisualDirectInput.parse(directInput);
    expect(parsed.feedback?.verbatim).toBe("  Warmer light, please.\n");
    expect(VisualDirectInput.safeParse({ ...directInput, previousShots: undefined }).success).toBe(
      false,
    );
  });

  it("refuses copy with more scenes or slides than a shot list can cover", () => {
    const script = (count: number) => ({
      totalDurationSec: count * 2,
      hookTimestampSec: 1,
      hookText: "Wait for it",
      scenes: Array.from({ length: count }, (_, index) => ({
        index,
        startSec: index * 2,
        durationSec: 2,
        voiceover: "Cold.",
        overlayText: "",
        visualNote: "Glass",
      })),
    });
    const withCopy = (copy: object) =>
      VisualDirectInput.safeParse({ ...directInput, copy: { ...directInput.copy, ...copy } });
    expect(withCopy({ script: script(COPY_LIMITS.scenesMax), onScreenText: null }).success).toBe(
      true,
    );
    expect(
      withCopy({ script: script(COPY_LIMITS.scenesMax + 1), onScreenText: null }).success,
    ).toBe(false);
    const slides = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ index, headline: "One", body: "Two" }));
    expect(withCopy({ slides: slides(COPY_LIMITS.slidesMax) }).success).toBe(true);
    expect(withCopy({ slides: slides(COPY_LIMITS.slidesMax + 1) }).success).toBe(false);
  });

  it("parses a shot list and enforces shape: ids, counts, ratios, colours", () => {
    expect(VisualDirectOutput.parse({ consistency, shots: [shot] }).shots).toHaveLength(1);
    const bad = (patch: Partial<Shot>) =>
      VisualDirectOutput.safeParse({ consistency, shots: [{ ...shot, ...patch }] }).success;
    expect(bad({ shotId: "shot1" })).toBe(false);
    expect(bad({ aspectRatio: "16:9" as never })).toBe(false);
    expect(bad({ prompt: "" })).toBe(false);
    expect(bad({ seed: -1 })).toBe(false);
    expect(bad({ durationSec: 0 })).toBe(false);
    expect(VisualDirectOutput.safeParse({ consistency, shots: [] }).success).toBe(false);
    const many = Array.from({ length: VISUAL_LIMITS.shotsMax + 1 }, (_, i) => ({
      ...shot,
      shotId: `s${i + 1}`,
    }));
    expect(VisualDirectOutput.safeParse({ consistency, shots: many }).success).toBe(false);
    // One shot per scene or slide: the longest script and carousel the copy allows both fit.
    expect(VISUAL_LIMITS.shotsMax).toBe(12);
    expect(VISUAL_LIMITS.shotsMax).toBeGreaterThanOrEqual(COPY_LIMITS.scenesMax);
    expect(VISUAL_LIMITS.shotsMax).toBeGreaterThanOrEqual(COPY_LIMITS.slidesMax);
    // A human copy edit can't ask for more scenes than the Visual Director can shoot.
    expect(EDITED_COPY_BOUNDS.scenesMax).toBe(COPY_LIMITS.scenesMax);
    expect(
      VisualDirectOutput.safeParse({
        consistency: { ...consistency, palette: ["red"] },
        shots: [shot],
      }).success,
    ).toBe(false);
  });

  it("leaves business rules to validators: a mismatched shot still parses", () => {
    // A VIDEO shot without a duration, on a scene and a slide at once: the validator's call.
    const odd = { ...shot, kind: "VIDEO" as const, durationSec: null, slideIndex: 2 };
    expect(VisualDirectOutput.safeParse({ consistency, shots: [odd] }).success).toBe(true);
    expect(
      VisualReviewOutput.safeParse({
        verdict: "regenerate",
        score: 3,
        issues: [],
        revisedPrompt: null,
      }).success,
    ).toBe(true);
  });

  it("orders shots by scene or slide, then by shot number", () => {
    const at = (
      shotId: string | null,
      sceneIndex: number | null,
      slideIndex: number | null = null,
    ) => ({
      shotId,
      sceneIndex,
      slideIndex,
    });
    const shuffled = [
      at("s10", null),
      at("s3", 2),
      at("s2", null),
      at(null, null),
      at("s1", 0),
      at("s9", null, 1),
    ];
    expect(shuffled.sort(compareShotPosition).map((s) => s.shotId)).toEqual([
      "s1",
      "s9",
      "s3",
      "s2",
      "s10",
      null,
    ]);
  });

  it("parses a review input and bounds the score", () => {
    const input = VisualReviewInput.parse({
      shot,
      render: {
        assetId: "a1",
        kind: "IMAGE",
        width: 1080,
        height: 1920,
        durationSec: null,
        placeholder: false,
      },
      attempt: 1 + MAX_VISUAL_REGENERATIONS,
      maxAttempts: 1 + MAX_VISUAL_REGENERATIONS,
      brand,
    });
    expect(input.attempt).toBe(3);
    // The last take the loop allows: the API may lower the spec's 2 regenerations, never raise it.
    expect(VisualReviewInput.safeParse({ ...input, maxAttempts: 1 }).success).toBe(true);
    expect(VisualReviewInput.safeParse({ ...input, maxAttempts: 4 }).success).toBe(false);
    expect(VisualReviewInput.safeParse({ ...input, maxAttempts: 0 }).success).toBe(false);
    // The reviewer must always be told whether it is looking at a placeholder.
    const { placeholder: _placeholder, ...unmarked } = input.render;
    expect(VisualReviewInput.safeParse({ ...input, render: unmarked }).success).toBe(false);
    const review = { verdict: "accept", score: 8.5, issues: [], revisedPrompt: null };
    expect(VisualReviewOutput.parse(review)).toEqual(review);
    expect(VisualReviewOutput.safeParse({ ...review, score: 11 }).success).toBe(false);
    expect(VisualReviewOutput.safeParse({ ...review, score: -1 }).success).toBe(false);
    expect(VisualReviewOutput.safeParse({ ...review, verdict: "maybe" }).success).toBe(false);
  });
});

const asset = {
  id: "a2",
  client: { id: "c1", name: "Qahwa Co" },
  campaign: { id: "camp1", name: "Ramadan" },
  post: { id: "post1", ref: "p1", type: "REEL" as const },
  variantId: null,
  position: null,
  role: "SHOT" as const,
  kind: "IMAGE" as const,
  status: "READY" as const,
  version: 2,
  isCurrent: true,
  parentAssetId: "a1",
  rootAssetId: "a1",
  provider: "mock",
  providerModel: null,
  prompt: shot.prompt,
  negativePrompt: "text, logos",
  params: {
    shot,
    consistency,
    origin: "vault" as const,
    instruction: "Warmer light",
    taskId: "task1",
    mockVideo: false,
  },
  shotId: "s1",
  sceneIndex: 0,
  slideIndex: null,
  aspectRatio: "9:16" as const,
  url: "http://localhost:4000/v1/files/c1/a2.png",
  posterUrl: null,
  mimeType: "image/png",
  width: 1080,
  height: 1920,
  durationSec: null,
  bytes: 48_213,
  review: {
    verdict: "accept" as const,
    score: 8,
    issues: [],
    revisedPrompt: null,
    attempt: 1,
    reviewedAt: now,
  },
  regenCount: 1,
  createdBy: { id: "u1", name: "Admin" },
  createdAt: now,
  updatedAt: now,
};

describe("asset DTOs", () => {
  it("round-trip through z.encode", () => {
    const v1 = {
      ...asset,
      id: "a1",
      version: 1,
      isCurrent: false,
      parentAssetId: null,
      params: { ...asset.params, origin: "direct" as const, instruction: null },
      regenCount: 0,
      createdBy: null,
    };
    const samples: [z.ZodType, unknown][] = [
      [AssetDto, asset],
      [
        AssetDetailDto,
        { ...asset, lineage: { rootAssetId: "a1", currentAssetId: "a2", versions: [v1, asset] } },
      ],
      [AssetListResponse, { items: [asset], nextCursor: null }],
    ];
    for (const [schema, sample] of samples) expect(z.encode(schema, sample)).toEqual(sample);
  });

  it("reads stored params with defaults and keeps provider extras", () => {
    expect(AssetParams.parse({})).toEqual({
      shot: null,
      consistency: null,
      origin: null,
      instruction: null,
      taskId: null,
      mockVideo: false,
    });
    expect(AssetParams.parse({ mockVideo: true, guidance: 7 })).toMatchObject({
      mockVideo: true,
      guidance: 7,
    });
    expect(AssetParams.safeParse({ origin: "magic" }).success).toBe(false);
  });

  it("parses list queries from a query string", () => {
    expect(AssetListQuery.parse({})).toEqual({ allVersions: false, limit: 48 });
    expect(
      AssetListQuery.parse({
        q: "  iced  ",
        sceneIndex: "2",
        kind: "IMAGE",
        allVersions: "true",
        limit: "10",
      }),
    ).toEqual({ q: "iced", sceneIndex: 2, kind: "IMAGE", allVersions: true, limit: 10 });
    expect(AssetListQuery.safeParse({ sceneIndex: "-1" }).success).toBe(false);
    expect(AssetListQuery.safeParse({ sceneIndex: "one" }).success).toBe(false);
    expect(AssetListQuery.safeParse({ limit: "101" }).success).toBe(false);
    expect(AssetListQuery.safeParse({ q: "x".repeat(201) }).success).toBe(false);
  });

  it("takes an optional regenerate instruction byte-for-byte", () => {
    expect(RegenerateAssetBody.parse({})).toEqual({ instruction: null });
    expect(RegenerateAssetBody.parse({ instruction: null })).toEqual({ instruction: null });
    const verbatim = "  More steam.\n\tLess sugar!  ";
    expect(RegenerateAssetBody.parse({ instruction: verbatim }).instruction).toBe(verbatim);
    expect(RegenerateAssetBody.safeParse({ instruction: "   " }).success).toBe(false);
  });
});
