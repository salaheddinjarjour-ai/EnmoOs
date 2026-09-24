"use client";

import { BrandFont, OverlayPosition, VisualStyleTokens, type ClientDto } from "@enmo/shared";
import { useId, useState, type ReactNode } from "react";
import { Checkbox } from "@/components/ui/Checkbox";
import { ChipInput } from "@/components/ui/ChipInput";
import { cx } from "@/components/ui/cx";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/Toast";
import { useUpdateClient } from "@/hooks/useClients";
import { errorMessage, fieldErrors } from "@/lib/api";
import { EditorForm, EditorSection, SaveBar } from "./EditorFrame";

/*
 * Visual style tab: the VisualStyleTokens the Visual Director keeps consistent across shots.
 * The shared token set has no separate "mood", "lens" or "character sheet" fields, so mood maps to
 * `keywords`, lens and composition live in the free-form `imagery` direction, and the character
 * sheet is the live preview composed from every token. Saving replaces the whole object (PATCH).
 */

type Palette = VisualStyleTokens["palette"];

const PALETTE_SLOTS: ReadonlyArray<{ key: keyof Palette; label: string }> = [
  { key: "primary", label: "Primary" },
  { key: "secondary", label: "Secondary" },
  { key: "accent", label: "Accent" },
  { key: "background", label: "Background" },
  { key: "text", label: "Text" },
];

const FONT_LABEL: Readonly<Record<BrandFont, string>> = {
  SPACE_GROTESK: "Space Grotesk",
  INTER: "Inter",
  JETBRAINS_MONO: "JetBrains Mono",
};

const FONT_CLASS: Readonly<Record<BrandFont, string>> = {
  SPACE_GROTESK: "font-display",
  INTER: "font-sans",
  JETBRAINS_MONO: "font-mono",
};

const OVERLAY_LABEL: Readonly<Record<OverlayPosition, string>> = {
  TOP: "Top",
  CENTER: "Centre",
  BOTTOM: "Bottom",
};

const FONT_OPTIONS = BrandFont.options.map((font) => ({ value: font, label: FONT_LABEL[font] }));
const OVERLAY_OPTIONS = OverlayPosition.options.map((position) => ({
  value: position,
  label: OVERLAY_LABEL[position],
}));

