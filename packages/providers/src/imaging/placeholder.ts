import sharp, { type OverlayOptions } from "sharp";
import type { BrandFont, OverlayPosition, VisualStyleTokens } from "@enmo/shared";
import { brandFontDescription, brandFontFile } from "./fonts";

/*
 * MockProvider's render (DESIGN §F): a gradient from the client's palette with a soft glow and a
 * vignette, the shot's words in the brand's display font, the prompt in its body font and a mono
 * footer such as "MOCK · s2 · v1". A VIDEO shot's poster adds a play glyph and the clip length.
 * Everything is drawn by sharp: the background as SVG shapes (no SVG <text>, which would resolve
 * fonts through fontconfig and silently fall back), the words as Pango text layers built from the
 * committed TTFs. Identical options give identical bytes.
 */

export interface PlaceholderOptions {
  width: number;
  height: number;
  palette: VisualStyleTokens["palette"];
  /** The words the shot illustrates, drawn as the headline; null draws none. */
  text: string | null;
  /** Mono footer line, e.g. "MOCK · s2 · v1". */
  footer: string;
  /** The client's typography tokens (the footer is always JetBrains Mono). */
  fonts: VisualStyleTokens["typography"];
  /** A smaller line under the headline in the body font (MockProvider: the prompt); null draws none. */
  detail?: string | null;
  /** Top-left label, e.g. the brand name; null draws none. */
  label?: string | null;
  /** Top-right mono tag, e.g. the aspect ratio; null draws none. */
  tag?: string | null;
  /** Where the words sit, as the brand's overlay tokens place text. Default CENTER. */
  position?: OverlayPosition;
  /** Varies the gradient direction and glow placement. Default: derived from the words. */
  seed?: number | null;
  /** Draws a play glyph and the clip length: the poster frame of a VIDEO shot. */
  video?: { durationSec: number | null } | null;
}

/** The text layers are laid out for a 1080px-wide canvas and scaled for any other width. */
const DESIGN_WIDTH = 1080;
const HEADLINE_SIZES = [112, 96, 84, 72, 62, 54, 46] as const;
const HEADLINE_MAX_CHARS = 140;
const DETAIL_MAX_CHARS = 160;

/** A PNG (RGB, no alpha) of exactly width × height. */
export async function renderPlaceholder(options: PlaceholderOptions): Promise<Buffer> {
  const { width, height } = options;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64) {
    throw new RangeError(`Placeholder size must be whole pixels, at least 64: ${width}×${height}`);
  }
  const palette = checkedPalette(options.palette);
  const px = (size: number) => Math.max(1, Math.round((size * width) / DESIGN_WIDTH));
  const margin = px(86);
  const textWidth = width - 2 * margin;
  const contentTop = margin + px(96);
  const contentBottom = height - margin - px(96);
  const seed = (options.seed ?? hashSeed([options.text, options.detail, options.footer])) >>> 0;

  const placed: Placed[] = [];
  const place = (layer: TextLayer, left: number, top: number) => {
    placed.push({ layer, left: Math.round(left), top: Math.round(top) });
  };

  if (options.label) {
    const label = await textLayer(options.label.toUpperCase(), {
      font: options.fonts.body,
      size: px(26),
      color: palette.text,
      alpha: 85,
      letterSpacing: px(3),
      width: Math.round(textWidth * 0.66),
    });
    place(label, margin, margin);
  }
  if (options.tag) {
    const tag = await textLayer(options.tag, {
      font: "JETBRAINS_MONO",
      size: px(24),
      color: palette.text,
      alpha: 55,
    });
    place(tag, width - margin - tag.width, margin);
  }
  const footer = await textLayer(options.footer, {
    font: "JETBRAINS_MONO",
    size: px(24),
    color: palette.text,
    alpha: 55,
    width: textWidth,
  });
  place(footer, margin, height - margin - footer.height);

  // A poster keeps the upper part of the frame for its play glyph, so its words go to the bottom.
  const video = options.video ?? null;
  const position: OverlayPosition = video ? "BOTTOM" : (options.position ?? "CENTER");
  const available = contentBottom - contentTop;
  const block = await textBlock(options, palette, {
    px,
    textWidth,
    maxHeight: video ? Math.round(available * 0.45) : available,
  });

  let blockTop = contentBottom;
  let accentBar: Rect | null = null;
  if (block) {
    blockTop =
      position === "TOP"
        ? contentTop
        : position === "BOTTOM"
          ? contentBottom - block.height
          : contentTop + (available - block.height) / 2;
    blockTop = Math.round(Math.max(contentTop, blockTop));
    accentBar = { x: margin, y: blockTop, ...block.bar };
    let y = blockTop;
    for (const part of block.parts) {
      if (part.layer) place(part.layer, margin, y);
      y += part.height + part.gapAfter;
    }
  }

  let glyph = "";
  if (video) {
    const centreY = (contentTop + blockTop) / 2;
    const radius = Math.max(px(24), Math.min(px(88), (blockTop - contentTop) / 2 - px(56)));
    glyph = playGlyph(width / 2, centreY - px(20), radius, palette, px);
    const duration = await textLayer(formatDuration(video.durationSec), {
      font: "JETBRAINS_MONO",
      size: px(28),
      color: palette.text,
      alpha: 70,
    });
    place(duration, (width - duration.width) / 2, centreY - px(20) + radius + px(28));
  }

  const background = backgroundSvg(width, height, palette, seed, px, glyph, accentBar);
  const { data, info } = await sharp(Buffer.from(background))
    .composite(await inside(placed, width, height))
    .removeAlpha()
    .png()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height) {
    throw new Error(`Placeholder rendered at ${info.width}×${info.height}, not ${width}×${height}`);
  }
  return data;
}

