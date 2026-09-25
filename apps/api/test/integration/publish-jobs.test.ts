import type { Client } from "@enmo/db";
import { AUDIT_ACTIONS, type PublishJobDto } from "@enmo/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HOUR_MS } from "../../src/lib/clock";
import { bestSlotOn } from "../../src/publishing/slot-optimizer";
import { buildTestApp, type TestApp } from "../helpers/app";
import { sessionCookieFor, type CookieHeader } from "../helpers/auth";
import { testDb } from "../helpers/db";
import { createClient, createUser, type TestUser } from "../helpers/factories";
import { RIYADH, seedPublishPost } from "../helpers/publish-fixtures";
import { obliterateQueues, queuedJobs, sender } from "../helpers/route-fixtures";

/*
 * The publish-job controls behind the calendar (DESIGN §E "calendar"): a drag moves a SCHEDULED
 * job to the best free hour of the new client-local day (the slot optimizer's bestSlotOn, no LLM),
 * a FAILED job is retried (QUEUED with a publish.run for its next attempt), a job that hasn't
 * started publishing, or that failed, is cancelled. Each is MANAGER+, audited, and announced with
 * publish.updated, and the post's status follows its jobs.
 */

/** Monday 1 March 2027, 09:00 in Riyadh. */
const NOW = "2027-03-01T06:00:00.000Z";
/** Tuesday 2 March, 11:00 in Riyadh: Instagram's first peak hour. */
const TUESDAY_1100 = "2027-03-02T08:00:00.000Z";
const WEDNESDAY = "2027-03-03";

let t: TestApp;
let admin: TestUser;
let manager: TestUser;
let cookies: Record<"admin" | "manager" | "editor", CookieHeader>;
let client: Client;
const send = sender(() => t.app);

beforeAll(async () => {
  t = await buildTestApp();
});

afterAll(async () => {
  await obliterateQueues(t.deps);
  await t.close();
});

beforeEach(async () => {
  t.clock.set(NOW);
  await obliterateQueues(t.deps);
  admin = await createUser({ role: "ADMIN" });
  manager = await createUser({ role: "MANAGER", name: "Maha" });
  const editor = await createUser({ role: "EDITOR" });
  const now = t.clock.now();
  cookies = {
    admin: await sessionCookieFor(admin, { now }),
    manager: await sessionCookieFor(manager, { now }),
    editor: await sessionCookieFor(editor, { now }),
  };
  client = await createClient({ name: "Qahwa Co", timezone: RIYADH });
});

async function publishEvents(jobId: string) {
  const rows = await testDb().realtimeEvent.findMany({
    where: { type: "publish.updated" },
    orderBy: { id: "asc" },
  });
  return rows
    .map((row) => row.payload)
    .filter((payload) => {
      return (payload as { jobId?: string }).jobId === jobId;
    });
}

async function auditOf(action: string) {
  return testDb().auditLog.findMany({ where: { action } });
}

