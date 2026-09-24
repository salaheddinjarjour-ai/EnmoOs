"use client";

import type { Capability } from "@enmo/shared";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/brand/Logo";
import { isNavItemActive, visibleNavItems, type NavIconName } from "@/lib/nav";

export interface SidebarProps {
  /** The session's capabilities (from GET /auth/me); undefined while loading hides gated items. */
  capabilities?: readonly Capability[];
}

/** Primary navigation. A Step A file: units pass props, they don't edit it. */
export function Sidebar({ capabilities }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="sticky top-0 flex h-dvh w-60 shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex h-14 items-center gap-2.5 border-b border-line px-5">
        <Link href="/command" aria-label="ENMO OS home" className="text-paper">
          <Logo className="text-[15px]" />
        </Link>
        <span className="font-mono text-[10px] tracking-[0.24em] text-steel">OS</span>
      </div>

      <nav aria-label="Primary" className="flex-1 overflow-y-auto px-3 py-4">
        <ul className="flex flex-col gap-0.5">
          {visibleNavItems(capabilities).map((item) => {
            const active = isNavItemActive(item, pathname);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                    active
                      ? "bg-paper/[0.05] text-paper"
                      : "text-steel hover:bg-paper/[0.03] hover:text-paper"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`absolute top-2 bottom-2 left-0 w-px bg-paper transition-opacity ${
                      active ? "opacity-100" : "opacity-0"
                    }`}
                  />
                  <NavIcon name={item.icon} />
                  <span>{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-line px-5 py-4 font-mono text-[10px] uppercase tracking-[0.2em] text-steel/70">
        Grow with Enmo
      </div>
    </aside>
  );
}

const ICON_PATHS: Record<NavIconName, string> = {
  command: "M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z",
  brief: "M3 4h10v7H7l-3 2.5V11H3z",
  calendar: "M3 4.5h10V13H3zM3 7h10M6 3v3M10 3v3",
  vault: "M3 5.5 8 3l5 2.5v5L8 13l-5-2.5zM3 5.5l5 2.5 5-2.5M8 8v5",
  approvals: "M3 8.5 6.5 12 13 4.5",
  clients:
    "M5.5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM2 13c0-2 1.6-3.5 3.5-3.5S9 11 9 13M11 7.5a1.75 1.75 0 1 0 0-3.5M11.5 9.5c1.4.3 2.5 1.6 2.5 3.5",
  admin: "M8 2.5 13 4.5v3.5c0 3-2.2 5-5 5.5-2.8-.5-5-2.5-5-5.5V4.5z",
};

function NavIcon({ name }: { name: NavIconName }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
