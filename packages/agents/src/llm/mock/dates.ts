/* Calendar arithmetic on YYYY-MM-DD strings (UTC), and the date phrases MockLlm's intake reads. */

const DAY_MS = 86_400_000;

function toUtc(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isoDate(year: number, month: number, day: number): string {
  return fromUtc(Date.UTC(year, month - 1, Math.min(day, daysInMonth(year, month))));
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addDays(iso: string, days: number): string {
  return fromUtc(toUtc(iso) + days * DAY_MS);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
}

export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) + months;
  return isoDate(Math.floor(index / 12), (index % 12) + 1, d);
}

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "Mar 1" */
export function formatDay(iso: string): string {
  const [, m, d] = iso.split("-").map(Number) as [number, number, number];
  return `${MONTH_ABBR[m - 1]} ${d}`;
}

/** "Mar 1 – Mar 30, 2027" (the year once when both ends share it). */
export function formatRange(start: string, end: string): string {
  const startYear = start.slice(0, 4);
  const endYear = end.slice(0, 4);
  return startYear === endYear
    ? `${formatDay(start)} – ${formatDay(end)}, ${endYear}`
    : `${formatDay(start)}, ${startYear} – ${formatDay(end)}, ${endYear}`;
}

export interface DateWindow {
  start: string;
  end: string;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const DAY = String.raw`(\d{1,2})(?:st|nd|rd|th)?`;
const YEAR = String.raw`(?:,?\s*(\d{4}))?`;
const TO = String.raw`\s*(?:–|—|-|to|until|till|through|thru)\s*`;

const ISO_RANGE = new RegExp(String.raw`(\d{4}-\d{2}-\d{2})${TO}(\d{4}-\d{2}-\d{2})`, "i");
/** "March 1–30", "Mar 1 to April 5, 2027" */
const MONTH_DAY_RANGE = new RegExp(
  String.raw`\b${MONTH}\s+${DAY}${YEAR}${TO}(?:${MONTH}\s+)?${DAY}${YEAR}\b`,
  "i",
);
/** "1–30 March", "1 March – 5 April 2027" */
const DAY_MONTH_RANGE = new RegExp(
  String.raw`\b${DAY}(?:\s+${MONTH})?${TO}${DAY}\s+${MONTH}${YEAR}\b`,
  "i",
);
/** "next 2 weeks", "the coming month", "following 10 days" */
const RELATIVE =
  /\b(?:next|coming|following)\s+(\d{1,2}|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple(?:\s+of)?|few)?\s*(day|week|month)s?\b/i;
/** "in March", "throughout April 2027" */
const WHOLE_MONTH = new RegExp(
  String.raw`\b(?:in|during|throughout|for|across|over|all\s+of)\s+${MONTH}(?:\s+(\d{4}))?\b`,
  "i",
);
const THIS_MONTH = /\bthis\s+month\b/i;

const WORD_NUMBERS: Readonly<Record<string, number>> = {
  a: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  couple: 2,
  "couple of": 2,
  few: 3,
};

function monthNumber(name: string | undefined): number | null {
  return name ? (MONTHS[name.toLowerCase().replace(/\.$/, "")] ?? null) : null;
}

/**
 * A month/day range without a year means its next occurrence: this year's, unless that has
 * already ended by `today`. A range that wraps the new year ("Dec 20 – Jan 5") ends a year later.
 */
function resolveRange(
  today: string,
  from: { month: number; day: number; year: number | null },
  to: { month: number; day: number; year: number | null },
): DateWindow {
  const baseYear = from.year ?? to.year ?? Number(today.slice(0, 4));
  const start = isoDate(baseYear, from.month, from.day);
  let end = isoDate(to.year ?? baseYear, to.month, to.day);
  if (end < start && to.year === null) end = isoDate(baseYear + 1, to.month, to.day);
  if (from.year === null && to.year === null && end < today) {
    return {
      start: isoDate(baseYear + 1, from.month, from.day),
      end: addMonths(end, 12),
    };
  }
  return { start, end };
}

/** The campaign window a message states, if any. */
export function parseWindow(text: string, today: string): DateWindow | null {
  const iso = ISO_RANGE.exec(text);
  if (iso) return { start: iso[1]!, end: iso[2]! };

  const monthDay = MONTH_DAY_RANGE.exec(text);
  if (monthDay) {
    const fromMonth = monthNumber(monthDay[1])!;
    return resolveRange(
      today,
      {
        month: fromMonth,
        day: Number(monthDay[2]),
        year: monthDay[3] ? Number(monthDay[3]) : null,
      },
      {
        month: monthNumber(monthDay[4]) ?? fromMonth,
        day: Number(monthDay[5]),
        year: monthDay[6] ? Number(monthDay[6]) : null,
      },
    );
  }

  const dayMonth = DAY_MONTH_RANGE.exec(text);
  if (dayMonth) {
    const toMonth = monthNumber(dayMonth[4])!;
    const year = dayMonth[5] ? Number(dayMonth[5]) : null;
    return resolveRange(
      today,
      { month: monthNumber(dayMonth[2]) ?? toMonth, day: Number(dayMonth[1]), year },
      { month: toMonth, day: Number(dayMonth[3]), year },
    );
  }

  const relative = RELATIVE.exec(text);
  if (relative) {
    const raw = relative[1]?.toLowerCase().replace(/\s+/g, " ");
    const count =
      raw === undefined ? 1 : /^\d+$/.test(raw) ? Number(raw) : (WORD_NUMBERS[raw] ?? 1);
    const unit = relative[2]!.toLowerCase();
    const start = addDays(today, 1);
    if (unit === "month" && raw === undefined) {
      // "next month" is the next calendar month.
      const [y, m] = today.split("-").map(Number) as [number, number];
      const first = addMonths(isoDate(y, m, 1), 1);
      const [ny, nm] = first.split("-").map(Number) as [number, number];
      return { start: first, end: isoDate(ny, nm, daysInMonth(ny, nm)) };
    }
    const end =
      unit === "month"
        ? addDays(addMonths(start, count), -1)
        : addDays(start, count * (unit === "week" ? 7 : 1) - 1);
    return { start, end };
  }

  const wholeMonth = WHOLE_MONTH.exec(text);
  if (wholeMonth) {
    const month = monthNumber(wholeMonth[1])!;
    const year = wholeMonth[2] ? Number(wholeMonth[2]) : null;
    return resolveRange(today, { month, day: 1, year }, { month, day: 31, year });
  }

  if (THIS_MONTH.test(text)) {
    const [y, m] = today.split("-").map(Number) as [number, number];
    return { start: today, end: isoDate(y, m, daysInMonth(y, m)) };
  }
  return null;
}
