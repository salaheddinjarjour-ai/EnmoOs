import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";

/**
 * The authenticated shell (DESIGN §G): a client-side AuthGate (no middleware on OpenNext), the
 * Sidebar with the session's capabilities, the Topbar and toasts. See components/shell/AppShell.
 */
export default function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <AppShell>{children}</AppShell>;
}
