import type { FormEvent, ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { cx } from "@/components/ui/cx";

/*
 * Layout shared by the client settings tabs: a form with titled sections and a sticky save bar.
 * Read-only viewers (Editors, archived clients) get the same layout with a note instead of the bar.
 */

export function EditorForm({ onSubmit, children }: { onSubmit: () => void; children: ReactNode }) {
  return (
    <form
      noValidate
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        onSubmit();
      }}
      className="flex flex-col gap-12"
    >
      {children}
    </form>
  );
}

export function EditorSection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("grid gap-6 lg:grid-cols-[16rem_1fr] lg:gap-12", className)}>
      <div className="flex flex-col gap-2">
        <h2 className="font-display text-lg font-medium tracking-tight text-paper">{title}</h2>
        {description ? (
          <div className="text-sm leading-relaxed text-steel">{description}</div>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-6">{children}</div>
    </section>
  );
}

export interface SaveBarProps {
  dirty: boolean;
  saving: boolean;
  /** Validation or API failure to show next to the buttons. */
  error?: string | null;
  saveLabel: string;
  onDiscard: () => void;
  /** Blocks saving (e.g. invalid draft) without hiding the bar. */
  invalid?: boolean;
  readOnlyReason?: string | null;
}

export function SaveBar({
  dirty,
  saving,
  error,
  saveLabel,
  onDiscard,
  invalid,
  readOnlyReason,
}: SaveBarProps) {
  if (readOnlyReason) {
    return (
      <p className="border-t border-line pt-5 font-mono text-[11px] uppercase tracking-[0.16em] text-steel">
        {readOnlyReason}
      </p>
    );
  }
  return (
    <div
      className={cx(
        "-mx-2 flex flex-wrap items-center justify-between gap-4 border-t border-line px-2 py-4",
        // Pinned to the viewport only while there is something to save.
        dirty && "sticky bottom-0 z-10 bg-void/85 backdrop-blur",
      )}
    >
      <div aria-live="polite" className="min-h-5">
        {error ? (
          <p className="text-sm text-red-300">{error}</p>
        ) : (
          <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-steel">
            <span
              aria-hidden
              className={cx(
                "size-1.5 rounded-full transition-colors duration-200",
                dirty ? "bg-paper" : "bg-steel/40",
              )}
            />
            {dirty ? "Unsaved changes" : "All changes saved"}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={onDiscard} disabled={!dirty || saving}>
          Discard
        </Button>
        <Button type="submit" variant="primary" loading={saving} disabled={!dirty || invalid}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
