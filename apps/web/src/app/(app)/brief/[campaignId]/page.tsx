import type { Metadata } from "next";
import { CampaignThread } from "@/components/chat/CampaignThread";

export const metadata: Metadata = { title: "Campaign" };

export default async function CampaignThreadPage({ params }: PageProps<"/brief/[campaignId]">) {
  const { campaignId } = await params;
  return <CampaignThread campaignId={campaignId} />;
}
