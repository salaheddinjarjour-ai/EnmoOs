"use client";

import {
  PLATFORM_LABEL,
  type CalendarGhostItem,
  type CalendarItemDto,
  type CalendarJobItem,
} from "@enmo/shared";
import { useState, type FormEvent, type ReactNode } from "react";
import { PostTypeChip } from "@/components/post/PlatformChips";
import { DryRunTag, PublishMark } from "@/components/post/PublishStatus";
import { PostStatusPill } from "@/components/post/StatusPill";
import { Button, buttonClasses } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog } from "@/components/ui/Dialog";
import { FormAlert } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { formatDateTime } from "@/components/ui/time";
import { useToast } from "@/components/ui/Toast";
import {
  useCancelPublishJob,
  useRetryPublishJob,
  useSchedulePublishJob,
} from "@/hooks/usePublishJobs";
import { errorMessage } from "@/lib/api";
import { useCan } from "@/lib/auth";
import {
  eventStatus,
  eventTime,
  formatDayTimeIn,
  formatShortDay,
  ghostNote,
  isCancellable,
  isGhostSchedulable,
  isReschedulable,
  isRetryable,
  liveUrlOf,
  SLOT_SOURCE_LABEL,
} from "./calendar-model";
import { EventThumb } from "./CalendarEvent";

/*
 * One calendar item in full: when it goes out (client time, and the viewer's), who picked the slot
 * and why, the live link or the last error, and what can be done with it: Move to date (the
 * keyboard's drag), retry a failed publish, cancel one that hasn't started or that failed, or
 * open the post. A ghost explains why nothing is scheduled there (ghostNote); on an approved post
 * a manager can put that platform on a day ("Schedule on date").
 */

export function EventDialog({
  item,
  today,
  viewerZone,
  onClose,
  onMove,
  onOpenPost,
}: {
  item: CalendarItemDto | null;
  today: string;
  viewerZone: string;
  onClose: () => void;
  onMove: (item: CalendarJobItem, date: string) => void;
  onOpenPost: (postId: string) => void;
}) {
  return (
    <Dialog
      open={item !== null}
      onClose={onClose}
      title={item ? `${item.clientName} · ${PLATFORM_LABEL[item.platform]}` : ""}
      description={item?.title}
    >
      {item ? (
        <div className="flex gap-5">
          <EventThumb url={item.thumbUrl} platform={item.platform} className="w-20 rounded-md" />
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            {item.kind === "job" ? (
              <JobDetails
                key={`${item.id}:${item.status}:${item.date}`}
                item={item}
                today={today}
                viewerZone={viewerZone}
                onClose={onClose}
                onMove={onMove}
              />
            ) : (
              <GhostDetails key={item.id} item={item} today={today} onClose={onClose} />
            )}
            <div className="flex flex-wrap gap-2 border-t border-line pt-4">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  onClose();
                  onOpenPost(item.postId);
                }}
              >
                Open post
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-baseline gap-3">
      <dt className="font-mono text-[10px] tracking-[0.14em] text-steel uppercase">{label}</dt>
      <dd className="min-w-0 text-sm text-paper/90">{children}</dd>
    </div>
  );
}

function GhostDetails({
  item,
  today,
  onClose,
}: {
  item: CalendarGhostItem;
  today: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const canSchedule = useCan("publish.reschedule") && isGhostSchedulable(item);
  const schedule = useSchedulePublishJob();
  // The planned day when it's still ahead, otherwise today.
  const [date, setDate] = useState(item.date < today ? today : item.date);
  const platform = PLATFORM_LABEL[item.platform];

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!date) return;
    schedule.mutate(
      { postId: item.postId, platform: item.platform, date },
      {
        onSuccess: (job) => {
          toast.success(
            `Scheduled on ${platform}`,
            `${formatDayTimeIn(job.scheduledFor, job.timezone)} (${job.timezone}).`,
          );
          onClose();
        },
      },
    );
  }

  return (
    <>
      <dl className="flex flex-col gap-2.5">
        <Fact label="Status">
          <span className="flex flex-wrap items-center gap-2">
            <PublishMark status={eventStatus(item)} />
            <PostStatusPill status={item.postStatus} />
          </span>
        </Fact>
        <Fact label="Planned">
          <span className="flex flex-wrap items-center gap-2">
            {formatShortDay(item.date)}
            <PostTypeChip type={item.postType} />
          </span>
        </Fact>
      </dl>
      <p className="text-sm leading-relaxed text-steel">{ghostNote(item)}</p>
      {canSchedule ? (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <Input
              label="Schedule on date"
              type="date"
              value={date}
              min={today}
              required
              onChange={(event) => setDate(event.target.value)}
              hint="The optimizer picks the best free hour that day, even outside the campaign window."
              className="w-52"
            />
            <Button type="submit" size="md" variant="primary" loading={schedule.isPending}>
              Schedule
            </Button>
          </div>
          {schedule.isError ? <FormAlert>{errorMessage(schedule.error)}</FormAlert> : null}
        </form>
      ) : null}
    </>
  );
}

