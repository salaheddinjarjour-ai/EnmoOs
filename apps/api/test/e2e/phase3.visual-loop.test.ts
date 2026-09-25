import { MockLlm, type LlmClient, type LlmRequest, type LlmResponse } from "@enmo/agents";
import { MockProvider } from "@enmo/providers";
import {
  AssetParams,
  AssetReview,
  VisualDirectInput,
  type AgentTaskDto,
  type ApprovalListResponse,
  type ApprovalRequestDto,
  type ManagerQaInput,
  type ManagerQaOutput,
  type TaskGraphDto,
} from "@enmo/shared";
import { afterEach, describe, expect, it } from "vitest";
import { jobIds } from "../../src/jobs/queues";
import { MINUTE_MS } from "../../src/lib/clock";
import { currentContentHash } from "../../src/orchestrator/approval-round";
import { nextUtcMidnight, utcDay, utcDayStart } from "../../src/services/budget";
import { browserHeaders } from "../helpers/app";
import { sessionCookieFor } from "../helpers/auth";
import { testDb } from "../helpers/db";
import { createAsset, createClient, createUser } from "../helpers/factories";
import { seedCampaign, testCopy } from "../helpers/route-fixtures";
import {
  seedProposedPlan,
  startHarness,
  type Harness,
  type HarnessOptions,
} from "../helpers/harness";

/*
 * The visual loop's other paths, on the Phase 3 pipeline (write → direct → qa):
 *   - Request Changes with target BOTH reaches the Visual Director verbatim too, and each shot
 *     continues its lineage as the next version; target VISUAL re-runs only direct.rN → qa.rN
 *     with the feedback verbatim; QA's visual issues re-run direct → qa;
 *   - a render the provider refuses escalates the task, one it fails on fails it, and a retry
 *     re-plans once the provider is back;
 *   - the sweeper re-drives a render whose poll job was lost;
 *   - a review stopped by the daily token budget waits for UTC midnight with the task WAITING;
 *   - a Vault regenerate on a post outside any plan runs as visual.regenerate and reopens approval.
 */

/** MockLlm, except that the Manager's first QA sends the post's visuals back once. */
class QaSendsVisualsBackLlm implements LlmClient {
  readonly provider = "mock" as const;
  readonly #mock = new MockLlm();
  readonly model = this.#mock.model;
  readonly qaInputs: ManagerQaInput[] = [];

  complete(request: LlmRequest): Promise<LlmResponse> {
    if (request.meta.agent !== "MANAGER" || request.meta.action !== "qa") {
      return this.#mock.complete(request);
    }
    const input = request.meta.input as ManagerQaInput;
    this.qaInputs.push(input);
    if (this.qaInputs.length > 1) return this.#mock.complete(request);
    const output: ManagerQaOutput = {
      verdict: "revise",
      issues: [
        {
          target: "VISUAL_DIRECTOR",
          field: "shots[0].prompt",
          problem: "The glass is lost in the frame.",
          instruction: "Frame the glass tight and centred.",
        },
      ],
      summaryForReviewer: "Sent the visual back once.",
    };
    return Promise.resolve({
      text: JSON.stringify(output),
      stopReason: "end_turn",
      refusal: null,
      usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: `mock:${request.model}`,
      latencyMs: 1,
    });
  }
}

const ACCEPTED = { verdict: "accept" as const, score: 8, issues: [], revisedPrompt: null };

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

function apiFor(h: Harness, cookie: string) {
  const headers = browserHeaders(cookie);
  return async <T>(method: "GET" | "POST", url: string, payload?: object) => {
    const response = await h.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    if (response.statusCode >= 300) {
      throw new Error(`${method} ${url} → ${response.statusCode}: ${response.body}`);
    }
    return { status: response.statusCode, body: response.json<T>() };
  };
}

async function start(options: HarnessOptions, type: "STATIC" | "CAROUSEL" | "REEL" = "STATIC") {
  const h = (harness = await startHarness(options));
  const seeded = await seedProposedPlan(h, { postCount: 1, type });
  const api = apiFor(h, await sessionCookieFor(seeded.admin, { now: h.clock.now() }));
  await api<TaskGraphDto>("POST", `/v1/task-graphs/${seeded.graphId}/approve`, {});
  const post = await testDb().post.findFirstOrThrow({ where: { campaignId: seeded.campaignId } });
  return { h, seeded, api, postId: post.id };
}

