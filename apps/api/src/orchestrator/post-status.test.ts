import { PostStatus, POST_STATUS_BOARD } from "@enmo/shared";
import { describe, expect, it } from "vitest";
import {
  ACTION_POST_STATUS,
  canTransition,
  POST_TRANSITIONS,
  postUpdatedPayload,
} from "./post-status";

describe("POST_TRANSITIONS", () => {
  it("covers every status with known statuses only", () => {
    expect(Object.keys(POST_TRANSITIONS).sort()).toEqual([...PostStatus.options].sort());
    for (const from of Object.values(POST_TRANSITIONS).flat()) {
      expect(PostStatus.options).toContain(from);
    }
  });

  it("walks the Phase 2 happy path and the revision loops", () => {
    const path = ["IDEA", "DRAFTING", "QA", "PENDING_APPROVAL", "APPROVED"] as const;
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
    // QA revise sends the post back to drafting; a human request goes through CHANGES_REQUESTED.
    expect(canTransition("QA", "DRAFTING")).toBe(true);
    expect(canTransition("PENDING_APPROVAL", "CHANGES_REQUESTED")).toBe(true);
    expect(canTransition("CHANGES_REQUESTED", "DRAFTING")).toBe(true);
    // An edit after approval reopens it.
    expect(canTransition("APPROVED", "PENDING_APPROVAL")).toBe(true);
  });

  it("refuses to skip human approval or move published posts backwards", () => {
    expect(canTransition("QA", "APPROVED")).toBe(false);
    expect(canTransition("DRAFTING", "PENDING_APPROVAL")).toBe(false);
    expect(canTransition("IDEA", "APPROVED")).toBe(false);
    expect(canTransition("LIVE", "DRAFTING")).toBe(false);
    expect(canTransition("SCORED", "PENDING_APPROVAL")).toBe(false);
  });

  it("maps each per-post action to the status its task puts the post in", () => {
    expect(ACTION_POST_STATUS).toEqual({
      strategy: null,
      write: "DRAFTING",
      direct: "VISUALIZING",
      adapt: "ADAPTING",
      qa: "QA",
    });
  });
});

describe("postUpdatedPayload", () => {
  const base = {
    id: "post_1",
    campaignId: "camp_1",
    clientId: "client_1",
    needsAttention: false,
    liveAt: null,
    approvedAt: null,
    copy: null,
  };

  it("places the card with the shared board mapping", () => {
    expect(postUpdatedPayload({ ...base, status: "PENDING_APPROVAL" })).toEqual({
      postId: "post_1",
      campaignId: "camp_1",
      clientId: "client_1",
      status: "PENDING_APPROVAL",
      column: POST_STATUS_BOARD.PENDING_APPROVAL.column,
      pill: POST_STATUS_BOARD.PENDING_APPROVAL.pill,
      needsAttention: false,
    });
  });

  it("keeps a FAILED post in the column of the stage it failed in", () => {
    const payload = postUpdatedPayload({
      ...base,
      status: "FAILED",
      copy: {},
      needsAttention: true,
    });
    expect(payload).toMatchObject({ column: "VISUAL", needsAttention: true });
  });
});