export function VisualStyleEditor({
  client,
  readOnlyReason,
}: {
  client: ClientDto;
  readOnlyReason: string | null;
}) {
  const toast = useToast();
  const update = useUpdateClient(client.id);
  const [saved, setSaved] = useState<VisualStyleTokens>(() => structuredClone(client.visualStyle));
  const [style, setStyle] = useState<VisualStyleTokens>(saved);
  const readOnly = readOnlyReason !== null;

  const dirty = JSON.stringify(style) !== JSON.stringify(saved);
  const validation = VisualStyleTokens.safeParse(style);
  const errors = validation.success ? {} : fieldErrors(validation.error);

  function patch(changes: Partial<VisualStyleTokens>) {
    setStyle((current) => ({ ...current, ...changes }));
  }

  function setColour(key: keyof Palette, value: string) {
    setStyle((current) => ({ ...current, palette: { ...current.palette, [key]: value } }));
  }

  function save() {
    if (!validation.success) return;
    update.mutate(
      { visualStyle: validation.data },
      {
        onSuccess: (next) => {
          setSaved(next.visualStyle);
          setStyle(next.visualStyle);
          toast.success("Visual style saved");
        },
      },
    );
  }

  const firstIssue = validation.success ? null : Object.values(errors)[0];

  return (
    <EditorForm onSubmit={save}>
      <EditorSection
        title="Character sheet"
        description="What the Visual Director reads before every shot, composed from the tokens below. It updates as you edit."
      >
        <CharacterSheet name={client.name} style={style} />
      </EditorSection>

      <EditorSection
        title="Palette"
        description="Five colours the renders, gradients and overlays are built from."
      >
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          {PALETTE_SLOTS.map((slot) => (
            <ColourSwatch
              key={slot.key}
              label={slot.label}
              value={style.palette[slot.key]}
              onChange={(value) => setColour(slot.key, value)}
              disabled={readOnly}
            />
          ))}
        </div>
      </EditorSection>

      <EditorSection
        title="Mood & light"
        description="The feeling every shot shares, and how it is lit and framed."
      >
        <ChipInput
          label="Mood"
          value={style.keywords}
          onChange={(keywords) => patch({ keywords })}
          disabled={readOnly}
          max={12}
          maxLength={40}
          placeholder="warm, unhurried, golden, tactile"
          error={errors.keywords}
        />
        <Input
          label="Lighting"
          value={style.lighting}
          onChange={(event) => patch({ lighting: event.target.value })}
          readOnly={readOnly}
          maxLength={200}
          placeholder="Late-afternoon sun through lattice shadows; soft window light indoors"
          error={errors.lighting}
        />
        <Textarea
          label="Imagery & lens"
          value={style.imagery}
          onChange={(event) => patch({ imagery: event.target.value })}
          readOnly={readOnly}
          rows={4}
          maxLength={1000}
          showCount
          placeholder="35mm, shallow depth of field. Hands, steam and texture in close-up; people over product. No stock-photo smiles."
          hint="Photography style, lens and composition, subjects and recurring characters."
          error={errors.imagery}
        />
      </EditorSection>

      <EditorSection
        title="Typography"
        description="Brand fonts the renderers ship with; used for overlays and on-image text."
      >
        <div className="grid gap-6 sm:grid-cols-2">
          <FontField
            label="Display font"
            value={style.typography.display}
            onChange={(display) => patch({ typography: { ...style.typography, display } })}
            disabled={readOnly}
          />
          <FontField
            label="Body font"
            value={style.typography.body}
            onChange={(body) => patch({ typography: { ...style.typography, body } })}
            disabled={readOnly}
          />
        </div>
      </EditorSection>

      <EditorSection
        title="Guardrails"
        description="What renders must never show, and how overlay text sits on the frame."
      >
        <ChipInput
          label="Never show"
          value={style.avoid}
          onChange={(avoid) => patch({ avoid })}
          disabled={readOnly}
          max={20}
          maxLength={80}
          placeholder="plastic cups, instant coffee jars"
          hint="Folded into every negative prompt."
          error={errors.avoid}
        />
        <div className="grid items-end gap-6 sm:grid-cols-2">
          <Select
            label="Overlay position"
            value={style.overlay.position}
            onChange={(event) =>
              patch({
                overlay: { ...style.overlay, position: OverlayPosition.parse(event.target.value) },
              })
            }
            options={OVERLAY_OPTIONS}
            disabled={readOnly}
          />
          <Checkbox
            label="Scrim behind overlay text"
            description="A soft shade that keeps text legible on busy frames."
            checked={style.overlay.scrim}
            onChange={(event) =>
              patch({ overlay: { ...style.overlay, scrim: event.target.checked } })
            }
            disabled={readOnly}
            className="pb-2"
          />
        </div>
      </EditorSection>

      <SaveBar
        dirty={dirty}
        saving={update.isPending}
        invalid={!validation.success}
        error={firstIssue ?? (update.isError ? errorMessage(update.error) : null)}
        saveLabel="Save visual style"
        onDiscard={() => setStyle(saved)}
        readOnlyReason={readOnlyReason}
      />
    </EditorForm>
  );
}

const HEX = /^#?([0-9a-f]{6})$/i;

function ColourSwatch({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const id = useId();
  // Text being typed that isn't a full colour yet; the swatch keeps the last valid value.
  const [typing, setTyping] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor={`${id}-picker`}
        className={cx(
          "relative block aspect-[4/5] overflow-hidden rounded-lg border border-line shadow-[inset_0_0_0_1px_rgb(0_0_0/0.25)] transition duration-200 ease-enmo",
          disabled
            ? "cursor-default"
            : "cursor-pointer hover:-translate-y-0.5 hover:border-paper/25",
        )}
        style={{ backgroundColor: value }}
      >
        <span className="sr-only">{label} colour</span>
        <input
          id={`${id}-picker`}
          type="color"
          value={value.toLowerCase()}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          className="absolute inset-0 size-full cursor-[inherit] opacity-0"
        />
      </label>
      <span className="text-xs text-paper">{label}</span>
      <input
        aria-label={`${label} hex`}
        value={typing ?? value}
        readOnly={disabled}
        maxLength={7}
        spellCheck={false}
        onChange={(event) => {
          const digits = HEX.exec(event.target.value.trim())?.[1];
          if (digits) {
            onChange(`#${digits.toUpperCase()}`);
            setTyping(null);
          } else {
            setTyping(event.target.value);
          }
        }}
        onBlur={() => setTyping(null)}
        className="h-8 w-full rounded-md border border-line bg-void/60 px-2 font-mono text-[11px] text-paper uppercase transition duration-200 hover:border-paper/15 focus:border-paper/40 focus-visible:outline-none"
      />
    </div>
  );
}

