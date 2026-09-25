import {
  COPY_BANNED_SCAN_IGNORE,
  MockLlm,
  validateCopy,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
} from "@enmo/agents";
import {
  CopywriterInput,
  CopywriterOutput,
  scanForBannedWords,
  type AgentStatusPayload,
  type AgentTaskListResponse,
  type AlertPayload,
  type ApprovalListResponse,
  type ApprovalRequestDto,
  type ApproveAllResponse,
  type CampaignDto,
  type ChatMessageDto,
  type ManagerIntakeInput,
  type MessageEventPayload,
  type PlanProposedPayload,
  type PostDto,
  type PostListResponse,
  type TaskGraphDto,
  type ThreadMessagesResponse,
} from "@enmo/shared";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/lib/clock";
import { browserHeaders } from "../helpers/app";
import { sessionCookieFor } from "../helpers/auth";
import { testDb } from "../helpers/db";
import { createClient, createUser } from "../helpers/factories";
import {
  PHASE2_PIPELINE,
  startHarness as startAnyHarness,
  type EventStream,
  type Harness,
  type HarnessOptions,
  type ReceivedEvent,
} from "../helpers/harness";

/*
 * Phase 2 exit test "brief → caption drafts → approve in the UI" (DESIGN "Phase 2", exit test
 * phase2.brief-to-approval), over HTTP on the real port with the realtime stream read as SSE:
 *   1. the brief gets exactly one clarifying question;
 *   2. the answer locks the brief and produces the plan, and nothing is drafted before it is
 *      approved;
 *   3. approving it lands 12 posts in PENDING_APPROVAL with contract-valid copy and no banned
 *      words, with agent.status events and a "Copywriter ✓" progress line on the stream;
 *   4. request changes on p3: the feedback reaches the Copywriter verbatim → approval round 2;
 *   5. approve-all → 12 posts APPROVED, one AuditLog row and every decision flagged viaApproveAll.
 * Plus the one-question rule: once the question was asked, intake runs under the brief-only
 * contract, so no second clarifying question can reach the thread.
 */

const BRIEF = "Ramadan campaign for the coffee client — 12 posts, push the iced line";
const ANSWER = "Instagram and Facebook, March 1–30";
const FEEDBACK = "Mention the new cold brew tonic";
/** Early January, so "March 1–30" is this year's March and still in the future. */
const NOW = "2027-01-11T09:00:00.000Z";
const BANNED = ["cheap"];

/** Phase 2's copy pipeline (write → qa); the Visual Director's direct has its own suites. */
const startHarness = (options: HarnessOptions = {}) =>
  startAnyHarness({ pipeline: PHASE2_PIPELINE, ...options });

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

function isMessage(kind: ChatMessageDto["kind"]) {
  return (event: ReceivedEvent) =>
    event.type === "message.created" &&
    (event.payload as MessageEventPayload).message.kind === kind;
}

/** JSON requests as the signed-in browser would send them; anything but 2xx throws. */
function apiFor(h: Harness, cookie: string) {
  const headers = browserHeaders(cookie);
  return async <T>(method: "GET" | "POST", url: string, payload?: object) => {
    const response = await h.app.inject({
      method,
      url,
      headers,
      ...(payload ? { payload } : {}),
    });
    if (response.statusCode >= 300) {
      throw new Error(`${method} ${url} → ${response.statusCode}: ${response.body}`);
    }
    return { status: response.statusCode, body: response.json<T>() };
  };
}

/**
 * Checks `post`'s copy against the Copywriter contract, with the exact input of the write task
 * that produced it (its newest revision), and scans it for the client's banned words.
 */
