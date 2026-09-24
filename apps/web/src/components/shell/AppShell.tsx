"use client";

import type { ReactNode } from "react";
import { BudgetMeter } from "@/components/dashboard/BudgetMeter";
import { LiveStatus } from "@/components/dashboard/LiveStatus";
import { Sidebar } from "@/components/ui/Sidebar";
import { ToastProvider } from "@/components/ui/Toast";
import { Topbar } from "@/components/ui/Topbar";
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
  return (
    <div className="flex min-h-dvh">
      <Sidebar capabilities={capabilities} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar>
          <LiveStatus />
          <BudgetMeter />
        </Topbar>
        <main className="flex-1 px-10 py-10">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
