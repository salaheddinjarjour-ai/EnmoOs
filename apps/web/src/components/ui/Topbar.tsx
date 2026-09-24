"use client";

import type { ReactNode } from "react";
import { UserMenu } from "@/components/shell/UserMenu";
import { modeChips, useRuntimeCapabilities } from "@/lib/capabilities";
import { Badge } from "./Badge";

/*
 * Top bar of the authenticated shell: which runtime modes are simulated (MOCK / DRY-RUN chips from
 * GET /capabilities) and the account menu. `children` is a slot for later additions such as the
 * budget meter (Phase 2). No chips means fully live, so that is only shown once the modes are
 * known: a failed lookup shows "Mode unknown" instead of looking live. Narrow screens get one
 * "Simulated" badge in place of the chips, never nothing.
 */
export function Topbar({ children }: { children?: ReactNode }) {
  const runtime = useRuntimeCapabilities();
  const chips = runtime.data ? modeChips(runtime.data) : [];

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-6 border-b border-line bg-void/80 px-10 backdrop-blur">
      <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-steel">
        The Arsenal
      </span>
      <div className="flex items-center gap-3">
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
