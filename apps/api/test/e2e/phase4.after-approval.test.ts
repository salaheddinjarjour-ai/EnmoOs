import { CopywriterOutput, defaultApprovalChain, type PublishUpdatedPayload } from "@enmo/shared";
import { afterEach, describe, expect, it } from "vitest";
import { jobIds } from "../../src/jobs/queues";
import { FakeClock } from "../../src/lib/clock";
import { currentContentHash } from "../../src/orchestrator/approval-round";
import { EventBatch } from "../../src/orchestrator/events";
import { cancelScheduledForPost, PUBLISH_CANCEL_REASONS } from "../../src/orchestrator/publishing";
import { schedulePost } from "../../src/publishing/schedule";
import { browserHeaders } from "../helpers/app";
import { sessionCookieFor } from "../helpers/auth";
import { testDb } from "../helpers/db";
import { createAsset, createClient, createUser } from "../helpers/factories";
import { startHarness, type Harness, type HarnessOptions } from "../helpers/harness";
import { seedCampaign, testCopy } from "../helpers/route-fixtures";
import { GRAPH_ERRORS, startFakeGraph, type FakeGraph } from "../fakes/meta-graph";
import {
  apiFor,
  connectMetaAccounts,
  eventsOfType,
  IG_TUESDAY_1100,
  jobsOf,
  NOW,
  RIYADH,
  runToApproval,
  seedMetaPlan,
  tickAt,
  waitForJobs,
  waitForPostStatus,
} from "./phase4.fixtures";

/*
 * Phase 4: what changes after approval never goes out unapproved (DESIGN §F "Publishing safety"),
 * on the pipeline harness:
 *   - content that drifted between the approval and publisher.schedule is not blessed by the
 *     Publisher extending the approval's hash to its variants: the guard cancels it at the slot;
 *   - a Vault take replacing one an approved post outside any plan shows calls its scheduled job
 *     off (takeReplaced) and reopens approval;
 *   - a retry resuming a container that already reached Instagram keeps the post frozen: no edit,
 *     no cancel, no lifecycle call-off, and a guard refusal fails it for a person to check rather
 *     than calling it off, so nothing is ever posted from scratch a second time.
 */

let harness: Harness | undefined;
let graph: FakeGraph | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  await graph?.close();
  graph = undefined;
});

async function start(options: HarnessOptions = {}): Promise<Harness> {
  harness = await startHarness({ clock: new FakeClock(NOW), ...options });
  return harness;
}

