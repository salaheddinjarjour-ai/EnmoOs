import {
  APPROVE_ALL_MAX,
  AUDIT_ACTIONS,
  type ApprovalChain,
  type ApprovalListResponse,
  type ApprovalRequestDto,
  type ApproveAllResponse,
} from "@enmo/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app";
import { testDb } from "../helpers/db";
import { createClient } from "../helpers/factories";
import {
  createTeam,
  obliterateQueues,
  queuedJobs,
  seedPipeline,
  sender,
  type Team,
} from "../helpers/route-fixtures";

/*
 * GET /v1/approvals, POST /v1/approvals/:id/decision, POST /v1/approvals/approve-all (DESIGN §D
 * "Request Changes", §E "Approval chain"). Every role may attempt a decision; the chain decides.
 */

let t: TestApp;
let team: Team;
const send = sender(() => t.app);

/** Leading/trailing whitespace, an em dash, a newline and a tab: all must survive untouched. */
const FEEDBACK = "  Lead with the iced oat latte —\n\tkeep the hook under ten words.  ";

beforeAll(async () => {
  t = await buildTestApp();
});

afterAll(async () => {
  await obliterateQueues(t.deps);
  await t.close();
});

beforeEach(async () => {
  team = await createTeam();
});

function twoStepChain(): ApprovalChain {
  return {
    steps: [
      { name: "Editor pass", approverRoles: ["MANAGER"], approverUserIds: [], minApprovals: 1 },
      { name: "Admin sign-off", approverRoles: ["ADMIN"], approverUserIds: [], minApprovals: 1 },
    ],
  };
}

describe("GET /v1/approvals", () => {
  it("lists pending rounds newest first with the viewer's canDecide", async () => {
    const client = await createClient({ name: "Qahwa Co" });
    const { campaign, posts, requests } = await seedPipeline({ createdBy: team.manager, client });
    await testDb().approvalRequest.update({
      where: { id: requests[1]?.id },
      data: { status: "APPROVED", resolvedAt: new Date() },
    });

    const asManager = await send("GET", "/v1/approvals", team.cookies.manager);
    expect(asManager.statusCode, asManager.body).toBe(200);
    const items = asManager.json<ApprovalListResponse>().items;
    expect(items.map((item) => item.post.ref)).toEqual(["p3", "p1"]);
    expect(items[0]).toMatchObject({
      id: requests[2]?.id,
      postId: posts[2]?.id,
      round: 1,
      status: "PENDING",
      currentStep: 0,
      canDecide: true,
      decisions: [],
      client: { id: client.id, name: "Qahwa Co" },
      campaign: { id: campaign.id },
      post: { ref: "p3", status: "PENDING_APPROVAL", currentApproval: { canDecide: true } },
    });

    const asEditor = await send("GET", "/v1/approvals", team.cookies.editor);
    const editorItems = asEditor.json<ApprovalListResponse>().items;
    expect(editorItems.map((item) => item.canDecide)).toEqual([false, false]);
  });

  it("marks rounds whose chain names the viewer as decidable", async () => {
    const client = await createClient({
      approvalChain: {
        steps: [
          {
            name: "Copy desk",
            approverRoles: [],
            approverUserIds: [team.editor.id],
            minApprovals: 1,
          },
        ],
      },
    });
    await seedPipeline({ createdBy: team.manager, client, postCount: 1 });
    const asEditor = await send("GET", "/v1/approvals", team.cookies.editor);
    expect(asEditor.json<ApprovalListResponse>().items.map((item) => item.canDecide)).toEqual([
      true,
    ]);
    const asManager = await send("GET", "/v1/approvals", team.cookies.manager);
    expect(asManager.json<ApprovalListResponse>().items.map((item) => item.canDecide)).toEqual([
      false,
    ]);
  });

  it("filters by client, campaign and platform", async () => {
    const qahwa = await createClient();
    const other = await createClient();
    const first = await seedPipeline({ createdBy: team.manager, client: qahwa, postCount: 2 });
    const second = await seedPipeline({ createdBy: team.manager, client: other, postCount: 1 });
    await testDb().post.update({
      where: { id: first.posts[0]?.id },
      data: { platforms: ["FACEBOOK"] },
    });

    const requestIds = async (query: string) => {
      const response = await send("GET", `/v1/approvals?${query}`, team.cookies.editor);
      expect(response.statusCode, response.body).toBe(200);
      return response.json<ApprovalListResponse>().items.map((item) => item.id);
    };
    expect(await requestIds(`clientId=${other.id}`)).toEqual([second.requests[0]?.id]);
    expect(await requestIds(`campaignId=${first.campaign.id}`)).toEqual([
      first.requests[1]?.id,
      first.requests[0]?.id,
    ]);
    expect(await requestIds("platform=FACEBOOK")).toEqual([first.requests[0]?.id]);
    expect((await send("GET", "/v1/approvals?platform=FAX", team.cookies.editor)).statusCode).toBe(
      400,
    );
  });
});

