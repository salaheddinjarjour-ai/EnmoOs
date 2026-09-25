import { AssetParams, COPY_LIMITS, type AssetDetailDto, type AssetDto } from "@enmo/shared";
import { describe, expect, it } from "vitest";
import {
  ANY_PLACE,
  canRegenerate,
  EMPTY_FILTERS,
  fileLine,
  filtersFromSearchParams,
  formatScore,
  hasActiveFilters,
  instructionOf,
  isPendingTake,
  lineageInFlight,
  lineageSteps,
  pendingTake,
  pendingTakeId,
  PLACE_OPTIONS,
  placeOf,
  providerLabel,
  selectedTake,
  shotLabel,
  takeLabel,
  toAssetListFilters,
  vaultSearch,
  vaultTakeHref,
  withoutPendingTakes,
  withPlace,
  withTake,
} from "./vault-model";

const AT = "2027-02-01T10:00:00.000Z";

const SHOT = {
  shotId: "s1",
  sceneIndex: null,
  slideIndex: null,
  kind: "IMAGE",
  aspectRatio: "4:5",
  durationSec: null,
  prompt: "An iced cardamom latte at dusk",
  negativePrompt: "text",
  cameraNote: "Slow push-in",
  seed: 7,
} as const;

function asset(overrides: Partial<AssetDto> = {}): AssetDto {
  return {
    id: "a1",
    client: { id: "cl1", name: "Bayt Coffee" },
    campaign: { id: "c1", name: "Ramadan nights" },
    post: { id: "post1", ref: "p3", type: "STATIC" },
    variantId: null,
    position: null,
    role: "SHOT",
    kind: "IMAGE",
    status: "READY",
    version: 1,
    isCurrent: true,
    parentAssetId: null,
    rootAssetId: "a1",
    provider: "mock",
    providerModel: null,
    prompt: SHOT.prompt,
    negativePrompt: "text",
    params: AssetParams.parse({ shot: SHOT, origin: "direct" }),
    shotId: "s1",
    sceneIndex: null,
    slideIndex: null,
    aspectRatio: "4:5",
    url: "https://files.enmo.test/a1.png",
    posterUrl: null,
    mimeType: "image/png",
    width: 1080,
    height: 1350,
    durationSec: null,
    bytes: 412_000,
    review: null,
    regenCount: 0,
    createdBy: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function detailOf(versions: AssetDto[], openId = versions[0]!.id): AssetDetailDto {
  const opened = versions.find((take) => take.id === openId)!;
  return {
    ...opened,
    lineage: {
      rootAssetId: versions[0]!.id,
      currentAssetId: versions.find((take) => take.isCurrent)?.id ?? null,
      versions,
    },
  };
}

const v1 = asset({ isCurrent: false, status: "REJECTED" });
const v2 = asset({ id: "a2", version: 2, parentAssetId: "a1", regenCount: 1 });

describe("filters", () => {
  it("leaves a blank search and the 'all' choices out of the query", () => {
    expect(toAssetListFilters(EMPTY_FILTERS)).toEqual({});
    expect(toAssetListFilters({ ...EMPTY_FILTERS, q: "   " })).toEqual({});
    expect(hasActiveFilters({ ...EMPTY_FILTERS, q: "  " })).toBe(false);
    expect(
      toAssetListFilters({
        q: "  iced latte ",
        clientId: "cl1",
        campaignId: "c1",
        sceneIndex: 2,
        slideIndex: null,
        kind: "VIDEO",
        allVersions: true,
      }),
    ).toEqual({
      q: "iced latte",
      clientId: "cl1",
      campaignId: "c1",
      sceneIndex: 2,
      kind: "VIDEO",
      allVersions: true,
    });
    // Scene and slide 0 are real places, not "all".
    expect(toAssetListFilters({ ...EMPTY_FILTERS, sceneIndex: 0 })).toEqual({ sceneIndex: 0 });
    expect(toAssetListFilters({ ...EMPTY_FILTERS, slideIndex: 0 })).toEqual({ slideIndex: 0 });
    expect(hasActiveFilters({ ...EMPTY_FILTERS, slideIndex: 0 })).toBe(true);
  });

  it("narrows to one scene or slide, labelled as the post drawer counts them", () => {
    expect(PLACE_OPTIONS[0]).toEqual({ value: ANY_PLACE, label: "Any scene or slide" });
    const labels = PLACE_OPTIONS.map((option) => option.label);
    expect(labels.filter((label) => label.startsWith("Scene "))).toHaveLength(
      COPY_LIMITS.scenesMax,
    );
    expect(labels.filter((label) => label.startsWith("Slide "))).toHaveLength(
      COPY_LIMITS.slidesMax,
    );
    expect(PLACE_OPTIONS).toContainEqual({ value: "scene:2", label: "Scene 3" });
    expect(PLACE_OPTIONS).toContainEqual({ value: "slide:0", label: "Slide 1" });

    const scene = withPlace(EMPTY_FILTERS, "scene:2");
    expect(scene).toMatchObject({ sceneIndex: 2, slideIndex: null });
    expect(placeOf(scene)).toBe("scene:2");
    expect(toAssetListFilters(scene)).toEqual({ sceneIndex: 2 });
    // Picking a slide replaces the scene, and "any" clears both.
    const slide = withPlace(scene, "slide:1");
    expect(slide).toMatchObject({ sceneIndex: null, slideIndex: 1 });
    expect(toAssetListFilters(slide)).toEqual({ slideIndex: 1 });
    expect(withPlace(slide, ANY_PLACE)).toEqual(EMPTY_FILTERS);
    expect(placeOf(EMPTY_FILTERS)).toBe(ANY_PLACE);
    expect(withPlace(slide, "scene:x")).toEqual(EMPTY_FILTERS);
    // Every choice round-trips.
    for (const option of PLACE_OPTIONS) {
      expect(placeOf(withPlace(EMPTY_FILTERS, option.value))).toBe(option.value);
    }
  });

  it("reads a Vault address, dropping what it doesn't know", () => {
    const params = new URLSearchParams("q=latte&campaignId=c1&kind=GIF&allVersions=true&x=1");
    expect(filtersFromSearchParams(params)).toEqual({
      q: "latte",
      clientId: null,
      campaignId: "c1",
      sceneIndex: null,
      slideIndex: null,
      kind: null,
      allVersions: true,
    });
    const place = (search: string) => {
      const { sceneIndex, slideIndex } = filtersFromSearchParams(new URLSearchParams(search));
      return [sceneIndex, slideIndex];
    };
    expect(place("sceneIndex=0")).toEqual([0, null]);
    expect(place("slideIndex=3")).toEqual([null, 3]);
    // A take fills a scene or a slide, never both; indexes the copy can't have are dropped.
    expect(place("sceneIndex=1&slideIndex=2")).toEqual([1, null]);
    expect(place(`sceneIndex=${COPY_LIMITS.scenesMax}`)).toEqual([null, null]);
    expect(place(`slideIndex=${COPY_LIMITS.slidesMax}`)).toEqual([null, null]);
    for (const junk of ["sceneIndex=", "sceneIndex=-1", "sceneIndex=1.5", "slideIndex=two"]) {
      expect(place(junk), junk).toEqual([null, null]);
    }
  });

  it("writes the address back, with the open take", () => {
    expect(vaultSearch(EMPTY_FILTERS, null)).toBe("");
    expect(vaultSearch({ ...EMPTY_FILTERS, q: "iced latte", kind: "IMAGE" }, "a2")).toBe(
      "?q=iced+latte&kind=IMAGE&asset=a2",
    );
    expect(vaultTakeHref("a1")).toBe("/vault?asset=a1");
    expect(vaultSearch({ ...EMPTY_FILTERS, campaignId: "c1", sceneIndex: 0 }, null)).toBe(
      "?campaignId=c1&sceneIndex=0",
    );
    // The round trip is stable, so syncing the address never loops.
    for (const filters of [
      { ...EMPTY_FILTERS, campaignId: "c1", allVersions: true },
      { ...EMPTY_FILTERS, sceneIndex: 0, kind: "VIDEO" as const },
      { ...EMPTY_FILTERS, q: "latte", slideIndex: 4 },
    ]) {
      const search = vaultSearch(filters, null);
      expect(filtersFromSearchParams(new URLSearchParams(search))).toEqual(filters);
      expect(vaultSearch(filtersFromSearchParams(new URLSearchParams(search)), null)).toBe(search);
    }
  });
});

describe("labels", () => {
  it("names a take by post, shot and version", () => {
    expect(shotLabel(v2)).toBe("p3 · s1");
    expect(takeLabel(v2)).toBe("p3 · s1 · v2");
    expect(takeLabel(asset({ post: null, shotId: null, version: 3 }))).toBe("Take · v3");
  });

  it("formats provider, score and file", () => {
    expect(providerLabel(v2)).toBe("mock");
    expect(providerLabel(asset({ provider: "higgsfield", providerModel: "soul" }))).toBe(
      "higgsfield · soul",
    );
    expect(formatScore(7)).toBe("7");
    expect(formatScore(7.25)).toBe("7.3");
    expect(fileLine(v2)).toBe("1080×1350 · PNG · 402 KB");
    expect(fileLine(asset({ width: null, height: null, mimeType: null, bytes: null }))).toBeNull();
  });
});

describe("lineage", () => {
  it("draws v1 → v2 with the rejected take dimmed and the current one marked", () => {
    const steps = lineageSteps(detailOf([v1, v2]));
    expect(steps.map((step) => [step.take.version, step.current, step.dimmed])).toEqual([
      [1, false, true],
      [2, true, false],
    ]);
  });

  it("shows the version picked, else the one opened", () => {
    const detail = detailOf([v1, v2], "a1");
    expect(selectedTake(detail, null).id).toBe("a1");
    expect(selectedTake(detail, "a2").id).toBe("a2");
    expect(selectedTake(detail, "gone").id).toBe("a1");
  });

  it("knows when a take of the shot is still rendering", () => {
    expect(lineageInFlight(detailOf([v1, v2]))).toBe(false);
    expect(lineageInFlight(detailOf([v1, { ...v2, status: "RENDERING" }]))).toBe(true);
  });

  it("regenerates only the Visual Director's shots on a post", () => {
    expect(canRegenerate(v2)).toBe(true);
    expect(canRegenerate(asset({ role: "VARIANT_FRAME" }))).toBe(false);
    expect(canRegenerate(asset({ post: null }))).toBe(false);
    expect(canRegenerate(asset({ params: AssetParams.parse({}) }))).toBe(false);
  });
});

describe("Regenerate", () => {
  it("sends the note verbatim, or nothing when it is blank", () => {
    expect(instructionOf("  Warmer light.\n")).toBe("  Warmer light.\n");
    expect(instructionOf(" \n ")).toBeNull();
  });

  it("draws the next version at once, queued, carrying the instruction", () => {
    const detail = detailOf([v1, v2]);
    const me = { id: "u1", name: "Salma" };
    const placeholder = pendingTake(v2, detail, {
      instruction: "Closer to the glass.",
      createdBy: me,
      now: AT,
    });
    expect(placeholder).toMatchObject({
      id: pendingTakeId("a2"),
      status: "QUEUED",
      version: 3,
      isCurrent: false,
      parentAssetId: "a2",
      rootAssetId: "a1",
      url: null,
      review: null,
      regenCount: 2,
      createdBy: me,
    });
    expect(placeholder.params).toMatchObject({
      origin: "vault",
      instruction: "Closer to the glass.",
    });
    expect(isPendingTake(placeholder.id)).toBe(true);

    const optimistic = withTake(detail, placeholder);
    expect(optimistic.lineage.versions.map((take) => take.version)).toEqual([1, 2, 3]);
    expect(lineageSteps(optimistic).at(-1)).toMatchObject({ pending: true, current: false });
    expect(lineageInFlight(optimistic)).toBe(true);

    // The API's answer replaces the placeholder.
    const created = asset({ id: "a3", version: 3, status: "QUEUED", isCurrent: false });
    const answered = withTake(withoutPendingTakes(optimistic), created);
    expect(answered.lineage.versions.map((take) => take.id)).toEqual(["a1", "a2", "a3"]);
    expect(withoutPendingTakes(detail)).toBe(detail);
  });

  it("leaves another lineage alone", () => {
    const other = detailOf([asset({ id: "b1", rootAssetId: "b1" })]);
    expect(withTake(other, v2)).toBe(other);
  });
});
