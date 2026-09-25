import type { Metadata } from "next";
import { Suspense } from "react";
import { CalendarScreen } from "@/components/calendar/CalendarScreen";

export const metadata: Metadata = { title: "Calendar" };

/* The screen reads its month and client filter from the address, which only the browser knows. */
export default function CalendarPage() {
  return (
    <Suspense>
      <CalendarScreen />
    </Suspense>
  );
}
