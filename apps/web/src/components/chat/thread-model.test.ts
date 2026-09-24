import type { CampaignDto, ChatMessageDto } from "@enmo/shared";
import { describe, expect, it } from "vitest";
import {
  agentsAtWork,
  clarifyState,
  composerMode,
  hasPosts,
  latestCardMessage,
  managerThinking,
  requestsWithCards,
} from "./thread-model";

const AT = "2027-02-01T10:00:00.000Z";

type Campaign = Pick<CampaignDto, "status" | "latestGraph">;
const briefing: Campaign = { status: "BRIEFING", latestGraph: null };
const planning: Campaign = { status: "PLANNING", latestGraph: null };
const proposed: Campaign = {
  status: "PLANNING",
  latestGraph: { id: "g1", version: 1, status: "PROPOSED" },
};
const producing: Campaign = {
  status: "PRODUCING",
  latestGraph: { id: "g1", version: 1, status: "APPROVED" },
};

function base(id: string, role: ChatMessageDto["role"]) {
  return {
    id,
    threadId: "t1",
    role,
    agent: role === "AGENT" ? ("MANAGER" as const) : null,
    author: role === "USER" ? { id: "u1", name: "Sara" } : null,
    content: id,
    createdAt: AT,
    updatedAt: AT,
  };
}

const user = (id: string): ChatMessageDto => ({ ...base(id, "USER"), kind: "TEXT", payload: null });
const agentText = (id: string): ChatMessageDto => ({
  ...base(id, "AGENT"),
  kind: "TEXT",
  payload: null,
});
const clarify = (id: string): ChatMessageDto => ({
  ...base(id, "AGENT"),
  kind: "CLARIFY",
  payload: {
    question: "Which platforms and dates?",
    missing: ["platforms", "window"],
    draft: {
      clientId: null,
      title: null,
      objective: null,
      productFocus: null,
      audience: null,
      keyMessages: null,
      platforms: null,
      postCount: 12,
      postMix: null,
      window: null,
      cadenceNotes: null,
      constraints: null,
      assumptions: null,
    },
  },
});
const brief = (id: string): ChatMessageDto => ({
  ...base(id, "AGENT"),
  kind: "BRIEF",
  payload: {
    confirmation: "Locked",
    brief: {
      clientId: "cl1",
      title: "Ramadan",
      objective: "Sell iced",
      productFocus: "iced line",
      audience: null,
      keyMessages: [],
      platforms: ["INSTAGRAM"],
      postCount: 12,
      postMix: [{ type: "REEL", count: 12 }],
      window: { start: "2027-03-01", end: "2027-03-30" },
      cadenceNotes: null,
      constraints: [],
      assumptions: [],
    },
  },
});
const plan = (id: string): ChatMessageDto => ({
  ...base(id, "AGENT"),
  kind: "PLAN",
  payload: { graphId: "g1", version: 1 },
});
const card = (id: string, postIds: string[]): ChatMessageDto => ({
  ...base(id, "AGENT"),
  kind: "POST_CARD",
  payload: { postIds },
});

describe("managerThinking", () => {
  it("waits on intake after a team turn while briefing", () => {
    expect(managerThinking(briefing, [user("m1")])).toBe(true);
    expect(managerThinking(briefing, [user("m1"), clarify("m2")])).toBe(false);
    expect(managerThinking(briefing, [user("m1"), clarify("m2"), user("m3")])).toBe(true);
  });

  it("waits on the plan once the brief locks, and after a change request", () => {
    expect(managerThinking(planning, [user("m1"), brief("m2")])).toBe(true);
    expect(managerThinking(proposed, [user("m1"), brief("m2"), plan("m3")])).toBe(false);
    expect(managerThinking(proposed, [brief("m2"), plan("m3"), user("m4")])).toBe(true);
  });

  it("stops when the Manager replies in words (a failure or a budget pause)", () => {
    expect(managerThinking(planning, [brief("m2"), agentText("m3")])).toBe(false);
  });

  it("is never on once production runs", () => {
    expect(managerThinking(producing, [plan("m3"), user("m4")])).toBe(false);
  });
});

