import type { SelectHTMLAttributes } from "react";
import { cx } from "./cx";
import { CONTROL_CLASS, FieldShell, useFieldIds, type FieldProps } from "./Field";

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export type SelectProps<V extends string = string> = Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "children"
> &
  FieldProps & {
    options: readonly SelectOption<V>[];
    selectClassName?: string;
  };

/** A styled native <select>: keyboard, screen-reader and mobile behaviour come for free. */
export function Select<V extends string = string>({
  label,
  labelHidden,
  hint,
  error,
  aside,
  className,
  selectClassName,
  options,
  id,
  ...props
}: SelectProps<V>) {
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
      <div className="relative">
        <select
          id={controlId}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className={cx(CONTROL_CLASS, "h-10 appearance-none pr-9 pl-3", selectClassName)}
          {...props}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-steel"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </div>
    </FieldShell>
  );
}
