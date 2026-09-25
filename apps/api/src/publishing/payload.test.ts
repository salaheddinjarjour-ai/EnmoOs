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
    storageKey: `clients/c1/asset_${sequence}.png`,
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
  storageUrl: (key: string) => `https://files.enmo.test/${key}`,
};

/** Where the Instagram rendition of a take's master lives, and what it is. */
function igRendition(image: PayloadTake, width = 1080, height = 1350) {
  const stem = image.storageKey!.replace(/\.png$/, "");
  const key = `${stem}-instagram-${width}x${height}.jpg`;
  return {
    rendition: { sourceKey: image.storageKey!, key, mimeType: "image/jpeg", width, height },
    media: { kind: "IMAGE", url: `https://files.enmo.test/${key}`, width, height, mimeType: "image/jpeg" },
  };
}

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
  it("publishes a static post's take with the copy's alt text: on Facebook, the master as is", () => {
    const image = take();
    const prepared = preparePayload({
      ...base,
      platform: "FACEBOOK",
      postType: "STATIC",
      takes: [image],
    });
    expect(prepared).toEqual({
      ok: true,
      payload: {
        platform: "FACEBOOK",
        postType: "STATIC",
        variantId: "variant_1",
        caption: "Cold brew after iftar.",
        altText: "An iced latte on a windowsill at sunset",
        hashtags: ["#Ramadan"],
        media: [
          { kind: "IMAGE", url: image.url, width: 1080, height: 1920, mimeType: "image/png" },
        ],
      },
      renditions: [],
    });
  });

  it("publishes an Instagram image as a JPEG rendition: 4:5 from the centre for the feed, whole for a story", () => {
    const image = take();
    const feed = preparePayload({ ...base, postType: "STATIC", takes: [image] });
    const cut = igRendition(image);
    expect(feed).toMatchObject({ ok: true, payload: { media: [cut.media] }, renditions: [cut.rendition] });

    const story = preparePayload({ ...base, postType: "STORY", takes: [image] });
    const whole = igRendition(image, 1080, 1920);
    expect(story).toMatchObject({ ok: true, payload: { media: [whole.media] }, renditions: [whole.rendition] });

    // A JPEG already inside the feed's range goes out as it is.
    const jpeg = take({ mimeType: "image/jpeg", width: 1080, height: 1350 });
    expect(preparePayload({ ...base, postType: "STATIC", takes: [jpeg] })).toMatchObject({
      ok: true,
      payload: { media: [{ url: jpeg.url, mimeType: "image/jpeg" }] },
      renditions: [],
    });

    // Without a stored master there is nothing to cut it from.
    const unstored = take({ storageKey: null });
    const refused = preparePayload({ ...base, postType: "STATIC", takes: [unstored] });
    expect(refused.ok || describeIssues(refused.issues)).toContain(
      `Take ${unstored.shotId} can't go out: it has no stored file`,
    );
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
    expect(prepared.ok && prepared.payload.media.map((media) => media.url)).toEqual(
      [slides[1]!, slides[2]!, slides[0]!].map((slide) => igRendition(slide).media.url),
    );
    expect(prepared.ok && prepared.renditions).toHaveLength(3);
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
    expect(preparePayload({ ...base, postType: "STATIC", takes: [] })).toEqual({
      ok: false,
      issues: [{ path: "media", message: "The post has no visuals to publish." }],
    });
    const oneSlide = preparePayload({
      ...base,
      postType: "CAROUSEL",
      takes: [take({ slideIndex: 0 })],
    });
    expect(oneSlide.ok || describeIssues(oneSlide.issues)).toContain("A carousel takes 2 to 10");
  });
});
