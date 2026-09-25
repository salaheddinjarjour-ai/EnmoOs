import { createRequire } from "node:module";
import path from "node:path";
import type { BrandFont } from "@enmo/shared";

/*
 * The committed brand fonts (fonts/README.md has their provenance and licences). sharp draws text
 * through Pango, which only loads a real TTF/OTF: pass `fontfile: brandFontFile(font)` together with
 * `font: brandFontDescription(font, size)` on every sharp text input.
 */

export const BRAND_FONT_FILES: Readonly<Record<BrandFont, string>> = {
  SPACE_GROTESK: "SpaceGrotesk-Bold.ttf",
  INTER: "Inter-SemiBold.ttf",
  JETBRAINS_MONO: "JetBrainsMono-Regular.ttf",
};

/** Pango family and style of each file, as sharp's `font` option names it (size appended). */
export const BRAND_FONT_FAMILIES: Readonly<Record<BrandFont, string>> = {
  SPACE_GROTESK: "Space Grotesk Bold",
  INTER: "Inter SemiBold",
  JETBRAINS_MONO: "JetBrains Mono",
};

let resolvedFontsDir: string | undefined;

/**
 * Absolute path of packages/providers/fonts. Resolved through the package's own name rather than
 * relative to this file: in apps/api's tsup bundle import.meta.url is dist/server.js, and the
 * package name still resolves there (through apps/api's dependency on @enmo/providers).
 */
export function fontsDir(): string {
  resolvedFontsDir ??= path.join(
    path.dirname(createRequire(import.meta.url).resolve("@enmo/providers/package.json")),
    "fonts",
  );
  return resolvedFontsDir;
}

export function brandFontFile(font: BrandFont): string {
  return path.join(fontsDir(), BRAND_FONT_FILES[font]);
}

/** sharp's `font` value for a brand font at `size` points (at dpi 72, points are pixels). */
export function brandFontDescription(font: BrandFont, size: number): string {
  return `${BRAND_FONT_FAMILIES[font]} ${size}`;
}
