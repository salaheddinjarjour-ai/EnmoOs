"use client";

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
  type ScreenReaderInstructions,
} from "@dnd-kit/core";
import { PLATFORM_LABEL, type CalendarItemDto, type CalendarJobItem } from "@enmo/shared";
import { useState } from "react";
import { cx } from "@/components/ui/cx";
import {
  formatDayLabel,
  formatShortDay,
  isReschedulable,
  monthOf,
  WEEKDAY_LABELS,
  type CalendarEntry,
  type MonthGrid as MonthGridDays,
} from "./calendar-model";
import { CalendarEvent, EventChip } from "./CalendarEvent";

/*
 * The month (DESIGN §G "calendar/MonthGrid"): Monday-to-Sunday weeks, each day listing the items
 * on it. A SCHEDULED job drags (pointer only, after a few pixels so a click still opens it) onto
 * another day, today or later; the drop asks for that day and the optimizer picks the hour. The
 * table keeps the days navigable for screen readers; moving by keyboard goes through the item's
 * "Move to date".
 */

/** Items a cell shows before "+N more". */
const VISIBLE_PER_DAY = 3;

const SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    "Drag with a pointer to move this post to another day. With the keyboard, press Enter to open it and choose Move to date.",
};

function itemName(item: CalendarItemDto): string {
  return `${item.clientName} on ${PLATFORM_LABEL[item.platform]}`;
}

function entryOf(data: unknown): CalendarEntry | null {
  const entry = (data as { entry?: CalendarEntry } | undefined)?.entry;
  return entry ?? null;
}

const ANNOUNCEMENTS: Announcements = {
  onDragStart: ({ active }) => {
    const entry = entryOf(active.data.current);
    return entry ? `Picked up ${itemName(entry.item)}.` : undefined;
  },
  onDragOver: ({ over }) =>
    over ? `Over ${formatDayLabel(String(over.id))}.` : "Not over a day you can move it to.",
  onDragEnd: ({ over }) =>
    over
      ? `Dropped on ${formatDayLabel(String(over.id))}; finding the best hour that day.`
      : "Dropped outside the calendar; nothing moved.",
  onDragCancel: () => "Move cancelled.",
};

export interface MonthGridProps {
  grid: MonthGridDays;
  byDay: ReadonlyMap<string, CalendarEntry[]>;
  today: string;
  viewerZone: string;
  canReschedule: boolean;
  onMove: (item: CalendarJobItem, date: string) => void;
  onOpen: (item: CalendarItemDto) => void;
  onShowDay: (date: string) => void;
}

export function MonthGrid({
  grid,
  byDay,
  today,
  viewerZone,
  canReschedule,
  onMove,
  onOpen,
  onShowDay,
}: MonthGridProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [dragging, setDragging] = useState<CalendarEntry | null>(null);

  function start({ active }: DragStartEvent) {
    setDragging(entryOf(active.data.current));
  }

  function end({ active, over }: DragEndEvent) {
    setDragging(null);
    const entry = entryOf(active.data.current);
    if (!entry || !over || !isReschedulable(entry.item)) return;
    const date = String(over.id);
    if (date !== entry.date) onMove(entry.item, date);
  }

  return (
    <DndContext
      id="calendar-month"
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={start}
      onDragEnd={end}
      onDragCancel={() => setDragging(null)}
      accessibility={{
        announcements: ANNOUNCEMENTS,
        screenReaderInstructions: SCREEN_READER_INSTRUCTIONS,
      }}
    >
      <div className="-mx-2 overflow-x-auto px-2 pb-2">
        <table className="w-full min-w-[56rem] table-fixed border-separate border-spacing-1.5">
          <caption className="sr-only">
            Publish jobs and planned posts by day, in each client&apos;s own time zone
          </caption>
          <thead>
            <tr>
              {WEEKDAY_LABELS.map((weekday) => (
                <th
                  key={weekday}
                  scope="col"
                  className="pb-1 text-left font-mono text-[11px] font-normal tracking-[0.16em] text-steel uppercase"
                >
                  {weekday}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.weeks.map((week) => (
              <tr key={week[0]}>
                {week.map((day) => (
                  <DayCell
                    key={day}
                    day={day}
                    inMonth={monthOf(day) === grid.month}
                    today={today}
                    entries={byDay.get(day) ?? []}
                    viewerZone={viewerZone}
                    canReschedule={canReschedule}
                    dragging={dragging !== null}
                    onOpen={onOpen}
                    onShowDay={onShowDay}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging ? <EventChip entry={dragging} viewerZone={viewerZone} overlay /> : null}
      </DragOverlay>
    </DndContext>
  );
}

function DayCell({
  day,
  inMonth,
  today,
  entries,
  viewerZone,
  canReschedule,
  dragging,
  onOpen,
  onShowDay,
}: {
  day: string;
  inMonth: boolean;
  today: string;
  entries: readonly CalendarEntry[];
  viewerZone: string;
  canReschedule: boolean;
  dragging: boolean;
  onOpen: (item: CalendarItemDto) => void;
  onShowDay: (date: string) => void;
}) {
  const isToday = day === today;
  // A slot has to be at least half an hour out, so the past takes no drops.
  const acceptsDrops = canReschedule && day >= today;
  const { setNodeRef, isOver } = useDroppable({ id: day, disabled: !acceptsDrops });
  const shown = entries.slice(0, VISIBLE_PER_DAY);
  const hidden = entries.length - shown.length;
  const label = formatDayLabel(day);

  return (
    <td
      ref={setNodeRef}
      aria-current={isToday ? "date" : undefined}
      className={cx(
        "h-36 rounded-lg border align-top transition-colors duration-200 ease-enmo",
        inMonth ? "border-line bg-panel/60" : "border-transparent bg-panel/20",
        isToday && "border-paper/30",
        isOver && "border-paper/40 bg-paper/[0.05]",
        dragging && !acceptsDrops && "opacity-40",
      )}
    >
      <div className="flex h-full flex-col gap-1.5 p-1.5">
        <div className="flex items-center justify-between gap-1 px-0.5">
          <span
            aria-hidden
            className={cx(
              "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 font-mono text-[11px] tabular-nums",
              isToday
                ? "bg-paper font-medium text-void"
                : inMonth
                  ? "text-paper/80"
                  : "text-steel/50",
            )}
          >
            {Number(day.slice(8))}
          </span>
          <span className="sr-only">
            {label}
            {isToday ? ", today" : ""}
          </span>
          {isToday ? (
            <span
              aria-hidden
              className="font-mono text-[9px] tracking-[0.16em] text-paper/70 uppercase"
            >
              Today
            </span>
          ) : null}
        </div>
        <ul aria-label={label} className="flex min-h-0 flex-1 flex-col gap-1">
          {shown.map((entry) => (
            <li key={entry.item.id} className="min-w-0">
              <CalendarEvent
                entry={entry}
                viewerZone={viewerZone}
                draggable={canReschedule && isReschedulable(entry.item) && !entry.moving}
                onOpen={() => onOpen(entry.item)}
              />
            </li>
          ))}
        </ul>
        {hidden > 0 ? (
          <button
            type="button"
            onClick={() => onShowDay(day)}
            aria-label={`Show all ${entries.length} on ${formatShortDay(day)}`}
            className="self-start rounded px-1 font-mono text-[10px] tracking-[0.08em] text-steel transition-colors duration-200 hover:text-paper"
          >
            +{hidden} more
          </button>
        ) : null}
      </div>
    </td>
  );
}
