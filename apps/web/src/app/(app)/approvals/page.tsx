import type { Metadata } from "next";
import { ScreenPlaceholder } from "@/components/shell/ScreenPlaceholder";

export const metadata: Metadata = { title: "Approvals" };

export default function ApprovalsPage() {
  return (
    <ScreenPlaceholder
      eyebrow="Approvals · Phase 4"
      title="Nothing speaks for a brand unapproved."
      description="Everything waiting on a human across all clients, newest first. Filter, then batch approve from thumbnails."
    />
  );
}
