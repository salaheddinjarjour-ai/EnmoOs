import type { Metadata } from "next";
import { InviteAcceptScreen } from "@/components/auth/InviteAcceptScreen";

export const metadata: Metadata = { title: "Join ENMO OS" };

export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  return <InviteAcceptScreen token={token} />;
}
