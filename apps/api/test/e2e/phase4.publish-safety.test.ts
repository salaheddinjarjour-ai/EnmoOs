import {
  COPY_BANNED_SCAN_IGNORE,
  MockLlm,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
} from "@enmo/agents";
import type { Client } from "@enmo/db";
import { DryRunPublisher } from "@enmo/providers";
import {
  CopywriterOutput,
  Feedback,
  scanForBannedWords,
  type AlertPayload,
  type ApproveAllResponse,
  type Platform,
  type PublishJobDto,
} from "@enmo/shared";
import { UnrecoverableError, Worker } from "bullmq";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { closeRedis, createWorkerConnection } from "../../src/jobs/connection";
import { enqueuePublishRun, jobIds, publishPollMaxPolls } from "../../src/jobs/queues";
import { DAY_MS, FakeClock, HOUR_MS, MINUTE_MS } from "../../src/lib/clock";
import { currentContentHash } from "../../src/orchestrator/approval-round";
import { EventBatch } from "../../src/orchestrator/events";
import { PUBLISH_CANCEL_REASONS, syncPostPublishStatus } from "../../src/orchestrator/publishing";
import { pollPublish, runPublish } from "../../src/publishing/publish-service";
import { testDb } from "../helpers/db";
import { createClient, createUser } from "../helpers/factories";
import { startHarness, type Harness, type HarnessOptions } from "../helpers/harness";
import { GRAPH_ERRORS, startFakeGraph, type FakeGraph } from "../fakes/meta-graph";
import {
  apiFor,
  approvePost,
  connectMetaAccounts,
  eventsOfType,
  expectSameInstant,
  FB_TUESDAY_0900,
  IG_TUESDAY_1100,
  jobsOf,
  NOW,
  publisherNotes,
  runToApproval,
  seedMetaPlan,
  THURSDAY,
  tickAt,
  waitForJobs,
  waitForPostStatus,
  type SeededMetaPlan,
} from "./phase4.fixtures";

/*
 * Phase 4 publishing safety (DESIGN §F "Publishing safety", §D ticks), on the pipeline harness:
 *   - publisher.schedule: the optimizer's top candidates when the Publisher agent fails (never an
 *     escalation), and a post no platform would take left approved and flagged;
 *   - the publish guard at the slot: archived work, content changed behind the approval's back,
 *     banned words added since, an expired token; content refusals cancel and reopen approval
 *     (banned copy through the Copywriter first) and the re-approved job goes out at its new slot,
 *     archived work is held back, a token refusal fails the job (retryable once reconnected);
 *   - dry run or live settled at the slot: a kill switch after scheduling, an account connected
 *     after scheduling, and a live publish still processing when publishing is switched off;
 *   - the live publisher's failures against the fake Graph server: a transient error retried
 *     automatically on the same container, a permanent refusal, a revoked token, media still
 *     processing (publish.poll) and a poll that never finishes;
 *   - tick.publish re-driving what was lost (a stalled PUBLISHING job, an approval whose
 *     publisher.schedule never ran) and the slot rules holding when posts are scheduled at once;
 *   - tick.tokens checking every Meta account's token once a day.
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

async function startLive(env: Record<string, string> = {}): Promise<Harness> {
  graph = await startFakeGraph();
  return start({
    publishMode: "live",
    metaBaseUrl: graph.url,
    env: { PUBLISH_POLL_INTERVAL_SEC: "1", ...env },
  });
}

interface ScheduledPost {
  seeded: SeededMetaPlan;
  postId: string;
}

/** An Instagram-only post, approved and SCHEDULED for Tuesday 11:00 in Riyadh. */
async function scheduledPost(
  h: Harness,
  platforms: readonly Platform[] = ["INSTAGRAM"],
  beforeApproval?: (client: Client) => Promise<unknown>,
): Promise<ScheduledPost> {
  const seeded = await seedMetaPlan(h, { platforms });
  await beforeApproval?.(seeded.client);
  const [post] = await runToApproval(h, seeded);
  await approvePost(h, seeded, post!.id);
  await waitForPostStatus(h, post!.id, "SCHEDULED");
  return { seeded, postId: post!.id };
}

async function alerts(): Promise<AlertPayload[]> {
  return eventsOfType<AlertPayload>("alert");
}

/**
 * The alerts once at least `count` have landed. A worker publishes its events just after the
 * commit the test waited on, so reading them straight after would race it.
 */
async function alertsAfter(h: Harness, count: number): Promise<AlertPayload[]> {
  return h.waitFor(async () => {
    const rows = await alerts();
    return rows.length >= count ? rows : null;
  });
}

