import type { Metadata } from "next";
import { Suspense } from "react";
import { ApprovalsScreen } from "@/components/approvals/ApprovalsScreen";

export const metadata: Metadata = { title: "Approvals" };

/* The screen reads its filters from the address, which only the browser knows. */
export default function ApprovalsPage() {
  return (
    <Suspense>
      <ApprovalsScreen />
    </Suspense>
  );
}
