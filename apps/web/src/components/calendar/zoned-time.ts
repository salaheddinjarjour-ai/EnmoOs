/*
 * Instants read in a given IANA time zone (a client's, or the viewer's), and calendar days read in
 * UTC so no zone can shift them. Labels are assembled from formatToParts rather than taken whole:
 * ICU versions (Node's, each browser's) disagree on the punctuation between parts, and these labels
 * double as accessible names the browser tests look for.
 */

type PartName = "weekday" | "day" | "month" | "year" | "hour" | "minute";

export function partsOf(
  format: Intl.DateTimeFormat,
  instant: number | Date,
): Map<PartName, string> {
  const parts = new Map<PartName, string>();
  for (const part of format.formatToParts(instant)) {
    if (part.type !== "literal") parts.set(part.type as PartName, part.value);
  }
  return parts;
}

export function joined(parts: Map<PartName, string>, names: readonly PartName[]): string {
  return names
    .map((name) => parts.get(name))
    .filter(Boolean)
    .join(" ");
}

const timeFormats = new Map<string, Intl.DateTimeFormat>();
const dayTimeFormats = new Map<string, Intl.DateTimeFormat>();

function cachedFormat(
  cache: Map<string, Intl.DateTimeFormat>,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  let format = cache.get(timeZone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat("en-GB", { ...options, timeZone });
    } catch {
      // An unknown zone reads as UTC rather than taking the screen down.
      format = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" });
    }
    cache.set(timeZone, format);
  }
  return format;
}

const clockTime = (parts: Map<PartName, string>) =>
  `${parts.get("hour") ?? "00"}:${parts.get("minute") ?? "00"}`;

/** "19:00" in `timeZone`. */
export function formatTimeIn(iso: string, timeZone: string): string {
  const format = cachedFormat(timeFormats, timeZone, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return clockTime(partsOf(format, new Date(iso)));
}

/** "Thu 1 Oct, 19:00" in `timeZone`. */
export function formatDayTimeIn(iso: string, timeZone: string): string {
  const format = cachedFormat(dayTimeFormats, timeZone, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = partsOf(format, new Date(iso));
  return `${joined(parts, ["weekday", "day", "month"])}, ${clockTime(parts)}`;
}

/** The viewer's IANA time zone ("UTC" when the browser doesn't say). */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
