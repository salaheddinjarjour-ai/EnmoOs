import type { Asset } from "@enmo/db";
import type { AssetReview, CopywriterOutput, Shot, VisualDirectCopy } from "@enmo/shared";
import { describe, expect, it } from "vitest";
import { sceneTextFor } from "./renders";
import { awaitedTakes, blockingTake, settled } from "./take-completion";
import {
  budgetDeferral,
  jsonParams,
  lineageRootId,
  postSlotKeys,
  slotKey,
  takeParams,
  takeSlot,
} from "./takes";
import { bestTake, previousShotList } from "./visuals";

/* The visual loop's pure pieces: places in a post, lineages, the best take, settling. */

function shot(overrides: Partial<Shot> = {}): Shot {
  return {
    shotId: "s1",
    sceneIndex: null,
    slideIndex: null,
    kind: "IMAGE",
    aspectRatio: "9:16",
    durationSec: null,
    prompt: "An iced latte at dusk",
    negativePrompt: "text",
    cameraNote: "Static",
    seed: 7,
    ...overrides,
  };
}

function review(verdict: "accept" | "regenerate", score: number): AssetReview {
  return {
    verdict,
    score,
    issues: verdict === "accept" ? [] : ["Too dark"],
    revisedPrompt: verdict === "accept" ? null : "Brighter",
    attempt: 1,
    reviewedAt: "2026-09-24T10:00:00.000Z",
  };
}

let n = 0;
function take(
  overrides: Partial<Asset> & { shot?: Shot; origin?: string; onTrial?: boolean } = {},
): Asset {
  const { shot: planned = shot(), origin = "direct", onTrial = false, ...rest } = overrides;
  n += 1;
  return {
    id: `a${n}`,
    clientId: "c1",
    campaignId: "k1",
    postId: "p1",
    variantId: null,
    position: null,
    role: "SHOT",
    parentAssetId: null,
    rootAssetId: `a${n}`,
    version: 1,
    isCurrent: true,
    kind: planned.kind,
    status: "READY",
    provider: "mock",
    providerModel: null,
    providerJobId: "job",
    prompt: planned.prompt,
    negativePrompt: null,
    params: { shot: planned, origin, taskId: "t1", ...(onTrial ? { onTrial: true } : {}) },
    shotId: planned.shotId,
    sceneIndex: planned.sceneIndex,
    storageKey: `clients/c1/assets/a${n}.png`,
    url: `https://files.enmo.test/a${n}.png`,
    posterUrl: null,
    mimeType: "image/png",
    width: 1080,
    height: 1920,
    durationSec: null,
    bytes: 1000,
    review: null,
    regenCount: 0,
    createdById: null,
    createdAt: new Date("2026-09-24T10:00:00Z"),
    updatedAt: new Date("2026-09-24T10:00:00Z"),
    ...rest,
  };
}

const scenes = (count: number): VisualDirectCopy => ({
  script: {
    totalDurationSec: count * 3,
    hookTimestampSec: 1,
    hookText: "Hook",
    scenes: Array.from({ length: count }, (_, index) => ({
      index,
      startSec: index * 3,
      durationSec: 3,
      voiceover: `Line ${index}`,
      overlayText: index === 1 ? "" : `Overlay ${index}`,
      visualNote: "Note",
    })),
  },
  slides: null,
  onScreenText: null,
});

