import type { Metadata } from "next";
import { Suspense } from "react";
import { VaultScreen } from "@/components/vault/VaultScreen";

export const metadata: Metadata = { title: "The Vault" };

/* The screen reads its filters and open take from the address, which only the browser knows. */
export default function VaultPage() {
  return (
    <Suspense>
      <VaultScreen />
    </Suspense>
  );
}
