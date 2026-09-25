import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { AspectRatio, DEFAULT_VISUAL_STYLE, pixelSizeFor } from "@enmo/shared";
import { renderPlaceholder, type PlaceholderOptions } from "../src";

function options(overrides: Partial<PlaceholderOptions> = {}): PlaceholderOptions {
  return {
    ...pixelSizeFor("4:5"),
    palette: { ...DEFAULT_VISUAL_STYLE.palette, accent: "#E0A458" },
    fonts: DEFAULT_VISUAL_STYLE.typography,
    text: "Iftar, iced.",
    detail: "A sweating glass of cold brew on dark marble at golden hour",
    footer: "MOCK · s1 · v1",
    label: "Qahwa House",
    tag: "4:5",
    seed: 7,
    ...overrides,
  };
}

async function raw(png: Buffer) {
  return sharp(png).raw().toBuffer({ resolveWithObject: true });
}

/** How many pixels differ by more than a rounding error between two renders of the same size. */
async function changedPixels(a: Buffer, b: Buffer): Promise<number> {
  const [left, right] = await Promise.all([raw(a), raw(b)]);
  expect([left.info.width, left.info.height]).toEqual([right.info.width, right.info.height]);
  const channels = left.info.channels;
  let changed = 0;
  for (let i = 0; i < left.data.length; i += channels) {
    for (let c = 0; c < channels; c++) {
      if (Math.abs(left.data[i + c]! - right.data[i + c]!) > 8) {
        changed++;
        break;
      }
    }
  }
  return changed;
}

describe("renderPlaceholder", () => {
  it.each(AspectRatio.options)("renders an opaque PNG of exactly the %s size", async (ratio) => {
    const size = pixelSizeFor(ratio);
    const png = await renderPlaceholder(options({ ...size, tag: ratio }));
    const meta = await sharp(png).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", size.width, size.height]);
    expect(meta.channels).toBe(3);
  });

  it("draws the words: the text layers change thousands of pixels", async () => {
    const blank = await renderPlaceholder(options({ text: null, detail: null, label: null }));
    const worded = await renderPlaceholder(options());
    expect(await changedPixels(blank, worded)).toBeGreaterThan(10_000);

    // Only the headline differs, in the brand's display font.
    const bodyFontHeadline = await renderPlaceholder(
      options({ fonts: { ...DEFAULT_VISUAL_STYLE.typography, display: "INTER" } }),
    );
    expect(await changedPixels(worded, bodyFontHeadline)).toBeGreaterThan(1_000);
  });

  it("is not a flat fill: the gradient and glow vary across the frame", async () => {
    const { channels } = await sharp(
      await renderPlaceholder(options({ text: null, detail: null })),
    ).stats();
    for (const channel of channels) expect(channel.max - channel.min).toBeGreaterThan(20);
  });

  it("gives identical bytes for identical options, and a new look for a new seed", async () => {
    const [a, b, reseeded] = await Promise.all([
      renderPlaceholder(options()),
      renderPlaceholder(options()),
      renderPlaceholder(options({ seed: 8 })),
    ]);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(reseeded)).toBe(false);
  });

  it("derives a stable seed from the words when none is given", async () => {
    const [a, b, other] = await Promise.all([
      renderPlaceholder(options({ seed: null })),
      renderPlaceholder(options({ seed: null })),
      renderPlaceholder(options({ seed: null, footer: "MOCK · s2 · v1" })),
    ]);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(other)).toBe(false);
  });

  it("draws a video poster with a play glyph at the requested size", async () => {
    const size = pixelSizeFor("9:16");
    const still = await renderPlaceholder(options({ ...size }));
    const poster = await renderPlaceholder(options({ ...size, video: { durationSec: 4.5 } }));
    const meta = await sharp(poster).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 1080, 1920]);
    expect(await changedPixels(still, poster)).toBeGreaterThan(5_000);
  });

  it("keeps long, markup-like words inside the frame", async () => {
    const png = await renderPlaceholder(
      options({
        ...pixelSizeFor("1:1"),
        text: `<b>Fish & chips</b> "tonight" ${"and every night after that ".repeat(12)}`,
        detail: "x".repeat(600),
        video: { durationSec: 10 },
      }),
    );
    const meta = await sharp(png).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1080]);
  });

  it("crops what doesn't fit rather than failing on a cramped canvas", async () => {
    const png = await renderPlaceholder(options({ width: 1080, height: 200, position: "BOTTOM" }));
    const meta = await sharp(png).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 200]);
  });

  it("refuses colours that aren't #RRGGBB and sizes that aren't whole pixels", async () => {
    await expect(
      renderPlaceholder(
        options({ palette: { ...DEFAULT_VISUAL_STYLE.palette, accent: 'red"/><script>' } }),
      ),
    ).rejects.toThrow(/palette.accent/);
    await expect(renderPlaceholder(options({ width: 1080.5 }))).rejects.toThrow(RangeError);
    await expect(renderPlaceholder(options({ height: 10 }))).rejects.toThrow(RangeError);
  });
});
