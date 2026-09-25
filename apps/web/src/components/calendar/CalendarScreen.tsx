"use client";

import { PLATFORM_LABEL, Platform, type CalendarItemDto, type CalendarJobItem } from "@enmo/shared";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { PLATFORM_DOT } from "@/components/clients/platforms";
import { PostDetailDrawer } from "@/components/post/PostDetailDrawer";
import { DryRunTag, PublishMark } from "@/components/post/PublishStatus";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button } from "@/components/ui/Button";
import { cx } from "@/components/ui/cx";
import { FormAlert } from "@/components/ui/Field";
import { Select, type SelectOption } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { useCalendar } from "@/hooks/useCalendar";
import { useClients } from "@/hooks/useClients";
import { usePost } from "@/hooks/usePosts";
import { usePendingMoves, useReschedulePublishJob } from "@/hooks/usePublishJobs";
import { errorMessage } from "@/lib/api";
import { useCan } from "@/lib/auth";
import {
  calendarQuery,
  calendarSearch,
  formatDayTimeIn,
  formatMonth,
  formatShortDay,
  monthGrid,
  monthOf,
  parseMonth,
  placeItems,
  shiftMonth,
  viewerTimeZone,
  viewerToday,
} from "./calendar-model";
import { DayDialog } from "./DayDialog";
import { EventDialog } from "./EventDialog";
import { MonthGrid } from "./MonthGrid";

/*
 * The Calendar (MASTER_PLAN §03): a month across all clients (or one), colour-coded by platform.
 * Each publish job sits on its client-local day at its client-local time; planned posts without a
 * job show as ghost slots. Dragging a SCHEDULED job to another day moves it at once, while the
 * Publisher's optimizer picks the best free hour there (a toast says which); a refusal puts it
 * back. The address carries the month and the client filter (`?month=2026-10&client=…`).
 */

/** The viewer's day, rolling over at their midnight while the page stays open. */
function useViewerToday(): string {
  const [today, setToday] = useState(viewerToday);
  useEffect(() => {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const timer = setTimeout(
      () => setToday(viewerToday()),
      midnight.getTime() - now.getTime() + 1_000,
    );
    return () => clearTimeout(timer);
  }, [today]);
  return today;
}