function waitForTask(h: Harness, postId: string, status: string, revision = 0) {
  return h.waitFor(async () => {
    const task = await testDb().agentTask.findFirst({
      where: { postId, action: "direct", revision },
    });
    return task?.status === status ? task : null;
  }, 30_000);
}

function waitForPostStatus(h: Harness, postId: string, status: string) {
  return h.waitFor(async () => {
    const post = await testDb().post.findUniqueOrThrow({ where: { id: postId } });
    return post.status === status ? post : null;
  }, 30_000);
}

describe("phase3 visual loop", () => {
  it("routes BOTH feedback verbatim to the Visual Director and continues every lineage", async () => {
    const { h, api, postId } = await start({}, "CAROUSEL");
    const db = testDb();
    await waitForPostStatus(h, postId, "PENDING_APPROVAL");
    const v1 = await db.asset.findMany({ where: { postId, isCurrent: true } });
    const [request] = (await api<ApprovalListResponse>("GET", "/v1/approvals")).body.items;
    const feedback = "Warmer light across the set, and lose the second slide's clutter.";
    await api<ApprovalRequestDto>("POST", `/v1/approvals/${request!.id}/decision`, {
      decision: "REQUEST_CHANGES",
      feedback,
      target: "BOTH",
    });

    await h.waitFor(() => db.approvalRequest.findFirst({ where: { postId, round: 2 } }), 30_000);
    const revision = await db.agentTask.findMany({ where: { postId, revision: 1 } });
    expect(revision.map((task) => task.action).sort()).toEqual(["direct", "qa", "write"]);
    const direct = revision.find((task) => task.action === "direct")!;
    expect(direct.feedback).toMatchObject({ verbatim: feedback, source: "HUMAN" });
    const input = VisualDirectInput.parse(direct.input);
    expect(input.feedback?.verbatim).toBe(feedback);
    // The previous shot list travels with the feedback while it still covers every slide of the
    // rewritten copy; each slide that is still there continues its lineage as v2.
    const slideOf = (take: { params: unknown }) => AssetParams.parse(take.params).shot!.slideIndex;
    const revisedSlides = input.copy.slides!.map((slide) => slide.index);
    const covered = revisedSlides.every((index) => v1.some((take) => slideOf(take) === index));
    expect(input.previousShots?.map((shot) => shot.slideIndex) ?? null).toEqual(
      covered ? revisedSlides : null,
    );

    const v2 = await db.asset.findMany({ where: { postId, isCurrent: true } });
    expect(v2.map(slideOf).sort()).toEqual([...revisedSlides].sort());
    for (const take of v2) {
      const previous = v1.find((old) => slideOf(old) === slideOf(take));
      expect(take).toMatchObject({
        version: previous ? 2 : 1,
        parentAssetId: previous?.id ?? null,
        rootAssetId: previous?.id ?? take.id,
        regenCount: 0,
        status: "READY",
      });
      expect(take.prompt).toContain(feedback);
      expect(AssetParams.parse(take.params)).toMatchObject({ origin: "direct", taskId: direct.id });
    }
    // The first round's takes stay in the Vault as accepted v1s.
    const old = await db.asset.findMany({ where: { id: { in: v1.map((t) => t.id) } } });
    expect(old.every((take) => take.status === "READY" && !take.isCurrent)).toBe(true);
  }, 60_000);

  it("routes VISUAL feedback verbatim to the Visual Director alone: direct.rN → qa.rN", async () => {
    const { h, api, postId } = await start({}, "CAROUSEL");
    const db = testDb();
    await waitForPostStatus(h, postId, "PENDING_APPROVAL");
    const before = await db.post.findUniqueOrThrow({ where: { id: postId } });
    const v1 = await db.asset.findMany({ where: { postId, isCurrent: true } });
    const [request] = (await api<ApprovalListResponse>("GET", "/v1/approvals")).body.items;
    const feedback = "Moodier: one lamp, deep shadows, the glass sweating.";
    const decided = await api<ApprovalRequestDto>("POST", `/v1/approvals/${request!.id}/decision`, {
      decision: "REQUEST_CHANGES",
      feedback,
      target: "VISUAL",
    });
    const decisionId = decided.body.decisions[0]!.id;

    const roundTwo = await h.waitFor(
      () => db.approvalRequest.findFirst({ where: { postId, round: 2 } }),
      30_000,
    );
    // Just the Visual Director and QA re-run, chained, named after the planned nodes.
    const planned = await db.agentTask.findMany({ where: { postId, revision: 0 } });
    const revision = await db.agentTask.findMany({
      where: { postId, revision: 1 },
      orderBy: { createdAt: "asc" },
    });
    expect(revision.map((task) => [task.action, task.status])).toEqual([
      ["direct", "SUCCEEDED"],
      ["qa", "SUCCEEDED"],
    ]);
    const [direct, qa] = revision;
    const plannedKey = (action: string) => planned.find((task) => task.action === action)!.nodeKey;
    expect(direct!.nodeKey).toBe(`${plannedKey("direct")}.r1`);
    expect(qa!.nodeKey).toBe(`${plannedKey("qa")}.r1`);
    expect(qa!.dependsOn).toEqual([direct!.id]);
    expect(qa!.feedback).toBeNull();

    // The reviewer's words, byte for byte, in the task and in what the Visual Director was sent.
    expect(direct!.feedback).toEqual({ verbatim: feedback, source: "HUMAN", decisionId });
    const run = await db.agentRun.findFirstOrThrow({
      where: { taskId: direct!.id, agent: "VISUAL_DIRECTOR", action: "direct", outcome: "OK" },
    });
    const snapshot = VisualDirectInput.parse(run.inputSnapshot);
    expect(snapshot.feedback).toEqual({ verbatim: feedback, source: "HUMAN", decisionId });
    expect(snapshot.previousShots?.map((shot) => shot.shotId)).toEqual(
      v1
        .map((take) => AssetParams.parse(take.params).shot!)
        .sort((a, b) => a.slideIndex! - b.slideIndex!)
        .map((shot) => shot.shotId),
    );

    // The copy is untouched; every slide continues its lineage as v2, and round 2 approves them.
    const after = await db.post.findUniqueOrThrow({ where: { id: postId } });
    expect(after).toMatchObject({ status: "PENDING_APPROVAL", revision: 1 });
    expect(after.copy).toEqual(before.copy);
    const v2 = await db.asset.findMany({ where: { postId, isCurrent: true } });
    expect(v2).toHaveLength(v1.length);
    for (const take of v2) {
      const previous = v1.find((old) => old.shotId === take.shotId)!;
      expect(take).toMatchObject({ version: 2, parentAssetId: previous.id, status: "READY" });
      expect(take.prompt).toContain(feedback);
    }
    expect(roundTwo.contentHash).toBe(await currentContentHash(db, postId));
    const roundOne = await db.approvalRequest.findUniqueOrThrow({ where: { id: request!.id } });
    expect(roundOne.status).toBe("CHANGES_REQUESTED");
    expect(roundTwo.contentHash).not.toBe(roundOne.contentHash);
  }, 60_000);

  it("escalates a render the provider refuses and fails a task whose render failed", async () => {
    let outcome: "rejected" | "failed" | null = "rejected";
    const visual = new MockProvider({
      outcome: () =>
        outcome === null
          ? null
          : { state: outcome, error: outcome === "rejected" ? "nsfw" : "GPU on fire" },
    });
    const { h, api, postId } = await start({ visual });
    const db = testDb();

    const escalated = await waitForTask(h, postId, "ESCALATED");
    expect(escalated.error).toContain("refused by the mock provider (nsfw)");
    const [refused] = await db.asset.findMany({ where: { postId } });
    expect(refused).toMatchObject({ status: "REJECTED", url: null, isCurrent: true });
    // Nothing rendered, so there is no take to accept.
    const noTake = await h.app.inject({
      method: "POST",
      url: `/v1/agent-tasks/${escalated.id}/resolve`,
      headers: browserHeaders(await sessionCookieFor(await db.user.findFirstOrThrow())),
      payload: { action: "accept_best" },
    });
    expect(noTake.statusCode).toBe(409);

    outcome = "failed";
    await api<AgentTaskDto>("POST", `/v1/agent-tasks/${escalated.id}/resolve`, { action: "retry" });
    const failed = await waitForTask(h, postId, "FAILED");
    expect(failed.error).toContain("couldn't get take 2 of s1 rendered by the mock provider");
    await h.waitFor(() =>
      db.realtimeEvent.findFirst({
        where: { type: "alert", payload: { path: ["entityId"], equals: failed.id } },
      }),
    );

    outcome = null;
    // A retry's job id is stamped with the clock, which only moves when the test says so.
    h.clock.advance(1_000);
    await api<AgentTaskDto>("POST", `/v1/agent-tasks/${failed.id}/resolve`, { action: "retry" });
    await waitForPostStatus(h, postId, "PENDING_APPROVAL");
    const takes = await db.asset.findMany({ where: { postId }, orderBy: { version: "asc" } });
    expect(takes.map((t) => [t.version, t.status, t.isCurrent])).toEqual([
      [1, "REJECTED", false],
      [2, "FAILED", false],
      [3, "READY", true],
    ]);
  }, 60_000);

  it("re-drives a render whose poll job was lost", async () => {
    // Slow polls leave a window to lose the job in.
    const { h, postId } = await start({ env: { RENDER_POLL_DELAY_MS: "3000" } });
    const db = testDb();
    const take = await h.waitFor(() =>
      db.asset.findFirst({ where: { postId, status: "RENDERING" } }),
    );
    const media = h.deps.queues.queue("media");
    const poll = await h.waitFor(() =>
      media.getJob(jobIds.renderPoll({ assetId: take.id, attempt: 1 })),
    );
    await poll.remove();

    h.clock.advance(4 * MINUTE_MS);
    await h.runTick("tick.sweeper");
    expect(await media.getJobs(["delayed", "waiting"])).toEqual([]);

    h.clock.advance(2 * MINUTE_MS);
    await h.runTick("tick.sweeper");
    expect(await media.getJob(jobIds.renderPoll({ assetId: take.id, attempt: 1 }))).toBeDefined();
    await waitForPostStatus(h, postId, "PENDING_APPROVAL");
    const done = await db.asset.findUniqueOrThrow({ where: { id: take.id } });
    expect(done).toMatchObject({ status: "READY", isCurrent: true });
    expect(AssetReview.parse(done.review).verdict).toBe("accept");
  }, 60_000);

  it("defers a review the token budget stops until UTC midnight, with the task WAITING", async () => {
    const { h, postId } = await start({ env: { RENDER_POLL_DELAY_MS: "3000" } });
    const db = testDb();
    const take = await h.waitFor(() =>
      db.asset.findFirst({ where: { postId, status: "RENDERING" } }),
    );
    // Today's budget runs out while the take renders.
    const day = utcDayStart(h.clock.now());
    const cap = BigInt(h.deps.config.DAILY_TOKEN_CAP);
    await db.tokenUsage.upsert({
      where: { day },
      create: { day, inputTokens: cap, outputTokens: 0n, calls: 1 },
      update: { inputTokens: cap },
    });

    const resumeAt = nextUtcMidnight(h.clock.now());
    const deferred = await h.waitFor(
      () =>
        h.deps.queues
          .queue("agents")
          .getJob(`${jobIds.visualReview({ assetId: take.id })}-budget-${utcDay(resumeAt)}`),
      30_000,
    );
    expect(await deferred.isDelayed()).toBe(true);
    expect(deferred.opts.delay).toBeGreaterThan(resumeAt.getTime() - h.clock.now().getTime());
    const waiting = await db.agentTask.findFirstOrThrow({ where: { postId, action: "direct" } });
    expect(waiting.status).toBe("WAITING");
    expect((await db.asset.findUniqueOrThrow({ where: { id: take.id } })).review).toBeNull();

    // The day rolls over: the review runs and the post moves on.
    await db.tokenUsage.update({ where: { day }, data: { inputTokens: 0n } });
    await deferred.promote();
    await waitForPostStatus(h, postId, "PENDING_APPROVAL");
    expect(
      AssetReview.parse((await db.asset.findUniqueOrThrow({ where: { id: take.id } })).review),
    ).toMatchObject({ verdict: "accept" });
  }, 60_000);

  it("regenerates a take of a post outside any plan through visual.regenerate", async () => {
    const h = (harness = await startHarness({}));
    const db = testDb();
    const admin = await createUser({ role: "ADMIN" });
    const client = await createClient({ name: "Qahwa Co" });
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
      review: { ...ACCEPTED, attempt: 1, reviewedAt: h.clock.now().toISOString() },
    });
    const round = await db.approvalRequest.create({
      data: {
        postId: post.id,
        round: 1,
        chain: client.approvalChain ?? {},
        contentHash: await currentContentHash(db, post.id),
      },
    });
    const api = apiFor(h, await sessionCookieFor(admin, { now: h.clock.now() }));

    const { body: v2 } = await api<{ id: string; version: number }>(
      "POST",
      `/v1/assets/${v1.id}/regenerate`,
      { instruction: "Warmer" },
    );
    expect(v2.version).toBe(2);
    const promoted = await h.waitFor(async () => {
      const take = await db.asset.findUniqueOrThrow({ where: { id: v2.id } });
      return take.isCurrent ? take : null;
    });
    expect(promoted).toMatchObject({ status: "READY", parentAssetId: v1.id, rootAssetId: v1.id });
    expect(AssetParams.parse(promoted.params)).toMatchObject({
      origin: "vault",
      instruction: "Warmer",
      taskId: null,
    });
    expect(AssetParams.parse(promoted.params).pendingDirection).toBeUndefined();
    const run = await db.agentRun.findFirstOrThrow({
      where: { agent: "VISUAL_DIRECTOR", action: "direct" },
    });
    expect(run.taskId).toBeNull();
    expect(VisualDirectInput.parse(run.inputSnapshot)).toMatchObject({
      feedback: { verbatim: "Warmer", source: "HUMAN", decisionId: null },
      previousShots: [AssetParams.parse(v1.params).shot],
    });
    expect((await db.asset.findUniqueOrThrow({ where: { id: v1.id } })).isCurrent).toBe(false);

    // Nothing re-checks a post outside a plan, so its approval reopens on the new take at once.
    const reopened = await h.waitFor(() =>
      db.approvalRequest.findFirst({ where: { postId: post.id, round: 2 } }),
    );
    expect(reopened.contentHash).toBe(await currentContentHash(db, post.id));
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: round.id } })).status).toBe(
      "CANCELLED",
    );
  }, 60_000);

  it("sends QA's visual issues back to the Visual Director as a direct → qa revision", async () => {
    const llm = new QaSendsVisualsBackLlm();
    const { h, postId } = await start({ llm });
    const db = testDb();
    await h.waitFor(() => db.approvalRequest.findFirst({ where: { postId } }), 30_000);

    // QA reviewed the takes it was shown, then the revision re-directed the shot.
    const [first, second] = llm.qaInputs;
    expect(first!.visuals).toHaveLength(1);
    expect(first!.visuals![0]!.shotId).toBe("s1");
    expect(first!.visuals![0]!.reviewScore).toBeGreaterThan(0);
    const revision = await db.agentTask.findMany({ where: { postId, revision: 1 } });
    expect(revision.map((task) => task.action).sort()).toEqual(["direct", "qa"]);
    const direct = revision.find((task) => task.action === "direct")!;
    const feedback = {
      verbatim:
        "shots[0].prompt: The glass is lost in the frame. → Frame the glass tight and centred.",
      source: "QA",
      decisionId: null,
    };
    expect(direct.feedback).toEqual(feedback);
    expect(VisualDirectInput.parse(direct.input)).toMatchObject({ feedback });
    const takes = await db.asset.findMany({ where: { postId }, orderBy: { version: "asc" } });
    expect(takes.map((t) => [t.version, t.isCurrent])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(second!.visuals![0]!.assetId).toBe(takes[1]!.id);
    const post = await db.post.findUniqueOrThrow({ where: { id: postId } });
    expect(post).toMatchObject({ status: "PENDING_APPROVAL", revision: 1 });
  }, 60_000);
});
