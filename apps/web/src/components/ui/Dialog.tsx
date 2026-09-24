"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { cx } from "./cx";

/*
 * Modal built on the native <dialog> + showModal(): the browser supplies the focus trap, inert
 * background, Escape handling and the `dialog` role. Content mounts only while open, so every
 * opening starts from fresh form state.
 */

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Block Escape / backdrop dismissal while something is saving. */
  dismissible?: boolean;
}

const WIDTHS = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl" } as const;

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  size = "md",
  dismissible = true,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(event) => {
        // Only the backdrop reports the <dialog> itself as the target: the panel fills the box.
        if (event.target === event.currentTarget && dismissible) onClose();
      }}
      className={cx(
        "m-auto max-h-[calc(100dvh-4rem)] w-[calc(100%-2rem)] overflow-visible bg-transparent p-0 text-paper",
        "backdrop:bg-void/75 backdrop:backdrop-blur-sm",
        "translate-y-0 opacity-100 transition-[opacity,translate] duration-250 ease-enmo starting:translate-y-2 starting:opacity-0",
        WIDTHS[size],
      )}
    >
      {open ? (
        <div className="flex max-h-[calc(100dvh-4rem)] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-[0_40px_120px_-40px_rgb(0_0_0/0.9)]">
          <header className="flex items-start justify-between gap-6 border-b border-line px-6 pt-5 pb-4">
            <div className="flex flex-col gap-1">
              <h2 id={titleId} className="font-display text-lg font-medium tracking-tight">
                {title}
              </h2>
              {description ? (
                <p id={descriptionId} className="text-sm leading-relaxed text-steel">
                  {description}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={!dismissible}
              aria-label="Close"
              className="-mr-2 rounded-md p-1.5 text-steel transition duration-200 hover:bg-paper/[0.06] hover:text-paper disabled:opacity-40"
            >
              <svg
                aria-hidden
                viewBox="0 0 16 16"
                className="size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
              >
                <path d="m4 4 8 8M12 4l-8 8" />
              </svg>
            </button>
          </header>
          <div className="overflow-y-auto px-6 py-5">{children}</div>
        </div>
      ) : null}
    </dialog>
  );
}

/** Right-aligned action row at the bottom of a dialog form. */
export function DialogActions({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "mt-2 flex items-center justify-end gap-2 border-t border-line pt-5",
        className,
      )}
    >
      {children}
    </div>
  );
}
