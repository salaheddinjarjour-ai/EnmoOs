"use client";

import type { PostDto, VisualStyleTokens } from "@enmo/shared";
import { cx } from "@/components/ui/cx";
import { previewText } from "./format";

/*
 * The post card's 9:16 frame. Phase 2 posts are text only, so the frame sets the hook and overlay
 * lines over Void Black in the client's palette (primary for the hook, text for overlays, accent
 * for the rule); Phase 3 swaps in the rendered visual. Before the Copywriter lands the frame
 * shimmers, like any render in progress.
 */

export type PreviewSize = "full" | "compact" | "thumb";

const FRAME: Record<PreviewSize, string> = {
  full: "w-40 rounded-lg p-3.5",
  compact: "w-9 rounded p-1",
  thumb: "w-24 rounded-md p-2",
};

const HOOK: Record<PreviewSize, string> = {
  full: "text-[15px] leading-snug line-clamp-6",
  compact: "text-[5px] leading-tight line-clamp-6",
  thumb: "text-[9px] leading-snug line-clamp-6",
};

type Palette = VisualStyleTokens["palette"];

/** Neutral stand-ins until the client (and its palette) has loaded. */
const NEUTRAL: Pick<Palette, "primary" | "text" | "accent"> = {
  primary: "#F5F5F4",
  text: "#8B8B90",
  accent: "#A8A29E",
};

export function PostPreview({
  post,
  palette,
  size = "full",
  className,
}: {
  post: Pick<PostDto, "ref" | "type" | "hook" | "angle" | "copy">;
  palette?: Palette | null;
  size?: PreviewSize;
  className?: string;
}) {
  const colors = palette ?? NEUTRAL;

  if (!post.copy) {
    return (
      <div
        role="img"
        aria-label={`${post.ref} preview, still being written`}
        className={cx(
          "shimmer relative flex aspect-[9/16] shrink-0 flex-col justify-end border border-line bg-void",
          FRAME[size],
          className,
        )}
      >
        {size === "full" ? (
          <span
            aria-hidden
            className="font-mono text-[10px] tracking-[0.14em] text-steel uppercase"
          >
            Drafting…
          </span>
        ) : null}
      </div>
    );
  }

  const text = previewText(post, post.copy);
  return (
    <div
      role="img"
      aria-label={`${post.ref} preview: ${text.hook}`}
      className={cx(
        "relative flex aspect-[9/16] shrink-0 flex-col overflow-hidden border border-line bg-void",
        FRAME[size],
        className,
      )}
    >
      <div aria-hidden className="flex flex-1 flex-col justify-center gap-2">
        <span className="block h-px w-6 shrink-0" style={{ backgroundColor: colors.accent }} />
        <p
          className={cx("font-display font-medium text-balance", HOOK[size])}
          style={{ color: colors.primary }}
        >
          {text.hook}
        </p>
        {size === "full" && text.lines.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {text.lines.map((line, index) => (
              <li
                key={index}
                className="line-clamp-2 text-[10px] leading-snug"
                style={{ color: colors.text }}
              >
                {line}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {size === "compact" ? null : (
        <p
          aria-hidden
          className="mt-2 flex items-center justify-between gap-2 font-mono text-[9px] tracking-[0.12em] text-steel/80 uppercase"
        >
          <span>{post.ref}</span>
          <span className="truncate">{text.meta}</span>
        </p>
      )}
    </div>
  );
}
