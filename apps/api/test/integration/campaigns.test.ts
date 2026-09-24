import {
  CHAT_MESSAGE_MAX_LENGTH,
  threadChannel,
  type CampaignDto,
  type CampaignListResponse,
  type PostListResponse,
} from "@enmo/shared";
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
  seedPlan,
  sender,
  testBrief,
  testCopy,
  testPlan,
  type Team,
} from "../helpers/route-fixtures";

/* GET/POST /v1/campaigns, GET /v1/campaigns/:id, POST /v1/campaigns/:id/archive (DESIGN §E). */

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

describe("POST /v1/campaigns", () => {
  it("opens the campaign, its thread and first message, and queues the intake", async () => {
    const brief = "Ramadan campaign for the coffee client — 12 posts, push the iced line";
    const response = await send("POST", "/v1/campaigns", team.cookies.editor, {
      message: brief,
    });
    expect(response.statusCode, response.body).toBe(201);
    const campaign = response.json<CampaignDto>();
    expect(campaign).toMatchObject({
      client: null,
      name: brief,
      status: "BRIEFING",
      brief: null,
      clarifyCount: 0,
      briefLockedAt: null,
      createdById: team.editor.id,
      latestGraph: null,
    });

    const messages = await testDb().chatMessage.findMany({
      where: { threadId: campaign.threadId },
    });
    expect(messages).toEqual([
      expect.objectContaining({
        role: "USER",
        kind: "TEXT",
        userId: team.editor.id,
        content: brief,
      }),
    ]);
    expect(await queuedJobs(t.deps)).toContainEqual(
      expect.objectContaining({
        name: "manager.intake",
        data: { campaignId: campaign.id, messageId: messages[0]?.id },
      }),
    );
    const events = await testDb().realtimeEvent.findMany({
      where: { channel: threadChannel(campaign.threadId) },
    });
    expect(events.map((event) => event.type)).toEqual(["message.created"]);
  });

  it("attaches the client the page picked", async () => {
    const client = await createClient({ name: "Qahwa Co" });
    const response = await send("POST", "/v1/campaigns", team.cookies.manager, {
      clientId: client.id,
      message: "Eid teaser, 3 posts",
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json<CampaignDto>().client).toEqual({ id: client.id, name: "Qahwa Co" });
  });

  it("refuses an unknown or archived client without creating anything", async () => {
    const archived = await createClient({ archivedAt: new Date() });
    for (const clientId of ["no-such-client", archived.id]) {
      const response = await send("POST", "/v1/campaigns", team.cookies.admin, {
        clientId,
        message: "A brief",
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    }
    expect(await testDb().campaign.count()).toBe(0);
  });

  it("validates the message", async () => {
    const bodies = [
      {},
      { message: "" },
      { message: "   " },
      { message: "x".repeat(CHAT_MESSAGE_MAX_LENGTH + 1) },
      { message: 42 },
    ];
    for (const body of bodies) {
      const response = await send("POST", "/v1/campaigns", team.cookies.editor, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    }
    expect(await testDb().campaign.count()).toBe(0);
  });

  it("needs a session and an allowed Origin", async () => {
    expect((await send("POST", "/v1/campaigns", undefined, { message: "Hi" })).statusCode).toBe(
      401,
    );
    const noOrigin = await t.app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: { cookie: team.cookies.admin },
      payload: { message: "Hi" },
    });
    expect(noOrigin.statusCode).toBe(403);
    expect(await testDb().campaign.count()).toBe(0);
  });
});

describe("GET /v1/campaigns", () => {
  it("lists newest first with filters by client and status", async () => {
    const client = await createClient();
    const older = await seedCampaign({
      createdBy: team.manager,
      name: "Older",
      createdAt: new Date(Date.now() - 60_000),
    });
    const newer = await seedCampaign({
      createdBy: team.manager,
      client,
      brief: testBrief(client),
      name: "Newer",
    });
    const plan = await seedPlan({ campaign: newer.campaign, plan: testPlan(3) });

    const all = await send("GET", "/v1/campaigns", team.cookies.editor);
    expect(all.statusCode, all.body).toBe(200);
    const items = all.json<CampaignListResponse>().items;
    expect(items.map((item) => item.name)).toEqual(["Newer", "Older"]);
    expect(items[0]).toMatchObject({
      client: { id: client.id },
      status: "PLANNING",
      clarifyCount: 1,
      threadId: newer.threadId,
      latestGraph: { id: plan.id, version: 1, status: "PROPOSED" },
      brief: { clientId: client.id, postCount: 3 },
    });
    expect(items[1]).toMatchObject({ threadId: older.threadId, latestGraph: null });

    const byClient = await send("GET", `/v1/campaigns?clientId=${client.id}`, team.cookies.editor);
    expect(byClient.json<CampaignListResponse>().items.map((item) => item.name)).toEqual(["Newer"]);
    const byStatus = await send("GET", "/v1/campaigns?status=BRIEFING", team.cookies.editor);
    expect(byStatus.json<CampaignListResponse>().items.map((item) => item.name)).toEqual(["Older"]);
  });

  it("rejects an unknown status filter", async () => {
    const response = await send("GET", "/v1/campaigns?status=DONE", team.cookies.editor);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  });
});

describe("GET /v1/campaigns/:id", () => {
  it("returns the campaign", async () => {
    const { campaign, threadId } = await seedCampaign({ createdBy: team.admin });
    const response = await send("GET", `/v1/campaigns/${campaign.id}`, team.cookies.editor);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<CampaignDto>()).toMatchObject({ id: campaign.id, threadId });
  });

  it("answers 404 for an unknown campaign", async () => {
    const response = await send("GET", "/v1/campaigns/nope", team.cookies.editor);
    expect(response.statusCode).toBe(404);
  });
});

describe("POST /v1/campaigns/:id/archive", () => {
  it("archives the campaign and stops everything still pending in it", async () => {
    const client = await createClient();
    const pipeline = await seedPipeline({ createdBy: team.manager, client });
    const db = testDb();
    const [firstTask] = pipeline.tasks;
    if (!firstTask) throw new Error("no tasks seeded");
    await db.agentTask.update({ where: { id: firstTask.id }, data: { status: "PENDING" } });
    const replan = await seedPlan({ campaign: pipeline.campaign, plan: testPlan(3), version: 2 });

    const response = await send(
      "POST",
      `/v1/campaigns/${pipeline.campaign.id}/archive`,
      team.cookies.manager,
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<CampaignDto>().status).toBe("ARCHIVED");

    expect((await db.agentTask.findUniqueOrThrow({ where: { id: firstTask.id } })).status).toBe(
      "CANCELLED",
    );
    expect((await db.taskGraph.findUniqueOrThrow({ where: { id: replan.id } })).status).toBe(
      "REJECTED",
    );
    const rounds = await db.approvalRequest.findMany({
      where: { post: { campaignId: pipeline.campaign.id } },
    });
    expect(rounds.map((round) => round.status)).toEqual(rounds.map(() => "CANCELLED"));

    const again = await send(
      "POST",
      `/v1/campaigns/${pipeline.campaign.id}/archive`,
      team.cookies.admin,
    );
    expect(again.statusCode).toBe(200);
    expect(again.json<CampaignDto>().status).toBe("ARCHIVED");
  });

  it("takes the campaign's posts off the pipeline, but keeps them readable in its thread", async () => {
    const client = await createClient();
    const archived = await seedPipeline({ createdBy: team.manager, client, postCount: 2 });
    const live = await seedPipeline({ createdBy: team.manager, client, postCount: 1 });
    const db = testDb();
    // One of the archived campaign's posts is still being drafted.
    await db.post.update({
      where: { id: archived.posts[1]?.id },
      data: { status: "DRAFTING" },
    });

    const response = await send(
      "POST",
      `/v1/campaigns/${archived.campaign.id}/archive`,
      team.cookies.manager,
    );
    expect(response.statusCode, response.body).toBe(200);

    const list = async (query: string) => {
      const listed = await send("GET", `/v1/posts${query}`, team.cookies.editor);
      expect(listed.statusCode, listed.body).toBe(200);
      return listed.json<PostListResponse>().items;
    };
    const liveIds = live.posts.map((post) => post.id);
    expect((await list(`?clientId=${client.id}`)).map((post) => post.id)).toEqual(liveIds);
    expect((await list("")).map((post) => post.id)).toEqual(liveIds);
    expect((await list("?status=PENDING_APPROVAL")).map((post) => post.id)).toEqual(liveIds);

    // Its own thread still shows what it made, with nothing left to decide or edit.
    const own = await list(`?campaignId=${archived.campaign.id}`);
    expect(own.map((post) => [post.ref, post.status])).toEqual([
      ["p1", "PENDING_APPROVAL"],
      ["p2", "DRAFTING"],
    ]);
    for (const post of own) {
      expect(post.editable, post.ref).toBe(false);
      expect(post.currentApproval?.canDecide ?? false, post.ref).toBe(false);
    }
    const edit = await send("PATCH", `/v1/posts/${own[0]?.id}/copy`, team.cookies.editor, {
      copy: testCopy("Too late"),
    });
    expect(edit.statusCode, edit.body).toBe(409);
    expect(edit.json()).toMatchObject({ error: { message: "The campaign is archived" } });

    // Open boards hear about every one of its posts, so they drop the cards.
    const updated = await db.realtimeEvent.findMany({ where: { type: "post.updated" } });
    expect(updated.map((event) => (event.payload as { postId: string }).postId).sort()).toEqual(
      archived.posts.map((post) => post.id).sort(),
    );
  });

  it("is for managers and admins only", async () => {
    const { campaign } = await seedCampaign({ createdBy: team.editor });
    const response = await send(
      "POST",
      `/v1/campaigns/${campaign.id}/archive`,
      team.cookies.editor,
    );
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "FORBIDDEN", details: { capability: "campaigns.archive" } },
    });
    expect((await testDb().campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe(
      "BRIEFING",
    );
  });

  it("answers 404 for an unknown campaign", async () => {
    const response = await send("POST", "/v1/campaigns/nope/archive", team.cookies.admin);
    expect(response.statusCode).toBe(404);
  });
});
