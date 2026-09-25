import { PLATFORM_LABEL, PUBLISHER_LIMITS, type PublisherInput } from "@enmo/shared";
import { ENMO_PREAMBLE, OUTPUT_RULES } from "./shared";

/*
 * PUBLISHER.schedule prompt. The optimizer has already done the arithmetic (best-time priors in
 * the client's time zone blended with learned slot scores, spacing and daily caps); the Publisher
 * weighs its top candidates against the campaign and picks one per variant, with a reason the
 * team reads on the calendar.
 */

/** Bump whenever the system prompt or the user-turn template changes. */
export const PUBLISHER_PROMPT_VERSION = "publisher.schedule.v1";

export const PUBLISHER_SYSTEM_PROMPT = `${ENMO_PREAMBLE}

You are the Publisher: you ship approved posts at the moment they will land best. The team has approved every post you see; you only choose when each one goes out.

# Your task: pick a slot for each variant
Each item is one platform variant of an approved post, with up to ${PUBLISHER_LIMITS.candidatesMax} candidate slots the slot optimizer scored for it. A score is the expected engagement against the account's own baseline (1.0 is an ordinary slot); the reasons say where it comes from: best-time priors for the platform in the client's time zone, and what the client's past posts in that slot scored.

## How to choose
- Pick exactly one slot per item, and only from that item's own candidates: copy its slotStart value exactly.
- Start from the highest score. Prefer another candidate only for a concrete reason the numbers can't see: it sits closer to the post's target date, it keeps a campaign moment (a launch, an evening ritual, a weekend) on its day, or it keeps two variants of the same post from landing hours apart for no reason.
- Read times in the client's time zone; the candidates are listed in it.
- reason: one sentence (at most ${PUBLISHER_LIMITS.reasonMaxChars} characters) the team will read on the calendar, naming the slot and why, e.g. "Tuesday 12:00 lunch peak, the day the plan set for this reel."

${OUTPUT_RULES}`;

function localTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("weekday")} ${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

export function renderPublisherUserMessage(input: PublisherInput): string {
  const { campaign, timezone } = input;
  const lines = [
    `Campaign: ${campaign.name} (${campaign.window.start} to ${campaign.window.end}).`,
    `Client time zone: ${timezone}.`,
    "",
    "<brief>",
    input.briefSummary.trim() || "(no summary)",
    "</brief>",
    "",
    `Pick one slot for each of these ${input.items.length} variants:`,
  ];
  for (const item of input.items) {
    lines.push(
      "",
      `## Variant ${item.variantId}: ${PLATFORM_LABEL[item.platform]} ${item.postType}, target date ${item.targetDate ?? "none"}`,
    );
    item.candidates.forEach((candidate, index) => {
      const reasons = candidate.reasons.length > 0 ? ` (${candidate.reasons.join("; ")})` : "";
      lines.push(
        `${index + 1}. slotStart "${candidate.slotStart}" = ${localTime(candidate.slotStart, timezone)} local, score ${candidate.score.toFixed(2)}${reasons}`,
      );
    });
  }
  return lines.join("\n");
}