describe("content changed after approval", () => {
  it("is not blessed when it drifted before publisher.schedule ran: the guard cancels it", async () => {
    const h = await start();
    const seeded = await seedMetaPlan(h, { platforms: ["INSTAGRAM"] });
    const [post] = await runToApproval(h, seeded);
    const postId = post!.id;
    const db = testDb();
    // Approved in the database alone, so no publisher.schedule is queued: the test runs it.
    const round = await db.approvalRequest.findFirstOrThrow({
      where: { postId, status: "PENDING" },
    });
    await db.approvalRequest.update({
      where: { id: round.id },
      data: { status: "APPROVED", resolvedAt: h.clock.now() },
    });
    await db.post.update({
      where: { id: postId },
      data: { status: "APPROVED", approvedAt: h.clock.now() },
    });
    // The copy changes between the approval and the Publisher's run.
    const copy = CopywriterOutput.parse(
      (await db.post.findUniqueOrThrow({ where: { id: postId } })).copy,
    );
    await db.post.update({
      where: { id: postId },
      data: { copy: { ...copy, caption: "Drifted before it was scheduled." } },
    });

    expect(await schedulePost(h.deps, { postId, round: round.round })).toEqual({
      status: "done",
      scheduled: 1,
      unscheduled: 0,
    });
    // The Publisher derived a variant, yet the approval's hash still covers only what was approved.
    const after = await db.approvalRequest.findUniqueOrThrow({ where: { id: round.id } });
    expect(after.contentHash).toBe(round.contentHash);
    expect(await currentContentHash(db, postId)).not.toBe(round.contentHash);

    const { INSTAGRAM: job } = await jobsOf(postId);
    await tickAt(h, job!.scheduledFor.toISOString());
    const reopened = await waitForPostStatus(h, postId, "PENDING_APPROVAL");
    expect(reopened).toMatchObject({
      needsAttention: true,
      attentionReason: "The post's content changed after it was approved",
    });
    expect((await jobsOf(postId)).INSTAGRAM).toMatchObject({
      id: job!.id,
      status: "CANCELLED",
      lastError: PUBLISH_CANCEL_REASONS.contentChanged,
      liveUrl: null,
    });
    const rounds = await db.approvalRequest.findMany({
      where: { postId },
      orderBy: { round: "asc" },
    });
    expect(rounds.map((entry) => entry.status)).toEqual(["CANCELLED", "PENDING"]);
  }, 90_000);

  it("calls off the scheduled job when a Vault take replaces one the approval covered", async () => {
    const h = await start();
    const db = testDb();
    const admin = await createUser({ role: "ADMIN" });
    const client = await createClient({
      name: "Qahwa Co",
      timezone: RIYADH,
      enabledPlatforms: ["INSTAGRAM"],
    });
    // A post outside any plan: nothing but its approval re-checks a take it gets.
    const { campaign } = await seedCampaign({ createdBy: admin, client, status: "PRODUCING" });
    const post = await db.post.create({
      data: {
        campaignId: campaign.id,
        clientId: client.id,
        ref: "p1",
        type: "STATIC",
        platforms: ["INSTAGRAM"],
        status: "PENDING_APPROVAL",
        copy: testCopy("Cold brew, warm evenings."),
      },
    });
    const v1 = await createAsset({
      client,
      campaignId: campaign.id,
      postId: post.id,
      review: {
        verdict: "accept",
        score: 8,
        issues: [],
        revisedPrompt: null,
        attempt: 1,
        reviewedAt: h.clock.now().toISOString(),
      },
    });
    const round = await db.approvalRequest.create({
      data: {
        postId: post.id,
        round: 1,
        chain: defaultApprovalChain(),
        contentHash: await currentContentHash(db, post.id),
      },
    });
    const api = apiFor(h, await sessionCookieFor(admin, { now: h.clock.now() }));
    await api("POST", `/v1/approvals/${round.id}/decision`, { decision: "APPROVE" });
    await waitForPostStatus(h, post.id, "SCHEDULED");
    const { INSTAGRAM: job } = await jobsOf(post.id);
    expect(job!.status).toBe("SCHEDULED");

    await api("POST", `/v1/assets/${v1.id}/regenerate`, { instruction: "Warmer light" });
    const reopened = await waitForPostStatus(h, post.id, "PENDING_APPROVAL");
    expect(reopened.approvedAt).toBeNull();
    expect((await jobsOf(post.id)).INSTAGRAM).toMatchObject({
      id: job!.id,
      status: "CANCELLED",
      lastError: PUBLISH_CANCEL_REASONS.takeReplaced,
    });
    const updates = await h.waitFor(async () => {
      const rows = (await eventsOfType<PublishUpdatedPayload>("publish.updated")).filter(
        (update) => update.jobId === job!.id,
      );
      return rows.at(-1)?.status === "CANCELLED" ? rows : null;
    });
    expect(updates.map((update) => update.status)).toEqual(["SCHEDULED", "CANCELLED"]);
    const rounds = await db.approvalRequest.findMany({
      where: { postId: post.id },
      orderBy: { round: "asc" },
    });
    expect(rounds.map((entry) => entry.status)).toEqual(["CANCELLED", "PENDING"]);
    expect(rounds[1]!.contentHash).toBe(await currentContentHash(db, post.id));

    // Its slot comes and goes: nothing goes out without the new approval.
    await tickAt(h, job!.scheduledFor.toISOString());
    expect((await jobsOf(post.id)).INSTAGRAM!.status).toBe("CANCELLED");
  }, 90_000);
});

