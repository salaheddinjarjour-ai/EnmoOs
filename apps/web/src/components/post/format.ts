import { QA_STILL_OPEN_HEADING, type CopywriterOutput, type PostDto } from "@enmo/shared";

/* Display helpers for posts and plans. Pure, so they are unit-tested. */

/*
 * Calendar dates ("2027-03-01") are days, not instants: formatting them in the viewer's zone could
 * move them a day, so they are read and written in UTC.
 */
const CALENDAR_DAY = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const CALENDAR_DAY_YEAR = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function calendarInstant(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00Z`);
}

/** "2027-03-01" → "1 Mar" */
export function formatCalendarDay(isoDate: string): string {
  return CALENDAR_DAY.format(calendarInstant(isoDate));
}

/** "1 Mar – 30 Mar 2027" (the year once when both ends share it). */
export function formatCalendarRange(start: string, end: string): string {
  if (start.slice(0, 4) === end.slice(0, 4)) {
    return `${formatCalendarDay(start)} – ${CALENDAR_DAY_YEAR.format(calendarInstant(end))}`;
  }
  return `${CALENDAR_DAY_YEAR.format(calendarInstant(start))} – ${CALENDAR_DAY_YEAR.format(calendarInstant(end))}`;
}

/** 15 → "0:15", 92.5 → "1:32.5" */
export function formatSeconds(seconds: number): string {
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = seconds - minutes * 60;
  const restText = Number.isInteger(rest) ? String(rest) : rest.toFixed(1);
  return `${minutes}:${rest < 10 ? "0" : ""}${restText}`;
}

export interface PreviewText {
  /** The line the viewer sees first. */
  hook: string;
  /** Overlay lines after the hook (scenes or slide headlines). */
  lines: string[];
  /** e.g. "0:14 · 4 scenes", "5 slides", "Static". */
  meta: string;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  return values.find((value) => value && value.trim().length > 0)?.trim() ?? "";
}

/** What the 9:16 text preview draws from the current copy (the Phase 2 posts are text only). */
export function previewText(
  post: Pick<PostDto, "type" | "hook" | "angle">,
  copy: CopywriterOutput | null,
): PreviewText {
  if (copy?.script) {
    const { script } = copy;
    return {
      hook: firstNonEmpty(script.hookText, script.scenes[0]?.overlayText, post.hook, post.angle),
      lines: script.scenes
        .slice(1)
        .map((scene) => scene.overlayText.trim())
        .filter(Boolean)
        .slice(0, 3),
      meta: `${formatSeconds(script.totalDurationSec)} · ${script.scenes.length} scenes`,
    };
  }
  if (copy?.slides && copy.slides.length > 0) {
    return {
      hook: firstNonEmpty(copy.slides[0]?.headline, post.hook, post.angle),
      lines: copy.slides
        .slice(1)
        .map((slide) => slide.headline.trim())
        .filter(Boolean)
        .slice(0, 3),
      meta: `${copy.slides.length} slides`,
    };
  }
  return {
    hook: firstNonEmpty(copy?.onScreenText, post.hook, copy?.caption.split("\n")[0], post.angle),
    lines: [],
    meta: post.type === "STORY" ? "Story" : "Static",
  };
}

/**
 * What the reviewer reads of Manager QA's note on a post card: the issues its revision left open
 * when there are any (`open`, flagged), otherwise its summary.
 */
export function qaNoteOf(qaNotes: string | null): { text: string; open: boolean } | null {
  if (!qaNotes?.trim()) return null;
  const at = qaNotes.indexOf(QA_STILL_OPEN_HEADING);
  if (at < 0) return { text: qaNotes.trim(), open: false };
  return { text: qaNotes.slice(at).trim(), open: true };
}