describe("composerMode", () => {
  it("closes while the Manager thinks and once the brief is locked", () => {
    expect(composerMode(briefing, [user("m1")]).kind).toBe("closed");
    expect(composerMode(producing, [plan("m1")]).kind).toBe("closed");
    expect(composerMode({ ...briefing, status: "ARCHIVED" }, [clarify("m1")])).toEqual({
      kind: "closed",
      reason: "This campaign is archived.",
    });
  });

  it("answers the clarifying question while briefing", () => {
    expect(composerMode(briefing, [user("m1"), clarify("m2")]).kind).toBe("message");
  });

  it("asks for a new plan version while one waits for approval", () => {
    expect(composerMode(proposed, [brief("m1"), plan("m2")])).toMatchObject({
      kind: "plan-changes",
      graphId: "g1",
    });
  });

  it("sends an adjustment after a failed planning attempt", () => {
    expect(composerMode(planning, [brief("m1"), agentText("m2")]).kind).toBe("message");
  });

  it("reopens for a resend once the Manager reports that intake failed for good", () => {
    expect(composerMode(briefing, [user("m1"), agentText("m2")]).kind).toBe("message");
    expect(composerMode(proposed, [plan("m1"), user("m2"), agentText("m3")]).kind).toBe(
      "plan-changes",
    );
  });
});

describe("clarifyState", () => {
  it("knows whether the one question has been answered", () => {
    const thread = [user("m1"), clarify("m2")];
    expect(clarifyState(thread, "m2")).toEqual({ isLatest: true, answered: false });
    expect(clarifyState([...thread, user("m3")], "m2")).toEqual({ isLatest: true, answered: true });
  });
});

describe("latestCardMessage", () => {
  it("gives each post to the newest POST_CARD that lists it", () => {
    const owners = latestCardMessage([card("c1", ["a", "b", "c"]), card("c2", ["b"])]);
    expect(owners.get("a")).toBe("c1");
    expect(owners.get("b")).toBe("c2");
  });
});

describe("requestsWithCards", () => {
  it("keeps only the rounds whose post has a card in the thread", () => {
    const requests = [{ postId: "a" }, { postId: "b" }, { postId: "c" }];
    const messages = [card("c1", ["a"]), card("c2", ["c"])];
    expect(requestsWithCards(requests, messages)).toEqual([{ postId: "a" }, { postId: "c" }]);
    expect(requestsWithCards(requests, [])).toEqual([]);
  });
});

describe("hasPosts", () => {
  it("is true once a plan was approved", () => {
    expect(hasPosts(proposed)).toBe(false);
    expect(hasPosts(producing)).toBe(true);
  });
});

describe("agentsAtWork", () => {
  const progress = (id: string, running: number, waiting = 0): ChatMessageDto => ({
    ...base(id, "AGENT"),
    kind: "PROGRESS",
    payload: {
      graphId: "g1",
      line: "Copywriter",
      aggregate: [
        {
          agent: "COPYWRITER",
          done: 12 - running - waiting,
          total: 12,
          running,
          waiting,
          escalated: 0,
          blocked: 0,
        },
      ],
    },
  });

  it("is true only while the live progress counts tasks in flight", () => {
    expect(agentsAtWork([plan("m1"), progress("m2", 3)])).toBe(true);
    expect(agentsAtWork([plan("m1"), progress("m2", 0, 1)])).toBe(true);
    // Every post settled (approved, or waiting on a human): PRODUCING, but nobody is working.
    expect(agentsAtWork([plan("m1"), progress("m2", 0), card("m3", ["a"])])).toBe(false);
    expect(agentsAtWork([plan("m1")])).toBe(false);
  });
});