export function CalendarScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const today = useViewerToday();
  const viewerZone = useMemo(() => viewerTimeZone(), []);
  const currentMonth = monthOf(today);
  const month = parseMonth(params.get("month")) ?? currentMonth;
  const clientId = params.get("client") || null;

  const grid = useMemo(() => monthGrid(month), [month]);
  const calendar = useCalendar(calendarQuery(grid, clientId));
  const clients = useClients();
  const moves = usePendingMoves();
  const reschedule = useReschedulePublishJob();
  const canReschedule = useCan("publish.reschedule");

  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [openPostId, setOpenPostId] = useState<string | null>(null);

  const items = useMemo(() => calendar.data?.items ?? [], [calendar.data]);
  const byDay = useMemo(() => placeItems(items, moves), [items, moves]);
  const openItem = items.find((item) => item.id === openItemId) ?? null;

  const show = (view: { month: string; clientId: string | null }) =>
    router.replace(`${pathname}${calendarSearch(view, currentMonth)}`, { scroll: false });

  function move(item: CalendarJobItem, date: string) {
    const what = `${item.clientName} · ${PLATFORM_LABEL[item.platform]}`;
    // mutateAsync: every move reports back, even when several are in flight at once.
    reschedule.mutateAsync({ jobId: item.id, date }).then(
      (job) =>
        toast.success(
          `${what} moved to ${formatDayTimeIn(job.scheduledFor, job.timezone)}`,
          `${job.slotReason ?? "The optimizer's best free hour that day."} (${job.timezone} time)`,
        ),
      (error: unknown) =>
        toast.error(`Couldn't move ${what} to ${formatShortDay(date)}`, errorMessage(error)),
    );
  }

  const clientOptions: SelectOption[] = [
    { value: "", label: "All clients" },
    ...(clients.data ?? []).map((client) => ({ value: client.id, label: client.name })),
  ];
  const jobs = items.filter((item) => item.kind === "job").length;
  const ghosts = items.length - jobs;
  const settling = calendar.isPlaceholderData && calendar.isFetching;

  return (
    <>
      <PageHeader
        eyebrow="Calendar"
        title="Every slot, every client."
        description="Publish jobs at their client's local time, colour-coded by platform, with ghost slots for planned posts. Drag a scheduled post to another day and the Publisher re-optimises the hour."
      />

      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            aria-label="Previous month"
            onClick={() => show({ month: shiftMonth(month, -1), clientId })}
          >
            <span aria-hidden>←</span>
          </Button>
          <h2
            aria-live="polite"
            className="min-w-44 text-center font-display text-xl font-medium tracking-tight text-paper"
          >
            {formatMonth(month)}
          </h2>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Next month"
            onClick={() => show({ month: shiftMonth(month, 1), clientId })}
          >
            <span aria-hidden>→</span>
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={month === currentMonth}
            onClick={() => show({ month: currentMonth, clientId })}
          >
            Today
          </Button>
        </div>
        <Select
          label="Client"
          options={clientOptions}
          value={clientId ?? ""}
          onChange={(event) => show({ month, clientId: event.target.value || null })}
          className="w-56"
        />
      </div>

      <Legend />

      {calendar.isError ? (
        <div className="mb-5 flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(calendar.error)}</FormAlert>
          <Button size="sm" onClick={() => void calendar.refetch()}>
            Try again
          </Button>
        </div>
      ) : null}

      <p
        role="status"
        className="mb-2 font-mono text-[11px] tracking-[0.16em] text-steel/80 uppercase"
      >
        {calendar.isPending
          ? "Loading the month…"
          : items.length === 0
            ? `Nothing scheduled or planned for ${formatMonth(month)}`
            : `${jobs} publish ${jobs === 1 ? "job" : "jobs"} · ${ghosts} planned`}
      </p>

      <div
        aria-busy={calendar.isPending || settling || undefined}
        className={cx(
          "transition-opacity duration-200 ease-enmo",
          (calendar.isPending || settling) && "opacity-60",
        )}
      >
        <MonthGrid
          grid={grid}
          byDay={byDay}
          today={today}
          viewerZone={viewerZone}
          canReschedule={canReschedule}
          onMove={move}
          onOpen={(item: CalendarItemDto) => setOpenItemId(item.id)}
          onShowDay={setOpenDay}
        />
      </div>

      <DayDialog
        day={openDay}
        entries={openDay ? (byDay.get(openDay) ?? []) : []}
        viewerZone={viewerZone}
        onClose={() => setOpenDay(null)}
        onOpen={(item) => setOpenItemId(item.id)}
      />
      <EventDialog
        item={openItem}
        today={today}
        viewerZone={viewerZone}
        onClose={() => setOpenItemId(null)}
        onMove={move}
        onOpenPost={setOpenPostId}
      />
      {openPostId ? <PostDrawer postId={openPostId} onClose={() => setOpenPostId(null)} /> : null}
    </>
  );
}

function PostDrawer({ postId, onClose }: { postId: string; onClose: () => void }) {
  const post = usePost(postId);
  return post.data ? (
    <PostDetailDrawer post={post.data} open onClose={onClose} showCampaignLink />
  ) : null;
}

function Legend() {
  return (
    <ul
      aria-label="Legend"
      className="mb-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-steel"
    >
      {Platform.options.map((platform) => (
        <li key={platform} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cx("h-3 w-[3px] rounded-full", PLATFORM_DOT[platform])} />
          {PLATFORM_LABEL[platform]}
        </li>
      ))}
      <li className="inline-flex items-center gap-1.5">
        <span
          aria-hidden
          className="h-3 w-5 rounded-sm border border-dashed border-paper/40 opacity-60"
        />
        Planned, not scheduled yet
      </li>
      <li className="inline-flex items-center gap-1.5">
        <PublishMark status={{ label: "LIVE", tone: "live" }} />
        links to the live post
      </li>
      <li className="inline-flex items-center gap-1.5">
        <DryRunTag />
        dry run, nothing posted
      </li>
    </ul>
  );
}
