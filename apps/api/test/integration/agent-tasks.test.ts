import { Prisma, type Asset } from "@enmo/db";
import type { AgentTaskDto, AgentTaskListResponse, AssetReview, PostDto } from "@enmo/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app";
import { testDb } from "../helpers/db";
import { createAsset, createAssetVersion, createClient } from "../helpers/factories";
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
    // Only the Visual Director's direct tasks have takes to accept.
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

/* ─── accept_best (Phase 3): the way out of a Visual Director escalation ─────────────────────── */

function review(score: number, attempt: number): AssetReview {
  return {
    verdict: score >= 7 ? "accept" : "regenerate",
    score,
    issues: score >= 7 ? [] : ["The cup is cropped"],
    revisedPrompt: score >= 7 ? null : "Pull back so the whole cup shows",
    attempt,
    reviewedAt: new Date().toISOString(),
  };
}

/**
 * A 1-post write → direct → qa pipeline whose Visual Director gave up in `status`: shot s1 has
 * three weak takes (scores 6, 4, 5; v3 on show), s2 one accepted take. QA waits on direct.
 */
async function stuckDirect(status: "ESCALATED" | "FAILED" = "ESCALATED") {
  const client = await createClient();
  const pipeline = await seedPipeline({
    createdBy: team.manager,
    client,
    postCount: 1,
    postStatus: "VISUALIZING",
  });
  const post = pipeline.posts[0]!;
  const [write, qa] = pipeline.tasks;
  if (!write || !qa) throw new Error("nothing seeded");
  const db = testDb();
  const direct = await db.agentTask.create({
    data: {
      graphId: pipeline.graph.id,
      nodeKey: "n1.d",
      agent: "VISUAL_DIRECTOR",
      action: "direct",
      postId: post.id,
      dependsOn: [write.id],
      status,
      contractAttempts: 1,
      error: "s1 kept rendering weak takes",
    },
  });
  await db.agentTask.update({
    where: { id: qa.id },
    data: {
      dependsOn: [direct.id],
      status: "PENDING",
      queuedAt: null,
      startedAt: null,
      finishedAt: null,
    },
  });
  await db.post.update({
    where: { id: post.id },
    data: { needsAttention: true, attentionReason: "The Visual Director needs a hand" },
  });

  const onPost = {
    client,
    campaignId: pipeline.campaign.id,
    postId: post.id,
    params: { taskId: direct.id },
  };
  const s1v1 = await createAsset({ ...onPost, shotId: "s1", slideIndex: 0, review: review(6, 1) });
  const s1v2 = await createAssetVersion(s1v1, { review: review(4, 2) });
  const s1v3 = await createAssetVersion(s1v2, { review: review(5, 3) });
  const s2 = await createAsset({ ...onPost, shotId: "s2", slideIndex: 1, review: review(8, 1) });
  return { pipeline, post, write, qa, direct, s1: [s1v1, s1v2, s1v3] as const, s2 };
}

async function currentFlags(assets: readonly Asset[]) {
  const rows = await testDb().asset.findMany({ where: { id: { in: assets.map((a) => a.id) } } });
  return Object.fromEntries(
    rows.map((row) => [row.id, { isCurrent: row.isCurrent, status: row.status }]),
  );
}

