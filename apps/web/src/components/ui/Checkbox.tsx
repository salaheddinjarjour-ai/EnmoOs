import type { InputHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: ReactNode;
  description?: ReactNode;
};

export function Checkbox({ label, description, className, disabled, ...props }: CheckboxProps) {
  return (
    <label
      className={cx(
        "group inline-flex cursor-pointer items-start gap-2.5 text-sm text-paper",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <input
        type="checkbox"
        disabled={disabled}
        className="mt-0.5 size-4 shrink-0 cursor-[inherit] rounded-sm accent-paper"
        {...props}
      />
      <span className="flex flex-col gap-0.5">
        <span>{label}</span>
        {description ? <span className="text-xs text-steel">{description}</span> : null}
      </span>
    </label>
  );
}
