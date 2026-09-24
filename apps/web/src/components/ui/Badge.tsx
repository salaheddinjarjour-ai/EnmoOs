import type { ReactNode } from "react";
import { cx } from "./cx";

/*
 * Small mono label for roles, states and modes. "positive" is the only green tone and is meant for
 * success / live / connected states; everything else stays neutral.
 */

export type BadgeTone = "neutral" | "muted" | "positive" | "warning" | "negative";

const TONES: Record<BadgeTone, string> = {
  neutral: "border-line bg-paper/[0.04] text-paper/90",
  muted: "border-line text-steel",
  positive: "border-enmo/40 text-enmo",
  warning: "border-amber-300/30 text-amber-200",
  negative: "border-red-400/30 text-red-300",
};

export function Badge({
  tone = "neutral",
  dot = false,
  title,
  className,
  children,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 font-mono text-[11px] leading-none tracking-[0.08em] uppercase",
        TONES[tone],
        className,
      )}
    >
      {dot ? <span aria-hidden className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}