function JobDetails({
  item,
  today,
  viewerZone,
  onClose,
  onMove,
}: {
  item: CalendarJobItem;
  today: string;
  viewerZone: string;
  onClose: () => void;
  onMove: (item: CalendarJobItem, date: string) => void;
}) {
  const toast = useToast();
  const canMove = useCan("publish.reschedule") && isReschedulable(item);
  const canRetry = useCan("publish.retry") && isRetryable(item);
  const canCancel = useCan("publish.cancel") && isCancellable(item);
  const retry = useRetryPublishJob();
  const cancel = useCancelPublishJob();
  const [date, setDate] = useState(item.date);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const time = eventTime(item.scheduledFor, item.timezone, viewerZone);
  const liveUrl = liveUrlOf(item);
  const platform = PLATFORM_LABEL[item.platform];

  function move(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!date || date === item.date) return;
    onClose();
    onMove(item, date);
  }

  return (
    <>
      <dl className="flex flex-col gap-2.5">
        <Fact label="Status">
          <span className="flex flex-wrap items-center gap-2">
            <PublishMark status={eventStatus(item)} />
            {item.dryRun ? <DryRunTag long /> : null}
          </span>
        </Fact>
        <Fact label="Goes out">
          <span className="flex flex-col">
            <span>
              {formatDayTimeIn(item.scheduledFor, item.timezone)}{" "}
              <span className="font-mono text-[11px] text-steel">{item.timezone}</span>
            </span>
            {time.viewer ? (
              <span className="text-xs text-steel">
                {time.viewer} your time ({viewerZone})
              </span>
            ) : null}
          </span>
        </Fact>
        <Fact label="Slot">
          <span className="flex flex-col">
            <span>{SLOT_SOURCE_LABEL[item.slotSource]}</span>
            {item.slotReason ? (
              <span className="text-xs leading-relaxed text-steel">{item.slotReason}</span>
            ) : null}
          </span>
        </Fact>
        {item.publishedAt ? (
          <Fact label="Published">{formatDateTime(item.publishedAt)}</Fact>
        ) : null}
      </dl>

      {item.dryRun ? (
        <p className="text-xs leading-relaxed text-steel">
          Dry run: the payload is validated exactly as for a real publish, and the live link is a
          dryrun.enmo.marketing address. Nothing is posted to {platform}.
        </p>
      ) : null}
      {item.status === "FAILED" && item.lastError ? <FormAlert>{item.lastError}</FormAlert> : null}

      {liveUrl ? (
        <a
          href={liveUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonClasses("primary", "sm", "self-start")}
        >
          View live post
          <span aria-hidden>↗</span>
        </a>
      ) : null}

      {canMove ? (
        <form onSubmit={move} className="flex flex-wrap items-end gap-2">
          <Input
            label="Move to date"
            type="date"
            value={date}
            min={today}
            required
            onChange={(event) => setDate(event.target.value)}
            hint="The optimizer picks the best free hour that day."
            className="w-52"
          />
          <Button type="submit" size="md" disabled={!date || date === item.date}>
            Move
          </Button>
        </form>
      ) : null}

      {canRetry || canCancel ? (
        <div className="flex flex-wrap gap-2">
          {canRetry ? (
            <Button
              size="sm"
              variant="primary"
              loading={retry.isPending}
              onClick={() =>
                retry.mutate(item.id, {
                  onSuccess: () => {
                    toast.success(`Publishing to ${platform} again`, "Queued now.");
                    onClose();
                  },
                  onError: (error) => toast.error("Couldn't retry", errorMessage(error)),
                })
              }
            >
              Retry publish
            </Button>
          ) : null}
          {canCancel ? (
            <Button size="sm" variant="danger" onClick={() => setConfirmingCancel(true)}>
              Cancel publish
            </Button>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmingCancel}
        onClose={() => setConfirmingCancel(false)}
        title={`Cancel publishing to ${platform}?`}
        description={`${item.clientName}'s post won't go out on ${platform}. While none of the post is out, editing it and approving it again schedules it anew.`}
        confirmLabel="Cancel publish"
        pending={cancel.isPending}
        error={cancel.isError ? errorMessage(cancel.error) : null}
        onConfirm={() =>
          cancel.mutate(item.id, {
            onSuccess: () => {
              setConfirmingCancel(false);
              toast.success(`Publishing to ${platform} cancelled`);
              onClose();
            },
          })
        }
      />
    </>
  );
}
