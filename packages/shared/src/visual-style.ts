import { z } from "zod";
import { deepFreeze } from "./internal";

export const HexColor = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, "Expected a #RRGGBB colour")
  .toUpperCase();
export type HexColor = z.infer<typeof HexColor>;

/** The brand fonts the renderers ship with (OFL TTFs in packages/providers/fonts). */
export const BrandFont = z.enum(["SPACE_GROTESK", "INTER", "JETBRAINS_MONO"]);
export type BrandFont = z.infer<typeof BrandFont>;

export const OverlayPosition = z.enum(["TOP", "CENTER", "BOTTOM"]);
export type OverlayPosition = z.infer<typeof OverlayPosition>;

/*
 * Every leaf has a default so that partial input and older JSON stored in Client.visualStyle
 * both parse into a complete token set. Updates replace the whole object.
 */
export const VisualStyleTokens = z.object({
  // Brand-neutral greys until the client's own colours are set: Enmo Green (#4ADE80) is ENMO's
  // action colour and must not end up in a client's renders by default.
  palette: z
    .object({
      primary: HexColor.default("#F5F5F4"),
      secondary: HexColor.default("#8B8B90"),
      accent: HexColor.default("#A8A29E"),
      background: HexColor.default("#060606"),
      text: HexColor.default("#F5F5F4"),
    })
    .prefault({}),
  typography: z
    .object({
      display: BrandFont.default("SPACE_GROTESK"),
      body: BrandFont.default("INTER"),
    })
    .prefault({}),
  /** Style keywords the Visual Director keeps consistent across shots. */
  keywords: z
    .array(z.string().trim().min(1).max(40))
    .max(12)
    .default(() => []),
  lighting: z.string().trim().max(200).default(""),
  /** Free-form art direction: photography style, subjects, composition. */
  imagery: z.string().trim().max(1000).default(""),
  /** Things renders must never show; folded into negative prompts. */
  avoid: z
    .array(z.string().trim().min(1).max(80))
    .max(20)
    .default(() => []),
  /** Default placement for text overlays drawn by the Adapter. */
  overlay: z
    .object({
      position: OverlayPosition.default("BOTTOM"),
      scrim: z.boolean().default(true),
    })
    .prefault({}),
});
export type VisualStyleTokens = z.output<typeof VisualStyleTokens>;
export type VisualStyleTokensInput = z.input<typeof VisualStyleTokens>;

/** A fresh, mutable default token set. */
export function defaultVisualStyle(): VisualStyleTokens {
  return VisualStyleTokens.parse({});
}

export const DEFAULT_VISUAL_STYLE: Readonly<VisualStyleTokens> = deepFreeze(defaultVisualStyle());
