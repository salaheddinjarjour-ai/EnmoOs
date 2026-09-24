import type {
  BannedWordsErrorDetails,
  CopyRuleErrorDetails,
  CopywriterOutput,
  Issue,
  PostDto,
  PostListResponse,
} from "@enmo/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BANNED_HITS_REPORTED_MAX } from "../../src/services/posts";
import { buildTestApp, type TestApp } from "../helpers/app";
import { testDb } from "../helpers/db";
import { createClient } from "../helpers/factories";
import {
  createTeam,
  obliterateQueues,
  seedPipeline,
  sender,
  testCopy,
  type Team,
} from "../helpers/route-fixtures";

/* GET /v1/posts, GET /v1/posts/:id, PATCH /v1/posts/:id/copy (DESIGN §E "posts"). */

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

describe("GET /v1/posts", () => {
  it("lists posts in campaign order with their board placement", async () => {
    const client = await createClient();
    const { campaign, posts } = await seedPipeline({ createdBy: team.manager, client });

    const response = await send("GET", `/v1/posts?campaignId=${campaign.id}`, team.cookies.editor);
    expect(response.statusCode, response.body).toBe(200);
    const items = response.json<PostListResponse>().items;
    expect(items.map((post) => post.ref)).toEqual(["p1", "p2", "p3"]);
    expect(items[0]).toMatchObject({
      id: posts[0]?.id,
      campaignId: campaign.id,
      clientId: client.id,
      type: "STATIC",
      status: "PENDING_APPROVAL",
      column: "APPROVAL",
      pill: "PENDING_APPROVAL",
      approved: false,
      failed: false,
      targetDate: "2027-02-10",
      copy: testCopy("Caption for p1"),
      humanEditCount: 0,
      currentApproval: { round: 1, status: "PENDING", currentStep: 0, stepCount: 1 },
    });
  });

  it("filters by client, campaign, status and platform", async () => {
    const qahwa = await createClient({ name: "Qahwa Co" });
    const other = await createClient({ name: "Other Co" });
    const first = await seedPipeline({ createdBy: team.manager, client: qahwa, postCount: 2 });
    const second = await seedPipeline({ createdBy: team.manager, client: other, postCount: 1 });
    const db = testDb();
    await db.post.update({
      where: { id: first.posts[1]?.id },
      data: { status: "APPROVED", platforms: ["FACEBOOK"] },
    });

    const ids = async (query: string) => {
      const response = await send("GET", `/v1/posts?${query}`, team.cookies.editor);
      expect(response.statusCode, response.body).toBe(200);
      return response.json<PostListResponse>().items.map((post) => post.id);
    };
    expect(await ids(`clientId=${other.id}`)).toEqual([second.posts[0]?.id]);
    expect(await ids(`campaignId=${first.campaign.id}&status=APPROVED`)).toEqual([
      first.posts[1]?.id,
    ]);
    expect(await ids("platform=FACEBOOK")).toEqual([first.posts[1]?.id]);
    expect((await ids("platform=TIKTOK")).sort()).toEqual(
      [first.posts[0]?.id, second.posts[0]?.id].sort(),
    );
  });

  it("rejects unknown filter values", async () => {
    for (const query of ["status=DONE", "platform=MYSPACE"]) {
      const response = await send("GET", `/v1/posts?${query}`, team.cookies.editor);
      expect(response.statusCode, query).toBe(400);
    }
  });
});

describe("GET /v1/posts/:id", () => {
  it("says whether the viewer may decide the open round", async () => {
    const client = await createClient();
    const { posts } = await seedPipeline({ createdBy: team.manager, client, postCount: 1 });
    const url = `/v1/posts/${posts[0]?.id}`;

    const asManager = await send("GET", url, team.cookies.manager);
    expect(asManager.statusCode, asManager.body).toBe(200);
    expect(asManager.json<PostDto>().currentApproval).toMatchObject({
      stepName: "Manager review",
      canDecide: true,
    });
    const asEditor = await send("GET", url, team.cookies.editor);
    expect(asEditor.json<PostDto>().currentApproval?.canDecide).toBe(false);
  });

  it("answers 404 for an unknown post", async () => {
    expect((await send("GET", "/v1/posts/nope", team.cookies.editor)).statusCode).toBe(404);
  });
});

