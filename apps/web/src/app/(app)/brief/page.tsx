import type { Metadata } from "next";
import { ScreenPlaceholder } from "@/components/shell/ScreenPlaceholder";

export const metadata: Metadata = { title: "The Brief" };

export default function BriefPage() {
  return (
    <ScreenPlaceholder
      eyebrow="The Brief · Phase 2"
      title="Where you run the agency."
      description="One thread per campaign: brief the Manager, approve the plan, and watch the Arsenal draft every post live."
    />
  );
}