describe("a retry resuming what reached the platform", () => {
  it("keeps the post frozen, and a guard refusal fails it for a person to check Instagram", async () => {
    graph = await startFakeGraph();
    // A minute before the automatic retry: the test acts inside that window, then runs it.
    const h = await start({
      publishMode: "live",
      metaBaseUrl: graph.url,
      env: { PUBLISH_POLL_INTERVAL_SEC: "60" },
    });
    const seeded = await seedMetaPlan(h, { platforms: ["INSTAGRAM"] });
    await connectMetaAccounts(h, seeded.client);
    const [post] = await runToApproval(h, seeded);
    const postId = post!.id;
    const round = await testDb().approvalRequest.findFirstOrThrow({
      where: { postId, status: "PENDING" },
    });
    await apiFor(h, seeded.cookie)("POST", `/v1/approvals/${round.id}/decision`, {
      decision: "APPROVE",
    });
    await waitForPostStatus(h, postId, "SCHEDULED");

    // media_publish meets an outage: Instagram may have published the container all the same.
    graph.failNext({
      match: /^POST \/v26\.0\/\d+\/media_publish$/,
      status: 500,
      error: GRAPH_ERRORS.unavailable,
    });
    await tickAt(h, IG_TUESDAY_1100);
    const retrying = await h.waitFor(async () => {
      const { INSTAGRAM: job } = await jobsOf(postId);
      return job?.status === "QUEUED" && job.lastError ? job : null;
    });
    expect(retrying.containerId).toMatch(/^IG_IMAGE;items=\d+$/);
    // Part of it may be out already: PUBLISHING, which nothing edits.
    await waitForPostStatus(h, postId, "PUBLISHING");

    const headers = browserHeaders(seeded.cookie);
    const stored = await testDb().post.findUniqueOrThrow({ where: { id: postId } });
    const copy = CopywriterOutput.parse(stored.copy);
    const edit = await h.app.inject({
      method: "PATCH",
      url: `/v1/posts/${postId}/copy`,
      headers,
      payload: { copy: { ...copy, caption: "Edited while the retry waits." } },
    });
    expect(edit.statusCode, edit.body).toBe(409);
    const cancel = await h.app.inject({
      method: "POST",
      url: `/v1/publish-jobs/${retrying.id}/cancel`,
      headers,
    });
    expect(cancel.statusCode, cancel.body).toBe(409);
    expect(cancel.json()).toMatchObject({
      error: {
        message:
          "This Instagram job is retrying a publish that already reached Instagram, so it can't be cancelled until that settles",
      },
    });
    // Nor does anything that calls a post's waiting jobs off (an edit, a revision, an archive).
    const calledOff = await h.deps.prisma.$transaction((tx) =>
      cancelScheduledForPost(tx, new EventBatch(), postId, "copyEdited"),
    );
    expect(calledOff).toBe(0);

    // A word the client bans meanwhile holds the retry back without calling the job off.
    const [variant] = await testDb().postVariant.findMany({ where: { postId } });
    const word = /\p{L}{5,}/u.exec(variant!.caption)![0];
    await testDb().client.update({
      where: { id: seeded.client.id },
      data: { bannedWords: [word] },
    });
    const run = await h.deps.queues
      .queue("ops")
      .getJob(jobIds.publishRun({ publishJobId: retrying.id, attempt: 2 }));
    await run!.promote();
    const { INSTAGRAM: failed } = await waitForJobs(h, postId, "FAILED", ["INSTAGRAM"]);
    expect(failed).toMatchObject({
      attempts: 2,
      containerId: retrying.containerId,
      lastError: `The post uses the client's banned words: "${word}", and an earlier attempt already reached Instagram, so the post may be there: check Instagram, then cancel this job`,
    });
    const flagged = await waitForPostStatus(h, postId, "FAILED");
    expect(flagged.attentionReason).toBe(failed!.lastError);
    // Nothing more reached Instagram: one container, and the one media_publish that went unanswered.
    expect(graph.state.containers.size).toBe(1);
    expect(graph.sequence().filter((call) => call.endsWith("/media_publish"))).toHaveLength(1);
  }, 90_000);
});