async function expectContractValidCopy(post: PostDto): Promise<CopywriterOutput> {
  const write = await testDb().agentTask.findFirstOrThrow({
    where: { postId: post.id, action: "write", status: "SUCCEEDED" },
    orderBy: { revision: "desc" },
  });
  const input = CopywriterInput.parse(write.input);
  const copy = CopywriterOutput.parse(post.copy);
  expect(validateCopy(copy, input), post.ref).toEqual([]);
  expect(
    scanForBannedWords(copy, BANNED, { ignoreKeys: COPY_BANNED_SCAN_IGNORE }),
    post.ref,
  ).toEqual([]);
  return copy;
}

describe("phase2.brief-to-approval", () => {
  it("takes a chat brief to 12 approved caption drafts", async () => {
    const h = (harness = await startHarness({ clock: new FakeClock(NOW) }));
    const db = testDb();
    const admin = await createUser({ role: "ADMIN", name: "Salah" });
    const client = await createClient({
      name: "Qahwa Co",
      bannedWords: BANNED,
      enabledPlatforms: ["INSTAGRAM", "FACEBOOK", "TIKTOK"],
    });
    const cookie = await sessionCookieFor(admin, { now: h.clock.now() });
    const api = apiFor(h, cookie);

    // 1. The brief → exactly one consolidated clarifying question.
    const created = await api<CampaignDto>("POST", "/v1/campaigns", { message: BRIEF });
    expect(created.status).toBe(201);
    const campaign = created.body;
    // lastEventId 0 replays this thread's (and the global) events from the first one.
    const stream: EventStream = await h.events({
      cookie,
      threadId: campaign.threadId,
      lastEventId: "0",
    });
    const clarify = await stream.waitFor(isMessage("CLARIFY"));
    const clarifyMessage = (clarify.payload as MessageEventPayload).message;
    expect(clarifyMessage.agent).toBe("MANAGER");
    // One question naming every gap at once.
    expect(clarifyMessage.payload).toMatchObject({
      missing: expect.arrayContaining(["platforms", "window"]) as unknown,
    });

    // 2. The answer locks the brief → the plan; no Copywriter run before it is approved.
    await api<ChatMessageDto>("POST", `/v1/threads/${campaign.threadId}/messages`, {
      content: ANSWER,
    });
    const proposed = await stream.waitFor((event) => event.type === "plan.proposed");
    const { graphId, version } = proposed.payload as PlanProposedPayload;
    expect(version).toBe(1);

    const locked = (await api<CampaignDto>("GET", `/v1/campaigns/${campaign.id}`)).body;
    expect(locked).toMatchObject({
      status: "PLANNING",
      clarifyCount: 1,
      client: { id: client.id },
      latestGraph: { id: graphId, version: 1, status: "PROPOSED" },
    });
    expect(locked.briefLockedAt).not.toBeNull();
    expect(locked.brief).toMatchObject({
      clientId: client.id,
      postCount: 12,
      platforms: ["INSTAGRAM", "FACEBOOK"],
      window: { start: "2027-03-01", end: "2027-03-30" },
    });

    const plan = (await api<TaskGraphDto>("GET", `/v1/task-graphs/${graphId}`)).body;
    expect(plan.status).toBe("PROPOSED");
    expect(plan.posts).toHaveLength(12);
    expect(plan.estimate.calls).toBeGreaterThan(0);
    expect(plan.estimate.usd).toBeGreaterThan(0);
    for (const post of plan.posts) {
      expect(post.targetDate >= "2027-03-01" && post.targetDate <= "2027-03-30", post.ref).toBe(
        true,
      );
      expect(["INSTAGRAM", "FACEBOOK"]).toEqual(expect.arrayContaining(post.platforms));
    }

    const thread = (
      await api<ThreadMessagesResponse>("GET", `/v1/threads/${campaign.threadId}/messages`)
    ).body.items;
    expect(thread.map((message) => [message.role, message.kind])).toEqual([
      ["USER", "TEXT"],
      ["AGENT", "CLARIFY"],
      ["USER", "TEXT"],
      ["AGENT", "BRIEF"],
      ["AGENT", "PLAN"],
    ]);
    expect(thread.at(-1)?.payload).toEqual({ graphId, version: 1 });
    const beforeApproval = await api<AgentTaskListResponse>(
      "GET",
      `/v1/campaigns/${campaign.id}/tasks`,
    );
    expect(beforeApproval.body.items).toEqual([]);
    expect(await db.agentRun.count({ where: { agent: "COPYWRITER" } })).toBe(0);
    expect(stream.ofType("agent.status")).toEqual([]);

    // 3. Approve the plan → 12 posts in PENDING_APPROVAL, with a "Copywriter ✓" event.
    const approved = await api<TaskGraphDto>("POST", `/v1/task-graphs/${graphId}/approve`, {});
    expect(approved.body.status).toBe("APPROVED");

    await stream.waitFor(
      (event) =>
        event.type === "agent.status" &&
        (event.payload as AgentStatusPayload).line.includes("Copywriter ✓"),
      45_000,
    );
    const posts = await h.waitFor(async () => {
      const list = await api<PostListResponse>("GET", `/v1/posts?campaignId=${campaign.id}`);
      const items = list.body.items;
      return items.length === 12 && items.every((post) => post.status === "PENDING_APPROVAL")
        ? items
        : null;
    }, 45_000);
    expect(posts.map((post) => post.ref)).toEqual(
      Array.from({ length: 12 }, (_, i) => `p${i + 1}`),
    );
    expect(posts.every((post) => post.clientId === client.id)).toBe(true);
    expect(posts.every((post) => post.currentApproval?.canDecide)).toBe(true);
    for (const post of posts) await expectContractValidCopy(post);

    const statuses = stream
      .ofType("agent.status")
      .map((event) => event.payload as AgentStatusPayload);
    expect(new Set(statuses.map((status) => status.agent))).toEqual(
      new Set(["COPYWRITER", "MANAGER"]),
    );
    expect(statuses.every((status) => status.campaignId === campaign.id)).toBe(true);
    const card = (await stream.waitFor(isMessage("POST_CARD"))).payload as MessageEventPayload;
    expect(card.message.payload).toEqual({ postIds: posts.map((post) => post.id) });
    const produced = (
      await api<ThreadMessagesResponse>("GET", `/v1/threads/${campaign.threadId}/messages`)
    ).body.items;
    // One live progress line for the graph, and the Copywriter signs off its batch.
    expect(produced.filter((message) => message.kind === "PROGRESS")).toHaveLength(1);
    expect(
      produced.find((message) => message.agent === "COPYWRITER" && message.kind === "TEXT")
        ?.content,
    ).toMatch(/^Copywriter ✓ 12\/12/);

    // 4. Request changes on p3 → the feedback reaches the Copywriter verbatim → round 2.
    const queue = (
      await api<ApprovalListResponse>("GET", `/v1/approvals?campaignId=${campaign.id}`)
    ).body.items;
    expect(queue).toHaveLength(12);
    const p3 = queue.find((request) => request.post.ref === "p3");
    if (!p3) throw new Error("p3 has no approval request");
    const decided = await api<ApprovalRequestDto>("POST", `/v1/approvals/${p3.id}/decision`, {
      decision: "REQUEST_CHANGES",
      feedback: FEEDBACK,
      target: "COPY",
    });
    expect(decided.body.status).toBe("CHANGES_REQUESTED");
    expect(decided.body.decisions[0]?.feedback).toBe(FEEDBACK);

    await stream.waitFor(
      (event) =>
        event.type === "approval.created" &&
        (event.payload as { postId: string; round: number }).postId === p3.postId &&
        (event.payload as { round: number }).round === 2,
      30_000,
    );
    const tasks = (await api<AgentTaskListResponse>("GET", `/v1/campaigns/${campaign.id}/tasks`))
      .body.items;
    const revision = tasks.find(
      (task) => task.postId === p3.postId && task.action === "write" && task.revision === 1,
    );
    expect(revision?.nodeKey).toMatch(/^n\d+\.r1$/);
    expect(revision?.feedback).toEqual({
      verbatim: FEEDBACK,
      source: "HUMAN",
      decisionId: decided.body.decisions[0]?.id,
    });
    const run = await db.agentRun.findFirstOrThrow({
      where: { taskId: revision?.id, agent: "COPYWRITER", outcome: "OK" },
    });
    const snapshot = run.inputSnapshot as { revision: { feedback: { verbatim: string } } };
    expect(snapshot.revision.feedback.verbatim).toBe(FEEDBACK);
    expect(Buffer.from(snapshot.revision.feedback.verbatim)).toEqual(Buffer.from(FEEDBACK));

    const roundTwo = await db.approvalRequest.findUniqueOrThrow({
      where: { postId_round: { postId: p3.postId, round: 2 } },
    });
    expect(roundTwo.status).toBe("PENDING");
    const revised = (await api<PostDto>("GET", `/v1/posts/${p3.postId}`)).body;
    expect(revised).toMatchObject({ status: "PENDING_APPROVAL", revision: 1 });
    const revisedCopy = await expectContractValidCopy(revised);
    expect(revisedCopy.caption).toMatch(/^\[rev\] /);
    expect(revisedCopy.caption).toContain(FEEDBACK);

    // 5. Approve-all → 12 posts APPROVED and one AuditLog row.
    const pending = (
      await api<ApprovalListResponse>("GET", `/v1/approvals?campaignId=${campaign.id}`)
    ).body.items;
    expect(pending).toHaveLength(12);
    expect(pending.find((request) => request.postId === p3.postId)?.round).toBe(2);
    const all = await api<ApproveAllResponse>("POST", "/v1/approvals/approve-all", {
      requestIds: pending.map((request) => request.id),
    });
    expect(all.body).toMatchObject({ approvedCount: 12, pendingCount: 0, skippedCount: 0 });
    expect(all.body.auditLogId).toBeTruthy();

    const final = (await api<PostListResponse>("GET", `/v1/posts?campaignId=${campaign.id}`)).body
      .items;
    expect(final.filter((post) => post.status === "APPROVED")).toHaveLength(12);
    expect(final.every((post) => post.approved && post.approvedAt !== null)).toBe(true);
    const audits = await db.auditLog.findMany({ where: { action: "approval.approve_all" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ id: all.body.auditLogId, actorId: admin.id });
    const approvals = await db.approvalDecision.findMany({ where: { decision: "APPROVE" } });
    expect(approvals).toHaveLength(12);
    expect(
      approvals.every(
        (decision) => decision.viaApproveAll && decision.auditLogId === all.body.auditLogId,
      ),
    ).toBe(true);
    await stream.waitFor(
      () =>
        stream
          .ofType("approval.resolved")
          .filter((event) => (event.payload as { status: string }).status === "APPROVED").length ===
        12,
    );
    // Still exactly one question in the whole thread.
    const everything = (
      await api<ThreadMessagesResponse>("GET", `/v1/threads/${campaign.threadId}/messages`)
    ).body.items;
    expect(everything.filter((message) => message.kind === "CLARIFY")).toHaveLength(1);
  }, 120_000);
});

/** Delegates to MockLlm, but its intake always asks a question, whatever the contract allows. */
class InsistsOnAskingLlm implements LlmClient {
  readonly provider = "mock" as const;
  readonly #mock = new MockLlm();
  readonly model = this.#mock.model;

  complete(request: LlmRequest): Promise<LlmResponse> {
    if (request.meta.agent !== "MANAGER" || request.meta.action !== "intake") {
      return this.#mock.complete(request);
    }
    const input = request.meta.input as ManagerIntakeInput;
    return this.#mock.complete({
      ...request,
      meta: { ...request.meta, input: { ...input, allowClarify: true } },
    });
  }
}