describe("POST /v1/approvals/:id/decision", () => {
  it("approves the post on the chain's last step", async () => {
    const client = await createClient();
    const { posts, requests } = await seedPipeline({
      createdBy: team.manager,
      client,
      postCount: 1,
    });
    const response = await send(
      "POST",
      `/v1/approvals/${requests[0]?.id}/decision`,
      team.cookies.manager,
      { decision: "APPROVE" },
    );
    expect(response.statusCode, response.body).toBe(200);
    const request = response.json<ApprovalRequestDto>();
    expect(request).toMatchObject({
      status: "APPROVED",
      canDecide: false,
      decisions: [
        {
          step: 0,
          user: { id: team.manager.id, name: team.manager.name },
          decision: "APPROVE",
          feedback: null,
          target: null,
          viaApproveAll: false,
        },
      ],
      post: { status: "APPROVED", approved: true },
    });
    expect(request.resolvedAt).not.toBeNull();
    const post = await testDb().post.findUniqueOrThrow({ where: { id: posts[0]?.id } });
    expect(post.approvedAt).not.toBeNull();
    const events = await testDb().realtimeEvent.findMany();
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["post.updated", "approval.resolved"]),
    );
  });

  it("moves a multi-step chain on without approving the post yet", async () => {
    const client = await createClient({ approvalChain: twoStepChain() });
    const { requests } = await seedPipeline({ createdBy: team.manager, client, postCount: 1 });
    const url = `/v1/approvals/${requests[0]?.id}/decision`;

    const first = await send("POST", url, team.cookies.manager, { decision: "APPROVE" });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json<ApprovalRequestDto>()).toMatchObject({
      status: "PENDING",
      currentStep: 1,
      post: { status: "PENDING_APPROVAL" },
    });
    // The manager's step is done; the next one is the admin's.
    expect(
      (await send("POST", url, team.cookies.manager, { decision: "APPROVE" })).statusCode,
    ).toBe(403);
    const last = await send("POST", url, team.cookies.admin, { decision: "APPROVE" });
    expect(last.json<ApprovalRequestDto>()).toMatchObject({
      status: "APPROVED",
      post: { status: "APPROVED" },
    });
  });

  it("routes requested changes to the Copywriter verbatim and starts a revision", async () => {
    const client = await createClient();
    const { graph, posts, requests } = await seedPipeline({
      createdBy: team.manager,
      client,
      postCount: 1,
    });
    const response = await send(
      "POST",
      `/v1/approvals/${requests[0]?.id}/decision`,
      team.cookies.manager,
      { decision: "REQUEST_CHANGES", feedback: FEEDBACK, target: "COPY" },
    );
    expect(response.statusCode, response.body).toBe(200);
    const request = response.json<ApprovalRequestDto>();
    expect(request).toMatchObject({
      status: "CHANGES_REQUESTED",
      decisions: [{ decision: "REQUEST_CHANGES", feedback: FEEDBACK, target: "COPY" }],
      post: { status: "CHANGES_REQUESTED", revision: 1 },
    });

    const decisionId = request.decisions[0]?.id;
    const db = testDb();
    const revision = await db.agentTask.findMany({
      where: { graphId: graph.id, postId: posts[0]?.id, revision: 1 },
      orderBy: { createdAt: "asc" },
    });
    expect(revision.map((task) => task.action)).toEqual(["write", "qa"]);
    expect(revision[0]?.feedback).toEqual({ verbatim: FEEDBACK, source: "HUMAN", decisionId });
    expect(revision[0]?.status).toBe("QUEUED");
    expect(await queuedJobs(t.deps)).toContainEqual(
      expect.objectContaining({
        name: "task.run",
        data: expect.objectContaining({ taskId: revision[0]?.id, revision: 1 }) as unknown,
      }),
    );
  });

  it("needs the feedback and a target to request changes", async () => {
    const client = await createClient();
    const { requests } = await seedPipeline({ createdBy: team.manager, client, postCount: 1 });
    const url = `/v1/approvals/${requests[0]?.id}/decision`;
    const bodies = [
      {},
      { decision: "MAYBE" },
      { decision: "REQUEST_CHANGES", target: "COPY" },
      { decision: "REQUEST_CHANGES", feedback: "Shorter please" },
      { decision: "REQUEST_CHANGES", feedback: " \n\t ", target: "COPY" },
      { decision: "REQUEST_CHANGES", feedback: "Shorter", target: "AUDIO" },
    ];
    for (const body of bodies) {
      const response = await send("POST", url, team.cookies.manager, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await testDb().approvalDecision.count()).toBe(0);
  });

  it("lets only the chain's approvers decide, once", async () => {
    const client = await createClient();
    const { requests } = await seedPipeline({ createdBy: team.manager, client, postCount: 1 });
    const url = `/v1/approvals/${requests[0]?.id}/decision`;

    const byEditor = await send("POST", url, team.cookies.editor, { decision: "APPROVE" });
    expect(byEditor.statusCode).toBe(403);
    expect(byEditor.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

    expect((await send("POST", url, team.cookies.admin, { decision: "APPROVE" })).statusCode).toBe(
      200,
    );
    const late = await send("POST", url, team.cookies.manager, { decision: "APPROVE" });
    expect(late.statusCode).toBe(409);
    expect(await testDb().approvalDecision.count()).toBe(1);

    const unknown = await send("POST", "/v1/approvals/nope/decision", team.cookies.admin, {
      decision: "APPROVE",
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("refuses a change request from someone the chain doesn't name, before any spend", async () => {
    const client = await createClient();
    const { graph, posts, requests } = await seedPipeline({
      createdBy: team.manager,
      client,
      postCount: 1,
    });
    const url = `/v1/approvals/${requests[0]?.id}/decision`;

    // Every role may attempt a decision; only the chain (managers and admins by default) decides.
    const byEditor = await send("POST", url, team.cookies.editor, {
      decision: "REQUEST_CHANGES",
      feedback: FEEDBACK,
      target: "COPY",
    });
    expect(byEditor.statusCode, byEditor.body).toBe(403);
    expect(byEditor.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

    const db = testDb();
    expect(await db.approvalDecision.count()).toBe(0);
    expect(
      await db.approvalRequest.findUniqueOrThrow({ where: { id: requests[0]?.id } }),
    ).toMatchObject({ status: "PENDING", resolvedAt: null });
    expect(await db.post.findUniqueOrThrow({ where: { id: posts[0]?.id } })).toMatchObject({
      status: "PENDING_APPROVAL",
      revision: 0,
    });
    expect(await db.agentTask.count({ where: { graphId: graph.id, revision: { gt: 0 } } })).toBe(0);
    const taskIds = new Set(
      (await db.agentTask.findMany({ where: { graphId: graph.id } })).map((task) => task.id),
    );
    expect(
      (await queuedJobs(t.deps)).filter((job) =>
        taskIds.has((job.data as { taskId?: string }).taskId ?? ""),
      ),
    ).toEqual([]);
  });

  it("takes one change request per round: a second one is a conflict that starts nothing", async () => {
    const client = await createClient();
    const { graph, posts, requests } = await seedPipeline({
      createdBy: team.manager,
      client,
      postCount: 1,
    });
    const url = `/v1/approvals/${requests[0]?.id}/decision`;
    const body = { decision: "REQUEST_CHANGES", feedback: FEEDBACK, target: "COPY" };

    expect((await send("POST", url, team.cookies.manager, body)).statusCode).toBe(200);
    const again = await send("POST", url, team.cookies.admin, {
      ...body,
      feedback: "Something else entirely",
    });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: "CONFLICT" } });

    const db = testDb();
    expect(await db.approvalDecision.count()).toBe(1);
    const revision = await db.agentTask.findMany({
      where: { graphId: graph.id, revision: { gt: 0 } },
      orderBy: { createdAt: "asc" },
    });
    expect(revision.map((task) => [task.nodeKey, task.revision])).toEqual([
      ["n1.r1", 1],
      ["n2.r1", 1],
    ]);
    expect(await db.post.findUniqueOrThrow({ where: { id: posts[0]?.id } })).toMatchObject({
      status: "CHANGES_REQUESTED",
      revision: 1,
    });
  });

  it("starts the revision even when what follows the committed decision fails", async () => {
    const client = await createClient();
    const { graph, requests } = await seedPipeline({
      createdBy: team.manager,
      client,
      postCount: 1,
    });
    const prisma = t.deps.prisma;
    const transaction = prisma.$transaction.bind(prisma) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    // The decision's own transaction commits; the progress recounts after it fail.
    let calls = 0;
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation((...args: unknown[]) => {
      calls += 1;
      if (calls > 1) return Promise.reject(new Error("P2028: transaction API error"));
      return transaction(...args);
    });
    let response;
    try {
      response = await send(
        "POST",
        `/v1/approvals/${requests[0]?.id}/decision`,
        team.cookies.manager,
        {
          decision: "REQUEST_CHANGES",
          feedback: FEEDBACK,
          target: "COPY",
        },
      );
    } finally {
      spy.mockRestore();
    }
    expect(response.statusCode, response.body).toBe(200);
    expect(calls).toBeGreaterThan(1);
    const write = await testDb().agentTask.findFirstOrThrow({
      where: { graphId: graph.id, action: "write", revision: 1 },
    });
    expect(write.status).toBe("QUEUED");
    expect(await queuedJobs(t.deps)).toContainEqual(
      expect.objectContaining({
        name: "task.run",
        data: expect.objectContaining({ taskId: write.id, revision: 1 }) as unknown,
      }),
    );
  });
});

describe("POST /v1/approvals/approve-all", () => {
  it("approves every eligible round, skips the rest and logs one audit row", async () => {
    const client = await createClient();
    const { posts, requests } = await seedPipeline({ createdBy: team.manager, client });
    const db = testDb();
    const done = requests[2];
    await db.approvalRequest.update({
      where: { id: done?.id },
      data: { status: "APPROVED", resolvedAt: new Date() },
    });
    const requestIds = [requests[0]?.id, requests[1]?.id, done?.id, "no-such-request"];

    const response = await send("POST", "/v1/approvals/approve-all", team.cookies.manager, {
      requestIds,
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<ApproveAllResponse>();
    expect(body).toMatchObject({ approvedCount: 2, pendingCount: 0, skippedCount: 2 });
    expect(body.results).toEqual([
      expect.objectContaining({
        requestId: requests[0]?.id,
        postId: posts[0]?.id,
        outcome: "approved",
      }),
      expect.objectContaining({ requestId: requests[1]?.id, outcome: "approved" }),
      expect.objectContaining({ requestId: done?.id, outcome: "skipped", reason: "NOT_PENDING" }),
      expect.objectContaining({
        requestId: "no-such-request",
        outcome: "skipped",
        reason: "NOT_FOUND",
      }),
    ]);

    const audits = await db.auditLog.findMany({
      where: { action: AUDIT_ACTIONS.approvalApproveAll },
    });
    expect(audits.map((audit) => audit.id)).toEqual([body.auditLogId]);
    expect(audits[0]?.actorId).toBe(team.manager.id);
    const decisions = await db.approvalDecision.findMany();
    expect(decisions).toHaveLength(2);
    expect(decisions.every((d) => d.viaApproveAll && d.auditLogId === body.auditLogId)).toBe(true);
    const approved = await db.post.findMany({ where: { status: "APPROVED" } });
    expect(approved.map((post) => post.ref).sort()).toEqual(["p1", "p2"]);
  });

  it("never skips a chain step", async () => {
    const client = await createClient({ approvalChain: twoStepChain() });
    const { requests } = await seedPipeline({ createdBy: team.manager, client, postCount: 2 });
    const response = await send("POST", "/v1/approvals/approve-all", team.cookies.admin, {
      requestIds: requests.map((request) => request.id),
    });
    expect(response.statusCode, response.body).toBe(200);
    // The admin isn't an approver of step 1, so nothing moves.
    expect(response.json<ApproveAllResponse>()).toMatchObject({
      approvedCount: 0,
      pendingCount: 0,
      skippedCount: 2,
      auditLogId: null,
      results: [{ reason: "NOT_ELIGIBLE" }, { reason: "NOT_ELIGIBLE" }],
    });

    const byManager = await send("POST", "/v1/approvals/approve-all", team.cookies.manager, {
      requestIds: requests.map((request) => request.id),
    });
    expect(byManager.json<ApproveAllResponse>()).toMatchObject({
      approvedCount: 0,
      pendingCount: 2,
      results: [
        { outcome: "pending", status: "PENDING", currentStep: 1 },
        { outcome: "pending", status: "PENDING", currentStep: 1 },
      ],
    });
  });

  it("is for managers and admins, with a sensible request", async () => {
    const client = await createClient();
    const { requests } = await seedPipeline({ createdBy: team.manager, client, postCount: 1 });
    const byEditor = await send("POST", "/v1/approvals/approve-all", team.cookies.editor, {
      requestIds: [requests[0]?.id],
    });
    expect(byEditor.statusCode).toBe(403);
    expect(byEditor.json()).toMatchObject({
      error: { code: "FORBIDDEN", details: { capability: "approvals.approveAll" } },
    });

    const id = requests[0]?.id ?? "";
    const bodies = [
      {},
      { requestIds: [] },
      { requestIds: [id, id] },
      { requestIds: Array.from({ length: APPROVE_ALL_MAX + 1 }, (_, i) => `r${i}`) },
    ];
    for (const body of bodies) {
      const response = await send("POST", "/v1/approvals/approve-all", team.cookies.manager, body);
      expect(response.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect(await testDb().approvalDecision.count()).toBe(0);
  });
});