describe("publisher.schedule", () => {
  it("leaves a post it can't publish approved, flagged and explained", async () => {
    // Copy and QA only: the post has no visuals, and neither platform takes a post without media.
    const h = await start({ pipeline: ["write", "qa"] });
    const seeded = await seedMetaPlan(h);
    const [post] = await runToApproval(h, seeded);
    await approvePost(h, seeded, post!.id);
    const flagged = await h.waitFor(async () => {
      const row = await testDb().post.findUniqueOrThrow({ where: { id: post!.id } });
      return row.needsAttention ? row : null;
    });
    expect(flagged.status).toBe("APPROVED");
    const why = "the post breaks its publishing rules: The post has no visuals to publish";
    expect(flagged.attentionReason).toBe(`Not scheduled on Instagram: ${why}; Facebook: ${why}`);
    expect(await testDb().publishJob.count()).toBe(0);
    expect(
      (await alertsAfter(h, 1)).map((alert) => [alert.kind, alert.entityType, alert.entityId]),
    ).toEqual([["failed", "Post", post!.id]]);
    expect((await publisherNotes(seeded.threadId)).at(-1)).toMatch(
      /^Couldn't schedule p1:\n- Instagram: the post breaks its publishing rules: /,
    );
    // Flagged posts are not re-driven by the tick.
    await tickAt(h, new Date(Date.parse(NOW) + 10 * MINUTE_MS).toISOString());
    expect(await testDb().publishJob.count()).toBe(0);
  }, 90_000);

  it("keeps to the campaign window: a post approved after it ended waits for a teammate's day", async () => {
    const h = await start();
    const seeded = await seedMetaPlan(h, { platforms: ["INSTAGRAM"] });
    const [post] = await runToApproval(h, seeded);
    const postId = post!.id;
    // The window closed before the approval came in (a Ramadan post approved after Eid).
    const campaign = await testDb().campaign.findUniqueOrThrow({
      where: { id: seeded.campaignId },
    });
    await testDb().campaign.update({
      where: { id: seeded.campaignId },
      data: {
        brief: {
          ...(campaign.brief as Record<string, unknown>),
          window: { start: "2027-02-20", end: "2027-02-28" },
        },
      },
    });
    await approvePost(h, seeded, postId);

    const flagged = await h.waitFor(async () => {
      const row = await testDb().post.findUniqueOrThrow({ where: { id: postId } });
      return row.needsAttention ? row : null;
    });
    expect(flagged).toMatchObject({
      status: "APPROVED",
      attentionReason:
        "Not scheduled on Instagram: the campaign window ended on 2027-02-28; put it on a day on the calendar",
    });
    // Nothing went on a day nobody chose.
    expect(await testDb().publishJob.count()).toBe(0);
    expect(
      (await alertsAfter(h, 1)).map((alert) => [alert.kind, alert.entityType, alert.entityId]),
    ).toEqual([["failed", "Post", postId]]);

    // A teammate picks Thursday; the optimizer picks its best Instagram hour.
    const job = await apiFor(h, seeded.cookie)<PublishJobDto>("POST", "/v1/publish-jobs", {
      postId,
      platform: "INSTAGRAM",
      date: THURSDAY,
    });
    expect(job).toMatchObject({
      status: "SCHEDULED",
      slotSource: "manual",
      date: THURSDAY,
      scheduledFor: "2027-03-04T08:00:00.000Z",
    });
    const scheduled = await waitForPostStatus(h, postId, "SCHEDULED");
    expect(scheduled).toMatchObject({ needsAttention: false, attentionReason: null });
    await tickAt(h, job.scheduledFor);
    await waitForPostStatus(h, postId, "LIVE");
  }, 90_000);

  it("falls back to the optimizer's top candidates when the Publisher can't answer", async () => {
    // Every attempt the runner allows comes back invalid, so the agent gives up on the post.
    const h = await start({ env: { MOCK_LLM_FAULTS: "PUBLISHER.schedule:invalid*3" } });
    const seeded = await seedMetaPlan(h);
    const [post] = await runToApproval(h, seeded);
    await approvePost(h, seeded, post!.id);
    const scheduled = await waitForPostStatus(h, post!.id, "SCHEDULED");
    expect(scheduled.needsAttention).toBe(false);

    const runs = await testDb().agentRun.findMany({ where: { agent: "PUBLISHER" } });
    expect(runs.length).toBeGreaterThan(1);
    expect(runs.every((run) => run.outcome === "INVALID_OUTPUT")).toBe(true);
    const jobs = await jobsOf(post!.id);
    for (const job of Object.values(jobs)) {
      expect(job).toMatchObject({ status: "SCHEDULED", slotSource: "optimizer" });
    }
    // The same slots the Publisher would have picked: each platform's first Tuesday peak.
    expectSameInstant(jobs.FACEBOOK!.scheduledFor, FB_TUESDAY_0900);
    expectSameInstant(jobs.INSTAGRAM!.scheduledFor, IG_TUESDAY_1100);
    expect(jobs.INSTAGRAM!.slotReason).toBe(
      "Top-scored slot: Instagram peak hour: Tue 11:00 Asia/Riyadh (prior 1.25).",
    );
    // Never an escalation: nobody is asked to pick a slot by hand.
    expect(await testDb().agentTask.count({ where: { status: "ESCALATED" } })).toBe(0);
    expect(await alerts()).toEqual([]);
  }, 90_000);

  it("notes a platform that has no such post without flagging the post", async () => {
    const h = await start();
    const seeded = await seedMetaPlan(h, { type: "STORY", platforms: ["INSTAGRAM", "TIKTOK"] });
    const [post] = await runToApproval(h, seeded);
    await approvePost(h, seeded, post!.id);
    const scheduled = await waitForPostStatus(h, post!.id, "SCHEDULED");
    expect(scheduled.needsAttention).toBe(false);
    expect(Object.keys(await jobsOf(post!.id))).toEqual(["INSTAGRAM"]);
    expect(await testDb().postVariant.count()).toBe(1);
    expect(await alerts()).toEqual([]);
    expect((await publisherNotes(seeded.threadId)).at(-1)).toContain(
      "Not scheduled:\n- TikTok: it doesn't take story posts.",
    );
  }, 90_000);
});