describe("places in a post", () => {
  it("has one place per scene, per slide, or the single image", () => {
    expect(postSlotKeys("REEL", scenes(3))).toEqual(["0/-", "1/-", "2/-"]);
    const slides: VisualDirectCopy = {
      script: null,
      slides: [0, 1, 2].map((index) => ({ index, headline: `H${index}`, body: "" })),
      onScreenText: null,
    };
    expect(postSlotKeys("CAROUSEL", slides)).toEqual(["-/0", "-/1", "-/2"]);
    expect(postSlotKeys("STATIC", { script: null, slides: null, onScreenText: "Hi" })).toEqual([
      "-/-",
    ]);
    // A copy of the wrong shape still asks for one image.
    expect(postSlotKeys("REEL", { script: null, slides: null, onScreenText: null })).toEqual([
      "-/-",
    ]);
  });

  it("reads a take's place from its shot, and its lineage from rootAssetId", () => {
    const slide = take({ shot: shot({ slideIndex: 2 }) });
    expect(slotKey(takeSlot(slide, takeParams(slide)))).toBe("-/2");
    expect(lineageRootId({ id: "v1", rootAssetId: null })).toBe("v1");
    expect(lineageRootId({ id: "v2", rootAssetId: "v1" })).toBe("v1");
  });

  it("stores params as plain JSON and reads them back with defaults", () => {
    const stored = jsonParams({ ...takeParams(take()), pendingDirection: true });
    expect(stored).toMatchObject({ origin: "direct", pendingDirection: true, mockVideo: false });
    expect(takeParams({ id: "x", params: {} })).toEqual({
      shot: null,
      consistency: null,
      origin: null,
      instruction: null,
      taskId: null,
      mockVideo: false,
    });
    expect(budgetDeferral({ clock: { now: () => new Date("2026-09-24T23:59:55Z") } })).toEqual({
      requeue: "budget-2026-09-25",
      delayMs: 10_000,
    });
  });
});

describe("previousShotList", () => {
  const takes = [0, 1, 2].map((i) =>
    take({ shot: shot({ shotId: `s${i + 1}`, sceneIndex: i, kind: "VIDEO", durationSec: 3 }) }),
  );

  it("returns the shots in post order while they cover every place of the copy", () => {
    const list = previousShotList([...takes].reverse(), { type: "REEL" }, scenes(3));
    expect(list?.map((s) => s.shotId)).toEqual(["s1", "s2", "s3"]);
    // A copy that lost a scene still has a previous shot for each place left.
    expect(previousShotList(takes, { type: "REEL" }, scenes(2))?.map((s) => s.shotId)).toEqual([
      "s1",
      "s2",
    ]);
  });

  it("leaves the list out when the copy gained a place or nothing was shot", () => {
    expect(previousShotList(takes, { type: "REEL" }, scenes(4))).toBeNull();
    expect(previousShotList([], { type: "REEL" }, scenes(3))).toBeNull();
  });
});

describe("bestTake", () => {
  it("picks the best-scored rendered take, the latest on a tie", () => {
    const low = take({ version: 1, status: "REJECTED", review: review("regenerate", 4) });
    const high = take({ version: 2, status: "REJECTED", review: review("regenerate", 6) });
    const tie = take({ version: 3, status: "READY", review: review("regenerate", 6) });
    expect(bestTake([low, high])?.id).toBe(high.id);
    expect(bestTake([low, high, tie])?.id).toBe(tie.id);
  });

  it("prefers a scored take over an unreviewed one and never picks a take with no file", () => {
    const scored = take({ version: 1, status: "REJECTED", review: review("regenerate", 3) });
    const unreviewed = take({ version: 2, status: "READY" });
    const refused = take({ version: 3, status: "REJECTED", url: null });
    const failed = take({ version: 4, status: "FAILED", url: null });
    expect(bestTake([scored, unreviewed, refused, failed])?.id).toBe(scored.id);
    expect(bestTake([refused, failed])).toBeUndefined();
  });

  it("keeps the take on show against a trial unless a take of the trial scored higher", () => {
    const onShow = take({ version: 1, review: review("accept", 6) });
    const weak = take({
      version: 2,
      isCurrent: false,
      status: "REJECTED",
      review: review("regenerate", 4),
    });
    const tie = take({ version: 3, isCurrent: false, review: review("regenerate", 6) });
    const better = take({ version: 4, isCurrent: false, review: review("accept", 8) });
    const unrendered = take({ version: 5, isCurrent: false, status: "FAILED", url: null });
    expect(bestTake([weak], onShow)?.id).toBe(onShow.id);
    expect(bestTake([weak, tie], onShow)?.id).toBe(onShow.id);
    expect(bestTake([weak, tie, better], onShow)?.id).toBe(better.id);
    // Nothing of the trial rendered: the post keeps what it shows.
    expect(bestTake([unrendered], onShow)?.id).toBe(onShow.id);
    // An unreviewed take on show loses to any scored take of the trial.
    expect(bestTake([weak], take({ version: 1 }))?.id).toBe(weak.id);
  });
});

