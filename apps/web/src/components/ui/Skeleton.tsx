import type { ReactNode } from "react";
import { cx } from "./cx";

/** Shimmering placeholder for anything still loading or rendering. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx("shimmer rounded-md bg-paper/[0.03]", className)} />;
}

/** A few lines of text-shaped skeleton, the last one shorter. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden className={cx("flex flex-col gap-2.5", className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={cx("h-3", index === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

/** Announces a loading region once to assistive tech while skeletons draw. */
export function LoadingRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}
