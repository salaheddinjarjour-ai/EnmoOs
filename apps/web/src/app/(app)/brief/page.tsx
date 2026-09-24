import type { Metadata } from "next";
import { BriefScreen } from "@/components/chat/BriefScreen";

export const metadata: Metadata = { title: "The Brief" };

export default async function BriefPage({ searchParams }: PageProps<"/brief">) {
  const { clientId } = await searchParams;
  return <BriefScreen clientId={typeof clientId === "string" ? clientId : undefined} />;
}
