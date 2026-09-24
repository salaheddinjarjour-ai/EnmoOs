import type { Metadata } from "next";
import { TeamScreen } from "@/components/admin/TeamScreen";

export const metadata: Metadata = { title: "Team" };

export default function AdminUsersPage() {
  return <TeamScreen />;
}
