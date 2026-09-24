import type { Metadata } from "next";
import { ClientsScreen } from "@/components/clients/ClientsScreen";

export const metadata: Metadata = { title: "Clients" };

export default function ClientsPage() {
  return <ClientsScreen />;
}