function FontField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: BrandFont;
  onChange: (font: BrandFont) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-end gap-4">
      <span
        aria-hidden
        className={cx(
          "w-14 shrink-0 text-center text-4xl leading-none text-paper",
          FONT_CLASS[value],
        )}
      >
        Aa
      </span>
      <Select
        label={label}
        value={value}
        onChange={(event) => onChange(BrandFont.parse(event.target.value))}
        options={FONT_OPTIONS}
        disabled={disabled}
        className="flex-1"
      />
    </div>
  );
}

const OVERLAY_PLACEMENT: Readonly<Record<OverlayPosition, string>> = {
  TOP: "top-4",
  CENTER: "top-1/2 -translate-y-1/2",
  BOTTOM: "bottom-4",
};

/** The brand at a glance: a 9:16 frame in its colours and type, next to every token. */
function CharacterSheet({ name, style }: { name: string; style: VisualStyleTokens }) {
  const { palette, typography, overlay } = style;
  const mood = style.keywords.slice(0, 3).join(" · ");

  return (
    <figure className="grid gap-6 rounded-xl border border-line bg-panel p-5 sm:grid-cols-[11rem_1fr]">
      <div
        aria-hidden
        className="relative aspect-[9/16] w-full overflow-hidden rounded-lg border border-line transition-[background] duration-300 ease-enmo"
        style={{
          background: `linear-gradient(165deg, ${palette.primary} 0%, ${palette.secondary} 48%, ${palette.background} 100%)`,
        }}
      >
        <div
          className={cx(
            "absolute inset-x-3 flex flex-col gap-1.5 rounded-md p-3 transition-all duration-300 ease-enmo",
            overlay.scrim && "bg-black/40 backdrop-blur-[2px]",
            OVERLAY_PLACEMENT[overlay.position],
          )}
        >
          <span
            className={cx(
              "text-[15px] leading-tight font-semibold",
              FONT_CLASS[typography.display],
            )}
            style={{ color: palette.text }}
          >
            {name}
          </span>
          {mood ? (
            <span
              className={cx("text-[10px] leading-snug", FONT_CLASS[typography.body])}
              style={{ color: palette.text }}
            >
              {mood}
            </span>
          ) : null}
          <span className="mt-1 h-1 w-8 rounded-full" style={{ backgroundColor: palette.accent }} />
        </div>
      </div>

      <figcaption className="flex min-w-0 flex-col gap-4 text-sm">
        <SheetRow label="Palette">
          <ul className="flex flex-wrap gap-2">
            {PALETTE_SLOTS.map((slot) => (
              <li
                key={slot.key}
                className="flex items-center gap-1.5 font-mono text-[11px] text-steel"
              >
                <span
                  aria-hidden
                  className="size-3.5 rounded-sm border border-line"
                  style={{ backgroundColor: palette[slot.key] }}
                />
                {palette[slot.key]}
              </li>
            ))}
          </ul>
        </SheetRow>
        <SheetRow label="Type">
          <span className={FONT_CLASS[typography.display]}>{FONT_LABEL[typography.display]}</span>
          <span className="text-steel"> / </span>
          <span className={FONT_CLASS[typography.body]}>{FONT_LABEL[typography.body]}</span>
        </SheetRow>
        <SheetRow label="Mood">
          {style.keywords.length ? style.keywords.join(", ") : <Unset />}
        </SheetRow>
        <SheetRow label="Light">{style.lighting || <Unset />}</SheetRow>
        <SheetRow label="Imagery & lens">
          <span className="line-clamp-3">{style.imagery || <Unset />}</span>
        </SheetRow>
        <SheetRow label="Never">{style.avoid.length ? style.avoid.join(", ") : <Unset />}</SheetRow>
      </figcaption>
    </figure>
  );
}

function SheetRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-3">
      <span className="pt-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-steel/80">
        {label}
      </span>
      <div className="min-w-0 text-paper/90">{children}</div>
    </div>
  );
}

function Unset() {
  return <span className="text-steel/60">Not set</span>;
}