describe("POST /v1/agent-tasks/:id/resolve accept_best", () => {
  it.each(["ESCALATED", "FAILED"] as const)(
    "keeps each shot's best-scored take of a %s direct task and moves the pipeline on",
    async (status) => {
      const { post, qa, direct, s1, s2 } = await stuckDirect(status);
      const url = `/v1/agent-tasks/${direct.id}/resolve`;

      const byEditor = await send("POST", url, team.cookies.editor, { action: "accept_best" });
      expect(byEditor.statusCode).toBe(403);

      const response = await send("POST", url, team.cookies.manager, { action: "accept_best" });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<AgentTaskDto>()).toMatchObject({
        id: direct.id,
        agent: "VISUAL_DIRECTOR",
        action: "direct",
        status: "SUCCEEDED",
        error: null,
      });

      // s1's best take is its first (6 beats 5 and 4), even though v3 was on show.
      const [s1v1, s1v2, s1v3] = s1;
      expect(await currentFlags([s1v1, s1v2, s1v3, s2])).toEqual({
        [s1v1.id]: { isCurrent: true, status: "READY" },
        [s1v2.id]: { isCurrent: false, status: "READY" },
        [s1v3.id]: { isCurrent: false, status: "READY" },
        [s2.id]: { isCurrent: true, status: "READY" },
      });

      const db = testDb();
      expect(await db.post.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({
        needsAttention: false,
        attentionReason: null,
      });
      expect((await db.agentTask.findUniqueOrThrow({ where: { id: qa.id } })).status).toBe(
        "QUEUED",
      );
      expect(await queuedJobs(t.deps)).toContainEqual(
        expect.objectContaining({
          name: "task.run",
          data: expect.objectContaining({ taskId: qa.id }) as unknown,
        }),
      );

      // The post card now shows the accepted takes.
      const card = await send("GET", `/v1/posts/${post.id}`, team.cookies.editor);
      expect(card.json<PostDto>().currentAssets.map((asset) => asset.id)).toEqual([s1v1.id, s2.id]);

      // Resolved once: a second click conflicts.
      const again = await send("POST", url, team.cookies.admin, { action: "accept_best" });
      expect(again.statusCode).toBe(409);
    },
  );

  it("answers 409 and changes nothing when a shot has no finished take", async () => {
    const { direct, s1, s2 } = await stuckDirect();
    const db = testDb();
    // s1's takes never rendered: v1 failed and v2 is still queued.
    await db.asset.updateMany({
      where: { id: { in: s1.map((take) => take.id) } },
      data: { status: "FAILED", url: null, storageKey: null, isCurrent: false },
    });
    const queued = await createAssetVersion(s1[2], { status: "QUEUED" });
    const before = await currentFlags([...s1, queued, s2]);

    const response = await send(
      "POST",
      `/v1/agent-tasks/${direct.id}/resolve`,
      team.cookies.manager,
      {
        action: "accept_best",
      },
    );
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "CONFLICT" } });
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: direct.id } })).status).toBe(
      "ESCALATED",
    );
    expect(await currentFlags([...s1, queued, s2])).toEqual(before);
  });

  it("answers 409 for a direct task that rendered nothing, or is still working", async () => {
    const { direct, s1, s2 } = await stuckDirect();
    const db = testDb();
    await db.asset.deleteMany({ where: { id: { in: [...s1, s2].map((take) => take.id) } } });
    const url = `/v1/agent-tasks/${direct.id}/resolve`;
    const nothing = await send("POST", url, team.cookies.manager, { action: "accept_best" });
    expect(nothing.statusCode, nothing.body).toBe(409);

    await db.agentTask.update({ where: { id: direct.id }, data: { status: "WAITING" } });
    const working = await send("POST", url, team.cookies.manager, { action: "accept_best" });
    expect(working.statusCode, working.body).toBe(409);
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: direct.id } })).status).toBe(
      "WAITING",
    );
  });
});

/* ─── accept_best on a Vault regenerate: the trial against the take the post shows ─────────────── */

/**
 * A post in revision after a Vault regenerate of s1: v1 is on show (scored `onShow`), and the
 * revision's direct task gave up in `status` with its takes on trial: v2 judged weak (4), v3
 * rendered but never reviewed. qa.r1 waits on the task.
 */
