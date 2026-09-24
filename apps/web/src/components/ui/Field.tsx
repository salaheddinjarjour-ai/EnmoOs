import { useId, type ReactNode } from "react";
import { cx } from "./cx";

/*
 * Shared label / hint / error plumbing for Input, Textarea and Select. Every control gets a real
 * <label> (or an sr-only one) and aria-describedby, so tests and screen readers find it by label.
 */

export const CONTROL_CLASS =
  "w-full rounded-md border border-line bg-void/60 text-sm text-paper placeholder:text-steel/50 transition duration-200 ease-enmo hover:border-paper/15 focus:border-paper/40 focus:bg-void focus:shadow-[0_0_0_3px_rgb(245_245_244/0.05)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-red-400/50";

export const LABEL_CLASS = "text-xs font-medium tracking-wide text-steel";

export interface FieldProps {
  label: ReactNode;
  /** Keep the label for assistive tech but don't draw it (e.g. search boxes). */
  labelHidden?: boolean;
  hint?: ReactNode;
  error?: string | null;
  /** Rendered after the label, right-aligned (counters, badges). */
  aside?: ReactNode;
  className?: string;
}

export interface FieldIds {
  controlId: string;
  describedBy: string | undefined;
  invalid: true | undefined;
}

export function useFieldIds(
  id: string | undefined,
  props: Pick<FieldProps, "hint" | "error">,
): FieldIds {
  const generated = useId();
  const controlId = id ?? generated;
  const describedBy = [
    props.hint ? `${controlId}-hint` : null,
    props.error ? `${controlId}-error` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    controlId,
    describedBy: describedBy || undefined,
    invalid: props.error ? true : undefined,
  };
}

export function FieldShell({
  controlId,
  label,
  labelHidden,
  hint,
  error,
  aside,
  className,
  children,
}: FieldProps & { controlId: string; children: ReactNode }) {
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      {labelHidden ? (
        <label htmlFor={controlId} className="sr-only">
          {label}
        </label>
      ) : (
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={controlId} className={LABEL_CLASS}>
            {label}
          </label>
          {aside}
        </div>
      )}
      {children}
      {hint ? (
        <p id={`${controlId}-hint`} className="text-xs leading-relaxed text-steel/80">
          {hint}
        </p>
      ) : null}
      {error ? <FieldError id={`${controlId}-error`}>{error}</FieldError> : null}
    </div>
  );
}

export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="text-xs leading-relaxed text-red-300">
      {children}
    </p>
  );
}

/** A form-level error (failed save, rejected login). */
export function FormAlert({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="alert"
      className={cx(
        "rounded-md border border-red-400/25 bg-red-500/[0.07] px-3.5 py-2.5 text-sm leading-relaxed text-red-200",
        className,
      )}
    >
      {children}
    </div>
  );
}
