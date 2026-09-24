"use client";

import { ROLE_LABEL } from "@enmo/shared";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ChangePasswordDialog } from "@/components/auth/ChangePasswordDialog";
import { Badge } from "@/components/ui/Badge";
import { cx } from "@/components/ui/cx";
import { useLogout, useSession } from "@/lib/auth";

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts.at(-1)] : [parts[0]];
  return letters
    .map((part) => part?.[0] ?? "")
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

/** Account button in the top bar: who is signed in, change password, sign out. */
export function UserMenu() {
  const { user } = useSession();
  const logout = useLogout();
  const [open, setOpen] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonId = useId();
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = items.findIndex((item) => item === document.activeElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items.at((index + step) % items.length)?.focus();
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Account menu"
        onClick={() => setOpen((value) => !value)}
        className={cx(
          "flex h-9 items-center gap-2.5 rounded-full border border-line py-1 pr-3 pl-1 text-sm transition duration-200 ease-enmo hover:border-paper/20 hover:bg-paper/[0.04]",
          open && "border-paper/20 bg-paper/[0.04]",
        )}
      >
        <span
          aria-hidden
          className="flex size-7 items-center justify-center rounded-full bg-paper/[0.08] font-mono text-[10px] tracking-[0.06em] text-paper"
        >
          {initials(user.name) || "·"}
        </span>
        <span className="max-w-40 truncate text-paper/90">{user.name}</span>
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className="size-3 text-steel"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>

      {open ? (
        <div className="absolute top-11 right-0 z-30 w-64 translate-y-0 overflow-hidden rounded-lg border border-line bg-panel opacity-100 shadow-[0_24px_60px_-24px_rgb(0_0_0/0.9)] transition-[opacity,translate] duration-200 ease-enmo starting:-translate-y-1 starting:opacity-0">
          <div className="flex flex-col gap-2 border-b border-line px-4 py-3.5">
            <div className="flex flex-col">
              <span className="truncate text-sm text-paper">{user.name}</span>
              <span className="truncate font-mono text-[11px] text-steel">{user.email}</span>
            </div>
            <Badge tone="muted" className="self-start">
              {ROLE_LABEL[user.role]}
            </Badge>
          </div>
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-labelledby={buttonId}
            onKeyDown={onMenuKeyDown}
            className="flex flex-col p-1.5"
          >
            <MenuItem
              onSelect={() => {
                setOpen(false);
                setChangingPassword(true);
              }}
            >
              Change password
            </MenuItem>
            <MenuItem onSelect={() => logout.mutate()} disabled={logout.isPending}>
              {logout.isPending ? "Signing out…" : "Sign out"}
            </MenuItem>
          </div>
        </div>
      ) : null}

      <ChangePasswordDialog open={changingPassword} onClose={() => setChangingPassword(false)} />
    </div>
  );
}

function MenuItem({
  onSelect,
  disabled,
  children,
}: {
  onSelect: () => void;
  disabled?: boolean;
  children: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      disabled={disabled}
      onClick={onSelect}
      className="rounded-md px-2.5 py-2 text-left text-sm text-paper/90 transition-colors duration-200 hover:bg-paper/[0.06] hover:text-paper focus-visible:bg-paper/[0.06] focus-visible:outline-none disabled:opacity-50"
    >
      {children}
    </button>
  );
}