describe("PATCH /v1/publish-jobs/:id (reschedule)", () => {
  it("moves a scheduled job to the best free hour of the dropped day", async () => {
    const { jobs, post } = await seedPublishPost({
      createdBy: admin,
      client,
      jobs: [{ platform: "INSTAGRAM", scheduledFor: TUESDAY_1100 }],
    });
    const job = jobs.INSTAGRAM!;
    const expected = await bestSlotOn(
      testDb(),
      {
        clientId: client.id,
        platform: "INSTAGRAM",
        timezone: RIYADH,
        now: t.clock.now(),
        excludeJobId: job.id,
      },
      WEDNESDAY,
    );
    // Instagram's first weekday peak, 11:00 in Riyadh.
    expect(expected?.slotStart).toBe("2027-03-03T08:00:00.000Z");

    const response = await send("PATCH", `/v1/publish-jobs/${job.id}`, cookies.manager, {
      date: WEDNESDAY,
    });
    expect(response.statusCode, response.body).toBe(200);
    const moved = response.json<PublishJobDto>();
    expect(moved).toMatchObject({
      id: job.id,
      postId: post.id,
      clientId: client.id,
      status: "SCHEDULED",
      scheduledFor: expected?.slotStart,
      date: WEDNESDAY,
      timezone: RIYADH,
      slotSource: "manual",
    });
    expect(moved.slotReason).toContain(`Moved to ${WEDNESDAY} by Maha`);

    const [audit] = await auditOf(AUDIT_ACTIONS.publishReschedule);
    expect(audit).toMatchObject({
      actorId: manager.id,
      entityType: "PublishJob",
      entityId: job.id,
      data: {
        postId: post.id,
        platform: "INSTAGRAM",
        date: WEDNESDAY,
        from: TUESDAY_1100,
        to: expected?.slotStart,
      },
    });
    expect(await publishEvents(job.id)).toEqual([
      expect.objectContaining({ status: "SCHEDULED", scheduledFor: expected?.slotStart }),
    ]);
  });

  it("keeps the client's other posts on the platform at least 4 hours apart", async () => {
    const first = await seedPublishPost({
      createdBy: admin,
      client,
      jobs: [{ platform: "INSTAGRAM", scheduledFor: "2027-03-03T08:00:00.000Z" }],
    });
    const second = await seedPublishPost({
      createdBy: admin,
      client,
      campaignId: first.campaignId,
      ref: "p2",
      jobs: [{ platform: "INSTAGRAM", scheduledFor: TUESDAY_1100 }],
    });

    const response = await send(
      "PATCH",
      `/v1/publish-jobs/${second.jobs.INSTAGRAM!.id}`,
      cookies.admin,
      { date: WEDNESDAY },
    );
    expect(response.statusCode, response.body).toBe(200);
    const moved = response.json<PublishJobDto>();
    expect(moved.date).toBe(WEDNESDAY);
    // The evening peak, 19:00 in Riyadh: 11:00 is taken and 12:00–14:00 are too close to it.
    expect(moved.scheduledFor).toBe("2027-03-03T16:00:00.000Z");
    const gap = Date.parse(moved.scheduledFor) - Date.parse("2027-03-03T08:00:00.000Z");
    expect(gap).toBeGreaterThanOrEqual(4 * HOUR_MS);
  });

  it("refuses a day already holding the client's two posts on the platform", async () => {
    const first = await seedPublishPost({
      createdBy: admin,
      client,
      jobs: [{ platform: "INSTAGRAM", scheduledFor: "2027-03-03T08:00:00.000Z" }],
    });
    await seedPublishPost({
      createdBy: admin,
      client,
      campaignId: first.campaignId,
      ref: "p2",
      jobs: [{ platform: "INSTAGRAM", scheduledFor: "2027-03-03T16:00:00.000Z" }],
    });
    const third = await seedPublishPost({
      createdBy: admin,
      client,
      campaignId: first.campaignId,
      ref: "p3",
      jobs: [{ platform: "INSTAGRAM", scheduledFor: TUESDAY_1100 }],
    });

    const response = await send(
      "PATCH",
      `/v1/publish-jobs/${third.jobs.INSTAGRAM!.id}`,
      cookies.manager,
      { date: WEDNESDAY },
    );
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "CONFLICT",
        message: expect.stringContaining("no free Instagram slot") as string,
      },
    });
    const stored = await testDb().publishJob.findUniqueOrThrow({
      where: { id: third.jobs.INSTAGRAM!.id },
    });
    expect(stored.scheduledFor.toISOString()).toBe(TUESDAY_1100);
    expect(await auditOf(AUDIT_ACTIONS.publishReschedule)).toEqual([]);
  });

  it("ignores other clients' posts when finding the hour", async () => {
    const other = await createClient({ name: "Other Co", timezone: RIYADH });
    await seedPublishPost({
      createdBy: admin,
      client: other,
      jobs: [{ platform: "INSTAGRAM", scheduledFor: "2027-03-03T08:00:00.000Z" }],
    });
    const { jobs } = await seedPublishPost({
      createdBy: admin,
      client,
      jobs: [{ platform: "INSTAGRAM", scheduledFor: TUESDAY_1100 }],
    });
    const response = await send("PATCH", `/v1/publish-jobs/${jobs.INSTAGRAM!.id}`, cookies.admin, {
      date: WEDNESDAY,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<PublishJobDto>().scheduledFor).toBe("2027-03-03T08:00:00.000Z");
  });

  it("refuses a day that has passed", async () => {
    const { jobs } = await seedPublishPost({
      createdBy: admin,
      client,
      jobs: [{ platform: "FACEBOOK", scheduledFor: TUESDAY_1100 }],
    });
    const response = await send("PATCH", `/v1/publish-jobs/${jobs.FACEBOOK!.id}`, cookies.admin, {
      date: "2027-02-27",
    });
    expect(response.statusCode, response.body).toBe(409);
  });

  it.each(["QUEUED", "PUBLISHING", "PUBLISHED", "FAILED", "CANCELLED"] as const)(
    "refuses to move a %s job",
    async (status) => {
      const { jobs } = await seedPublishPost({
        createdBy: admin,
        client,
        jobs: [{ platform: "INSTAGRAM", status, scheduledFor: TUESDAY_1100 }],
      });
      const response = await send(
        "PATCH",
        `/v1/publish-jobs/${jobs.INSTAGRAM!.id}`,
        cookies.admin,
        { date: WEDNESDAY },
      );
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: "CONFLICT", details: { status } },
      });
    },
  );

  it("is for managers and admins only, and validates the day", async () => {
    const { jobs } = await seedPublishPost({
      createdBy: admin,
      client,
      jobs: [{ platform: "INSTAGRAM", scheduledFor: TUESDAY_1100 }],
    });
    const url = `/v1/publish-jobs/${jobs.INSTAGRAM!.id}`;
    expect((await send("PATCH", url, cookies.editor, { date: WEDNESDAY })).statusCode).toBe(403);
    expect((await send("PATCH", url, undefined, { date: WEDNESDAY })).statusCode).toBe(401);
    expect((await send("PATCH", url, cookies.admin, { date: "03/03/2027" })).statusCode).toBe(400);
    expect(
      (await send("PATCH", "/v1/publish-jobs/nope", cookies.admin, { date: WEDNESDAY })).statusCode,
    ).toBe(404);
  });
});

