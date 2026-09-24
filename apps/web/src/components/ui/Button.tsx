import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";
import { cx } from "./cx";

/*
 * Enmo Green is reserved for actions, success and live states (MASTER_PLAN §04), so only the
 * primary variant carries it. Hover lifts by a pixel over 200ms; nothing bounces.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "relative inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition duration-200 ease-enmo disabled:pointer-events-none disabled:opacity-40 aria-disabled:pointer-events-none aria-disabled:opacity-40";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-enmo text-void shadow-[0_10px_30px_-14px_rgb(74_222_128/0.8)] hover:-translate-y-px hover:bg-[#62e392] hover:shadow-[0_14px_34px_-14px_rgb(74_222_128/0.9)] active:translate-y-0",
  secondary:
    "border border-line bg-paper/[0.04] text-paper hover:-translate-y-px hover:border-paper/20 hover:bg-paper/[0.08] active:translate-y-0",
  ghost: "text-steel hover:bg-paper/[0.05] hover:text-paper",
  danger:
    "border border-red-400/25 bg-red-500/10 text-red-300 hover:-translate-y-px hover:border-red-400/40 hover:bg-red-500/20 active:translate-y-0",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-[15px]",
};

export function buttonClasses(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return cx(BASE, VARIANTS[variant], SIZES[size], className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and blocks clicks while an action runs. */
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  type = "button",
  disabled,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses(variant, size, className)}
      {...props}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
}

export type ButtonLinkProps = ComponentProps<typeof Link> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function ButtonLink({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonLinkProps) {
  return <Link className={buttonClasses(variant, size, className)} {...props} />;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx(
        "inline-block size-3.5 animate-spin rounded-full border-[1.5px] border-current border-r-transparent",
        className,
      )}
    />
  );
}
