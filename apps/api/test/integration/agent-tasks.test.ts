import type { AgentTaskDto, AgentTaskListResponse } from "@enmo/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app";
import { testDb } from "../helpers/db";
import { createClient } from "../helpers/factories";
import {
  createTeam,
  obliterateQueues,
  queuedJobs,
  seedCampaign,
  seedPipeline,
  sender,
  type Team,
} from "../helpers/route-fixtures";

/* GET /v1/campaigns/:id/tasks and POST /v1/agent-tasks/:id/resolve (DESIGN §D, §E). */

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

/** A 2-post pipeline whose p1 draft escalated. */
async function escalated() {
  const client = await createClient();
  const pipeline = await seedPipeline({ createdBy: team.manager, client, postCount: 2 });
  const [write] = pipeline.tasks;
  const post = pipeline.posts[0];
  if (!write || !post) throw new Error("nothing seeded");
  const db = testDb();
  await db.agentTask.update({
    where: { id: write.id },
    data: { status: "ESCALATED", contractAttempts: 3, error: "caption: too long" },
  });
  await db.post.update({
    where: { id: post.id },
    data: { status: "DRAFTING", needsAttention: true, attentionReason: "Copywriter escalated" },
  });
  return { ...pipeline, write, post };
}

describe("GET /v1/campaigns/:id/tasks", () => {
  it("lists every task in plan order, revisions after their node", async () => {
    const client = await createClient();
    const { campaign, graph, posts, tasks } = await seedPipeline({
      createdBy: team.manager,
      client,
      postCount: 2,
    });
    const feedback = { verbatim: " Warmer, please ", source: "HUMAN", decisionId: null };
    const revision = await testDb().agentTask.create({
      data: {
        graphId: graph.id,
        nodeKey: "n1.r1",
        agent: "COPYWRITER",
        action: "write",
        postId: posts[0]?.id,
        revision: 1,
        feedback,
      },
    });

    const response = await send("GET", `/v1/campaigns/${campaign.id}/tasks`, team.cookies.editor);
    expect(response.statusCode, response.body).toBe(200);
    const items = response.json<AgentTaskListResponse>().items;
    expect(items.map((task) => task.nodeKey)).toEqual(["n1", "n1.r1", "n2", "n3", "n4"]);
    expect(items[0]).toMatchObject({
      id: tasks[0]?.id,
      graphId: graph.id,
      agent: "COPYWRITER",
      action: "write",
      postId: posts[0]?.id,
      postRef: "p1",
      dependsOn: [],
      status: "SUCCEEDED",
      revision: 0,
      feedback: null,
    });
    expect(items[1]).toMatchObject({ id: revision.id, revision: 1, status: "PENDING", feedback });
    expect(items[2]).toMatchObject({ agent: "MANAGER", action: "qa", dependsOn: [tasks[0]?.id] });
  });

  it("is empty before a plan is approved, and 404 for an unknown campaign", async () => {
    const { campaign } = await seedCampaign({ createdBy: team.editor });
    const empty = await send("GET", `/v1/campaigns/${campaign.id}/tasks`, team.cookies.editor);
    expect(empty.json<AgentTaskListResponse>().items).toEqual([]);
    expect((await send("GET", "/v1/campaigns/nope/tasks", team.cookies.editor)).statusCode).toBe(
      404,
    );
  });
});

describe("POST /v1/agent-tasks/:id/resolve", () => {
  it("retries an escalated task with fresh attempts and clears the post's alert", async () => {
    const { write, post } = await escalated();
    const response = await send(
      "POST",
      `/v1/agent-tasks/${write.id}/resolve`,
      team.cookies.manager,
      { action: "retry" },
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<AgentTaskDto>()).toMatchObject({
      id: write.id,
      status: "QUEUED",
      contractAttempts: 0,
      error: null,
      finishedAt: null,
    });
    const stored = await testDb().post.findUniqueOrThrow({ where: { id: post.id } });
    expect(stored).toMatchObject({ needsAttention: false, attentionReason: null });
    expect(await queuedJobs(t.deps)).toContainEqual(
      expect.objectContaining({
        name: "task.run",
        data: expect.objectContaining({
          taskId: write.id,
          requeue: expect.any(String) as string,
        }) as unknown,
      }),
    );
  });

  it("keeps the post flagged while another of its tasks is still stuck", async () => {
    const { write, post, tasks } = await escalated();
    const qa = tasks.find((task) => task.postId === post.id && task.action === "qa");
    await testDb().agentTask.update({ where: { id: qa?.id }, data: { status: "FAILED" } });
    const response = await send("POST", `/v1/agent-tasks/${write.id}/resolve`, team.cookies.admin, {
      action: "retry",
    });
    expect(response.statusCode, response.body).toBe(200);
    const stored = await testDb().post.findUniqueOrThrow({ where: { id: post.id } });
    expect(stored.needsAttention).toBe(true);
  });

  it("only resolves escalated or failed tasks", async () => {
    const { write, tasks } = await escalated();
    const succeeded = tasks.find((task) => task.id !== write.id);
    const notStuck = await send(
      "POST",
      `/v1/agent-tasks/${succeeded?.id}/resolve`,
      team.cookies.manager,
      { action: "retry" },
    );
    expect(notStuck.statusCode).toBe(409);
    // Takes to accept only exist once the Visual Director renders (Phase 3).
    const acceptBest = await send(
      "POST",
      `/v1/agent-tasks/${write.id}/resolve`,
      team.cookies.manager,
      { action: "accept_best" },
    );
    expect(acceptBest.statusCode).toBe(409);
    expect((await testDb().agentTask.findUniqueOrThrow({ where: { id: write.id } })).status).toBe(
      "ESCALATED",
    );
  });

  it("refuses tasks of an archived campaign", async () => {
    const { campaign, write } = await escalated();
    await testDb().campaign.update({ where: { id: campaign.id }, data: { status: "ARCHIVED" } });
    const response = await send("POST", `/v1/agent-tasks/${write.id}/resolve`, team.cookies.admin, {
      action: "retry",
    });
    expect(response.statusCode).toBe(409);
  });

  it("is for managers and admins, with a known action", async () => {
    const { write } = await escalated();
    const url = `/v1/agent-tasks/${write.id}/resolve`;
    const byEditor = await send("POST", url, team.cookies.editor, { action: "retry" });
    expect(byEditor.statusCode).toBe(403);
    expect(byEditor.json()).toMatchObject({
      error: { code: "FORBIDDEN", details: { capability: "tasks.resolveEscalation" } },
    });
    for (const body of [{}, { action: "ignore" }]) {
      expect((await send("POST", url, team.cookies.manager, body)).statusCode).toBe(400);
    }
    const unknown = await send("POST", "/v1/agent-tasks/nope/resolve", team.cookies.manager, {
      action: "retry",
    });
    expect(unknown.statusCode).toBe(404);
    expect((await testDb().agentTask.findUniqueOrThrow({ where: { id: write.id } })).status).toBe(
      "ESCALATED",
    );
  });
});
