import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { BrandFont } from "@enmo/shared";
import { BRAND_FONT_FILES, brandFontDescription, brandFontFile, fontsDir } from "../src";

const SAMPLE = "Iftar, iced. WWW iii 0123";

/** Renders SAMPLE and fingerprints the pixels, so two renders compare by the glyphs drawn. */
async function fingerprint(font: string, fontfile?: string): Promise<string> {
  const { data, info } = await sharp({
    text: { text: SAMPLE, font, rgba: true, dpi: 72, ...(fontfile ? { fontfile } : {}) },
  })
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(info.width).toBeGreaterThan(0);
  return `${info.width}x${info.height}:${createHash("sha1").update(data).digest("hex")}`;
}

describe("brand fonts", () => {
  it("resolves the committed fonts directory through the package name", () => {
    expect(path.basename(fontsDir())).toBe("fonts");
    expect(existsSync(path.join(fontsDir(), "README.md"))).toBe(true);
  });

  it("ships every brand font as a TTF with its OFL licence", () => {
    for (const font of BrandFont.options) {
      const file = brandFontFile(font);
      expect(path.basename(file)).toBe(BRAND_FONT_FILES[font]);
      // TrueType files start with the sfnt version 0x00010000.
      expect(readFileSync(file).subarray(0, 4)).toEqual(Buffer.from([0, 1, 0, 0]));
      const licence = path.join(fontsDir(), `${BRAND_FONT_FILES[font].split("-")[0]}-OFL.txt`);
      expect(readFileSync(licence, "utf8")).toContain("SIL OPEN FONT LICENSE Version 1.1");
    }
  });

  it("draws text with each font file in sharp, not with a fallback font", async () => {
    const fallback = await fingerprint("NoSuchFamily 48");
    const rendered = new Set<string>();
    for (const font of BrandFont.options) {
      const print = await fingerprint(brandFontDescription(font, 48), brandFontFile(font));
      expect(print, font).not.toBe(fallback);
      rendered.add(print);
    }
    expect(rendered.size).toBe(BrandFont.options.length);
  });
});
