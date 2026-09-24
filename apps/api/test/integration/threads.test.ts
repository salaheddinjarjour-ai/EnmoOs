import {
  CHAT_MESSAGE_MAX_LENGTH,
  threadChannel,
  VERBATIM_TEXT_MAX_LENGTH,
  type ChatMessageDto,
  type ClarifyPayload,
  type MessageEventPayload,
  type ThreadMessagesResponse,
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
  seedPlan,
  sender,
  testBrief,
  testPlan,
  type Team,
} from "../helpers/route-fixtures";

/* GET/POST /v1/threads/:id/messages (DESIGN §E "campaigns and chat"). */

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

const CLARIFY: ClarifyPayload = {
  question: "Which platforms, and which dates should the campaign run?",
  missing: ["platforms", "window"],
  draft: {
    clientId: null,
    title: "Ramadan iced line",
    objective: null,
    productFocus: "Iced line",
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
};

/** USER brief → AGENT clarify → USER answer, a second apart. */
async function seedConversation(threadId: string, userId: string) {
  const db = testDb();
  const at = (offsetSec: number) => new Date(Date.now() - 60_000 + offsetSec * 1000);
  const brief = await db.chatMessage.create({
    data: { threadId, role: "USER", kind: "TEXT", userId, content: "12 posts", createdAt: at(0) },
  });
  const clarify = await db.chatMessage.create({
    data: {
      threadId,
      role: "AGENT",
      kind: "CLARIFY",
      agent: "MANAGER",
      content: CLARIFY.question,
      payload: CLARIFY,
      createdAt: at(1),
    },
  });
  const answer = await db.chatMessage.create({
    data: { threadId, role: "USER", kind: "TEXT", userId, content: "IG, Feb", createdAt: at(2) },
  });
  return [brief, clarify, answer] as const;
}

describe("GET /v1/threads/:id/messages", () => {
  it("returns the thread oldest first with typed payloads", async () => {
    const { threadId } = await seedCampaign({ createdBy: team.editor });
    const [brief, clarify, answer] = await seedConversation(threadId, team.editor.id);

    const response = await send("GET", `/v1/threads/${threadId}/messages`, team.cookies.manager);
    expect(response.statusCode, response.body).toBe(200);
    const items = response.json<ThreadMessagesResponse>().items;
    expect(items.map((message) => message.id)).toEqual([brief.id, clarify.id, answer.id]);
    expect(items[0]).toMatchObject({
      role: "USER",
      kind: "TEXT",
      agent: null,
      author: { id: team.editor.id, name: team.editor.name },
      payload: null,
    });
    expect(items[1]).toMatchObject({
      role: "AGENT",
      kind: "CLARIFY",
      agent: "MANAGER",
      author: null,
      payload: CLARIFY,
    });
  });

  it("pages with an exclusive ?after= cursor", async () => {
    const { threadId } = await seedCampaign({ createdBy: team.editor });
    const [brief, clarify, answer] = await seedConversation(threadId, team.editor.id);
    const url = `/v1/threads/${threadId}/messages`;

    const afterBrief = await send("GET", `${url}?after=${brief.id}`, team.cookies.editor);
    expect(afterBrief.json<ThreadMessagesResponse>().items.map((m) => m.id)).toEqual([
      clarify.id,
      answer.id,
    ]);
    const afterLast = await send("GET", `${url}?after=${answer.id}`, team.cookies.editor);
    expect(afterLast.json<ThreadMessagesResponse>().items).toEqual([]);
  });

  it("answers 404 for an unknown thread or a cursor from elsewhere", async () => {
    const mine = await seedCampaign({ createdBy: team.editor });
    const other = await seedCampaign({ createdBy: team.editor });
    const [foreign] = await seedConversation(other.threadId, team.editor.id);

    const unknownThread = await send("GET", "/v1/threads/nope/messages", team.cookies.editor);
    expect(unknownThread.statusCode).toBe(404);
    const unknownCursor = await send(
      "GET",
      `/v1/threads/${mine.threadId}/messages?after=nope`,
      team.cookies.editor,
    );
    expect(unknownCursor.statusCode).toBe(404);
    const foreignCursor = await send(
      "GET",
      `/v1/threads/${mine.threadId}/messages?after=${foreign.id}`,
      team.cookies.editor,
    );
    expect(foreignCursor.statusCode).toBe(404);
  });
});

describe("POST /v1/threads/:id/messages", () => {
  it("stores the answer, emits it and queues the intake while the brief is open", async () => {
    const { campaign, threadId } = await seedCampaign({ createdBy: team.manager });
    const response = await send("POST", `/v1/threads/${threadId}/messages`, team.cookies.editor, {
      content: "Instagram and TikTok, Feb 8 – Mar 9, 2027.",
    });
    expect(response.statusCode, response.body).toBe(201);
    const message = response.json<ChatMessageDto>();
    expect(message).toMatchObject({
      threadId,
      role: "USER",
      kind: "TEXT",
      agent: null,
      author: { id: team.editor.id, name: team.editor.name },
      content: "Instagram and TikTok, Feb 8 – Mar 9, 2027.",
      payload: null,
    });

    expect(await queuedJobs(t.deps)).toContainEqual(
      expect.objectContaining({
        name: "manager.intake",
        data: { campaignId: campaign.id, messageId: message.id },
      }),
    );
    const event = await testDb().realtimeEvent.findFirstOrThrow({
      where: { channel: threadChannel(threadId) },
    });
    expect(event.type).toBe("message.created");
    expect((event.payload as MessageEventPayload).message.id).toBe(message.id);
  });

  it("is just conversation once a plan is on the table", async () => {
    const client = await createClient();
    const { campaign, threadId } = await seedCampaign({
      createdBy: team.manager,
      client,
      brief: testBrief(client),
    });
    await seedPlan({ campaign, plan: testPlan(3) });

    const response = await send("POST", `/v1/threads/${threadId}/messages`, team.cookies.editor, {
      content: "Looks good to me",
    });
    expect(response.statusCode, response.body).toBe(201);
    const jobs = await queuedJobs(t.deps);
    expect(jobs.filter((job) => JSON.stringify(job.data).includes(campaign.id))).toEqual([]);
  });

  it("re-plans with the message when the last planning attempt produced no plan", async () => {
    const client = await createClient();
    const { campaign, threadId } = await seedCampaign({
      createdBy: team.manager,
      client,
      brief: testBrief(client),
    });
    const content = "Make it 3 statics instead";
    const response = await send("POST", `/v1/threads/${threadId}/messages`, team.cookies.editor, {
      content,
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(await queuedJobs(t.deps)).toContainEqual(
      expect.objectContaining({
        name: "manager.plan",
        data: {
          campaignId: campaign.id,
          version: 1,
          changeRequest: content,
          previousGraphId: null,
        },
      }),
    );
  });

  it("passes a re-plan message on byte-for-byte, and refuses one too long before storing it", async () => {
    const client = await createClient();
    const { campaign, threadId } = await seedCampaign({
      createdBy: team.manager,
      client,
      brief: testBrief(client),
    });
    const tooLong = "x".repeat(VERBATIM_TEXT_MAX_LENGTH + 1);
    const refused = await send("POST", `/v1/threads/${threadId}/messages`, team.cookies.editor, {
      content: tooLong,
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json()).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        message: "The change request is too long",
        details: { issues: [{ path: "content" }] },
      },
    });
    expect(await testDb().chatMessage.count()).toBe(0);
    const forCampaign = async () =>
      (await queuedJobs(t.deps)).filter((job) => JSON.stringify(job.data).includes(campaign.id));
    expect(await forCampaign()).toEqual([]);

    const content = "  Make it 3 statics —\n\tand move them a week later.  ";
    const response = await send("POST", `/v1/threads/${threadId}/messages`, team.cookies.editor, {
      content,
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json<ChatMessageDto>().content).toBe(content);
    const [job] = await forCampaign();
    expect(job).toMatchObject({ name: "manager.plan" });
    expect(job?.data).toEqual({
      campaignId: campaign.id,
      version: 1,
      changeRequest: content,
      previousGraphId: null,
    });
  });

  it("trims a brief turn", async () => {
    const { threadId } = await seedCampaign({ createdBy: team.manager });
    const response = await send("POST", `/v1/threads/${threadId}/messages`, team.cookies.editor, {
      content: "  Instagram only, March 1–30 \n",
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json<ChatMessageDto>().content).toBe("Instagram only, March 1–30");
  });

  it("refuses messages on an archived campaign", async () => {
    const { threadId } = await seedCampaign({ createdBy: team.manager, status: "ARCHIVED" });
    const response = await send("POST", `/v1/threads/${threadId}/messages`, team.cookies.editor, {
      content: "Anyone there?",
    });
    expect(response.statusCode).toBe(409);
    expect(await testDb().chatMessage.count()).toBe(0);
  });

  it("validates the content and the thread", async () => {
    const { threadId } = await seedCampaign({ createdBy: team.manager });
    for (const body of [
      {},
      { content: "" },
      { content: " \n " },
      { content: "x".repeat(CHAT_MESSAGE_MAX_LENGTH + 1) },
    ]) {
      const response = await send(
        "POST",
        `/v1/threads/${threadId}/messages`,
        team.cookies.editor,
        body,
      );
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
    const unknown = await send("POST", "/v1/threads/nope/messages", team.cookies.editor, {
      content: "Hello",
    });
    expect(unknown.statusCode).toBe(404);
    expect(await testDb().chatMessage.count()).toBe(0);
  });
});