/* ─── Text ─────────────────────────────────────────────────────────────────────────────────────── */

interface TextLayerOptions {
  font: BrandFont;
  size: number;
  color: string;
  /** Opacity of the glyphs, in percent. */
  alpha?: number;
  /** Extra space between letters, in pixels. */
  letterSpacing?: number;
  /** Wrap width; the layer is only as wide as its longest line. */
  width?: number;
  /** Line spacing adjustment, in pixels (negative tightens a large headline). */
  spacing?: number;
}

interface TextLayer {
  data: Buffer;
  width: number;
  height: number;
}

async function textLayer(text: string, options: TextLayerOptions): Promise<TextLayer> {
  const attributes = [`foreground="${options.color}"`];
  if (options.alpha !== undefined) attributes.push(`fgalpha="${options.alpha}%"`);
  // Pango measures letter spacing in 1024ths of a point; at 72 dpi a point is a pixel.
  if (options.letterSpacing) attributes.push(`letter_spacing="${options.letterSpacing * 1024}"`);
  const { data, info } = await sharp({
    text: {
      text: `<span ${attributes.join(" ")}>${escapeMarkup(text)}</span>`,
      font: brandFontDescription(options.font, options.size),
      // Without fontfile Pango silently substitutes an installed font for an unknown family.
      fontfile: brandFontFile(options.font),
      rgba: true,
      dpi: 72,
      // word-char: a word longer than the line (a URL, a typo'd run of letters) breaks too.
      wrap: "word-char",
      ...(options.width === undefined ? {} : { width: options.width }),
      ...(options.spacing === undefined ? {} : { spacing: options.spacing }),
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Placed {
  layer: TextLayer;
  left: number;
  top: number;
}

/**
 * The composite list, each layer cropped to the canvas: sharp refuses an overlay that reaches past
 * the base image, and an overlong block should lose its tail rather than the whole render.
 */
async function inside(placed: Placed[], width: number, height: number): Promise<OverlayOptions[]> {
  const overlays: OverlayOptions[] = [];
  for (const { layer, left, top } of placed) {
    const x = Math.max(0, left);
    const y = Math.max(0, top);
    const visibleWidth = Math.min(layer.width - (x - left), width - x);
    const visibleHeight = Math.min(layer.height - (y - top), height - y);
    if (visibleWidth <= 0 || visibleHeight <= 0) continue;
    const whole = visibleWidth === layer.width && visibleHeight === layer.height;
    const input = whole
      ? layer.data
      : await sharp(layer.data)
          .extract({ left: x - left, top: y - top, width: visibleWidth, height: visibleHeight })
          .png()
          .toBuffer();
    overlays.push({ input, left: x, top: y });
  }
  return overlays;
}

interface BlockPart {
  /** null for the accent bar, which the background SVG draws. */
  layer: TextLayer | null;
  height: number;
  gapAfter: number;
}

interface TextBlock {
  parts: BlockPart[];
  height: number;
  bar: { width: number; height: number };
}

/**
 * The accent bar, headline and detail stacked as one block, the headline at the largest size that
 * keeps the block within maxHeight.
 */
async function textBlock(
  options: PlaceholderOptions,
  palette: Palette,
  layout: { px: (size: number) => number; textWidth: number; maxHeight: number },
): Promise<TextBlock | null> {
  const { px, textWidth, maxHeight } = layout;
  const headline = clipText(options.text, HEADLINE_MAX_CHARS);
  const detailText = clipText(options.detail ?? null, DETAIL_MAX_CHARS);
  if (!headline && !detailText) return null;

  const bar = { width: px(72), height: px(8), gapAfter: px(32) };
  const detail = detailText
    ? await textLayer(detailText, {
        font: options.fonts.body,
        size: px(30),
        color: palette.text,
        alpha: 72,
        width: textWidth,
        spacing: px(6),
      })
    : null;
  const detailGap = headline && detail ? px(40) : 0;

  let title: TextLayer | null = null;
  if (headline) {
    const room = maxHeight - bar.height - bar.gapAfter - detailGap - (detail?.height ?? 0);
    for (const size of HEADLINE_SIZES) {
      title = await textLayer(headline, {
        font: options.fonts.display,
        size: px(size),
        color: palette.text,
        width: textWidth,
        spacing: -px(size / 12),
      });
      if (title.height <= room) break;
    }
  }

  const parts: BlockPart[] = [{ layer: null, height: bar.height, gapAfter: bar.gapAfter }];
  if (title) parts.push({ layer: title, height: title.height, gapAfter: detailGap });
  if (detail) parts.push({ layer: detail, height: detail.height, gapAfter: 0 });
  const height = parts.reduce((sum, part) => sum + part.height + part.gapAfter, 0);
  return { parts, height, bar: { width: bar.width, height: bar.height } };
}

/** Trims, collapses whitespace and cuts at a word boundary with an ellipsis; "" becomes null. */
function clipText(text: string | null, maxChars: number): string | null {
  const flat = text?.replace(/\s+/g, " ").trim() ?? "";
  if (flat.length === 0) return null;
  if (flat.length <= maxChars) return flat;
  const cut = flat.slice(0, maxChars - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > maxChars / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "")}…`;
}

function escapeMarkup(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatDuration(durationSec: number | null): string {
  if (durationSec === null) return "VIDEO";
  return `VIDEO · ${Number.isInteger(durationSec) ? durationSec : durationSec.toFixed(1)}s`;
}

/* ─── Background ───────────────────────────────────────────────────────────────────────────────── */

type Palette = VisualStyleTokens["palette"];

const HEX = /^#[0-9A-Fa-f]{6}$/;

/** The palette goes into SVG attributes and Pango markup, so only #RRGGBB values are let through. */
function checkedPalette(palette: Palette): Palette {
  for (const [name, value] of Object.entries(palette)) {
    if (!HEX.test(value)) throw new TypeError(`palette.${name} is not a #RRGGBB colour: ${value}`);
  }
  return palette;
}

function backgroundSvg(
  width: number,
  height: number,
  palette: Palette,
  seed: number,
  px: (size: number) => number,
  glyph: string,
  accentBar: Rect | null,
): string {
  const random = mulberry32(seed);
  const angle = random() * 2 * Math.PI;
  const [x1, y1, x2, y2] = [
    0.5 - Math.cos(angle) / 2,
    0.5 - Math.sin(angle) / 2,
    0.5 + Math.cos(angle) / 2,
    0.5 + Math.sin(angle) / 2,
  ].map(fixed);
  const glowA = { cx: fixed(0.2 + random() * 0.6), cy: fixed(0.1 + random() * 0.35) };
  const glowB = { cx: fixed(0.2 + random() * 0.6), cy: fixed(0.55 + random() * 0.35) };
  const inset = px(40);
  // A dark edge frames a dark background; on a light one it would read as dirt, so it fades out.
  const vignette = fixed(0.4 - 0.28 * luminance(palette.background));
  const bar = accentBar
    ? `<rect x="${accentBar.x}" y="${fixed(accentBar.y)}" width="${accentBar.width}" height="${accentBar.height}" rx="${fixed(accentBar.height / 2)}" fill="${palette.accent}"/>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="base" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">
      <stop offset="0" stop-color="${palette.background}"/>
      <stop offset="1" stop-color="${mix(palette.background, palette.accent, 0.3)}"/>
    </linearGradient>
    <radialGradient id="glowA" cx="${glowA.cx}" cy="${glowA.cy}" r="0.6">
      <stop offset="0" stop-color="${palette.primary}" stop-opacity="0.22"/>
      <stop offset="1" stop-color="${palette.primary}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowB" cx="${glowB.cx}" cy="${glowB.cy}" r="0.55">
      <stop offset="0" stop-color="${palette.secondary}" stop-opacity="0.2"/>
      <stop offset="1" stop-color="${palette.secondary}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vignette" cx="0.5" cy="0.5" r="0.75">
      <stop offset="0.55" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="${vignette}"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#base)"/>
  <rect width="${width}" height="${height}" fill="url(#glowA)"/>
  <rect width="${width}" height="${height}" fill="url(#glowB)"/>
  <rect width="${width}" height="${height}" fill="url(#vignette)"/>
  <rect x="${inset}" y="${inset}" width="${width - 2 * inset}" height="${height - 2 * inset}" rx="${px(28)}" fill="none" stroke="${palette.text}" stroke-opacity="0.1" stroke-width="${px(2)}"/>
  ${bar}
  ${glyph}
</svg>`;
}

function playGlyph(
  cx: number,
  cy: number,
  radius: number,
  palette: Palette,
  px: (size: number) => number,
): string {
  const r = radius;
  // An equilateral-ish triangle, nudged right so it looks centred in the ring.
  const points = [
    [cx - r * 0.3, cy - r * 0.42],
    [cx - r * 0.3, cy + r * 0.42],
    [cx + r * 0.46, cy],
  ]
    .map(([x, y]) => `${fixed(x!)},${fixed(y!)}`)
    .join(" ");
  return `<circle cx="${fixed(cx)}" cy="${fixed(cy)}" r="${fixed(r)}" fill="${palette.primary}" fill-opacity="0.1" stroke="${palette.text}" stroke-opacity="0.85" stroke-width="${px(6)}"/>
  <polygon points="${points}" fill="${palette.text}" fill-opacity="0.9"/>`;
}

function channel(hex: string, index: number): number {
  return parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
}

/** Rough perceived lightness, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  return (0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2)) / 255;
}

/** `from` blended towards `to` by t (0–1), per sRGB channel. */
function mix(from: string, to: string, t: number): string {
  return `#${[0, 1, 2]
    .map((index) =>
      Math.round(channel(from, index) + (channel(to, index) - channel(from, index)) * t)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function fixed(value: number): string {
  return value.toFixed(3);
}

/** FNV-1a over the words, so an unseeded placeholder still varies from shot to shot. */
function hashSeed(parts: readonly (string | null | undefined)[]): number {
  let hash = 0x811c9dc5;
  for (const char of parts.map((part) => part ?? "").join("\u0000")) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
