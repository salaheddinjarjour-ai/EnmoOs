"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { UserMenu } from "@/components/shell/UserMenu";
import { modeChips, useRuntimeCapabilities } from "@/lib/capabilities";
import { activeNavItem } from "@/lib/nav";
import { Badge } from "./Badge";
import { SIDEBAR_ID } from "./Sidebar";

/*
 * Top bar of the authenticated shell: which runtime modes are simulated (MOCK / DRY-RUN chips from
 * GET /capabilities) and the account menu. `children` is a slot for later additions such as the
 * budget meter (Phase 2). No chips means fully live, so that is only shown once the modes are
 * known: a failed lookup shows "Mode unknown" instead of looking live. Narrow screens get one
 * "Simulated" badge in place of the chips, never nothing. On the left, where you are (the
 * sidebar's current screen) and, below the lg breakpoint, the button that opens the sidebar.
 */
export function Topbar({
  children,
  onOpenNav,
  navOpen = false,
}: {
  children?: ReactNode;
  onOpenNav?: () => void;
  navOpen?: boolean;
}) {
  const runtime = useRuntimeCapabilities();
  const chips = runtime.data ? modeChips(runtime.data) : [];
  const screen = activeNavItem(usePathname());
  const menuRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(navOpen);

  // Closing the drawer hands focus back to the button that opened it.
  useEffect(() => {
    if (wasOpen.current && !navOpen) menuRef.current?.focus({ preventScroll: true });
    wasOpen.current = navOpen;
  }, [navOpen]);

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-4 border-b border-line bg-void/80 px-4 backdrop-blur-md sm:px-6 lg:px-10">
      <div className="flex min-w-0 items-center gap-3">
        {onOpenNav ? (
          <button
            ref={menuRef}
            type="button"
            onClick={onOpenNav}
            aria-label="Open menu"
            aria-expanded={navOpen}
            aria-controls={SIDEBAR_ID}
            className="-ml-1.5 flex size-9 flex-none items-center justify-center rounded-lg text-paper/70 transition-colors hover:bg-paper/[0.05] hover:text-paper lg:hidden"
          >
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              className="size-[18px]"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
            >
              <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7" />
            </svg>
          </button>
        ) : null}
        <span className="hidden font-mono text-[11px] tracking-[0.24em] whitespace-nowrap text-steel uppercase sm:inline">
          The Arsenal
        </span>
        {screen ? (
          <>
            <span aria-hidden className="hidden text-[13px] text-paper/20 sm:inline">
              /
            </span>
            <span
              key={screen.href}
              className="animate-fade-in truncate text-[14px] font-medium tracking-[-0.006em] text-paper"
            >
              {screen.label}
            </span>
          </>
        ) : null}
      </div>
      <div className="flex flex-none items-center gap-3">
        {runtime.isError && !runtime.data ? (
          <button
            type="button"
            onClick={() => void runtime.refetch()}
            disabled={runtime.isFetching}
            title="Couldn't load the runtime modes, so this may be a mock or dry run. Retry."
            className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-paper/60"
          >
            <Badge tone="warning">Mode unknown</Badge>
          </button>
        ) : chips.length > 0 ? (
          <>
            <ul aria-label="Simulated modes" className="hidden items-center gap-1.5 md:flex">
              {chips.map((chip) => (
                <li key={chip.id}>
                  <Badge tone="muted" title={chip.description}>
                    {chip.label}
                  </Badge>
                </li>
              ))}
            </ul>
            <Badge
              tone="muted"
              title={chips.map((chip) => chip.label).join(" · ")}
              className="md:hidden"
            >
              <span aria-hidden>Simulated</span>
              <span className="sr-only">
                Simulated modes: {chips.map((chip) => chip.label).join(", ")}
              </span>
            </Badge>
          </>
        ) : null}
        {children}
        <UserMenu />
      </div>
    </header>
  );
}
