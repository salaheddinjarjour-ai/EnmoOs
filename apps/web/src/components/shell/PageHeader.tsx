import type { ReactNode } from "react";
import { cx } from "@/components/ui/cx";

/** Screen title block: mono eyebrow, display headline, optional description and actions. */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  meta,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Small line under the title (slugs, ids, timestamps). */
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx("mb-10 flex flex-wrap items-end justify-between gap-6", className)}>
      <div className="flex min-w-0 flex-col gap-3">
        {eyebrow ? (
          <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-steel">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="font-display text-4xl font-medium tracking-tight text-balance text-paper">
          {title}
        </h1>
        {meta ? <div className="flex flex-wrap items-center gap-2">{meta}</div> : null}
        {description ? (
          <p className="max-w-2xl text-[15px] leading-relaxed text-pretty text-steel">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
