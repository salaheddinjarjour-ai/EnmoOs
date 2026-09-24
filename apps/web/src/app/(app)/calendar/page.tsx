import type { Metadata } from "next";
import { ScreenPlaceholder } from "@/components/shell/ScreenPlaceholder";

export const metadata: Metadata = { title: "Calendar" };

export default function CalendarPage() {
  return (
    <ScreenPlaceholder
      eyebrow="Calendar · Phase 4"
      title="Every slot, every client."
      description="A month across all clients, colour-coded by platform. Drag to reschedule and the Publisher re-optimises the slot."
    />
  );
}
