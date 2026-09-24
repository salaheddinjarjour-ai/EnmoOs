import { PLATFORM_LABEL, type Platform } from "@enmo/shared";
import { PLATFORM_DOT } from "@/components/clients/platforms";
import { cx } from "@/components/ui/cx";

/*
 * Where a post goes, as chips coloured by platform (IG #C13584, FB #5B7FF0, TikTok #25F4EE). The
 * compact form keeps only the dots for tight spots (kanban cards); names stay for screen readers.
 */
export function PlatformChips({
  platforms,
  compact = false,
  className,
}: {
  platforms: readonly Platform[];
  compact?: boolean;
  className?: string;
}) {
  return (
    <ul aria-label="Platforms" className={cx("flex flex-wrap items-center gap-1.5", className)}>
      {platforms.map((platform) =>
        compact ? (
          <li key={platform} title={PLATFORM_LABEL[platform]} className="inline-flex">
            <span aria-hidden className={cx("size-1.5 rounded-full", PLATFORM_DOT[platform])} />
            <span className="sr-only">{PLATFORM_LABEL[platform]}</span>
          </li>
        ) : (
          <li
            key={platform}
            className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line px-2.5 text-[11px] text-steel"
          >
            <span aria-hidden className={cx("size-1.5 rounded-full", PLATFORM_DOT[platform])} />
            {PLATFORM_LABEL[platform]}
          </li>
        ),
      )}
    </ul>
  );
}

const POST_TYPE_LABEL = {
  REEL: "Reel",
  TIKTOK: "TikTok",
  CAROUSEL: "Carousel",
  STATIC: "Static",
  STORY: "Story",
} as const;

/** The post format as a small mono tag. */
export function PostTypeChip({
  type,
  className,
}: {
  type: keyof typeof POST_TYPE_LABEL;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-5 shrink-0 items-center rounded border border-line px-1.5 font-mono text-[10px] tracking-[0.12em] text-steel uppercase",
        className,
      )}
    >
      {POST_TYPE_LABEL[type]}
    </span>
  );
}
