import type { ApprovalRequestDto, PostDto } from "@enmo/shared";
import { describe, expect, it } from "vitest";
import { optimisticallyApprovedRequest } from "./useApprovals";

const AT = "2026-09-25T10:00:00.000Z";

function post(stepCount: number): PostDto {
  return {
    id: "post-1",
    campaignId: "campaign-1",
    clientId: "client-1",
    ref: "p1",
    type: "STATIC",
    platforms: ["INSTAGRAM", "FACEBOOK"],
    status: "PENDING_APPROVAL",
    column: "APPROVAL",
    pill: "PENDING_APPROVAL",
    approved: false,
    failed: false,
    targetDate: "2026-10-01",
    pillar: null,
    angle: null,
    hook: null,
    copy: null,
    currentAssets: [],
    humanEditCount: 0,
    editable: true,
    revision: 0,
    needsAttention: false,
    attentionReason: null,
    qaNotes: null,
    approvedAt: null,
    liveAt: null,
    publishing: [],
    currentApproval: {
      id: "request-1",
      round: 1,
      status: "PENDING",
      currentStep: 0,
      stepCount,
      stepName: "Manager review",
      canDecide: true,
    },
    createdAt: AT,
    updatedAt: AT,
  };
}

function request(stepCount: number): ApprovalRequestDto {
  const step = {
    name: "Manager review",
    approverRoles: ["ADMIN" as const],
    approverUserIds: [],
    minApprovals: 1,
  };
  return {
    id: "request-1",
    postId: "post-1",
    round: 1,
    status: "PENDING",
    chain: { steps: Array.from({ length: stepCount }, () => step) },
    currentStep: 0,
    canDecide: true,
    decisions: [],
    post: post(stepCount),
    client: { id: "client-1", name: "Sahar Juice Bar" },
    campaign: { id: "campaign-1", name: "Launch" },
    createdAt: AT,
    resolvedAt: null,
  };
}

describe("optimisticallyApprovedRequest", () => {
  it("shows the queue's post approved (green border) once the last step is the viewer's", () => {
    const next = optimisticallyApprovedRequest(request(1));
    expect(next.canDecide).toBe(false);
    expect(next.post).toMatchObject({ status: "APPROVED", approved: true });
  });

  it("only takes the round out of the viewer's hands when later steps remain", () => {
    const next = optimisticallyApprovedRequest(request(2));
    expect(next.canDecide).toBe(false);
    expect(next.post).toMatchObject({ status: "PENDING_APPROVAL", approved: false });
    expect(next.post.currentApproval?.canDecide).toBe(false);
  });
});