describe("POST /v1/publish-jobs/:id/retry", () => {
  it("queues a failed job again for its next attempt, going out now", async () => {
    const { jobs, post } = await seedPublishPost({
      createdBy: admin,
      client,
      status: "FAILED",
      needsAttention: true,
      jobs: [
        {
          platform: "INSTAGRAM",
          status: "FAILED",
          scheduledFor: "2027-02-28T08:00:00.000Z",
          attempts: 3,
          lastError: "Instagram is unavailable (gave up after 3 attempts)",
        },
      ],
    });
    const job = jobs.INSTAGRAM!;

    const response = await send("POST", `/v1/publish-jobs/${job.id}/retry`, cookies.manager);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<PublishJobDto>()).toMatchObject({
      id: job.id,
      status: "QUEUED",
      attempts: 3,
      lastError: null,
      scheduledFor: NOW,
      date: "2027-03-01",
      slotSource: "manual",
      slotReason: "Retried by Maha: publishing now.",
    });

    expect(await queuedJobs(t.deps, "ops")).toEqual([
      {
        id: `publish-${job.id}-run4`,
        name: "publish.run",
        data: { publishJobId: job.id, attempt: 4 },
      },
    ]);
    const stored = await testDb().post.findUniqueOrThrow({ where: { id: post.id } });
    expect(stored).toMatchObject({
      status: "SCHEDULED",
      needsAttention: false,
      attentionReason: null,
    });
    const [audit] = await auditOf(AUDIT_ACTIONS.publishRetry);
    expect(audit).toMatchObject({
      actorId: manager.id,
      entityId: job.id,
      data: {
        attempt: 4,
        previousError: "Instagram is unavailable (gave up after 3 attempts)",
      },
    });
    expect(await publishEvents(job.id)).toEqual([expect.objectContaining({ status: "QUEUED" })]);
    const postEvents = await testDb().realtimeEvent.findMany({ where: { type: "post.updated" } });
    expect(postEvents.map((row) => row.payload)).toEqual([
      expect.objectContaining({ postId: post.id, status: "SCHEDULED" }),
    ]);
  });

  it("puts a live job whose account was disconnected on the client's current account", async () => {
    const account = await testDb().socialAccount.create({
      data: {
        clientId: client.id,
        platform: "INSTAGRAM",
        externalId: "17841400000000009",
        handle: "qahwa.co",
        accessTokenEnc: t.deps.tokenCipher.encrypt("page-token"),
        status: "ACTIVE",
      },
    });
    const { jobs } = await seedPublishPost({
      createdBy: admin,
      client,
      status: "FAILED",
      jobs: [
        {
          platform: "INSTAGRAM",
          status: "FAILED",
          scheduledFor: "2027-02-28T08:00:00.000Z",
          attempts: 1,
          dryRun: false,
          socialAccountId: null,
        },
      ],
    });
    const response = await send(
      "POST",
      `/v1/publish-jobs/${jobs.INSTAGRAM!.id}/retry`,
      cookies.admin,
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<PublishJobDto>()).toMatchObject({
      dryRun: false,
      socialAccountId: account.id,
    });
  });

  it.each(["SCHEDULED", "QUEUED", "PUBLISHING", "PUBLISHED", "CANCELLED"] as const)(
    "refuses to retry a %s job",
    async (status) => {
      const { jobs } = await seedPublishPost({
        createdBy: admin,
        client,
        jobs: [{ platform: "INSTAGRAM", status, scheduledFor: TUESDAY_1100 }],
      });
      const response = await send(
        "POST",
        `/v1/publish-jobs/${jobs.INSTAGRAM!.id}/retry`,
        cookies.admin,
      );
      expect(response.statusCode, response.body).toBe(409);
      expect(await queuedJobs(t.deps, "ops")).toEqual([]);
    },
  );

  it("refuses once the campaign or the client is archived", async () => {
    const seed = () =>
      seedPublishPost({
        createdBy: admin,
        client,
        status: "FAILED",
        jobs: [{ platform: "INSTAGRAM", status: "FAILED", scheduledFor: TUESDAY_1100 }],
      });
    const inCampaign = await seed();
    await testDb().campaign.update({
      where: { id: inCampaign.campaignId },
      data: { status: "ARCHIVED" },
    });
    const campaignRetry = await send(
      "POST",
      `/v1/publish-jobs/${inCampaign.jobs.INSTAGRAM!.id}/retry`,
      cookies.admin,
    );
    expect(campaignRetry.statusCode, campaignRetry.body).toBe(409);
    expect(campaignRetry.json()).toMatchObject({
      error: { message: "The campaign is archived, so nothing of it publishes any more" },
    });

    const ofClient = await seed();
    await testDb().client.update({ where: { id: client.id }, data: { archivedAt: new Date() } });
    const clientRetry = await send(
      "POST",
      `/v1/publish-jobs/${ofClient.jobs.INSTAGRAM!.id}/retry`,
      cookies.admin,
    );
    expect(clientRetry.statusCode, clientRetry.body).toBe(409);
    expect(await queuedJobs(t.deps, "ops")).toEqual([]);
  });

  it("refuses once the post has gone back to approval", async () => {
    const { jobs } = await seedPublishPost({
      createdBy: admin,
      client,
      status: "PENDING_APPROVAL",
      jobs: [{ platform: "INSTAGRAM", status: "FAILED", scheduledFor: TUESDAY_1100 }],
    });
    const response = await send(
      "POST",
      `/v1/publish-jobs/${jobs.INSTAGRAM!.id}/retry`,
      cookies.admin,
    );
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({
      error: { details: { postStatus: "PENDING_APPROVAL" } },
    });
  });

  it("is for managers and admins only", async () => {
    const { jobs } = await seedPublishPost({
      createdBy: admin,
      client,
      status: "FAILED",
      jobs: [{ platform: "INSTAGRAM", status: "FAILED", scheduledFor: TUESDAY_1100 }],
    });
    const url = `/v1/publish-jobs/${jobs.INSTAGRAM!.id}/retry`;
    expect((await send("POST", url, cookies.editor)).statusCode).toBe(403);
    expect((await send("POST", "/v1/publish-jobs/nope/retry", cookies.admin)).statusCode).toBe(404);
  });
});

