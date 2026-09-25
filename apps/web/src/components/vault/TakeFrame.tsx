import type { PixelSize } from "@enmo/shared";
import type { ReactNode } from "react";
import { cx } from "@/components/ui/cx";
import { fitStyle, isRendering, playableVideoUrl, stillUrlOf, type TakeMedia } from "./media";

/*
 * One take, framed at its own aspect ratio inside whatever box the caller gives it (a 4:5 grid
 * cell, the drawer's stage, a 9:16 post preview): the box is a size container and the take is as
 * large as fits. While the take renders the frame shimmers in its final shape, so nothing jumps
 * when the file lands. `children` are overlays (badges) drawn over the box's corners.
 */

export interface TakeFrameProps {
  take: TakeMedia;
  /** The proportions to frame (media.ts frameSizeOf). */
  size: PixelSize;
  alt: string;
  /** Rejected or failed takes stay visible in the lineage, but dimmed. */
  dimmed?: boolean;
  /** Play a real clip inline (the drawer); elsewhere a clip shows its poster. */
  playable?: boolean;
  /** Show "Rendering…" on the shimmer (big frames only). */
  labelled?: boolean;
  /** Load the image as soon as possible (above the fold) instead of lazily. */
  eager?: boolean;
  /** A hairline around the take (off where the container already draws the edge). */
  outlined?: boolean;
  /**
   * Fill the positioned parent (absolute, inset 0) instead of sizing itself. A size container has
   * no height of its own content, so it needs one or the other.
   */
  fill?: boolean;
  className?: string;
  frameClassName?: string;
  children?: ReactNode;
}

export function TakeFrame({
  take,
  size,
  alt,
  dimmed = false,
  playable = false,
  labelled = false,
  eager = false,
  outlined = true,
  fill = false,
  className,
  frameClassName,
  children,
}: TakeFrameProps) {
  return (
    <div
      className={cx(
        "grid place-items-center [container-type:size]",
        fill ? "absolute inset-0" : "relative",
        className,
      )}
    >
      <div
        style={fitStyle(size)}
        className={cx(
          "relative overflow-hidden bg-void transition-opacity duration-300 ease-enmo",
          outlined && "ring-1 ring-line",
          dimmed && "opacity-40",
          frameClassName,
        )}
      >
        <TakeContent take={take} alt={alt} playable={playable} labelled={labelled} eager={eager} />
      </div>
      {children}
    </div>
  );
}

function TakeContent({
  take,
  alt,
  playable,
  labelled,
  eager,
}: {
  take: TakeMedia;
  alt: string;
  playable: boolean;
  labelled: boolean;
  eager: boolean;
}) {
  if (isRendering(take.status)) {
    return (
      <div role="img" aria-label={`${alt}, rendering`} className="shimmer absolute inset-0">
        {labelled ? (
          <span
            aria-hidden
            className="absolute inset-x-0 bottom-3 text-center font-mono text-[10px] tracking-[0.16em] text-steel uppercase"
          >
            Rendering…
          </span>
        ) : null}
      </div>
    );
  }
  const still = stillUrlOf(take);
  const clip = playable ? playableVideoUrl(take) : null;
  if (clip) {
    return (
      <video
        src={clip}
        poster={still ?? undefined}
        controls
        playsInline
        preload="metadata"
        aria-label={alt}
        className="absolute inset-0 size-full object-cover"
      />
    );
  }
  if (still) return <TakeImage src={still} alt={alt} eager={eager} />;
  return (
    <div
      role="img"
      aria-label={`${alt}, no render`}
      className="absolute inset-0 grid place-items-center p-2 text-center"
    >
      <span aria-hidden className="font-mono text-[10px] tracking-[0.14em] text-steel/80 uppercase">
        {take.status === "FAILED" ? "Render failed" : "No render"}
      </span>
    </div>
  );
}

/**
 * Takes are served straight from Storage (the API's /files or R2): plain <img>, since the app runs
 * with images.unoptimized and there is no optimiser to route them through.
 */
export function TakeImage({
  src,
  alt,
  eager = false,
  className,
}: {
  src: string;
  alt: string;
  eager?: boolean;
  className?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- see above: no image optimiser
    <img
      src={src}
      alt={alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      draggable={false}
      className={cx("absolute inset-0 size-full object-cover", className)}
    />
  );
}
