/*
 * Timestamp display. The API sends ISO strings; these render in the viewer's locale and zone.
 * Only used below the client-side AuthGate, so server and client never disagree on the zone.
 */

const DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const STEPS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

export function formatDateTime(iso: string): string {
  return DATE_TIME.format(new Date(iso));
}

export function formatDate(iso: string): string {
  return DATE.format(new Date(iso));
}

export function formatRelative(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  for (const [unit, size] of STEPS) {
    if (Math.abs(seconds) >= size) return RELATIVE.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

/** <time> with a relative label and the exact timestamp on hover. */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  return (
    <time dateTime={iso} title={formatDateTime(iso)} className={className} suppressHydrationWarning>
      {formatRelative(iso)}
    </time>
  );
}
