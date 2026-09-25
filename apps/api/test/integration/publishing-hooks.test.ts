import type { ApprovalChain } from "@enmo/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PUBLISH_CANCEL_REASONS } from "../../src/orchestrator/publishing";
import { buildTestApp, type TestApp } from "../helpers/app";
import { testDb } from "../helpers/db";
import { createClient } from "../helpers/factories";
import { seedPublishPost } from "../helpers/publish-fixtures";
import {
  createTeam,
  obliterateQueues,
  queuedJobs,
  seedPipeline,
  sender,
  testCopy,
  type Team,
} from "../helpers/route-fixtures";

/*
 * Where approvals meet publishing (orchestrator/publishing.ts, DESIGN §F "Publishing safety"): the
 * final approval of a post queues publisher.schedule for that round, an edit after approval calls
 * off the post's scheduled PublishJobs, saying why, before approval reopens, and archiving a
 * campaign or a client calls off everything of it still waiting to go out.
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
  await obliterateQueues(t.deps);
  team = await createTeam();
});

const scheduleJobs = async () =>
  (await queuedJobs(t.deps)).filter((job) => job.name === "publisher.schedule");

function twoStepChain(): ApprovalChain {
  return {
    steps: [
      { name: "Editor pass", approverRoles: ["MANAGER"], approverUserIds: [], minApprovals: 1 },
      { name: "Admin sign-off", approverRoles: ["ADMIN"], approverUserIds: [], minApprovals: 1 },
    ],
  };
}

describe("a post's final approval", () => {
  it("hands the post to the Publisher once the chain's last step approves it", async () => {
    const client = await createClient({ approvalChain: twoStepChain() });
    const { posts, requests } = await seedPipeline({
      createdBy: team.manager,
      client,
      postCount: 1,
    });
    const url = `/v1/approvals/${requests[0]?.id}/decision`;

    const first = await send("POST", url, team.cookies.manager, { decision: "APPROVE" });
    expect(first.statusCode, first.body).toBe(200);
    expect(await scheduleJobs()).toEqual([]);

    const last = await send("POST", url, team.cookies.admin, { decision: "APPROVE" });
    expect(last.statusCode, last.body).toBe(200);
    expect(await scheduleJobs()).toEqual([
      {
        id: `schedule-${posts[0]?.id}-r1`,
        name: "publisher.schedule",
        data: { postId: posts[0]?.id, round: 1 },
      },
    ]);
  });

  it("hands every post approve-all approves to the Publisher, and none it leaves pending", async () => {
    const client = await createClient();
    const { posts, requests } = await seedPipeline({
      createdBy: team.manager,
      client,
      postCount: 2,
    });
    const response = await send("POST", "/v1/approvals/approve-all", team.cookies.manager, {
      requestIds: requests.map((request) => request.id),
    });
    expect(response.statusCode, response.body).toBe(200);

    const scheduled = (await scheduleJobs()).map((job) => job.data);
    expect(scheduled).toHaveLength(posts.length);
    expect(scheduled).toEqual(
      expect.arrayContaining(posts.map((post) => ({ postId: post.id, round: 1 }))),
    );
  });

  it("clears the flag a publish-time refusal left on the post it reopened", async () => {
    const client = await createClient();
    const { posts, requests } = await seedPipeline({
      createdBy: team.manager,
      client,
      postCount: 1,
    });
    const postId = posts[0]?.id ?? "";
    const reason = "The post's content changed after it was approved";
    await testDb().post.update({
      where: { id: postId },
      data: { needsAttention: true, attentionReason: reason },
    });

    const response = await send(
      "POST",
      `/v1/approvals/${requests[0]?.id}/decision`,
      team.cookies.manager,
      { decision: "APPROVE" },
    );
    expect(response.statusCode, response.body).toBe(200);
    // Still flagged, tick.publish would never re-drive a publisher.schedule lost for it.
    expect(await testDb().post.findUniqueOrThrow({ where: { id: postId } })).toMatchObject({
      status: "APPROVED",
      needsAttention: false,
      attentionReason: null,
    });
    const [event] = await testDb().realtimeEvent.findMany({ where: { type: "post.updated" } });
    expect(event?.payload).toMatchObject({ postId, status: "APPROVED", needsAttention: false });
  });

  it("starts nothing when changes are requested", async () => {
    const client = await createClient();
    const { requests } = await seedPipeline({ createdBy: team.manager, client, postCount: 1 });
    const response = await send(
      "POST",
      `/v1/approvals/${requests[0]?.id}/decision`,
      team.cookies.manager,
      { decision: "REQUEST_CHANGES", feedback: "Shorter hook.", target: "COPY" },
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(await scheduleJobs()).toEqual([]);
  });
});

describe("an edit after approval", () => {
  it("cancels the post's scheduled publish jobs with the reason and announces each", async () => {
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
      data: { status: "SCHEDULED", approvedAt: new Date() },
    });
    const scheduledFor = new Date(Date.now() + 86_400_000);
    const jobFor = async (platform: "INSTAGRAM" | "TIKTOK", status: "SCHEDULED" | "PUBLISHED") => {
      const variant = await db.postVariant.create({
        data: {
          postId,
          platform,
          format: "VERTICAL_9_16",
          caption: "Caption for p1",
          hashtags: ["#Ramadan"],
        },
      });
      return db.publishJob.create({
        data: {
          variantId: variant.id,
          platform,
          status,
          scheduledFor,
          slotSource: "optimizer",
          dryRun: true,
        },
      });
    };
    const scheduled = await jobFor("INSTAGRAM", "SCHEDULED");
    const published = await jobFor("TIKTOK", "PUBLISHED");

    const response = await send("PATCH", `/v1/posts/${postId}/copy`, team.cookies.editor, {
      copy: testCopy("Edited after approval"),
    });
    expect(response.statusCode, response.body).toBe(200);

    expect(await db.publishJob.findUniqueOrThrow({ where: { id: scheduled.id } })).toMatchObject({
      status: "CANCELLED",
      lastError: PUBLISH_CANCEL_REASONS.copyEdited,
    });
    // Out in the world already: nothing to call off.
    expect((await db.publishJob.findUniqueOrThrow({ where: { id: published.id } })).status).toBe(
      "PUBLISHED",
    );
    const announced = await db.realtimeEvent.findMany({ where: { type: "publish.updated" } });
    expect(announced.map((event) => event.payload)).toEqual([
      {
        jobId: scheduled.id,
        variantId: scheduled.variantId,
        postId,
        platform: "INSTAGRAM",
        status: "CANCELLED",
        scheduledFor: scheduledFor.toISOString(),
        liveUrl: null,
      },
    ]);
  });
});

describe("archiving", () => {
  const TUESDAY_1100 = new Date(Date.now() + 2 * 86_400_000).toISOString();

  it("calls off a campaign's waiting publish jobs; its posts are approved again", async () => {
    const client = await createClient();
    const seeded = await seedPublishPost({
      createdBy: team.admin,
      client,
      jobs: [
        { platform: "INSTAGRAM", scheduledFor: TUESDAY_1100 },
        { platform: "FACEBOOK", status: "QUEUED", scheduledFor: new Date() },
      ],
    });
    const other = await seedPublishPost({
      createdBy: team.admin,
      client,
      jobs: [{ platform: "INSTAGRAM", scheduledFor: TUESDAY_1100 }],
    });

    const response = await send(
      "POST",
      `/v1/campaigns/${seeded.campaignId}/archive`,
      team.cookies.admin,
    );
    expect(response.statusCode, response.body).toBe(200);
    const db = testDb();
    for (const job of Object.values(seeded.jobs)) {
      expect(await db.publishJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
        status: "CANCELLED",
        lastError: PUBLISH_CANCEL_REASONS.campaignArchived,
      });
    }
    expect((await db.post.findUniqueOrThrow({ where: { id: seeded.post.id } })).status).toBe(
      "APPROVED",
    );
    // Another campaign of the client goes on as planned.
    expect(
      (await db.publishJob.findUniqueOrThrow({ where: { id: other.jobs.INSTAGRAM!.id } })).status,
    ).toBe("SCHEDULED");
    const announced = await db.realtimeEvent.findMany({ where: { type: "publish.updated" } });
    expect(announced.map((event) => event.payload)).toEqual(
      expect.arrayContaining(
        Object.values(seeded.jobs).map((job) =>
          expect.objectContaining({ jobId: job.id, status: "CANCELLED" }),
        ),
      ),
    );
  });

  it("calls off every waiting publish job of an archived client, leaving what is out", async () => {
    const client = await createClient();
    const first = await seedPublishPost({
      createdBy: team.admin,
      client,
      status: "PUBLISHING",
      jobs: [
        { platform: "INSTAGRAM", scheduledFor: TUESDAY_1100 },
        {
          platform: "FACEBOOK",
          status: "PUBLISHED",
          scheduledFor: new Date(),
          publishedAt: new Date(),
          liveUrl: "https://dryrun.enmo.marketing/facebook/v1",
        },
      ],
    });
    const second = await seedPublishPost({
      createdBy: team.admin,
      client,
      jobs: [{ platform: "INSTAGRAM", scheduledFor: TUESDAY_1100 }],
    });

    const response = await send("POST", `/v1/clients/${client.id}/archive`, team.cookies.admin);
    expect(response.statusCode, response.body).toBe(200);
    const db = testDb();
    for (const job of [first.jobs.INSTAGRAM!, second.jobs.INSTAGRAM!]) {
      expect(await db.publishJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
        status: "CANCELLED",
        lastError: PUBLISH_CANCEL_REASONS.clientArchived,
      });
    }
    expect(
      (await db.publishJob.findUniqueOrThrow({ where: { id: first.jobs.FACEBOOK!.id } })).status,
    ).toBe("PUBLISHED");
    // What is out stays out: the post is LIVE on the rest.
    expect((await db.post.findUniqueOrThrow({ where: { id: first.post.id } })).status).toBe("LIVE");
    expect((await db.post.findUniqueOrThrow({ where: { id: second.post.id } })).status).toBe(
      "APPROVED",
    );
  });
});
