import type { InputHTMLAttributes } from "react";
import { cx } from "./cx";
import { CONTROL_CLASS, FieldShell, useFieldIds, type FieldProps } from "./Field";

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> &
  FieldProps & {
    inputClassName?: string;
  };

export function Input({
  label,
  labelHidden,
  hint,
  error,
  aside,
  className,
  inputClassName,
  id,
  ...props
}: InputProps) {
  const { controlId, describedBy, invalid } = useFieldIds(id, { hint, error });
  return (
    <FieldShell
      controlId={controlId}
      label={label}
      labelHidden={labelHidden}
      hint={hint}
      error={error}
      aside={aside}
      className={className}
    >
      <input
        id={controlId}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        className={cx(CONTROL_CLASS, "h-10 px-3", inputClassName)}
        {...props}
      />
    </FieldShell>
  );
}
