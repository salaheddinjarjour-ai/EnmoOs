import type { ReactNode } from "react";
import { cx } from "./cx";

/*
 * Cinematic, never apologetic (MASTER_PLAN §04). One green call to action at most: pass it as
 * `action`; anything secondary goes in `children` and stays neutral.
 */

export interface EmptyStateProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  /** Decorative lead-in above the title (e.g. the idle Arsenal). */
  visual?: ReactNode;
  children?: ReactNode;
  className?: string;
  headingLevel?: "h1" | "h2" | "h3";
}

export function EmptyState({
  eyebrow,
  title,
  description,
  action,
  visual,
  children,
  className,
  headingLevel: Heading = "h2",
}: EmptyStateProps) {
  return (
    <section
      className={cx(
        "relative isolate flex flex-col items-center overflow-hidden rounded-2xl border border-line bg-panel/40 px-8 py-20 text-center",
        className,
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-40 -z-10 mx-auto h-80 max-w-2xl rounded-full bg-[radial-gradient(closest-side,rgb(245_245_244/0.07),transparent)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-12 bottom-0 -z-10 h-px bg-linear-to-r from-transparent via-paper/15 to-transparent"
      />
      {visual ? <div className="mb-10">{visual}</div> : null}
      {eyebrow ? (
        <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.24em] text-steel">
          {eyebrow}
        </p>
      ) : null}
      <Heading className="max-w-2xl font-display text-3xl font-medium tracking-tight text-balance text-paper sm:text-4xl">
        {title}
      </Heading>
      {description ? (
        <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-pretty text-steel">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-9">{action}</div> : null}
      {children ? <div className="mt-5 text-sm text-steel">{children}</div> : null}
    </section>
  );
}
