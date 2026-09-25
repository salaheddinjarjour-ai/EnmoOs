import type { PostPlatformPublishDto, PublishStatus } from "@enmo/shared";
import { formatDayTimeIn } from "@/components/calendar/zoned-time";

/*
 * How a post's publishing reads (PostDto.publishing, one entry per platform): the mono mark for
 * each job state, and the line a card or the drawer shows per platform. A PUBLISHED job reads LIVE
 * (MASTER_PLAN §04 pills). Pure, so it is unit-tested.
 */

export type PublishTone = "planned" | "waiting" | "working" | "live" | "failed" | "cancelled";

export interface PublishMarkStatus {
  /** The machine token, mono. */
  label: string;
  tone: PublishTone;
}

export function publishMark(status: PublishStatus): PublishMarkStatus {
  switch (status) {
    case "SCHEDULED":
      return { label: "SCHEDULED", tone: "waiting" };
    case "QUEUED":
      return { label: "QUEUED", tone: "working" };
    case "PUBLISHING":
      return { label: "PUBLISHING", tone: "working" };
    case "PUBLISHED":
      return { label: "LIVE", tone: "live" };
    case "FAILED":
      return { label: "FAILED", tone: "failed" };
    case "CANCELLED":
      return { label: "CANCELLED", tone: "cancelled" };
  }
}

/** Whether any platform of the post has a publish job yet. */
export function hasPublishing(entries: readonly PostPlatformPublishDto[]): boolean {
  return entries.some((entry) => entry.status !== null);
}

export interface PublishLine {
  mark: PublishMarkStatus;
  /** When it goes (or went) out, in `timeZone`: "Thu 1 Oct, 19:00". */
  when: string | null;
  liveUrl: string | null;
  dryRun: boolean;
  error: string | null;
}

export function publishLine(entry: PostPlatformPublishDto, timeZone: string): PublishLine {
  if (entry.status === null) {
    return {
      mark: { label: "NOT SCHEDULED", tone: "planned" },
      when: null,
      liveUrl: null,
      dryRun: false,
      error: null,
    };
  }
  const at = entry.status === "PUBLISHED" ? entry.publishedAt : entry.scheduledFor;
  return {
    mark: publishMark(entry.status),
    when: at && entry.status !== "CANCELLED" ? formatDayTimeIn(at, timeZone) : null,
    liveUrl: entry.status === "PUBLISHED" ? entry.liveUrl : null,
    dryRun: entry.dryRun === true,
    error: entry.status === "FAILED" ? entry.lastError : null,
  };
}
