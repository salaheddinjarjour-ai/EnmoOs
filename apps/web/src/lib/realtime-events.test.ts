import type { ChatMessageDto, PostDto, RealtimeEvent } from "@enmo/shared";
import { describe, expect, it } from "vitest";
import { queryKeys } from "../hooks/query-keys";
import { effectsOf, patchPost, queryKeyId, upsertMessage } from "./realtime-events";

const AT = "2027-02-01T10:00:00.000Z";

function text(id: string, createdAt = AT, content = id): ChatMessageDto {
  return {
    id,
    threadId: "t1",
    role: "AGENT",
    agent: "MANAGER",
    author: null,
    content,
    createdAt,
    updatedAt: createdAt,
    kind: "TEXT",
    payload: null,
  };
}

function post(overrides: Partial<PostDto> = {}): PostDto {
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
    targetDate: "2027-03-01",
    pillar: null,
    angle: "Iced line",
    hook: null,
    copy: null,
    humanEditCount: 0,
    editable: false,
    revision: 0,
    needsAttention: false,
    attentionReason: null,
    qaNotes: null,
    approvedAt: null,
    liveAt: null,
    currentApproval: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

const invalidated = (event: RealtimeEvent) =>
  effectsOf(event)
    .filter((effect) => effect.kind === "invalidate")
    .map((effect) => queryKeyId(effect.queryKey));

describe("effectsOf", () => {
  it("upserts thread messages and refreshes the campaign when the conversation moves on", () => {
    const message = text("m1");
    const effects = effectsOf({ type: "message.created", payload: { threadId: "t1", message } });
    expect(effects[0]).toEqual({ kind: "upsertMessage", threadId: "t1", message });
    expect(invalidated({ type: "message.created", payload: { threadId: "t1", message } })).toEqual([
      queryKeyId(queryKeys.campaigns.all),
    ]);
  });

  it("leaves the campaign alone on progress upserts, which fire per task transition", () => {
    const progress: ChatMessageDto = {
      ...text("m2"),
      kind: "PROGRESS",
      payload: { graphId: "g1", aggregate: [], line: "" },
    };
    const event: RealtimeEvent = {
      type: "message.updated",
      payload: { threadId: "t1", message: progress },
    };
    expect(effectsOf(event)).toHaveLength(1);
  });

  it("refreshes posts and approvals when posts land in approval", () => {
    const card: ChatMessageDto = { ...text("m3"), kind: "POST_CARD", payload: { postIds: ["a"] } };
    expect(
      invalidated({ type: "message.created", payload: { threadId: "t1", message: card } }),
    ).toEqual(
      expect.arrayContaining([
        queryKeyId(queryKeys.posts.all),
        queryKeyId(queryKeys.approvals.all),
      ]),
    );
  });

  it("patches a post in place, then refetches it for the rest of the DTO", () => {
    const payload = {
      postId: "post1",
      campaignId: "c1",
      clientId: "cl1",
      status: "APPROVED" as const,
      column: "SCHEDULED" as const,
      pill: "SCHEDULED" as const,
      needsAttention: false,
    };
    expect(effectsOf({ type: "post.updated", payload })).toEqual([
      { kind: "patchPost", post: payload },
      { kind: "invalidate", queryKey: queryKeys.posts.all },
    ]);
  });

  it("stores budget snapshots, raises alerts and resyncs", () => {
    const budget = {
      day: "2027-02-01",
      used: 10,
      cap: 100,
      remaining: 90,
      blockedTasks: 0,
      resetsAt: "2027-02-02T00:00:00.000Z",
    };
    expect(effectsOf({ type: "budget.updated", payload: budget })).toEqual([
      { kind: "setBudget", budget },
    ]);
    expect(effectsOf({ type: "resync", payload: { reason: "too many" } })).toEqual([
      { kind: "resync" },
    ]);
    const alert = {
      kind: "budget" as const,
      entityType: "Campaign",
      entityId: "c1",
      message: "Spent",
      clientId: null,
      campaignId: "c1",
    };
    const effects = effectsOf({ type: "alert", payload: alert });
    expect(effects[0]).toEqual({ kind: "alert", alert });
    expect(effects).toContainEqual({ kind: "invalidate", queryKey: queryKeys.budget });
  });

  it("refreshes the campaign's tasks on agent status", () => {
    expect(
      invalidated({
        type: "agent.status",
        payload: {
          campaignId: "c1",
          taskId: "k1",
          agent: "COPYWRITER",
          postRef: "p1",
          state: "running",
          line: "Copywriter writing 0/1…",
        },
      }),
    ).toEqual([queryKeyId(queryKeys.campaigns.tasks("c1"))]);
  });
});

describe("upsertMessage", () => {
  it("keeps the thread in server order (createdAt, then id)", () => {
    const list = [text("b", "2027-02-01T10:00:01.000Z"), text("d", "2027-02-01T10:00:03.000Z")];
    const merged = upsertMessage(list, text("c", "2027-02-01T10:00:01.000Z"));
    expect(merged.map((message) => message.id)).toEqual(["b", "c", "d"]);
    expect(upsertMessage(merged, text("a", AT)).map((message) => message.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("replaces a message by id, but never with an older copy", () => {
    const original = { ...text("m", AT, "Copywriter 1/2"), updatedAt: "2027-02-01T10:00:05.000Z" };
    const newer = { ...original, content: "Copywriter 2/2", updatedAt: "2027-02-01T10:00:09.000Z" };
    const older = { ...original, content: "Copywriter 0/2", updatedAt: AT };
    expect(upsertMessage([original], newer)[0]?.content).toBe("Copywriter 2/2");
    expect(upsertMessage([original], older)[0]?.content).toBe("Copywriter 1/2");
  });
});

describe("patchPost", () => {
  it("moves the card and derives approval from the new status", () => {
    const patched = patchPost(post(), {
      postId: "post1",
      campaignId: "c1",
      clientId: "cl1",
      status: "APPROVED",
      column: "SCHEDULED",
      pill: "SCHEDULED",
      needsAttention: false,
    });
    expect(patched).toMatchObject({ status: "APPROVED", column: "SCHEDULED", approved: true });
  });

  it("marks a failure without claiming approval, and ignores other posts", () => {
    const update = {
      postId: "post1",
      campaignId: "c1",
      clientId: "cl1",
      status: "FAILED" as const,
      column: "APPROVAL" as const,
      pill: "PENDING_APPROVAL" as const,
      needsAttention: true,
    };
    expect(patchPost(post(), update)).toMatchObject({
      failed: true,
      approved: false,
      needsAttention: true,
    });
    const other = post({ id: "post2" });
    expect(patchPost(other, update)).toBe(other);
  });

  it("hides Edit as soon as the post leaves approval, but leaves granting it to the refetch", () => {
    const update = (status: PostDto["status"]) => ({
      postId: "post1",
      campaignId: "c1",
      clientId: "cl1",
      status,
      column: "DRAFT" as const,
      pill: "PLANNING" as const,
      needsAttention: false,
    });
    const editable = post({ editable: true });
    expect(patchPost(editable, update("CHANGES_REQUESTED")).editable).toBe(false);
    expect(patchPost(editable, update("APPROVED")).editable).toBe(true);
    expect(patchPost(post({ editable: false }), update("PENDING_APPROVAL")).editable).toBe(false);
  });
});
