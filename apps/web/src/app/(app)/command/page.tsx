import type { Metadata } from "next";
import { CommandCenter } from "@/components/command/CommandCenter";

export const metadata: Metadata = { title: "Command Center" };

export default function CommandPage() {
  return <CommandCenter />;
}
