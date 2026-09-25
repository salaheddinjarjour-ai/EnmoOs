"use client";

import { aspectRatioFor, pixelSizeFor, type PostDto, type VisualStyleTokens } from "@enmo/shared";
import { cx } from "@/components/ui/cx";
import {
  isRendering,
  previewVisual,
  stillUrlOf,
  type PreviewVisual,
} from "@/components/vault/media";
import { VideoBadge } from "@/components/vault/TakeBadges";
import { TakeFrame, TakeImage } from "@/components/vault/TakeFrame";
import { previewText } from "./format";

/*
 * The post card's 9:16 frame. Once the Visual Director has shots, it shows the current take of the
 * first one (a carousel's first slide, with the slide count) at the post's master ratio; a take of
 * another shape sits in the 9:16 frame over a blurred wash of itself. While that take renders, the
 * frame shimmers in its final shape. Before any visual, the frame sets the hook and overlay lines over
 * Void Black in the client's palette (primary for the hook, text for overlays, accent for the
 * rule); before the Copywriter lands it shimmers too.
 */

export type PreviewSize = "full" | "compact" | "thumb";

const FRAME: Record<PreviewSize, string> = {
  full: "w-40 rounded-lg p-3.5",
  compact: "w-9 rounded p-1",
  thumb: "w-24 rounded-md p-2",
};

/** The same frames without the text layout's padding: a visual runs to the edge. */
const MEDIA_FRAME: Record<PreviewSize, string> = {
  full: "w-40 rounded-lg",
  compact: "w-9 rounded",
  thumb: "w-24 rounded-md",
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

type PreviewPost = Pick<PostDto, "ref" | "type" | "hook" | "angle" | "copy" | "currentAssets">;

export function PostPreview({
  post,
  palette,
  size = "full",
  className,
}: {
  post: PreviewPost;
  palette?: Palette | null;
  size?: PreviewSize;
  className?: string;
}) {
  const visual = previewVisual(post.currentAssets);
  if (visual.mode !== "none") {
    return <VisualPreview post={post} visual={visual} size={size} className={className} />;
  }
  return <TextPreview post={post} palette={palette} size={size} className={className} />;
}

function altTextOf(post: PreviewPost): string {
  return post.copy?.altText.trim() || `${post.ref} visual`;
}

function VisualPreview({
  post,
  visual,
  size,
  className,
}: {
  post: PreviewPost;
  visual: Exclude<PreviewVisual, { mode: "none" }>;
  size: PreviewSize;
  className?: string;
}) {
  const alt = altTextOf(post);
  const master = pixelSizeFor(aspectRatioFor(post.type));
  const frame = cx(
    "relative aspect-[9/16] shrink-0 overflow-hidden border border-line bg-void",
    MEDIA_FRAME[size],
    className,
  );

  if (visual.mode === "rendering") {
    return (
      <div className={frame}>
        <TakeFrame
          take={visual.lead}
          size={master}
          alt={`${post.ref} visual`}
          labelled={size === "full"}
          outlined={false}
          fill
        />
      </div>
    );
  }
  const { take, count } = visual;
  const still = stillUrlOf(take)!;
  const unit = post.type === "CAROUSEL" ? "slides" : "shots";
  const rendering = post.currentAssets.filter((asset) => isRendering(asset.status)).length;
  return (
    <div className={frame}>
      {/* The take itself, blurred, fills the frame around a take shorter than 9:16. */}
      <TakeImage src={still} alt="" className="scale-110 opacity-40 blur-xl" />
      <TakeFrame take={take} size={master} alt={alt} eager outlined={false} fill />
      {size === "compact" ? null : (
        <>
          {count > 1 ? (
            <span className="absolute top-1.5 right-1.5 inline-flex h-5 items-center rounded-full bg-void/75 px-1.5 font-mono text-[10px] text-paper tabular-nums backdrop-blur-sm">
              <span aria-hidden>
                {visual.index + 1}/{count}
              </span>
              <span className="sr-only">
                {count} {unit}
              </span>
            </span>
          ) : null}
          {size === "full" && (take.kind === "VIDEO" || rendering > 0) ? (
            <span className="absolute inset-x-1.5 bottom-1.5 flex items-end justify-between gap-1">
              {take.kind === "VIDEO" ? (
                <VideoBadge durationSec={take.durationSec} onMedia />
              ) : (
                <span />
              )}
              {rendering > 0 ? (
                <span className="inline-flex h-5 items-center gap-1 rounded-full bg-void/75 px-1.5 font-mono text-[10px] text-paper backdrop-blur-sm">
                  <span aria-hidden className="size-1.5 animate-agent-pulse rounded-full bg-enmo" />
                  {rendering} rendering
                </span>
              ) : null}
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}

function TextPreview({
  post,
  palette,
  size,
  className,
}: {
  post: PreviewPost;
  palette?: Palette | null;
  size: PreviewSize;
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
