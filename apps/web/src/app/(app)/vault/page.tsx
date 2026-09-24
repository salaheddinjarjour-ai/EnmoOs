import type { Metadata } from "next";
import { ScreenPlaceholder } from "@/components/shell/ScreenPlaceholder";

export const metadata: Metadata = { title: "The Vault" };

export default function VaultPage() {
  return (
    <ScreenPlaceholder
      eyebrow="The Vault · Phase 3"
      title="Every take, versioned."
      description="Search every generated asset by prompt, campaign or scene, and regenerate any take with its original context."
    />
  );
}
