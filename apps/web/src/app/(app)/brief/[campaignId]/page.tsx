import type { Metadata } from "next";
import { ScreenPlaceholder } from "@/components/shell/ScreenPlaceholder";

export const metadata: Metadata = { title: "Campaign" };

export default function CampaignThreadPage() {
  return (
    <ScreenPlaceholder
      eyebrow="The Brief · Phase 2"
      title="Campaign thread"
      description="Agent status, plan cards and finished post cards for this campaign, with one-click approve all."
    />
  );
}
