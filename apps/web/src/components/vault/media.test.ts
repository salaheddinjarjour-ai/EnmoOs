import type { AssetThumbDto } from "@enmo/shared";
import { describe, expect, it } from "vitest";
import {
  fitStyle,
  frameSizeOf,
  isRendering,
  isVideoTake,
  playableVideoUrl,
  previewVisual,
  stillUrlOf,
} from "./media";

function take(overrides: Partial<AssetThumbDto> = {}): AssetThumbDto {
  return {
    id: "a1",
    kind: "IMAGE",
    status: "READY",
    version: 1,
    shotId: "s1",
    sceneIndex: null,
    slideIndex: null,
    url: "https://files.enmo.test/clients/cl1/assets/a1.png",
    posterUrl: null,
    mimeType: "image/png",
    width: 1080,
    height: 1350,
    durationSec: null,
    ...overrides,
  };
}

describe("stillUrlOf", () => {
  it("draws an image take's own file", () => {
    expect(stillUrlOf(take())).toBe("https://files.enmo.test/clients/cl1/assets/a1.png");
  });

  it("draws a clip's poster, never the clip", () => {
    const clip = take({
      kind: "VIDEO",
      url: "https://files.enmo.test/a1.mp4",
      mimeType: "video/mp4",
      posterUrl: "https://files.enmo.test/a1.poster.png",
    });
    expect(stillUrlOf(clip)).toBe("https://files.enmo.test/a1.poster.png");
    expect(stillUrlOf({ ...clip, posterUrl: null })).toBeNull();
  });

  it("has nothing while the take renders or after it failed", () => {
    expect(stillUrlOf(take({ status: "QUEUED", url: null, mimeType: null }))).toBeNull();
    expect(stillUrlOf(take({ status: "RENDERING", url: null, mimeType: null }))).toBeNull();
    expect(stillUrlOf(take({ status: "FAILED", url: null, mimeType: null }))).toBeNull();
  });

  it("still shows a take the review rejected, which kept its file", () => {
    expect(stillUrlOf(take({ status: "REJECTED" }))).toBe(take().url);
  });
});

describe("playableVideoUrl and isVideoTake", () => {
  it("plays only real clips; MockProvider's video is a poster PNG", () => {
    const mockVideo = take({ kind: "VIDEO", posterUrl: take().url });
    expect(playableVideoUrl(mockVideo)).toBeNull();
    expect(isVideoTake(mockVideo)).toBe(true);

    const clip = take({ kind: "VIDEO", url: "https://x/a.mp4", mimeType: "video/mp4" });
    expect(playableVideoUrl(clip)).toBe("https://x/a.mp4");
    expect(playableVideoUrl({ ...clip, status: "RENDERING" })).toBeNull();
  });

  it("badges an image take flagged as mock video", () => {
    expect(isVideoTake({ kind: "IMAGE", params: { mockVideo: true } })).toBe(true);
    expect(isVideoTake({ kind: "IMAGE", params: { mockVideo: false } })).toBe(false);
  });
});

describe("frameSizeOf and fitStyle", () => {
  it("frames the planned ratio first, then the measured pixels, then the fallback", () => {
    expect(frameSizeOf({ width: 10, height: 10, aspectRatio: "9:16" }, "4:5")).toEqual({
      width: 1080,
      height: 1920,
    });
    expect(frameSizeOf({ width: 1080, height: 1080 }, "4:5")).toEqual({
      width: 1080,
      height: 1080,
    });
    expect(frameSizeOf({ width: null, height: null }, "4:5")).toEqual({
      width: 1080,
      height: 1350,
    });
  });

  it("sizes the box to fit its container at the take's proportions", () => {
    expect(fitStyle({ width: 1080, height: 1920 })).toEqual({
      aspectRatio: "1080 / 1920",
      width: "min(100cqw, calc(100cqh * 1080 / 1920))",
    });
  });
});

describe("previewVisual", () => {
  it("falls back to the text frame before the Visual Director has shots", () => {
    expect(previewVisual([])).toEqual({ mode: "none" });
  });

  it("shows the first shot, with how many there are (a carousel's first slide)", () => {
    const slides = [
      take({ id: "a1", slideIndex: 0 }),
      take({ id: "a2", slideIndex: 1, status: "RENDERING", url: null }),
    ];
    expect(previewVisual(slides)).toMatchObject({ mode: "image", index: 0, count: 2 });
    expect(previewVisual(slides)).toHaveProperty("take.id", "a1");
  });

  it("shimmers while the first shot renders", () => {
    const lead = take({ status: "QUEUED", url: null, mimeType: null });
    expect(previewVisual([lead, take({ id: "a2" })])).toEqual({
      mode: "rendering",
      lead,
      count: 2,
    });
    expect(isRendering(lead.status)).toBe(true);
  });

  it("skips a failed first shot for the next one with a still", () => {
    const failed = take({ id: "a1", status: "FAILED", url: null, mimeType: null });
    expect(previewVisual([failed, take({ id: "a2" })])).toMatchObject({
      mode: "image",
      index: 1,
    });
    const rendering = take({ id: "a2", status: "RENDERING", url: null });
    expect(previewVisual([failed, rendering])).toEqual({
      mode: "rendering",
      lead: rendering,
      count: 2,
    });
    expect(previewVisual([failed])).toEqual({ mode: "none" });
  });
});
