import type { Metadata } from "next";
import { ClientDetailScreen } from "@/components/clients/ClientDetailScreen";

export const metadata: Metadata = { title: "Client" };

export default async function ClientPage({ params }: PageProps<"/clients/[clientId]">) {
  const { clientId } = await params;
  return <ClientDetailScreen clientId={clientId} />;
}
