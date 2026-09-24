import { AUDIT_ACTIONS, estimatePlan, type TaskGraphDto } from "@enmo/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app";
import { testDb } from "../helpers/db";
import { createClient } from "../helpers/factories";
import {
  createTeam,
  obliterateQueues,
  queuedJobs,
  seedCampaign,
  seedPlan,
  sender,
  testBrief,
  testPlan,
  type Team,
} from "../helpers/route-fixtures";

/*
 * GET /v1/task-graphs/:id, POST …/approve, POST …/request-changes (DESIGN §D "Graph lifecycle",
 * §E). Approval is the first moment anything is queued for the agents.
 */

let t: TestApp;
let team: Team;
const send = sender(() => t.app);

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

/** A briefed campaign with a proposed 3-post write+qa plan. */
async function proposed() {
  const client = await createClient({ name: "Qahwa Co" });
  const seeded = await seedCampaign({ createdBy: team.editor, client, brief: testBrief(client) });
  const plan = testPlan(3);
  const graph = await seedPlan({ campaign: seeded.campaign, plan });
  return { ...seeded, client, plan, graph };
}

describe("GET /v1/task-graphs/:id", () => {
  it("returns the PlanCard: summary, posts, nodes and the code-computed estimate", async () => {
    const { campaign, plan, graph } = await proposed();
    const response = await send("GET", `/v1/task-graphs/${graph.id}`, team.cookies.editor);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<TaskGraphDto>()).toMatchObject({
      id: graph.id,
      campaignId: campaign.id,
      version: 1,
      status: "PROPOSED",
      summary: plan.summary,
      posts: plan.posts,
      nodes: plan.nodes,
      estimate: estimatePlan(plan),
      changeRequest: null,
      approvedBy: null,
      approvedAt: null,
    });
  });

  it("answers 404 for an unknown plan", async () => {
    expect((await send("GET", "/v1/task-graphs/nope", team.cookies.editor)).statusCode).toBe(404);
  });
});

describe("POST /v1/task-graphs/:id/approve", () => {
  it("turns the plan into posts and tasks and queues the first drafts", async () => {
    const { campaign, client, graph } = await proposed();
    const older = await seedPlan({ campaign, plan: testPlan(3), version: 2 });
    const approvedGraph = await seedPlan({ campaign, plan: testPlan(3), version: 3 });
    await testDb().taskGraph.update({ where: { id: graph.id }, data: { status: "SUPERSEDED" } });

    const response = await send(
      "POST",
      `/v1/task-graphs/${approvedGraph.id}/approve`,
      team.cookies.manager,
    );
    expect(response.statusCode, response.body).toBe(200);
    const dto = response.json<TaskGraphDto>();
    expect(dto).toMatchObject({
      id: approvedGraph.id,
      status: "APPROVED",
      approvedBy: { id: team.manager.id, name: team.manager.name },
    });
    expect(dto.approvedAt).not.toBeNull();

    const db = testDb();
    expect((await db.taskGraph.findUniqueOrThrow({ where: { id: older.id } })).status).toBe(
      "SUPERSEDED",
    );
    expect((await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe(
      "PRODUCING",
    );
    const posts = await db.post.findMany({ where: { campaignId: campaign.id } });
    expect(posts.map((post) => post.ref).sort()).toEqual(["p1", "p2", "p3"]);
    expect(posts.every((post) => post.status === "IDEA" && post.clientId === client.id)).toBe(true);

    const tasks = await db.agentTask.findMany({ where: { graphId: approvedGraph.id } });
    expect(tasks).toHaveLength(6);
    const writes = tasks.filter((task) => task.action === "write");
    expect(writes.map((task) => task.status)).toEqual(["QUEUED", "QUEUED", "QUEUED"]);
    expect(tasks.filter((task) => task.action === "qa").map((task) => task.status)).toEqual([
      "PENDING",
      "PENDING",
      "PENDING",
    ]);
    const jobs = await queuedJobs(t.deps);
    for (const task of writes) {
      expect(jobs).toContainEqual(
        expect.objectContaining({
          name: "task.run",
          data: expect.objectContaining({ taskId: task.id }) as unknown,
        }),
      );
    }
    const audits = await db.auditLog.findMany({ where: { action: AUDIT_ACTIONS.planApprove } });
    expect(audits).toEqual([
      expect.objectContaining({ actorId: team.manager.id, entityId: approvedGraph.id }),
    ]);
  });

  it("approves a plan once: a second click is a conflict, not a second set of posts", async () => {
    const { campaign, graph } = await proposed();
    const first = await send("POST", `/v1/task-graphs/${graph.id}/approve`, team.cookies.admin);
    expect(first.statusCode, first.body).toBe(200);
    const second = await send("POST", `/v1/task-graphs/${graph.id}/approve`, team.cookies.admin);
    expect(second.statusCode).toBe(409);
    expect(await testDb().post.count({ where: { campaignId: campaign.id } })).toBe(3);
  });

  it("is for managers and admins: an editor's click spends nothing", async () => {
    const { graph } = await proposed();
    const response = await send("POST", `/v1/task-graphs/${graph.id}/approve`, team.cookies.editor);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "FORBIDDEN", details: { capability: "plan.approve" } },
    });
    expect(await testDb().agentTask.count()).toBe(0);
    expect((await testDb().taskGraph.findUniqueOrThrow({ where: { id: graph.id } })).status).toBe(
      "PROPOSED",
    );
  });

  it("answers 404 for an unknown plan", async () => {
    const response = await send("POST", "/v1/task-graphs/nope/approve", team.cookies.admin);
    expect(response.statusCode).toBe(404);
  });
});

