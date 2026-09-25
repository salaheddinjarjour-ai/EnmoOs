"use client";

import type { CalendarItemDto } from "@enmo/shared";
import { Dialog } from "@/components/ui/Dialog";
import { formatDayLabel, type CalendarEntry } from "./calendar-model";
import { EventChip } from "./CalendarEvent";

/** Every item of one crowded day, when its cell shows only the first few. */
export function DayDialog({
  day,
  entries,
  viewerZone,
  onClose,
  onOpen,
}: {
  day: string | null;
  entries: readonly CalendarEntry[];
  viewerZone: string;
  onClose: () => void;
  onOpen: (item: CalendarItemDto) => void;
}) {
  return (
    <Dialog
      open={day !== null}
      onClose={onClose}
      title={day ? formatDayLabel(day) : ""}
      description="Drag from the month to move a post; here, open one to move it to another date."
      size="sm"
    >
      <ul
        aria-label={day ? `Everything on ${formatDayLabel(day)}` : undefined}
        className="flex flex-col gap-1.5"
      >
        {entries.map((entry) => (
          <li key={entry.item.id}>
            <EventChip
              entry={entry}
              viewerZone={viewerZone}
              onOpen={() => {
                onClose();
                onOpen(entry.item);
              }}
            />
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