describe("settled", () => {
  it("needs every current take READY and accepted", () => {
    const accepted = take({ review: review("accept", 8) });
    const old = take({ isCurrent: false, status: "REJECTED", review: review("regenerate", 3) });
    expect(settled([accepted, old])).toBe(true);
    expect(settled([accepted, take({ status: "RENDERING" })])).toBe(false);
    expect(settled([accepted, take({ review: review("regenerate", 4) })])).toBe(false);
    expect(settled([old])).toBe(false);
  });

  it("waits for a take on trial until it is accepted and current", () => {
    // A weak Vault take goes round the loop like any other: it never settles the task.
    const weak = take({
      origin: "vault",
      onTrial: true,
      isCurrent: false,
      review: review("regenerate", 4),
    });
    expect(settled([weak])).toBe(false);
    const unreviewed = take({ origin: "vault", onTrial: true, isCurrent: false });
    expect(settled([unreviewed])).toBe(false);
    const promoted = take({ origin: "review", onTrial: true, review: review("accept", 8) });
    expect(settled([weak, promoted])).toBe(true);
  });
});

describe("awaitedTakes and blockingTake", () => {
  it("waits on the current takes and on the newest take of each lineage on trial", () => {
    const current = take({ review: review("accept", 8) });
    const trialV2 = take({
      rootAssetId: "root",
      version: 2,
      isCurrent: false,
      onTrial: true,
      status: "REJECTED",
      review: review("regenerate", 4),
    });
    const trialV3 = take({ rootAssetId: "root", version: 3, isCurrent: false, onTrial: true });
    const replaced = take({
      isCurrent: false,
      status: "REJECTED",
      review: review("regenerate", 3),
    });
    expect(awaitedTakes([current, trialV2, trialV3, replaced]).map((t) => t.id)).toEqual([
      current.id,
      trialV3.id,
    ]);
    expect(blockingTake([current, trialV2, trialV3, replaced])).toBeUndefined();
  });

  it("finds an awaited take that failed or was refused, never one the review replaced", () => {
    const failed = take({ status: "FAILED", url: null });
    expect(blockingTake([take({ review: review("accept", 8) }), failed])?.id).toBe(failed.id);
    const refused = take({ status: "REJECTED", url: null });
    expect(blockingTake([refused])?.id).toBe(refused.id);
    const failedOnTrial = take({ isCurrent: false, onTrial: true, status: "FAILED", url: null });
    expect(blockingTake([failedOnTrial])?.id).toBe(failedOnTrial.id);
    const regenerated = take({
      isCurrent: false,
      status: "REJECTED",
      review: review("regenerate", 4),
    });
    expect(blockingTake([regenerated, take({ status: "RENDERING" })])).toBeUndefined();
  });
});

describe("sceneTextFor", () => {
  const copy = (patch: Partial<CopywriterOutput>): CopywriterOutput =>
    ({ script: null, slides: null, onScreenText: null, ...patch }) as CopywriterOutput;

  it("labels a render with the words its shot illustrates", () => {
    const reel = copy({ script: scenes(3).script });
    expect(sceneTextFor(reel, shot({ sceneIndex: 0 }))).toBe("Overlay 0");
    // No overlay: the voiceover line.
    expect(sceneTextFor(reel, shot({ sceneIndex: 1 }))).toBe("Line 1");
    const carousel = copy({ slides: [{ index: 0, headline: "Cover", body: "" }] });
    expect(sceneTextFor(carousel, shot({ slideIndex: 0 }))).toBe("Cover");
    expect(sceneTextFor(copy({ onScreenText: "Iced, after iftar" }), shot())).toBe(
      "Iced, after iftar",
    );
    expect(sceneTextFor(null, shot())).toBeNull();
    expect(sceneTextFor(reel, shot({ sceneIndex: 9 }))).toBeNull();
  });
});