describe("POST /v1/task-graphs/:id/request-changes", () => {
  it("re-plans with the feedback byte-for-byte and adds it to the thread", async () => {
    const { campaign, threadId, graph } = await proposed();
    const feedback = "  Fewer statics —\n\tmore reels, and start on Feb 10.  ";
    const response = await send(
      "POST",
      `/v1/task-graphs/${graph.id}/request-changes`,
      team.cookies.editor,
      { feedback },
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<TaskGraphDto>()).toMatchObject({ id: graph.id, status: "PROPOSED" });

    expect(await queuedJobs(t.deps)).toContainEqual(
      expect.objectContaining({
        name: "manager.plan",
        data: {
          campaignId: campaign.id,
          version: 2,
          changeRequest: feedback,
          previousGraphId: graph.id,
        },
      }),
    );
    const messages = await testDb().chatMessage.findMany({ where: { threadId } });
    expect(messages).toEqual([
      expect.objectContaining({ role: "USER", userId: team.editor.id, content: feedback }),
    ]);
  });

  it("validates the feedback", async () => {
    const { graph } = await proposed();
    const url = `/v1/task-graphs/${graph.id}/request-changes`;
    for (const body of [
      {},
      { feedback: "" },
      { feedback: "  \n\t " },
      { feedback: "x".repeat(4001) },
    ]) {
      const response = await send("POST", url, team.cookies.editor, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    }
    expect(await testDb().chatMessage.count()).toBe(0);
  });

  it("only changes a proposed plan", async () => {
    const { graph } = await proposed();
    await testDb().taskGraph.update({ where: { id: graph.id }, data: { status: "APPROVED" } });
    const response = await send(
      "POST",
      `/v1/task-graphs/${graph.id}/request-changes`,
      team.cookies.editor,
      { feedback: "Too late?" },
    );
    expect(response.statusCode).toBe(409);
    const unknown = await send(
      "POST",
      "/v1/task-graphs/nope/request-changes",
      team.cookies.editor,
      { feedback: "Hello" },
    );
    expect(unknown.statusCode).toBe(404);
  });
});
