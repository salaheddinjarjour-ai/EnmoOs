import { z } from "zod";
import { Platform, PostType } from "../enums";
import { SLOT_RULES } from "../platform-rules";
import { Id, IsoDate, IsoDateTime } from "../dto/common";
import { POST_COUNT_MAX, BriefWindow } from "./common";

/*
 * PUBLISHER.schedule contract (DESIGN §C "Publisher"). After a post's final approval the slot
 * optimizer scores candidate slots for each of its variants (best-time priors in the client's time
 * zone blended with learned SlotScores, within the spacing rules); the Publisher picks one per
 * variant and says why. Output follows the structured-output rules in ./common.ts: slotStart is a
 * plain string there, and "one of this variant's candidates" is a business rule checked by the
 * agents package's validator. Once retries run out the orchestrator falls back to each variant's
 * top candidate (slotSource "optimizer"); the Publisher never escalates.
 */

export const PUBLISHER_LIMITS = {
  /** Every variant of a campaign's posts at most. */
  itemsMax: POST_COUNT_MAX * Platform.options.length,
  candidatesMax: SLOT_RULES.candidates,
  reasonMaxChars: 280,
} as const;

/** One slot the optimizer proposes: when, how good, and the evidence behind the score. */
export const SlotCandidate = z.object({
  /** The slot's start as an instant (UTC ISO-8601). */
  slotStart: IsoDateTime,
  /** Expected score: engagement vs the account baseline (1.0 = an ordinary slot). */
  score: z.number().nonnegative(),
  /** Plain-language evidence, e.g. "Instagram weekday lunch peak (Tue 12:00 Asia/Riyadh)". */
  reasons: z.array(z.string()),
});
export type SlotCandidate = z.infer<typeof SlotCandidate>;

/** One platform variant waiting for its slot. */
export const PublisherItem = z.object({
  variantId: Id,
  platform: Platform,
  postType: PostType,
  /** The day the plan meant the post for, in the client's calendar; null when it has none. */
  targetDate: IsoDate.nullable(),
  /** Best first; never empty (a variant without candidates is scheduled by code). */
  candidates: z.array(SlotCandidate).min(1).max(PUBLISHER_LIMITS.candidatesMax),
});
export type PublisherItem = z.infer<typeof PublisherItem>;

export const PublisherInput = z.object({
  campaign: z.object({
    name: z.string(),
    window: BriefWindow,
  }),
  /** The brief in a few lines: objective, product focus, audience, cadence notes. */
  briefSummary: z.string(),
  /** The client's IANA time zone; candidate times are best read in it. */
  timezone: z.string(),
  items: z.array(PublisherItem).min(1).max(PUBLISHER_LIMITS.itemsMax),
});
export type PublisherInput = z.infer<typeof PublisherInput>;

export const SlotAssignment = z.object({
  variantId: z.string(),
  /** Exactly one of this variant's candidate slotStart values (validated in code). */
  slotStart: z.string(),
  /** Why this slot, in one sentence the team sees on the calendar (PublishJob.slotReason). */
  reason: z.string().min(1).max(PUBLISHER_LIMITS.reasonMaxChars),
});
export type SlotAssignment = z.infer<typeof SlotAssignment>;

export const PublisherOutput = z.object({
  /** One per input item. */
  assignments: z.array(SlotAssignment),
});
export type PublisherOutput = z.infer<typeof PublisherOutput>;

/**
 * The candidate the optimizer rates highest (the first of equals): the mock's pick and the
 * orchestrator's fallback once the Publisher's retries run out.
 */
export function topSlotCandidate(candidates: readonly SlotCandidate[]): SlotCandidate | null {
  let best: SlotCandidate | null = null;
  for (const candidate of candidates) {
    if (best === null || candidate.score > best.score) best = candidate;
  }
  return best;
}

/** The candidate `slotStart` names, compared as instants ("…T09:00Z" matches "…T09:00:00.000Z"). */
export function findSlotCandidate(
  candidates: readonly SlotCandidate[],
  slotStart: string,
): SlotCandidate | null {
  const instant = Date.parse(slotStart);
  if (Number.isNaN(instant)) return null;
  return candidates.find((candidate) => Date.parse(candidate.slotStart) === instant) ?? null;
}
