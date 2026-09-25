import type { ApprovalChain } from "@enmo/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PUBLISH_CANCEL_REASONS } from "../../src/orchestrator/publishing";
import { buildTestApp, type TestApp } from "../helpers/app";
import { testDb } from "../helpers/db";
import { createClient } from "../helpers/factories";
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
 * final approval of a post queues publisher.schedule for that round, and an edit after approval
 * calls off the post's scheduled PublishJobs, saying why, before approval reopens.
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
