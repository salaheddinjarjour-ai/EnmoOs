import type { PostDto } from "@enmo/shared";
import { describe, expect, it } from "vitest";
import { optimisticallyApproved } from "./useApprovals";
import { budgetUse, formatTokens } from "./useBudget";

const AT = "2027-02-01T10:00:00.000Z";

function pending(currentStep: number, stepCount: number): PostDto {
  return {
    id: "post1",
    campaignId: "c1",
    clientId: "cl1",
    ref: "p1",
    type: "REEL",
    platforms: ["INSTAGRAM"],
    status: "PENDING_APPROVAL",
    column: "APPROVAL",
    pill: "PENDING_APPROVAL",
    approved: false,
    failed: false,
    targetDate: null,
    pillar: null,
    angle: null,
    hook: null,
    copy: null,
    currentAssets: [],
    humanEditCount: 0,
    editable: false,
    revision: 0,
    needsAttention: false,
    attentionReason: null,
    qaNotes: null,
    approvedAt: null,
    liveAt: null,
    currentApproval: {
      id: "r1",
      round: 1,
      status: "PENDING",
      currentStep,
      stepCount,
      stepName: "Manager review",
      canDecide: true,
    },
    createdAt: AT,
    updatedAt: AT,
  };
}

describe("optimisticallyApproved", () => {
  it("approves the post when the viewer decides the last step", () => {
    expect(optimisticallyApproved(pending(0, 1))).toMatchObject({
      status: "APPROVED",
      column: "SCHEDULED",
      pill: "SCHEDULED",
      approved: true,
      currentApproval: { status: "APPROVED", canDecide: false },
    });
  });

  it("only hands the round on when later steps remain", () => {
    const next = optimisticallyApproved(pending(0, 2));
    expect(next).toMatchObject({ status: "PENDING_APPROVAL", approved: false });
    expect(next.currentApproval?.canDecide).toBe(false);
  });
});

describe("budget helpers", () => {
  it("measures the day's spend against the cap", () => {
    expect(budgetUse({ used: 50, cap: 100 })).toEqual({
      fraction: 0.5,
      exhausted: false,
      tight: false,
    });
    expect(budgetUse({ used: 85, cap: 100 }).tight).toBe(true);
    expect(budgetUse({ used: 120, cap: 100 })).toEqual({
      fraction: 1,
      exhausted: true,
      tight: true,
    });
    expect(budgetUse({ used: 0, cap: 0 }).exhausted).toBe(true);
  });

  it("prints token counts compactly", () => {
    expect(formatTokens(39_600)).toBe("39.6K");
    expect(formatTokens(2_000_000)).toBe("2M");
    expect(formatTokens(512)).toBe("512");
  });
});