describe("the publish guard", () => {
  it("cancels content that changed behind the approval's back and reopens approval", async () => {
    const h = await startLive();
    const { seeded, postId } = await scheduledPost(h, ["INSTAGRAM"], (client) =>
      connectMetaAccounts(h, client),
    );
    const db = testDb();
    const { INSTAGRAM: job } = await jobsOf(postId);
    const stored = await db.post.findUniqueOrThrow({ where: { id: postId } });
    const copy = CopywriterOutput.parse(stored.copy);
    await db.post.update({
      where: { id: postId },
      data: { copy: { ...copy, caption: "Changed behind the approval's back." } },
    });

    await tickAt(h, IG_TUESDAY_1100);
    const reopened = await waitForPostStatus(h, postId, "PENDING_APPROVAL");
    const message = "The post's content changed after it was approved";
    expect(reopened).toMatchObject({
      needsAttention: true,
      attentionReason: message,
      approvedAt: null,
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
    expect(rounds.map((round) => round.status)).toEqual(["CANCELLED", "PENDING"]);
    expect(rounds[1]!.contentHash).toBe(await currentContentHash(db, postId));
    expect(await alertsAfter(h, 1)).toEqual([
      {
        kind: "failed",
        entityType: "PublishJob",
        entityId: job!.id,
        message: `Held back p1 on Instagram: ${message}.`,
        clientId: seeded.client.id,
        campaignId: seeded.campaignId,
      },
    ]);
    expect((await publisherNotes(seeded.threadId)).at(-1)).toBe(
      `I held back p1 on Instagram: ${message}. Its approval is open again.`,
    );
    // Held back before anything reached the platform.
    expect(graph!.calls).toEqual([]);
  }, 90_000);

  it("cancels a job whose post no longer stands approved, before any Graph call", async () => {
    const h = await startLive();
    const { seeded, postId } = await scheduledPost(h, ["INSTAGRAM"], (client) =>
      connectMetaAccounts(h, client),
    );
    const { INSTAGRAM: job } = await jobsOf(postId);
    // The approval withdrawn behind the job's back (nothing that cancels jobs ran).
    await testDb().approvalRequest.updateMany({
      where: { postId, status: "APPROVED" },
      data: { status: "CANCELLED" },
    });

    await tickAt(h, IG_TUESDAY_1100);
    const reopened = await waitForPostStatus(h, postId, "PENDING_APPROVAL");
    const message = "The post's latest approval round is cancelled, not approved";
    expect(reopened).toMatchObject({ needsAttention: true, attentionReason: message });
    expect((await jobsOf(postId)).INSTAGRAM).toMatchObject({
      id: job!.id,
      status: "CANCELLED",
      lastError: PUBLISH_CANCEL_REASONS.approvalWithdrawn,
      externalId: null,
      liveUrl: null,
    });
    const rounds = await testDb().approvalRequest.findMany({
      where: { postId },
      orderBy: { round: "asc" },
    });
    expect(rounds.map((round) => round.status)).toEqual(["CANCELLED", "PENDING"]);
    expect(
      (await alertsAfter(h, 1)).map((alert) => [alert.kind, alert.entityType, alert.entityId]),
    ).toEqual([["failed", "PublishJob", job!.id]]);
    expect((await publisherNotes(seeded.threadId)).at(-1)).toBe(
      `I held back p1 on Instagram: ${message}. Its approval is open again.`,
    );
    expect(graph!.calls).toEqual([]);
  }, 90_000);

  it("publishes a job the guard refused at its new slot once the post is approved again", async () => {
    const h = await start();
    const { seeded, postId } = await scheduledPost(h);
    const db = testDb();
    const { INSTAGRAM: job } = await jobsOf(postId);
    const stored = await db.post.findUniqueOrThrow({ where: { id: postId } });
    const copy = CopywriterOutput.parse(stored.copy);
    await db.post.update({
      where: { id: postId },
      data: { copy: { ...copy, caption: "Changed behind the approval's back." } },
    });

    await tickAt(h, IG_TUESDAY_1100);
    const reopened = await waitForPostStatus(h, postId, "PENDING_APPROVAL");
    expect(reopened.needsAttention).toBe(true);
    // The refused run is done, and BullMQ keeps its id taken for a day.
    const runOne = jobIds.publishRun({ publishJobId: job!.id, attempt: 1 });
    await h.waitFor(async () => {
      const run = await h.deps.queues.queue("ops").getJob(runOne);
      return run && (await run.getState()) === "completed";
    });

    await approvePost(h, seeded, postId);
    const rescheduled = await waitForPostStatus(h, postId, "SCHEDULED");
    // The reviewers' approval answers the refusal's flag.
    expect(rescheduled).toMatchObject({ needsAttention: false, attentionReason: null });
    const again = (await jobsOf(postId)).INSTAGRAM!;
    expect(again).toMatchObject({ id: job!.id, status: "SCHEDULED", attempts: 1, lastError: null });
    expect(again.scheduledFor.getTime()).toBeGreaterThan(Date.parse(IG_TUESDAY_1100));

    await tickAt(h, again.scheduledFor.toISOString());
    const live = await waitForPostStatus(h, postId, "LIVE");
    expect(live.needsAttention).toBe(false);
    expect((await jobsOf(postId)).INSTAGRAM).toMatchObject({ status: "PUBLISHED", attempts: 2 });
  }, 90_000);

  it("sends copy that uses a word the client banned after approval back to the Copywriter", async () => {
    const h = await start();
    const { seeded, postId } = await scheduledPost(h);
    const db = testDb();
    const [variant] = await db.postVariant.findMany({ where: { postId } });
    const word = /\p{L}{5,}/u.exec(variant!.caption)![0];
    await db.client.updateMany({ data: { bannedWords: [word] } });

    await tickAt(h, IG_TUESDAY_1100);
    const message = `The post uses the client's banned words: "${word}"`;
    const held = await waitForJobs(h, postId, "CANCELLED", ["INSTAGRAM"]);
    expect(held.INSTAGRAM!.lastError).toBe(PUBLISH_CANCEL_REASONS.bannedWords);
    // No round opens on copy that can't go out: the Copywriter rewrites it and QA sends it on.
    const write = await db.agentTask.findFirstOrThrow({
      where: { postId, action: "write", revision: { gt: 0 } },
    });
    const feedback = Feedback.parse(write.feedback);
    expect(feedback).toMatchObject({ source: "QA", decisionId: null });
    expect(feedback.verbatim).toContain(`Uses the banned term "${word}"`);
    expect((await publisherNotes(seeded.threadId)).at(-1)).toBe(
      `I held back p1 on Instagram: ${message}. It's back with the Copywriter.`,
    );

    const revised = await waitForPostStatus(h, postId, "PENDING_APPROVAL");
    expect(revised.needsAttention).toBe(false);
    expect(
      scanForBannedWords(revised.copy, [word], { ignoreKeys: COPY_BANNED_SCAN_IGNORE }),
    ).toEqual([]);
    const rounds = await db.approvalRequest.findMany({
      where: { postId },
      orderBy: { round: "asc" },
    });
    expect(rounds.map((round) => round.status)).toEqual(["CANCELLED", "PENDING"]);
    expect(rounds[1]!.contentHash).toBe(await currentContentHash(db, postId));
  }, 90_000);

  it("holds back a job whose campaign was archived behind its back, reopening nothing", async () => {
    const h = await startLive();
    const { seeded, postId } = await scheduledPost(h, ["INSTAGRAM"], (client) =>
      connectMetaAccounts(h, client),
    );
    const { INSTAGRAM: job } = await jobsOf(postId);
    // Archived without the service, which would have cancelled the job itself.
    await testDb().campaign.update({
      where: { id: seeded.campaignId },
      data: { status: "ARCHIVED" },
    });

    await tickAt(h, IG_TUESDAY_1100);
    const held = await waitForJobs(h, postId, "CANCELLED", ["INSTAGRAM"]);
    expect(held.INSTAGRAM).toMatchObject({
      id: job!.id,
      lastError: PUBLISH_CANCEL_REASONS.campaignArchived,
      liveUrl: null,
    });
    const post = await waitForPostStatus(h, postId, "APPROVED");
    expect(post.needsAttention).toBe(false);
    expect(await testDb().approvalRequest.count({ where: { postId, status: "PENDING" } })).toBe(0);
    expect((await publisherNotes(seeded.threadId)).at(-1)).toBe(
      "I held back p1 on Instagram: The post's campaign is archived.",
    );
    expect(graph!.calls).toEqual([]);

    // Nothing schedules it again.
    await tickAt(h, new Date(Date.parse(IG_TUESDAY_1100) + 10 * MINUTE_MS).toISOString());
    expect((await jobsOf(postId)).INSTAGRAM!.status).toBe("CANCELLED");
    expect(await alerts()).toEqual([]);
  }, 90_000);

  it("fails a live job whose token expired, marks the account, and publishes on a retry once reconnected", async () => {
    const h = await startLive();
    const { seeded, postId } = await scheduledPost(h, ["INSTAGRAM"], (client) =>
      connectMetaAccounts(h, client, { tokenExpiresAt: new Date("2027-03-02T00:00:00Z") }),
    );
    const { INSTAGRAM: job } = await jobsOf(postId);
    expect(job).toMatchObject({ dryRun: false });

    await tickAt(h, IG_TUESDAY_1100);
    const failed = await waitForPostStatus(h, postId, "FAILED");
    const reason =
      "The Instagram account's token expired on 2027-03-02T00:00:00.000Z; reconnect it";
    expect(failed).toMatchObject({ needsAttention: true, attentionReason: reason });
    expect((await jobsOf(postId)).INSTAGRAM).toMatchObject({
      status: "FAILED",
      attempts: 1,
      lastError: reason,
    });
    const account = await testDb().socialAccount.findUniqueOrThrow({
      where: { id: job!.socialAccountId! },
    });
    expect(account.status).toBe("EXPIRED");
    expect((await alertsAfter(h, 2)).map((alert) => [alert.kind, alert.entityType])).toEqual([
      ["token_expiring", "SocialAccount"],
      ["failed", "PublishJob"],
    ]);
    expect((await publisherNotes(seeded.threadId)).at(-1)).toBe(
      `I couldn't publish p1 on Instagram: ${reason}. Retry it from the calendar once that's sorted.`,
    );
    expect(graph!.calls).toEqual([]);

    // Reconnected; the retry (as POST /publish-jobs/:id/retry does it) goes out.
    await testDb().socialAccount.update({
      where: { id: account.id },
      data: { status: "ACTIVE", tokenExpiresAt: null },
    });
    const events = new EventBatch();
    await h.deps.prisma.$transaction(async (tx) => {
      await tx.publishJob.update({ where: { id: job!.id }, data: { status: "QUEUED" } });
      await syncPostPublishStatus(tx, events, postId);
    });
    expect((await testDb().post.findUniqueOrThrow({ where: { id: postId } })).status).toBe(
      "SCHEDULED",
    );
    await enqueuePublishRun(h.deps.queues, { publishJobId: job!.id, attempt: 2 });
    const live = await waitForPostStatus(h, postId, "LIVE");
    expect(live).toMatchObject({ needsAttention: false, attentionReason: null });
    expect((await jobsOf(postId)).INSTAGRAM).toMatchObject({
      status: "PUBLISHED",
      attempts: 2,
      lastError: null,
    });
  }, 90_000);
});

describe("dry run or live, settled at the slot", () => {
  it("publishes a job scheduled live as a dry run once publishing is switched off, and says so", async () => {
    // Both processes share the storage the takes were rendered into, as a deploy would.
    const storage = { STORAGE_LOCAL_DIR: await mkdtemp(path.join(tmpdir(), "enmo-kill-switch-")) };
    onTestFinished(() => rm(storage.STORAGE_LOCAL_DIR, { recursive: true, force: true }));
    const live = await startLive(storage);
    const { seeded, postId } = await scheduledPost(live, ["INSTAGRAM"], (client) =>
      connectMetaAccounts(live, client),
    );
    expect((await jobsOf(postId)).INSTAGRAM).toMatchObject({ dryRun: false });
    // The kill switch: the next process runs with PUBLISH_MODE=dry-run.
    await live.stop();
    harness = undefined;
    const h = await start({ env: storage });

    await tickAt(h, IG_TUESDAY_1100);
    await waitForPostStatus(h, postId, "LIVE");
    const { INSTAGRAM: job } = await jobsOf(postId);
    expect(job).toMatchObject({
      status: "PUBLISHED",
      dryRun: true,
      externalId: `dryrun_${job!.variantId}`,
      liveUrl: `https://dryrun.enmo.marketing/instagram/${job!.variantId}`,
    });
    expect(graph!.calls).toEqual([]);
    expect((await publisherNotes(seeded.threadId)).at(-1)).toBe(
      `p1 is live.\nInstagram: ${job!.liveUrl} (dry run)`,
    );
  }, 90_000);

  it("publishes for real a post scheduled before its account was connected", async () => {
    const h = await startLive();
    const { seeded, postId } = await scheduledPost(h);
    expect((await jobsOf(postId)).INSTAGRAM).toMatchObject({
      dryRun: true,
      socialAccountId: null,
    });
    expect((await publisherNotes(seeded.threadId)).at(-1)).toContain(
      "[dry run: no Instagram account connected]",
    );
    const { instagram } = await connectMetaAccounts(h, seeded.client);

    await tickAt(h, IG_TUESDAY_1100);
    await waitForPostStatus(h, postId, "LIVE");
    const [media] = [...graph!.state.media.values()];
    expect((await jobsOf(postId)).INSTAGRAM).toMatchObject({
      status: "PUBLISHED",
      dryRun: false,
      socialAccountId: instagram.id,
      externalId: media!.id,
      liveUrl: media!.permalink,
    });
  }, 90_000);

  it("fails a live publish still processing once publishing is switched off, faking nothing", async () => {
    const h = await startLive();
    const { postId } = await scheduledPost(h, ["INSTAGRAM"], (client) =>
      connectMetaAccounts(h, client),
    );
    graph!.state.containerPolls = 10_000;
    await tickAt(h, IG_TUESDAY_1100);
    const publishing = await h.waitFor(async () => {
      const { INSTAGRAM: job } = await jobsOf(postId);
      return job?.status === "PUBLISHING" && job.containerId ? job : null;
    });

    const switchedOff = {
      ...h.deps,
      publishers: { ...h.deps.publishers, INSTAGRAM: new DryRunPublisher("INSTAGRAM") },
    };
    const result = await pollPublish(
      switchedOff,
      { publishJobId: publishing.id, attempt: 1, poll: 1 },
      { isLast: false },
    );
    expect(result).toBe("failed");
    const { INSTAGRAM: failed } = await jobsOf(postId);
    expect(failed).toMatchObject({ status: "FAILED", dryRun: false, liveUrl: null });
    expect(failed!.lastError).toMatch(/^Instagram publishing was switched to dry run /);
  }, 90_000);
});

describe("the live publisher's failures", () => {
  it("retries a transient error automatically on the same container", async () => {
    const h = await startLive();
    const { postId } = await scheduledPost(h, ["INSTAGRAM"], (client) =>
      connectMetaAccounts(h, client),
    );
    graph!.failNext({
      match: /^POST \/v26\.0\/\d+\/media_publish$/,
      status: 500,
      error: GRAPH_ERRORS.unavailable,
    });

    await tickAt(h, IG_TUESDAY_1100);
    const retrying = await h.waitFor(async () => {
      const { INSTAGRAM: job } = await jobsOf(postId);
      return job?.status === "QUEUED" && job.lastError ? job : null;
    });
    expect(retrying.attempts).toBe(1);
    expect(retrying.lastError).toMatch(/^Instagram is unavailable: /);
    expect(retrying.containerId).toBeTruthy();

    const published = await waitForJobs(h, postId, "PUBLISHED", ["INSTAGRAM"]);
    expect(published.INSTAGRAM).toMatchObject({ attempts: 2, lastError: null });
    await waitForPostStatus(h, postId, "LIVE");
    // The automatic retry runs in the chain its first attempt began.
    const retried = await h.deps.queues
      .queue("ops")
      .getJob(jobIds.publishRun({ publishJobId: retrying.id, attempt: 2 }));
    expect(retried?.data).toEqual({ publishJobId: retrying.id, attempt: 2, firstAttempt: 1 });
    const calls = graph!.sequence();
    expect(calls.filter((call) => /\/media$/.test(call))).toHaveLength(1);
    expect(calls.filter((call) => /\/media_publish$/.test(call))).toHaveLength(2);
  }, 90_000);

  it("fails at once on a permanent refusal, with an alert and the post FAILED", async () => {
    const h = await startLive();
    const { seeded, postId } = await scheduledPost(h, ["INSTAGRAM"], (client) =>
      connectMetaAccounts(h, client),
    );
    graph!.failNext({
      match: /^POST \/v26\.0\/\d+\/media$/,
      status: 400,
      error: {
        message: "(#100) The image could not be downloaded",
        type: "OAuthException",
        code: 100,
      },
    });

    await tickAt(h, IG_TUESDAY_1100);
    const failed = await waitForPostStatus(h, postId, "FAILED");
    const { INSTAGRAM: job } = await jobsOf(postId);
    expect(job).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(job!.lastError).toMatch(/^Instagram /);
    expect(failed.attentionReason).toBe(job!.lastError);
    const [alert] = await alertsAfter(h, 1);
    expect(alert).toMatchObject({ kind: "failed", entityType: "PublishJob", entityId: job!.id });
    expect((await publisherNotes(seeded.threadId)).at(-1)).toMatch(
      /^I couldn't publish p1 on Instagram: .*Retry it from the calendar once that's sorted\.$/,
    );
  }, 90_000);

  it("marks the account EXPIRED when Meta refuses its token mid-publish", async () => {
    const h = await startLive();
    let token = "";
    const { postId } = await scheduledPost(h, ["INSTAGRAM"], async (client) => {
      token = (await connectMetaAccounts(h, client)).token;
    });
    graph!.state.invalidTokens.add(token);

    await tickAt(h, IG_TUESDAY_1100);
    await waitForPostStatus(h, postId, "FAILED");
    const { INSTAGRAM: job } = await jobsOf(postId);
    expect(job!.lastError).toMatch(/^Instagram refused the account's token: /);
    const account = await testDb().socialAccount.findUniqueOrThrow({
      where: { id: job!.socialAccountId! },
    });
    expect(account.status).toBe("EXPIRED");
    expect((await alertsAfter(h, 2)).map((alert) => alert.kind).sort()).toEqual([
      "failed",
      "token_expiring",
    ]);
  }, 90_000);

  it("polls media the platform is still processing until it is live", async () => {
    const h = await startLive();
    const { postId } = await scheduledPost(h, ["INSTAGRAM"], (client) =>
      connectMetaAccounts(h, client),
    );
    graph!.state.containerPolls = 2;

    await tickAt(h, IG_TUESDAY_1100);
    await waitForPostStatus(h, postId, "LIVE");
    const [container] = [...graph!.state.containers.values()];
    const statusReads = graph!.sequence().filter((call) => call === `GET /v26.0/${container!.id}`);
    expect(statusReads).toHaveLength(3);
    expect((await jobsOf(postId)).INSTAGRAM).toMatchObject({ status: "PUBLISHED", attempts: 1 });
  }, 90_000);

  it("fails a publish the platform is still processing after PUBLISH_POLL_MAX_MIN", async () => {
    const h = await startLive();
    const { postId } = await scheduledPost(h, ["INSTAGRAM"], (client) =>
      connectMetaAccounts(h, client),
    );
    graph!.state.containerPolls = 10_000;

    await tickAt(h, IG_TUESDAY_1100);
    const publishing = await h.waitFor(async () => {
      const { INSTAGRAM: job } = await jobsOf(postId);
      return job?.status === "PUBLISHING" && job.containerId ? job : null;
    });
    // The last poll the budget allows, as the poll chain would reach it.
    const last = publishPollMaxPolls(h.deps.config);
    const result = await pollPublish(
      h.deps,
      { publishJobId: publishing.id, attempt: 1, poll: last },
      { isLast: false },
    );
    expect(result).toBe("failed");
    expect((await jobsOf(postId)).INSTAGRAM).toMatchObject({
      status: "FAILED",
      lastError: "Instagram was still processing the media after 10 min",
    });
    await waitForPostStatus(h, postId, "FAILED");
  }, 90_000);
});

/** A post with one job in `status`, written straight to the database (no worker involved). */
async function seedJobRow(
  h: Harness,
  input: {
    status: "QUEUED" | "PUBLISHING";
    platform?: Platform;
    attempts?: number;
    containerId?: string | null;
  },
) {
  const platform = input.platform ?? "INSTAGRAM";
  const admin = await createUser({ role: "ADMIN" });
  const client = await createClient({ name: "Qahwa Co" });
  const campaign = await testDb().campaign.create({
    data: { clientId: client.id, name: "Iced", status: "ACTIVE", createdById: admin.id },
  });
  const post = await testDb().post.create({
    data: {
      campaignId: campaign.id,
      clientId: client.id,
      ref: "p1",
      type: "STATIC",
      platforms: [platform],
      status: input.status === "QUEUED" ? "SCHEDULED" : "PUBLISHING",
      approvedAt: h.clock.now(),
    },
  });
  const variant = await testDb().postVariant.create({
    data: {
      postId: post.id,
      platform,
      format: platform === "FACEBOOK" ? "SQUARE_1_1" : "PORTRAIT_4_5",
      caption: "Iced.",
    },
  });
  const job = await testDb().publishJob.create({
    data: {
      variantId: variant.id,
      platform,
      status: input.status,
      scheduledFor: h.clock.now(),
      slotSource: "optimizer",
      dryRun: true,
      attempts: input.attempts ?? 1,
      containerId: input.containerId ?? null,
    },
  });
  return { post, job };
}

/**
 * Takes the waiting ops job `jobId` as a worker would and fails it for good, as BullMQ keeps a run
 * whose last attempt threw (e.g. the database was down for longer than its backoff).
 */
async function failRun(h: Harness, jobId: string, reason: string): Promise<void> {
  const connection = createWorkerConnection(h.deps.config.REDIS_URL, h.deps.logger);
  const worker = new Worker("ops", null, { connection, prefix: h.deps.queues.prefix });
  try {
    const token = `test-${jobId}`;
    const job = await worker.getNextJob(token, { block: false });
    expect(job?.id).toBe(jobId);
    await job!.moveToFailed(new UnrecoverableError(reason), token);
    expect(await job!.getState()).toBe("failed");
  } finally {
    await worker.close();
    await closeRedis(connection);
  }
}

describe("tick.publish", () => {
  it("fails a PUBLISHING job nothing is working on any more, as stuck", async () => {
    const h = await start({ workers: false });
    const { post, job } = await seedJobRow(h, {
      status: "PUBLISHING",
      containerId: "IG_IMAGE;items=1",
    });

    await h.runTick("tick.publish");
    expect(await testDb().publishJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "FAILED",
      lastError: "publishing stalled with nothing left working on it; retry it to resume",
      containerId: "IG_IMAGE;items=1",
    });
    expect((await testDb().post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe(
      "FAILED",
    );
    expect((await alerts()).map((alert) => [alert.kind, alert.entityId])).toEqual([
      ["stuck", job.id],
    ]);
  });

  it("tells people to check the Page before retrying a Facebook post that stalled mid-publish", async () => {
    const h = await start({ workers: false });
    const { job } = await seedJobRow(h, {
      status: "PUBLISHING",
      platform: "FACEBOOK",
      containerId: "FB_PHOTO;posting",
    });
    await h.runTick("tick.publish");
    expect(await testDb().publishJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "FAILED",
      lastError:
        "publishing stalled right after Facebook was sent the post, so it may be live already: check Facebook, then retry to post it again, or cancel the job",
    });
  });

  it("re-drives a QUEUED job whose run gave up once, and fails it with an alert when that gives up too", async () => {
    const h = await start({ workers: false });
    const { post, job } = await seedJobRow(h, { status: "QUEUED", attempts: 0 });
    const ops = h.deps.queues.queue("ops");
    const run = { publishJobId: job.id, attempt: 1 };
    await enqueuePublishRun(h.deps.queues, run);
    await failRun(h, jobIds.publishRun(run), "Can't reach database server at 127.0.0.1:54329");

    // The failed run keeps its id for a week, so a plain re-add would do nothing: a new id.
    await h.runTick("tick.publish");
    const sweep = jobIds.publishRun(run, "sweep");
    expect(await (await ops.getJob(sweep))?.getState()).toBe("waiting");
    expect(await testDb().publishJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "QUEUED",
      attempts: 0,
    });
    // While it waits, later ticks leave it be.
    await h.runTick("tick.publish");
    expect(await ops.getJobCountByTypes("waiting", "failed")).toBe(2);

    await failRun(h, sweep, "Can't reach database server at 127.0.0.1:54329");
    await h.runTick("tick.publish");
    expect(await testDb().publishJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "FAILED",
      attempts: 1,
      lastError:
        "publishing couldn't start (Can't reach database server at 127.0.0.1:54329); retry it",
    });
    expect((await testDb().post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe(
      "FAILED",
    );
    expect((await alerts()).map((alert) => [alert.kind, alert.entityId])).toEqual([
      ["stuck", job.id],
    ]);
    // Settled: nothing more is queued for it.
    await h.runTick("tick.publish");
    expect(await ops.getJobCountByTypes("waiting", "delayed")).toBe(0);
  });

  it("fails a QUEUED job whose run can't claim it on BullMQ's last attempt", async () => {
    const h = await start({ workers: false });
    const { job } = await seedJobRow(h, { status: "QUEUED", attempts: 0 });
    // The claim's transaction fails (a timeout, an outage); what comes after it works again.
    const prisma = h.deps.prisma;
    let broken = 0;
    const flaky = new Proxy(prisma, {
      get(target, property) {
        if (property === "$transaction" && broken > 0) {
          broken -= 1;
          return () => Promise.reject(new Error("Transaction API error: Transaction already closed"));
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? (value as () => unknown).bind(target) : value;
      },
    });
    const deps = { ...h.deps, prisma: flaky };
    const data = { publishJobId: job.id, attempt: 1 };

    broken = 1;
    await expect(runPublish(deps, data, { isLast: false })).rejects.toThrow(/Transaction/);
    expect((await testDb().publishJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe(
      "QUEUED",
    );

    broken = 1;
    await expect(runPublish(deps, data, { isLast: true })).rejects.toThrow(/Transaction/);
    expect(await testDb().publishJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "FAILED",
      attempts: 1,
      lastError:
        "publishing couldn't start (Transaction API error: Transaction already closed); retry it",
    });
    expect((await alerts()).map((alert) => [alert.kind, alert.entityId])).toEqual([
      ["stuck", job.id],
    ]);
  });

  it("flags an approved post whose re-driven publisher.schedule gave up too, and stops re-driving it", async () => {
    const h = await start({ workers: false });
    const seeded = await seedMetaPlan(h, { platforms: ["INSTAGRAM"] });
    const post = await testDb().post.create({
      data: {
        campaignId: seeded.campaignId,
        clientId: seeded.client.id,
        ref: "p9",
        type: "STATIC",
        platforms: ["INSTAGRAM"],
        status: "APPROVED",
        approvedAt: h.clock.now(),
      },
    });
    await testDb().approvalRequest.create({
      data: {
        postId: post.id,
        round: 1,
        status: "APPROVED",
        chain: [],
        currentStep: 0,
        contentHash: "fixture",
        resolvedAt: h.clock.now(),
      },
    });
    const agents = h.deps.queues.queue("agents");
    const failSchedule = async (id: string) => {
      const connection = createWorkerConnection(h.deps.config.REDIS_URL, h.deps.logger);
      const worker = new Worker("agents", null, { connection, prefix: h.deps.queues.prefix });
      try {
        const token = `test-${id}`;
        const job = await worker.getNextJob(token, { block: false });
        expect(job?.id).toBe(id);
        await job!.moveToFailed(new UnrecoverableError("LLM budget store unreachable"), token);
      } finally {
        await worker.close();
        await closeRedis(connection);
      }
    };
    const later = (minutes: number) =>
      new Date(Date.parse(NOW) + minutes * MINUTE_MS).toISOString();

    await tickAt(h, later(6));
    const sweep = jobIds.publisherSchedule({ postId: post.id, round: 1 }, "sweep");
    expect(await (await agents.getJob(sweep))?.getState()).toBe("waiting");
    await failSchedule(sweep);

    await tickAt(h, later(7));
    const flagged = await testDb().post.findUniqueOrThrow({ where: { id: post.id } });
    expect(flagged).toMatchObject({
      status: "APPROVED",
      needsAttention: true,
      attentionReason: "The Publisher couldn't schedule it: LLM budget store unreachable",
    });
    expect(await alerts()).toEqual([
      expect.objectContaining({
        kind: "failed",
        entityType: "Post",
        entityId: post.id,
        message:
          "The Publisher couldn't schedule p9: LLM budget store unreachable. Pick its days on the calendar.",
      }),
    ]);
    await tickAt(h, later(8));
    expect(await agents.getJobCountByTypes("waiting", "delayed")).toBe(0);
    expect(await alerts()).toHaveLength(1);
  });

  it("re-drives an approved post whose publisher.schedule never ran", async () => {
    const h = await start();
    const seeded = await seedMetaPlan(h, { platforms: ["INSTAGRAM"] });
    const [post] = await runToApproval(h, seeded);
    const postId = post!.id;
    // Approved in the database alone: the post-commit enqueue never happened.
    await testDb().approvalRequest.updateMany({
      where: { postId },
      data: { status: "APPROVED", resolvedAt: h.clock.now() },
    });
    await testDb().post.update({
      where: { id: postId },
      data: { status: "APPROVED", approvedAt: h.clock.now() },
    });

    await tickAt(h, new Date(Date.parse(NOW) + MINUTE_MS).toISOString());
    expect(
      await h.deps.queues
        .queue("agents")
        .getJob(jobIds.publisherSchedule({ postId, round: 1 }, "sweep")),
    ).toBeUndefined();

    await tickAt(h, new Date(Date.parse(NOW) + 6 * MINUTE_MS).toISOString());
    await waitForPostStatus(h, postId, "SCHEDULED");
    expect(
      await h.deps.queues
        .queue("agents")
        .getJob(jobIds.publisherSchedule({ postId, round: 1 }, "sweep")),
    ).toBeDefined();
    // Scheduled once: later ticks leave it be.
    await h.runTick("tick.publish");
    expect(await testDb().publishJob.count()).toBe(1);
  }, 90_000);

  it("keeps posts approved together four hours apart, at most two a day", async () => {
    // Every Publisher call waits for the other two, so all three pick Tuesday 11:00 at once and
    // the slot re-check under the client's lock has to sort them out.
    const llm = new PublisherBarrierLlm(3);
    const h = await start({ llm });
    const seeded = await seedMetaPlan(h, {
      postCount: 3,
      platforms: ["INSTAGRAM"],
      sameTargetDate: true,
    });
    const posts = await runToApproval(h, seeded);
    const pending = await testDb().approvalRequest.findMany({ where: { status: "PENDING" } });
    const all = await apiFor(h, seeded.cookie)<ApproveAllResponse>(
      "POST",
      "/v1/approvals/approve-all",
      { requestIds: pending.map((request) => request.id) },
    );
    expect(all.approvedCount).toBe(3);
    for (const post of posts) await waitForPostStatus(h, post.id, "SCHEDULED");
    expect(llm.released).toBe(true);

    const jobs = await testDb().publishJob.findMany({ orderBy: { scheduledFor: "asc" } });
    // Tuesday (the target) takes its two best hours, 11:00 and 19:00; the third goes to Wednesday
    // 11:00, the next day of the window (it opens on Tuesday) with a peak left.
    expect(jobs.map((job) => job.scheduledFor.toISOString())).toEqual([
      IG_TUESDAY_1100,
      "2027-03-02T16:00:00.000Z",
      "2027-03-03T08:00:00.000Z",
    ]);
    expect(jobs.map((job) => job.slotSource)).toEqual(["publisher", "optimizer", "optimizer"]);
    for (const job of jobs.slice(1)) {
      expect(job.slotReason).toMatch(/^Tue 2 Mar 11:00 was taken meanwhile\. Top-scored slot: /);
    }
  }, 90_000);
});

/** MockLlm, except PUBLISHER calls are held until `parties` of them are waiting (or 10s pass). */
class PublisherBarrierLlm implements LlmClient {
  readonly provider = "mock" as const;
  readonly #mock = new MockLlm();
  readonly model = this.#mock.model;
  readonly #waiting: (() => void)[] = [];
  released = false;

  constructor(private readonly parties: number) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (request.meta.agent === "PUBLISHER") {
      await new Promise<void>((resolve) => {
        this.#waiting.push(resolve);
        if (this.#waiting.length >= this.parties) {
          this.released = true;
          for (const release of this.#waiting.splice(0)) release();
        } else {
          setTimeout(resolve, 10_000);
        }
      });
    }
    return this.#mock.complete(request);
  }
}

describe("tick.tokens", () => {
  it("checks each Meta account once a day and flags revoked, lapsed and expiring tokens", async () => {
    graph = await startFakeGraph();
    const h = await start({
      clock: new FakeClock(),
      publishMode: "live",
      metaBaseUrl: graph.url,
      workers: false,
    });
    const client = await createClient({ name: "Qahwa Co" });
    const { instagram, facebook, token } = await connectMetaAccounts(h, client);
    const debugged = () =>
      graph!.calls
        .filter((call) => call.path.endsWith("/debug_token"))
        .map((call) => call.query.input_token);

    await h.runTick("tick.tokens");
    expect(debugged()).toEqual([token, token]);
    for (const id of [instagram.id, facebook.id]) {
      expect(await testDb().socialAccount.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: "ACTIVE",
        lastCheckedAt: h.clock.now(),
      });
    }
    expect(await alerts()).toEqual([]);

    // Checked within the last day: left alone, even though Meta has revoked the token since.
    graph.state.invalidTokens.add(token);
    h.clock.advance(HOUR_MS);
    await h.runTick("tick.tokens");
    expect(debugged()).toHaveLength(2);

    h.clock.advance(DAY_MS);
    await h.runTick("tick.tokens");
    expect(debugged()).toHaveLength(4);
    const revoked = await testDb().socialAccount.findMany({ where: { clientId: client.id } });
    expect(revoked.map((account) => account.status)).toEqual(["REVOKED", "REVOKED"]);
    const flagged = await alerts();
    expect(flagged.map((alert) => [alert.kind, alert.entityType])).toEqual([
      ["token_expiring", "SocialAccount"],
      ["token_expiring", "SocialAccount"],
    ]);
    expect(flagged[0]!.message).toMatch(
      /is revoked: .*Reconnect it; nothing can publish through it until then\.$/,
    );

    // A token whose stored expiry has passed is EXPIRED without asking Meta.
    const other = await createClient({ name: "Other Co" });
    const lapsed = await testDb().socialAccount.create({
      data: {
        clientId: other.id,
        platform: "FACEBOOK",
        externalId: "100000000000099",
        handle: "Other Co",
        accessTokenEnc: h.deps.tokenCipher.encrypt("lapsed-token"),
        tokenExpiresAt: new Date(h.clock.now().getTime() - MINUTE_MS),
      },
    });
    // One Meta says expires in three days: still ACTIVE, with a warning.
    const soon = "expiring-page-token";
    graph.state.tokens.set(soon, {
      type: "PAGE",
      subjectId: "100000000000098",
      userId: graph.state.user.id,
      scopes: ["pages_manage_posts", "pages_read_engagement"],
      expiresAt: Math.floor(h.clock.now().getTime() / 1000) + 3 * 24 * 3600,
    });
    const expiring = await testDb().socialAccount.create({
      data: {
        clientId: other.id,
        platform: "FACEBOOK",
        externalId: "100000000000098",
        handle: "Other Co Events",
        accessTokenEnc: h.deps.tokenCipher.encrypt(soon),
      },
    });
    await h.runTick("tick.tokens");
    expect(debugged().slice(4)).toEqual([soon]);
    expect(
      await testDb().socialAccount.findUniqueOrThrow({ where: { id: lapsed.id } }),
    ).toMatchObject({
      status: "EXPIRED",
    });
    const warned = await testDb().socialAccount.findUniqueOrThrow({ where: { id: expiring.id } });
    expect(warned.status).toBe("ACTIVE");
    expectSameInstant(
      warned.tokenExpiresAt,
      new Date((Math.floor(h.clock.now().getTime() / 1000) + 3 * 24 * 3600) * 1000).toISOString(),
    );
    const latest = (await alerts()).slice(2).map((alert) => [alert.entityId, alert.message]);
    expect(latest).toEqual(
      expect.arrayContaining([
        [
          lapsed.id,
          "Facebook account Other Co is expired: its token expired. Reconnect it; nothing can publish through it until then.",
        ],
        [
          expiring.id,
          "Facebook account Other Co Events: its token expires in 3 days; reconnect it before then.",
        ],
      ]),
    );
  });
});
