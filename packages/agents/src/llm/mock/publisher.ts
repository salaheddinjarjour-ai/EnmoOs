import {
  PUBLISHER_LIMITS,
  topSlotCandidate,
  type PublisherInput,
  type PublisherOutput,
} from "@enmo/shared";

/** The same batch of variants, however often it is scheduled. */
export function publisherSubject(input: PublisherInput): unknown {
  return input.items.map((item) => item.variantId);
}

/** Takes every variant's top-scored candidate, as a careful scheduler with no other context would. */
export function mockPublisherSchedule(input: PublisherInput): PublisherOutput {
  return {
    assignments: input.items.map((item) => {
      const best = topSlotCandidate(item.candidates) ?? item.candidates[0];
      const why = best?.reasons[0] ?? "the best expected engagement of the candidates";
      return {
        variantId: item.variantId,
        slotStart: best?.slotStart ?? "",
        reason: `Top-scored slot: ${why}.`.slice(0, PUBLISHER_LIMITS.reasonMaxChars),
      };
    }),
  };
}
