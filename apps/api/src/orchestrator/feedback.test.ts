import { describe, expect, it } from "vitest";
import { qaFeedbackText, qaRevisionTarget, revisionActions } from "./feedback";

describe("revisionActions", () => {
  it("re-runs the copy chain for COPY", () => {
    expect(revisionActions("COPY", ["write", "qa"])).toEqual(["write", "qa"]);
    expect(revisionActions("COPY", ["write", "direct", "adapt", "qa"])).toEqual([
      "write",
      "adapt",
      "qa",
    ]);
  });

  it("re-runs direct → adapt → qa for VISUAL once the Visual Director is in the pipeline", () => {
    expect(revisionActions("VISUAL", ["write", "direct", "qa"])).toEqual(["direct", "qa"]);
    expect(revisionActions("VISUAL", ["strategy", "write", "direct", "adapt", "qa"])).toEqual([
      "direct",
      "adapt",
      "qa",
    ]);
  });

  it("falls back to the copy chain for VISUAL and BOTH before Phase 3", () => {
    expect(revisionActions("VISUAL", ["write", "qa"])).toEqual(["write", "qa"]);
    expect(revisionActions("BOTH", ["write", "qa"])).toEqual(["write", "qa"]);
  });

  it("re-runs everything for BOTH and never the strategy node", () => {
    expect(revisionActions("BOTH", ["strategy", "write", "direct", "adapt", "qa"])).toEqual([
      "write",
      "direct",
      "adapt",
      "qa",
    ]);
  });
});

describe("QA feedback", () => {
  const issue = (target: "COPYWRITER" | "VISUAL_DIRECTOR" | "ADAPTER") => ({
    target,
    field: "caption",
    problem: "Too long.",
    instruction: "Cut it to two lines.",
  });

  it("routes issues to the specialists they name", () => {
    expect(qaRevisionTarget([issue("COPYWRITER")])).toBe("COPY");
    expect(qaRevisionTarget([issue("VISUAL_DIRECTOR")])).toBe("VISUAL");
    expect(qaRevisionTarget([issue("COPYWRITER"), issue("VISUAL_DIRECTOR")])).toBe("BOTH");
    expect(qaRevisionTarget([])).toBe("COPY");
  });

  it("turns issues into one instruction per line, or falls back to the summary", () => {
    expect(qaFeedbackText([issue("COPYWRITER")], "summary")).toBe(
      "caption: Too long. → Cut it to two lines.",
    );
    expect(qaFeedbackText([], "Tighten the hook.")).toBe("Tighten the hook.");
  });
});
