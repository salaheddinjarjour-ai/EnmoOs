"use client";

import { useDraggable } from "@dnd-kit/core";
import type { Platform } from "@enmo/shared";
import type { ReactNode } from "react";
import { PLATFORM_DOT } from "@/components/clients/platforms";
import { DryRunTag, PublishMark } from "@/components/post/PublishStatus";
import { cx } from "@/components/ui/cx";
import { TakeImage } from "@/components/vault/TakeFrame";
import {
  eventLabel,
  eventStatus,
  eventTime,
  liveUrlOf,
  type CalendarEntry,
} from "./calendar-model";

/*
 * One item in a day cell: a thumbnail, the time in the client's zone (the viewer's on hover), the
 * client and a status mark, on a bar in the platform's colour. A ghost (a planned post with no job
 * yet) is dashed at 40% opacity; a LIVE item links to the live post; anything else opens its
 * details, where "Move to date" is the keyboard way to do what a drag does. Only SCHEDULED jobs
 * drag (CalendarEvent), and only with a pointer.
 */

const PLATFORM_TINT: Readonly<Record<Platform, string>> = {
  INSTAGRAM: "bg-ig/25",
  FACEBOOK: "bg-fb/25",
  TIKTOK: "bg-tt/20",
};

export function EventThumb({
  url,
  platform,
  className,
}: {
  url: string | null;
  platform: Platform;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cx(
        "relative block aspect-[9/16] shrink-0 overflow-hidden rounded-[3px] border border-line",
        url ? "bg-void" : PLATFORM_TINT[platform],
        className,
      )}
    >
      {url ? <TakeImage src={url} alt="" /> : null}
    </span>
  );
}

export interface EventChipProps {
  entry: CalendarEntry;
  viewerZone: string;
  onOpen?: () => void;
  /** dnd-kit's node ref, attributes and listeners, when the chip drags. */
  dragRef?: (node: HTMLElement | null) => void;
  dragProps?: Record<string, unknown>;
  /** The chip left behind while its copy follows the pointer. */
  lifted?: boolean;
  /** The copy that follows the pointer (DragOverlay). */
  overlay?: boolean;
}

export function EventChip({
  entry,
  viewerZone,
  onOpen,
  dragRef,
  dragProps,
  lifted = false,
  overlay = false,
}: EventChipProps) {
  const { item, moving } = entry;
  const status = eventStatus(item);
  const time =
    item.kind === "job" && !moving ? eventTime(item.scheduledFor, item.timezone, viewerZone) : null;
  const label = eventLabel(item, time?.local ?? null);
  const liveUrl = liveUrlOf(item);
  const draggable = Boolean(dragProps);

  const className = cx(
    "group/event relative flex w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-md border py-1 pr-1.5 pl-2.5 text-left transition duration-200 ease-enmo",
    item.kind === "ghost"
      ? "border-dashed border-paper/30 bg-transparent opacity-40 hover:opacity-60"
      : "border-line bg-panel hover:border-paper/20",
    status.tone === "failed" && "border-red-400/35",
    moving && "shimmer",
    draggable && "cursor-grab touch-none active:cursor-grabbing",
    lifted && "opacity-30",
    overlay && "cursor-grabbing border-paper/30 shadow-[0_18px_40px_-16px_rgb(0_0_0/0.9)]",
  );

  const body: ReactNode = (
    <>
      <span
        aria-hidden
        className={cx(
          "absolute inset-y-0 left-0 w-[3px]",
          PLATFORM_DOT[item.platform],
          item.kind === "ghost" && "opacity-70",
        )}
      />
      <EventThumb url={item.thumbUrl} platform={item.platform} className="w-4" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          {item.kind === "job" ? (
            <span className="font-mono text-[10px] leading-none text-paper tabular-nums">
              {time?.local ?? "…"}
            </span>
          ) : null}
          {status.tone === "waiting" ? null : <PublishMark status={status} className="min-w-0" />}
          {item.kind === "job" && item.dryRun ? <DryRunTag className="ml-auto" /> : null}
        </span>
        <span className="truncate text-[11px] leading-tight text-steel">{item.clientName}</span>
      </span>
    </>
  );

  const title = time ? `${item.title}\n${time.tooltip}` : item.title;

  if (liveUrl && !overlay) {
    return (
      <a
        href={liveUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${label}, open the live post`}
        title={title}
        className={className}
      >
        {body}
      </a>
    );
  }
  return (
    <button
      ref={dragRef}
      type="button"
      {...dragProps}
      aria-label={label}
      title={title}
      onClick={onOpen}
      className={className}
    >
      {body}
    </button>
  );
}

/** A chip in the grid: draggable when its job may still move and the viewer may move it. */
export function CalendarEvent({
  entry,
  viewerZone,
  draggable,
  onOpen,
}: {
  entry: CalendarEntry;
  viewerZone: string;
  draggable: boolean;
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: entry.item.id,
    data: { entry },
    disabled: !draggable,
  });
  return (
    <EventChip
      entry={entry}
      viewerZone={viewerZone}
      onOpen={onOpen}
      dragRef={draggable ? setNodeRef : undefined}
      dragProps={draggable ? { ...attributes, ...listeners } : undefined}
      lifted={isDragging}
    />
  );
}