async function stuckTrial(onShow: number, status: "ESCALATED" | "FAILED" = "ESCALATED") {
  const client = await createClient();
  const pipeline = await seedPipeline({
    createdBy: team.manager,
    client,
    postCount: 1,
    postStatus: "CHANGES_REQUESTED",
  });
  const post = pipeline.posts[0]!;
  const db = testDb();
  const direct = await db.agentTask.create({
    data: {
      graphId: pipeline.graph.id,
      nodeKey: "n2.r1",
      agent: "VISUAL_DIRECTOR",
      action: "direct",
      postId: post.id,
      revision: 1,
      status,
      contractAttempts: 1,
      error: "take 3 of s1 couldn't be reviewed",
    },
  });
  const qa = await db.agentTask.create({
    data: {
      graphId: pipeline.graph.id,
      nodeKey: "n3.r1",
      agent: "MANAGER",
      action: "qa",
      postId: post.id,
      revision: 1,
      dependsOn: [direct.id],
    },
  });
  const v1 = await createAsset({
    client,
    campaignId: pipeline.campaign.id,
    postId: post.id,
    review: review(onShow, 1),
  });
  const trial = { taskId: direct.id, origin: "vault" as const, onTrial: true };
  // Rendered (it has a file), then rejected by its review.
  const rendered = await createAssetVersion(v1, {
    isCurrent: false,
    review: review(4, 1),
    params: trial,
  });
  const v2 = await db.asset.update({ where: { id: rendered.id }, data: { status: "REJECTED" } });
  const v3 = await createAssetVersion(v2, {
    isCurrent: false,
    review: null,
    params: { ...trial, origin: "review" },
  });
  return { post, direct, qa, v1, v2, v3 };
}

async function acceptBest(taskId: string) {
  const response = await send("POST", `/v1/agent-tasks/${taskId}/resolve`, team.cookies.manager, {
    action: "accept_best",
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json<AgentTaskDto>().status).toBe("SUCCEEDED");
}

describe("POST /v1/agent-tasks/:id/resolve accept_best on a Vault regenerate", () => {
  it("keeps the take on show when it outscores the trial, and sets the trial's takes aside", async () => {
    const { post, direct, qa, v1, v2, v3 } = await stuckTrial(8);
    await acceptBest(direct.id);

    expect(await currentFlags([v1, v2, v3])).toEqual({
      [v1.id]: { isCurrent: true, status: "READY" },
      [v2.id]: { isCurrent: false, status: "REJECTED" },
      // Nothing would ever review it now: left READY, it would read as still under review.
      [v3.id]: { isCurrent: false, status: "REJECTED" },
    });
    const card = await send("GET", `/v1/posts/${post.id}`, team.cookies.editor);
    expect(card.json<PostDto>().currentAssets.map((asset) => asset.id)).toEqual([v1.id]);
    // QA re-checks the post and opens the next round on v1.
    expect((await testDb().agentTask.findUniqueOrThrow({ where: { id: qa.id } })).status).toBe(
      "QUEUED",
    );
  });

  it("puts the trial's best take up, off trial, when it outscores the take on show", async () => {
    const { direct, v1, v2, v3 } = await stuckTrial(3.5, "FAILED");
    await acceptBest(direct.id);

    expect(await currentFlags([v1, v2, v3])).toEqual({
      [v1.id]: { isCurrent: false, status: "READY" },
      [v2.id]: { isCurrent: true, status: "READY" },
      [v3.id]: { isCurrent: false, status: "REJECTED" },
    });
    const kept = await testDb().asset.findUniqueOrThrow({ where: { id: v2.id } });
    expect(kept.params).not.toHaveProperty("onTrial");
    expect(kept.params).toMatchObject({ taskId: direct.id, origin: "vault" });
  });

  it("keeps the take on show when nothing of the trial rendered", async () => {
    const { direct, v1, v2, v3 } = await stuckTrial(8, "FAILED");
    await testDb().asset.updateMany({
      where: { id: { in: [v2.id, v3.id] } },
      data: { status: "FAILED", url: null, storageKey: null, review: Prisma.DbNull },
    });
    await acceptBest(direct.id);

    expect(await currentFlags([v1, v2, v3])).toEqual({
      [v1.id]: { isCurrent: true, status: "READY" },
      [v2.id]: { isCurrent: false, status: "FAILED" },
      [v3.id]: { isCurrent: false, status: "FAILED" },
    });
  });
});
