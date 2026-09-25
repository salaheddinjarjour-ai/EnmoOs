import type { CopywriterOutput } from "@enmo/shared";
import { describe, expect, it } from "vitest";
import { describeIssues, preparePayload, variantCopyOf, type PayloadTake } from "./payload";

/* What a variant publishes (DESIGN §F): its text, and the post's current takes by URL. */

const COPY: CopywriterOutput = {
  caption: "Cold brew, warm evenings.",
  hashtags: ["#Ramadan", "#IcedLatte"],
  cta: "Order tonight",
  altText: "An iced latte on a windowsill at sunset",
  platformCaptions: [
    { platform: "INSTAGRAM", caption: "Cold brew after iftar." },
    { platform: "FACEBOOK", caption: "Cold brew, warm evenings, after iftar." },
  ],
  script: {
    totalDurationSec: 15,
    hookTimestampSec: 1,
    hookText: "Iftar, iced.",
    scenes: [
      { index: 0, startSec: 0, durationSec: 2.5, voiceover: "", overlayText: "", visualNote: "" },
      {
        index: 1,
        startSec: 2.5,
        durationSec: 12.5,
        voiceover: "",
        overlayText: "",
        visualNote: "",
      },
    ],
  },
  slides: null,
  onScreenText: null,
};

let sequence = 0;
function take(overrides: Partial<PayloadTake> & { slideIndex?: number | null } = {}): PayloadTake {
  const { slideIndex = null, ...rest } = overrides;
  sequence += 1;
  return {
    id: `asset_${sequence}`,
    kind: "IMAGE",
    status: "READY",
    url: `https://files.enmo.test/clients/c1/asset_${sequence}.png`,
    posterUrl: null,
    mimeType: "image/png",
    width: 1080,
    height: 1920,
    durationSec: null,
    shotId: `s${sequence}`,
    sceneIndex: null,
    params: {
      shot: {
        shotId: `s${sequence}`,
        sceneIndex: rest.sceneIndex ?? null,
        slideIndex,
        kind: rest.kind ?? "IMAGE",
        aspectRatio: "9:16",
        durationSec: rest.durationSec ?? null,
        prompt: "An iced latte at golden hour",
        negativePrompt: "",
        cameraNote: "Static, eye level",
        seed: null,
      },
    },
    ...rest,
  };
}

const base = {
  platform: "INSTAGRAM" as const,
  variantId: "variant_1",
  caption: "Cold brew after iftar.",
  hashtags: ["#Ramadan"],
  copy: COPY,
  publicBaseUrl: "https://api.enmo.test/files",
};

describe("variantCopyOf", () => {
  it("takes the platform's own caption and the copy's hashtags", () => {
    expect(variantCopyOf(COPY, "FACEBOOK")).toEqual({
      caption: "Cold brew, warm evenings, after iftar.",
      hashtags: ["#Ramadan", "#IcedLatte"],
    });
    // No caption for TikTok: the main one.
    expect(variantCopyOf(COPY, "TIKTOK").caption).toBe("Cold brew, warm evenings.");
  });
});

describe("preparePayload", () => {
  it("publishes a static post's take with the copy's alt text", () => {
    const image = take();
    const prepared = preparePayload({ ...base, postType: "STATIC", takes: [image] });
    expect(prepared).toEqual({
      ok: true,
      payload: {
        platform: "INSTAGRAM",
        postType: "STATIC",
        variantId: "variant_1",
        caption: "Cold brew after iftar.",
        altText: "An iced latte on a windowsill at sunset",
        hashtags: ["#Ramadan"],
        media: [
          { kind: "IMAGE", url: image.url, width: 1080, height: 1920, mimeType: "image/png" },
        ],
      },
    });
  });

  it("publishes a reel's first scene at the script's length, whatever the clip runs", () => {
    const second = take({ kind: "VIDEO", sceneIndex: 1, durationSec: 12.5 });
    const first = take({
      kind: "VIDEO",
      sceneIndex: 0,
      durationSec: 2.5,
      posterUrl: "clients/c1/poster.png",
    });
    const prepared = preparePayload({ ...base, postType: "REEL", takes: [second, first] });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.payload.media).toEqual([
      expect.objectContaining({ kind: "VIDEO", url: first.url, durationSec: 15 }),
    ]);
    // A relative stored URL is made absolute against PUBLIC_ASSET_BASE_URL.
    expect(prepared.payload.coverUrl).toBe("https://api.enmo.test/files/clients/c1/poster.png");
  });

  it("publishes a carousel's slides in slide order", () => {
    const slides = [2, 0, 1].map((slideIndex) => take({ slideIndex }));
    const prepared = preparePayload({ ...base, postType: "CAROUSEL", takes: slides });
    expect(prepared.ok && prepared.payload.media.map((media) => media.url)).toEqual([
      slides[1]!.url,
      slides[2]!.url,
      slides[0]!.url,
    ]);
  });

  it("reports what a platform wouldn't take, a take that isn't ready included", () => {
    const rendering = take({ status: "RENDERING", url: null });
    const prepared = preparePayload({ ...base, postType: "STATIC", takes: [rendering] });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.issues[0]).toEqual({
      path: "media",
      message: `Take ${rendering.shotId} isn't ready to publish (RENDERING).`,
    });
    expect(preparePayload({ ...base, postType: "STATIC", takes: [] })).toMatchObject({ ok: false });
    const oneSlide = preparePayload({
      ...base,
      postType: "CAROUSEL",
      takes: [take({ slideIndex: 0 })],
    });
    expect(oneSlide.ok || describeIssues(oneSlide.issues)).toContain("A carousel takes 2 to 10");
  });
});
