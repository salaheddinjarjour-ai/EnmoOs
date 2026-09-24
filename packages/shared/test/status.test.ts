import { describe, expect, it } from "vitest";
import {
  KanbanColumn,
  POST_STATUS_BOARD,
  PostStatus,
  inferFailedStage,
  postPlacement,
  type ActivePostStatus,
} from "../src";

describe("post status → board placement", () => {
  it("maps every non-FAILED PostStatus, and nothing else", () => {
    const active = PostStatus.options.filter((s) => s !== "FAILED");
    expect(Object.keys(POST_STATUS_BOARD).sort()).toEqual([...active].sort());
  });

  it("gives every status a placement, FAILED included", () => {
    for (const status of PostStatus.options) {
      const placement = postPlacement(status);
      expect(KanbanColumn.options).toContain(placement.column);
      expect(placement.failed).toBe(status === "FAILED");
    }
  });

  it("uses all seven kanban columns", () => {
    const used = new Set(Object.values(POST_STATUS_BOARD).map((p) => p.column));
    expect([...used].sort()).toEqual([...KanbanColumn.options].sort());
    expect(KanbanColumn.options).toHaveLength(7);
  });

  it("follows the DESIGN §B table", () => {
    const table: [ActivePostStatus, string, string][] = [
      ["IDEA", "IDEA", "PLANNING"],
      ["DRAFTING", "DRAFT", "PLANNING"],
      ["CHANGES_REQUESTED", "DRAFT", "PLANNING"],
      ["VISUALIZING", "VISUAL", "PLANNING"],
      ["ADAPTING", "VISUAL", "PLANNING"],
      ["QA", "VISUAL", "PLANNING"],
      ["PENDING_APPROVAL", "APPROVAL", "PENDING_APPROVAL"],
      ["APPROVED", "SCHEDULED", "SCHEDULED"],
      ["SCHEDULED", "SCHEDULED", "SCHEDULED"],
      ["PUBLISHING", "SCHEDULED", "SCHEDULED"],
      ["LIVE", "LIVE", "LIVE"],
      ["SCORED", "SCORED", "LEARNED"],
    ];
    for (const [status, column, pill] of table) {
      expect({ status, ...postPlacement(status) }).toMatchObject({ status, column, pill });
    }
  });

  it("marks approval only once a human has approved", () => {
    const approved = PostStatus.options.filter(
      (s) => s !== "FAILED" && POST_STATUS_BOARD[s].approved,
    );
    expect(approved).toEqual(["APPROVED", "SCHEDULED", "PUBLISHING", "LIVE", "SCORED"]);
  });

  it("keeps a FAILED post in the column and pill of the stage it failed in", () => {
    expect(postPlacement("FAILED", "PUBLISHING")).toEqual({
      column: "SCHEDULED",
      pill: "SCHEDULED",
      approved: true,
      failed: true,
    });
    expect(postPlacement("FAILED", "VISUALIZING")).toMatchObject({
      column: "VISUAL",
      pill: "PLANNING",
    });
    // The stage is ignored unless the post actually failed.
    expect(postPlacement("LIVE", "IDEA")).toMatchObject({ column: "LIVE", failed: false });
  });

  it("infers the failing stage from the post's own fields", () => {
    const base = { liveAt: null, approvedAt: null, copy: null };
    expect(inferFailedStage(base)).toBe("DRAFTING");
    expect(inferFailedStage({ ...base, copy: { caption: "x" } })).toBe("QA");
    expect(inferFailedStage({ ...base, copy: {}, approvedAt: new Date() })).toBe("PUBLISHING");
    expect(inferFailedStage({ ...base, approvedAt: new Date(), liveAt: new Date() })).toBe("LIVE");
    expect(
      postPlacement("FAILED", inferFailedStage({ ...base, approvedAt: "2026-01-01" })).column,
    ).toBe("SCHEDULED");
  });
});
