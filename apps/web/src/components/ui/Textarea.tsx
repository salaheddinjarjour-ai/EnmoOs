import type { TextareaHTMLAttributes } from "react";
import { cx } from "./cx";
import { CONTROL_CLASS, FieldShell, useFieldIds, type FieldProps } from "./Field";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> &
  FieldProps & {
    textareaClassName?: string;
    /** Shows "used / max" next to the label when maxLength is set. */
    showCount?: boolean;
  };

export function Textarea({
  label,
  labelHidden,
  hint,
  error,
  aside,
  className,
  textareaClassName,
  showCount = false,
  id,
  value,
  maxLength,
  ...props
}: TextareaProps) {
  const { controlId, describedBy, invalid } = useFieldIds(id, { hint, error });
  const used = typeof value === "string" ? value.length : 0;
  const counter =
    showCount && maxLength ? (
      <span className="font-mono text-[11px] text-steel/70 tabular-nums">
        {used.toLocaleString("en-US")} / {maxLength.toLocaleString("en-US")}
      </span>
    ) : null;

  return (
    <FieldShell
      controlId={controlId}
      label={label}
      labelHidden={labelHidden}
      hint={hint}
      error={error}
      aside={aside ?? counter}
      className={className}
    >
      <textarea
        id={controlId}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        value={value}
        maxLength={maxLength}
        className={cx(
          CONTROL_CLASS,
          "min-h-24 resize-y px-3 py-2.5 leading-relaxed",
          textareaClassName,
        )}
        {...props}
      />
    </FieldShell>
  );
}
