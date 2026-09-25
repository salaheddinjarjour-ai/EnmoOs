"use client";

import { useCallback, useState, type ReactNode } from "react";
import { BudgetMeter } from "@/components/dashboard/BudgetMeter";
import { LiveStatus } from "@/components/dashboard/LiveStatus";
import { Sidebar } from "@/components/ui/Sidebar";
import { ToastProvider } from "@/components/ui/Toast";
import { Topbar } from "@/components/ui/Topbar";
import { useApprovals } from "@/hooks/useApprovals";
import { AuthGate, useSession } from "@/lib/auth";
import { RealtimeProvider } from "@/lib/realtime";
import { SessionLoading, SessionUnavailable } from "./SessionScreens";

/**
 * The authenticated shell: session gate, primary navigation, top bar (with the live-updates
 * indicator and the daily token budget) and toasts. The one realtime stream lives here, so it
 * opens with the session and survives navigation between screens.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <AuthGate
      loading={<SessionLoading />}
      failed={(retry) => <SessionUnavailable onRetry={retry} />}
    >
      <ToastProvider>
        <RealtimeProvider>
          <SignedInLayout>{children}</SignedInLayout>
        </RealtimeProvider>
      </ToastProvider>
    </AuthGate>
  );
}

function SignedInLayout({ children }: { children: ReactNode }) {
  const { capabilities } = useSession();
  const [navOpen, setNavOpen] = useState(false);
  const openNav = useCallback(() => setNavOpen(true), []);
  const closeNav = useCallback(() => setNavOpen(false), []);
  // The same query as the Approvals Queue, so realtime approval events keep the count current.
  const approvals = useApprovals();
  const waitingOnViewer = approvals.data?.filter((request) => request.canDecide).length ?? 0;

  return (
    <div className="flex min-h-dvh">
      <Sidebar
        capabilities={capabilities}
        counts={{ "/approvals": waitingOnViewer }}
        mobileOpen={navOpen}
        onMobileClose={closeNav}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onOpenNav={openNav} navOpen={navOpen}>
          <LiveStatus />
          <BudgetMeter />
        </Topbar>
        <main className="flex-1 px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