describe("the one-question rule", () => {
  async function briefing(h: Harness) {
    const admin = await createUser({ role: "ADMIN" });
    const client = await createClient({ name: "Qahwa Co", bannedWords: BANNED });
    const api = apiFor(h, await sessionCookieFor(admin, { now: h.clock.now() }));
    const campaign = (await api<CampaignDto>("POST", "/v1/campaigns", { message: BRIEF })).body;
    await h.waitFor(() =>
      testDb().chatMessage.findFirst({ where: { threadId: campaign.threadId, kind: "CLARIFY" } }),
    );
    // The reply still leaves the platforms and the dates open.
    await api<ChatMessageDto>("POST", `/v1/threads/${campaign.threadId}/messages`, {
      content: "Not sure yet, use your judgement.",
    });
    return { campaign, client, api };
  }

  async function intakeRuns(campaignId: string) {
    return testDb().agentRun.findMany({
      where: { campaignId, agent: "MANAGER", action: "intake" },
      orderBy: [{ createdAt: "asc" }, { attempt: "asc" }],
    });
  }

  it("locks the brief with written assumptions instead of asking again", async () => {
    const h = (harness = await startHarness({ clock: new FakeClock(NOW) }));
    const { campaign, client } = await briefing(h);

    const brief = await h.waitFor(() =>
      testDb().chatMessage.findFirst({ where: { threadId: campaign.threadId, kind: "BRIEF" } }),
    );
    const payload = brief.payload as { brief: { clientId: string; assumptions: string[] } };
    expect(payload.brief.clientId).toBe(client.id);
    expect(payload.brief.assumptions.length).toBeGreaterThan(0);
    expect(
      await testDb().chatMessage.count({ where: { threadId: campaign.threadId, kind: "CLARIFY" } }),
    ).toBe(1);

    const runs = await intakeRuns(campaign.id);
    expect(runs.map((run) => (run.inputSnapshot as ManagerIntakeInput).allowClarify)).toEqual([
      true,
      false,
    ]);
    expect(
      (await testDb().campaign.findUniqueOrThrow({ where: { id: campaign.id } })).clarifyCount,
    ).toBe(1);
  });

  it("never lets a second question through, even from a model that insists", async () => {
    const h = (harness = await startHarness({
      clock: new FakeClock(NOW),
      llm: new InsistsOnAskingLlm(),
    }));
    const { campaign } = await briefing(h);

    // The brief-only contract rejects every attempt; the Manager hands the brief back instead.
    const handBack = await h.waitFor(() =>
      testDb().chatMessage.findFirst({
        where: { threadId: campaign.threadId, role: "AGENT", kind: "TEXT", agent: "MANAGER" },
      }),
    );
    expect(handBack.content).toMatch(/brief/);
    const second = (await intakeRuns(campaign.id)).slice(1);
    expect(second.map((run) => [run.attempt, run.outcome])).toEqual([
      [1, "INVALID_OUTPUT"],
      [2, "INVALID_OUTPUT"],
      [3, "INVALID_OUTPUT"],
    ]);
    expect(
      second.every((run) => (run.inputSnapshot as ManagerIntakeInput).allowClarify === false),
    ).toBe(true);
    const messages = await testDb().chatMessage.findMany({
      where: { threadId: campaign.threadId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(messages.filter((message) => message.kind === "CLARIFY")).toHaveLength(1);
    expect(messages.some((message) => message.kind === "BRIEF")).toBe(false);
    const current = await testDb().campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(current).toMatchObject({ clarifyCount: 1, status: "BRIEFING", briefLockedAt: null });
    const alerts = await testDb().realtimeEvent.findMany({ where: { type: "alert" } });
    expect(alerts.map((row) => row.payload as AlertPayload)).toEqual([
      expect.objectContaining({ kind: "escalated", entityType: "Campaign", entityId: campaign.id }),
    ]);
  });
});