describe("POST /v1/publish-jobs/:id/cancel", () => {
  it("cancels a scheduled job, and the post is only approved once none is left", async () => {
    const { jobs, post } = await seedPublishPost({
      createdBy: admin,
      client,
      jobs: [
        { platform: "INSTAGRAM", scheduledFor: TUESDAY_1100 },
        { platform: "FACEBOOK", status: "QUEUED", scheduledFor: "2027-03-01T05:00:00.000Z" },
      ],
    });

    const first = await send(
      "POST",
      `/v1/publish-jobs/${jobs.INSTAGRAM!.id}/cancel`,
      cookies.manager,
    );
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json<PublishJobDto>()).toMatchObject({
      status: "CANCELLED",
      lastError: "Cancelled by Maha",
    });
    expect((await testDb().post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe(
      "SCHEDULED",
    );

    const second = await send(
      "POST",
      `/v1/publish-jobs/${jobs.FACEBOOK!.id}/cancel`,
      cookies.admin,
    );
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json<PublishJobDto>().status).toBe("CANCELLED");
    expect((await testDb().post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe(
      "APPROVED",
    );

    const audits = await auditOf(AUDIT_ACTIONS.publishCancel);
    expect(audits.map((audit) => audit.data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ platform: "INSTAGRAM", previousStatus: "SCHEDULED" }),
        expect.objectContaining({ platform: "FACEBOOK", previousStatus: "QUEUED" }),
      ]),
    );
    expect(await publishEvents(jobs.INSTAGRAM!.id)).toEqual([
      expect.objectContaining({ status: "CANCELLED" }),
    ]);
    const postEvents = await testDb().realtimeEvent.findMany({ where: { type: "post.updated" } });
    expect(postEvents.map((row) => row.payload)).toEqual([
      expect.objectContaining({ postId: post.id, status: "APPROVED" }),
    ]);
  });

  it("drops a failed platform: the post goes LIVE on the rest, the failure kept in the audit", async () => {
    const liveUrl = "https://dryrun.enmo.marketing/facebook/variant";
    const error = "Instagram can't take this post: the image is 9:16";
    const { jobs, post } = await seedPublishPost({
      createdBy: admin,
      client,
      status: "FAILED",
      needsAttention: true,
      jobs: [
        {
          platform: "INSTAGRAM",
          status: "FAILED",
          scheduledFor: "2027-03-01T05:00:00.000Z",
          attempts: 1,
          lastError: error,
        },
        {
          platform: "FACEBOOK",
          status: "PUBLISHED",
          scheduledFor: "2027-03-01T04:00:00.000Z",
          attempts: 1,
          publishedAt: new Date("2027-03-01T04:00:05.000Z"),
          liveUrl,
        },
      ],
    });

    const response = await send(
      "POST",
      `/v1/publish-jobs/${jobs.INSTAGRAM!.id}/cancel`,
      cookies.manager,
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<PublishJobDto>()).toMatchObject({
      status: "CANCELLED",
      lastError: "Cancelled by Maha",
    });
    expect(await testDb().post.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({
      status: "LIVE",
      needsAttention: false,
      attentionReason: null,
      liveAt: new Date("2027-03-01T04:00:05.000Z"),
    });
    const [audit] = await auditOf(AUDIT_ACTIONS.publishCancel);
    expect(audit?.data).toMatchObject({ previousStatus: "FAILED", previousError: error });
    // Nothing is queued: a dropped platform stays dropped.
    expect(await queuedJobs(t.deps, "ops")).toEqual([]);
  });

  it("drops the only failed job: the post is approved again, and editable", async () => {
    const { jobs, post } = await seedPublishPost({
      createdBy: admin,
      client,
      status: "FAILED",
      needsAttention: true,
      platforms: ["INSTAGRAM"],
      jobs: [
        {
          platform: "INSTAGRAM",
          status: "FAILED",
          scheduledFor: "2027-03-01T05:00:00.000Z",
          attempts: 3,
          lastError: "Instagram rejected the post",
        },
      ],
    });
    const response = await send(
      "POST",
      `/v1/publish-jobs/${jobs.INSTAGRAM!.id}/cancel`,
      cookies.admin,
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(await testDb().post.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({
      status: "APPROVED",
      needsAttention: false,
    });
    const dto = await send("GET", `/v1/posts/${post.id}`, cookies.admin);
    expect(dto.json<{ editable: boolean }>().editable).toBe(true);
  });

  it.each(["PUBLISHING", "PUBLISHED", "CANCELLED"] as const)(
    "refuses to cancel a %s job",
    async (status) => {
      const { jobs } = await seedPublishPost({
        createdBy: admin,
        client,
        jobs: [{ platform: "INSTAGRAM", status, scheduledFor: TUESDAY_1100 }],
      });
      const response = await send(
        "POST",
        `/v1/publish-jobs/${jobs.INSTAGRAM!.id}/cancel`,
        cookies.admin,
      );
      expect(response.statusCode, response.body).toBe(409);
      const stored = await testDb().publishJob.findUniqueOrThrow({
        where: { id: jobs.INSTAGRAM!.id },
      });
      expect(stored.status).toBe(status);
    },
  );

  it("is for managers and admins only", async () => {
    const { jobs } = await seedPublishPost({
      createdBy: admin,
      client,
      jobs: [{ platform: "INSTAGRAM", scheduledFor: TUESDAY_1100 }],
    });
    const url = `/v1/publish-jobs/${jobs.INSTAGRAM!.id}/cancel`;
    expect((await send("POST", url, cookies.editor)).statusCode).toBe(403);
    expect((await send("POST", "/v1/publish-jobs/nope/cancel", cookies.admin)).statusCode).toBe(
      404,
    );
  });
});
