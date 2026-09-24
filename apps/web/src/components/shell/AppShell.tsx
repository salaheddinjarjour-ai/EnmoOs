"use client";

import type { ReactNode } from "react";
import { Sidebar } from "@/components/ui/Sidebar";
import { ToastProvider } from "@/components/ui/Toast";
import { Topbar } from "@/components/ui/Topbar";
import { AuthGate, useSession } from "@/lib/auth";
import { SessionLoading, SessionUnavailable } from "./SessionScreens";

/** The authenticated shell: session gate, primary navigation, top bar and toasts. */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <AuthGate
      loading={<SessionLoading />}
      failed={(retry) => <SessionUnavailable onRetry={retry} />}
    >
      <ToastProvider>
        <SignedInLayout>{children}</SignedInLayout>
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
        <Topbar />
        <main className="flex-1 px-10 py-10">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
