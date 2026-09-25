import {
  findSlotCandidate,
  type Issue,
  type PublisherInput,
  type PublisherOutput,
} from "@enmo/shared";

/*
 * PUBLISHER.schedule business rules (DESIGN §C): exactly one assignment per input variant, each
 * at one of that variant's own candidates.
 */

export function validatePublisher(output: PublisherOutput, input: PublisherInput): Issue[] {
  const issues: Issue[] = [];
  const items = new Map(input.items.map((item) => [item.variantId, item]));
  const assigned = new Set<string>();

  output.assignments.forEach((assignment, index) => {
    const item = items.get(assignment.variantId);
    if (!item) {
      issues.push({
        path: `assignments[${index}].variantId`,
        message: `There is no variant "${assignment.variantId}" in the request.`,
      });
      return;
    }
    if (assigned.has(assignment.variantId)) {
      issues.push({
        path: `assignments[${index}].variantId`,
        message: `Variant ${assignment.variantId} is assigned twice; give each variant exactly one slot.`,
      });
      return;
    }
    assigned.add(assignment.variantId);
    if (!findSlotCandidate(item.candidates, assignment.slotStart)) {
      issues.push({
        path: `assignments[${index}].slotStart`,
        message: `"${assignment.slotStart}" isn't one of variant ${assignment.variantId}'s candidates; copy one of their slotStart values exactly.`,
      });
    }
  });

  for (const item of input.items) {
    if (!assigned.has(item.variantId)) {
      issues.push({
        path: "assignments",
        message: `Variant ${item.variantId} has no slot; add an assignment for it.`,
      });
    }
  }
  return issues;
}