describe("PATCH /v1/posts/:id/copy", () => {
  it("saves the edit, counts it and opens a fresh approval round", async () => {
    const client = await createClient();
    const { posts } = await seedPipeline({ createdBy: team.manager, client, postCount: 1 });
    const postId = posts[0]?.id ?? "";
    const copy = testCopy("Slow evenings, cold coffee.");

    const response = await send("PATCH", `/v1/posts/${postId}/copy`, team.cookies.editor, {
      copy,
    });
    expect(response.statusCode, response.body).toBe(200);
    const post = response.json<PostDto>();
    expect(post).toMatchObject({
      copy,
      humanEditCount: 1,
      status: "PENDING_APPROVAL",
      currentApproval: { round: 2, status: "PENDING" },
    });
    const rounds = await testDb().approvalRequest.findMany({
      where: { postId },
      orderBy: { round: "asc" },
    });
    expect(rounds.map((round) => [round.round, round.status])).toEqual([
      [1, "CANCELLED"],
      [2, "PENDING"],
    ]);
    const events = await testDb().realtimeEvent.findMany({ orderBy: { id: "asc" } });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["approval.resolved", "approval.created", "post.updated"]),
    );
  });

  it("reopens approval when an approved post is edited", async () => {
    const client = await createClient();
    const { posts, requests } = await seedPipeline({
      createdBy: team.manager,
      client,
      postCount: 1,
    });
    const postId = posts[0]?.id ?? "";
    const db = testDb();
    await db.approvalRequest.update({
      where: { id: requests[0]?.id },
      data: { status: "APPROVED", resolvedAt: new Date() },
    });
    await db.post.update({
      where: { id: postId },
      data: { status: "APPROVED", approvedAt: new Date() },
    });

    const response = await send("PATCH", `/v1/posts/${postId}/copy`, team.cookies.editor, {
      copy: testCopy("Edited after approval"),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<PostDto>()).toMatchObject({
      status: "PENDING_APPROVAL",
      approved: false,
      approvedAt: null,
      currentApproval: { round: 2, status: "PENDING" },
    });
    expect(
      (await db.approvalRequest.findUniqueOrThrow({ where: { id: requests[0]?.id } })).status,
    ).toBe("CANCELLED");
  });

  it("answers 422 with every banned-word hit and keeps the old copy", async () => {
    const client = await createClient({ bannedWords: ["cheap", "sale"] });
    const { posts } = await seedPipeline({ createdBy: team.manager, client, postCount: 1 });
    const postId = posts[0]?.id ?? "";
    const copy = { ...testCopy("A cheap treat for suhoor"), hashtags: ["#Sale", "#Ramadan"] };

    const response = await send("PATCH", `/v1/posts/${postId}/copy`, team.cookies.editor, {
      copy,
    });
    expect(response.statusCode, response.body).toBe(422);
    const body = response.json<{ error: { code: string; details: BannedWordsErrorDetails } }>();
    expect(body.error.code).toBe("UNPROCESSABLE");
    expect(body.error.details.bannedWords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "caption", term: "cheap", match: "cheap" }),
        expect.objectContaining({ term: "sale" }),
      ]),
    );

    const stored = await testDb().post.findUniqueOrThrow({ where: { id: postId } });
    expect(stored.copy).toEqual(testCopy("Caption for p1"));
    expect(stored.humanEditCount).toBe(0);
  });

  it("validates the copy", async () => {
    const client = await createClient();
    const { posts } = await seedPipeline({ createdBy: team.manager, client, postCount: 1 });
    const url = `/v1/posts/${posts[0]?.id}/copy`;
    const { caption: _caption, ...withoutCaption } = testCopy();
    for (const body of [
      {},
      { copy: withoutCaption },
      { copy: { ...testCopy(), hashtags: "#x" } },
    ]) {
      const response = await send("PATCH", url, team.cookies.editor, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    }
  });

  it("answers 422 with every broken Copywriter rule for the post, and keeps the old copy", async () => {
    const client = await createClient();
    const { posts, requests } = await seedPipeline({
      createdBy: team.manager,
      client,
      postCount: 1,
    });
    const postId = posts[0]?.id ?? "";
    const url = `/v1/posts/${postId}/copy`;
    const good = testCopy("Slow evenings, cold coffee.");
    const [instagram] = good.platformCaptions;
    // The fixture post is a STATIC for Instagram and TikTok.
    const broken: CopywriterOutput = {
      ...good,
      platformCaptions: instagram ? [instagram] : [],
      hashtags: ["#Ramadan", "iced latte"],
      script: {
        totalDurationSec: 6,
        hookTimestampSec: 1,
        hookText: "Wait for it",
        scenes: [
          {
            index: 0,
            startSec: 0,
            durationSec: 6,
            voiceover: "Cold.",
            overlayText: "",
            visualNote: "Glass",
          },
        ],
      },
      onScreenText: null,
    };

    const response = await send("PATCH", url, team.cookies.editor, { copy: broken });
    expect(response.statusCode, response.body).toBe(422);
    const { error } = response.json<{
      error: { code: string; message: string; details: CopyRuleErrorDetails };
    }>();
    expect(error.code).toBe("UNPROCESSABLE");
    expect(error.message).toMatch(/^The copy doesn't fit this STATIC post\. /);
    expect(error.details.issues.map((issue) => issue.path)).toEqual([
      "onScreenText",
      "script",
      "platformCaptions",
      "hashtags[1]",
    ]);
    expect(error.details.issues[2]?.message).toMatch(/Add the TikTok caption/);

    // Nothing was stored and no round moved.
    const stored = await testDb().post.findUniqueOrThrow({ where: { id: postId } });
    expect(stored.copy).toEqual(testCopy("Caption for p1"));
    expect(stored.humanEditCount).toBe(0);
    expect(
      (await testDb().approvalRequest.findUniqueOrThrow({ where: { id: requests[0]?.id } })).status,
    ).toBe("PENDING");
    expect(await testDb().approvalRequest.count({ where: { postId } })).toBe(1);

    // Banned words and broken rules are reported together.
    await testDb().client.update({ where: { id: client.id }, data: { bannedWords: ["cold"] } });
    const both = await send("PATCH", url, team.cookies.editor, { copy: broken });
    expect(both.statusCode).toBe(422);
    const details = both.json<{
      error: { details: BannedWordsErrorDetails & CopyRuleErrorDetails };
    }>().error.details;
    expect(details.bannedWords.map((hit) => hit.path)).toContain("caption");
    expect(details.issues).toHaveLength(4);
  });

  it("bounds the edit: contract limits, field sizes and the body", async () => {
    const client = await createClient({ bannedWords: ["cheap"] });
    const { posts } = await seedPipeline({ createdBy: team.manager, client, postCount: 1 });
    const url = `/v1/posts/${posts[0]?.id}/copy`;
    const copy = testCopy();
    const slide = { index: 0, headline: "One", body: "Slide" };
    for (const [label, edit] of [
      ["caption", { ...copy, caption: "x".repeat(2201) }],
      [
        "platformCaptions.0.caption",
        { ...copy, platformCaptions: [{ platform: "INSTAGRAM", caption: "x".repeat(2201) }] },
      ],
      ["hashtags", { ...copy, hashtags: Array.from({ length: 31 }, (_, i) => `#t${i}`) }],
      ["hashtags.0", { ...copy, hashtags: [`#${"x".repeat(100)}`] }],
      ["altText", { ...copy, altText: "x".repeat(2201) }],
      [
        "slides",
        { ...copy, slides: Array.from({ length: 11 }, (_, index) => ({ ...slide, index })) },
      ],
    ] as const) {
      const response = await send("PATCH", url, team.cookies.editor, { copy: edit });
      expect(response.statusCode, label).toBe(400);
      const body = response.json<{ error: { code: string; details: { issues: Issue[] } } }>();
      expect(body.error.code, label).toBe("VALIDATION_FAILED");
      expect(
        body.error.details.issues.map((issue) => issue.path),
        label,
      ).toContain(`copy.${label}`);
    }

    // Past the body limit nothing is parsed, let alone scanned.
    const huge = await send("PATCH", url, team.cookies.editor, {
      copy: { ...copy, caption: "cheap ".repeat(40_000) },
    });
    expect(huge.statusCode).toBe(413);

    // A caption full of banned words is reported, but only its first hits.
    const flagged = await send("PATCH", url, team.cookies.editor, {
      copy: { ...copy, caption: "cheap ".repeat(300) },
    });
    expect(flagged.statusCode).toBe(422);
    const hits = flagged.json<{ error: { details: BannedWordsErrorDetails } }>().error.details
      .bannedWords;
    expect(hits).toHaveLength(BANNED_HITS_REPORTED_MAX);
    expect(hits[0]).toMatchObject({ path: "caption", index: 0, match: "cheap" });
  });

  it("waits while an agent is working on the post", async () => {
    const client = await createClient();
    const { posts, tasks } = await seedPipeline({ createdBy: team.manager, client, postCount: 1 });
    await testDb().agentTask.update({ where: { id: tasks[0]?.id }, data: { status: "RUNNING" } });
    const response = await send("PATCH", `/v1/posts/${posts[0]?.id}/copy`, team.cookies.editor, {
      copy: testCopy("Mid-flight edit"),
    });
    expect(response.statusCode).toBe(409);
  });

  /** A PATCH that must be refused, leaving the post exactly as it was. */
  async function expectRefusedEdit(postId: string, label: string) {
    const before = await testDb().post.findUniqueOrThrow({ where: { id: postId } });
    const read = await send("GET", `/v1/posts/${postId}`, team.cookies.editor);
    expect(read.json<PostDto>().editable, label).toBe(false);
    const response = await send("PATCH", `/v1/posts/${postId}/copy`, team.cookies.editor, {
      copy: testCopy(`Edited while ${label}`),
    });
    expect(response.statusCode, `${label}: ${response.body}`).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "CONFLICT" } });
    const after = await testDb().post.findUniqueOrThrow({ where: { id: postId } });
    expect(after, label).toMatchObject({
      copy: before.copy,
      humanEditCount: before.humanEditCount,
      status: before.status,
    });
  }

  it("says a post waiting on a human is editable", async () => {
    const client = await createClient();
    const { posts } = await seedPipeline({ createdBy: team.manager, client, postCount: 1 });
    const read = await send("GET", `/v1/posts/${posts[0]?.id}`, team.cookies.editor);
    expect(read.json<PostDto>().editable).toBe(true);
  });

  it("refuses an edit once changes are requested: the Copywriter's revision would overwrite it", async () => {
    const client = await createClient();
    const { posts, requests } = await seedPipeline({
      createdBy: team.manager,
      client,
      postCount: 1,
    });
    const postId = posts[0]?.id ?? "";
    const decision = await send(
      "POST",
      `/v1/approvals/${requests[0]?.id}/decision`,
      team.cookies.manager,
      { decision: "REQUEST_CHANGES", feedback: "Warmer, please.", target: "COPY" },
    );
    expect(decision.statusCode, decision.body).toBe(200);
    await expectRefusedEdit(postId, "changes are requested");

    // However long the revision waits (here: on the budget), the post stays closed to edits.
    await testDb().agentTask.updateMany({
      where: { postId, revision: 1 },
      data: { status: "BLOCKED_BUDGET" },
    });
    await expectRefusedEdit(postId, "the revision waits on the budget");
  });

  it("refuses an edit while any agent work on the post is unfinished", async () => {
    const client = await createClient();
    const { posts, tasks } = await seedPipeline({ createdBy: team.manager, client, postCount: 1 });
    const postId = posts[0]?.id ?? "";
    const [write] = tasks;
    if (!write) throw new Error("seedPipeline: no tasks");
    for (const status of ["PENDING", "QUEUED", "WAITING", "BLOCKED_BUDGET"] as const) {
      await testDb().agentTask.update({ where: { id: write.id }, data: { status } });
      await expectRefusedEdit(postId, `a task is ${status}`);
    }
    // Finished work, however it ended, doesn't hold the post.
    for (const status of ["SUCCEEDED", "ESCALATED", "FAILED", "CANCELLED"] as const) {
      await testDb().agentTask.update({ where: { id: write.id }, data: { status } });
      const read = await send("GET", `/v1/posts/${postId}`, team.cookies.editor);
      expect(read.json<PostDto>().editable, status).toBe(true);
    }
  });

  it("refuses an edit before the post reaches approval, even when its agent gave up", async () => {
    const client = await createClient();
    for (const postStatus of ["IDEA", "DRAFTING", "QA", "CHANGES_REQUESTED"] as const) {
      const { posts, tasks } = await seedPipeline({
        createdBy: team.manager,
        client,
        postCount: 1,
        postStatus,
      });
      // The Copywriter escalated: nothing is queued, but the post never passed QA.
      await testDb().agentTask.update({
        where: { id: tasks[0]?.id },
        data: { status: "ESCALATED" },
      });
      await expectRefusedEdit(posts[0]?.id ?? "", postStatus);
    }
    const { posts } = await seedPipeline({ createdBy: team.manager, client, postCount: 1 });
    await testDb().post.update({ where: { id: posts[0]?.id }, data: { status: "LIVE" } });
    await expectRefusedEdit(posts[0]?.id ?? "", "LIVE");
  });

  it("answers 404 for an unknown post", async () => {
    const response = await send("PATCH", "/v1/posts/nope/copy", team.cookies.editor, {
      copy: testCopy(),
    });
    expect(response.statusCode).toBe(404);
  });
});
