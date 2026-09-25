import { MockLlm, type LlmClient, type LlmRequest, type LlmResponse } from "@enmo/agents";
import type { Asset, DbClient, DbTransaction } from "@enmo/db";
import {
  MockProvider,
  type VisualJobStatus,
  type VisualProvider,
  type VisualRequest,
  type VisualSubmitResult,
} from "@enmo/providers";
import {
  AssetParams,
  AssetReview,
  type AgentTaskDto,
  type AlertPayload,
  type PostDto,
  type TaskGraphDto,
  VisualDirectInput,
  type VisualReviewInput,
  type VisualReviewOutput,
} from "@enmo/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Deps } from "../../src/deps";
import { JOB, JOB_QUEUE, type JobName } from "../../src/jobs/queues";
import { processorFor, processors } from "../../src/jobs/registry";
import { MINUTE_MS } from "../../src/lib/clock";
import { currentContentHash } from "../../src/orchestrator/approval-round";
import { failTake } from "../../src/orchestrator/render-outcomes";
import { driveStaleRenders } from "../../src/orchestrator/visual-sweep";
import { RENDER_POLL_MAX_ATTEMPTS } from "../../src/orchestrator/renders";
import { UNFINISHED_STATUSES } from "../../src/orchestrator/tasks";
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
 * The visual loop when things go wrong, on the Phase 3 pipeline (write → direct → qa):
 *   - a Vault regenerate the Visual Director judges weak goes round the same loop as its own takes
 *     (at most MAX_VISUAL_REGENERATIONS regenerations, then an escalation), and the post keeps its
 *     current take until one passes review;
 *   - the Visual Director's contract failures (invalid, refusal) on direct and review, on a planned
 *     post and outside any plan, and the last attempts of every asset job after transport errors;
 *   - renders that never settle, or settle without anything to review;
 *   - the sweeper among many takes nobody waits on any more, and a failed take whose hand-off was
 *     lost; a hand-off that fails rolls the take back with it.
 */

let harness: Harness | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.stop();
  harness = undefined;
});

const INSTRUCTION = "Closer on the glass.";

/**
 * MockLlm, except that the next `weak` reviews come back "regenerate" (scored 3 + attempt), and
 * the `invalid` replies after them break the review's contract (three in a row escalate a review).
 */
class WeakReviewsLlm implements LlmClient {
  readonly provider = "mock" as const;
  readonly #mock = new MockLlm();
  readonly model = this.#mock.model;
  weak = 0;
  invalid = 0;

  complete(request: LlmRequest): Promise<LlmResponse> {
    if (request.meta.agent !== "VISUAL_DIRECTOR" || request.meta.action !== "review") {
      return this.#mock.complete(request);
    }
    if (this.weak === 0 && this.invalid > 0) {
      this.invalid -= 1;
      return Promise.resolve(llmResponse(request, { verdict: "maybe" }));
    }
    if (this.weak === 0) return this.#mock.complete(request);
    this.weak -= 1;
    const input = request.meta.input as VisualReviewInput;
    const output: VisualReviewOutput = {
      verdict: "regenerate",
      score: 3 + input.attempt,
      issues: ["The glass is lost in the frame."],
      revisedPrompt: `${input.shot.prompt} Tighter on the glass, take ${input.attempt + 1}.`,
    };
    return Promise.resolve(llmResponse(request, output));
  }
}

/** MockLlm, except that `failing` calls ("AGENT.action") throw a transport error. */
class FlakyLlm implements LlmClient {
  readonly provider = "mock" as const;
  readonly #mock = new MockLlm();
  readonly model = this.#mock.model;
  constructor(private readonly failing: string) {}

  complete(request: LlmRequest): Promise<LlmResponse> {
    if (`${request.meta.agent}.${request.meta.action}` === this.failing) {
      return Promise.reject(new Error("socket hang up"));
    }
    return this.#mock.complete(request);
  }
}

function llmResponse(request: LlmRequest, output: unknown): LlmResponse {
  return {
    text: JSON.stringify(output),
    stopReason: "end_turn",
    refusal: null,
    usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    model: `mock:${request.model}`,
    latencyMs: 1,
  };
}

/**
 * MockProvider, except where `mode` breaks it: submit throws, jobs never settle, no still, or the
 * render arrives cut off halfway (its header still reads as a whole 1080×1920 PNG).
 */
class BrokenProvider implements VisualProvider {
  readonly name = "mock" as const;
  readonly #inner = new MockProvider();
  /** How many finished jobs handed out cut-off outputs. */
  truncatedDeliveries = 0;
  constructor(private readonly mode: "submit" | "stuck" | "clip-only" | "truncated") {}

  capabilities() {
    return this.#inner.capabilities();
  }

  submit(request: VisualRequest): Promise<VisualSubmitResult> {
    if (this.mode === "submit") return Promise.reject(new Error("503 from the provider"));
    return this.#inner.submit(request);
  }

  async status(jobId: string): Promise<VisualJobStatus> {
    if (this.mode === "stuck") return { state: "running" };
    if (this.mode === "clip-only") {
      const clip = Buffer.from("\x00\x00\x00\x18ftypmp42 a clip").toString("base64");
      return {
        state: "succeeded",
        outputs: [{ url: `data:video/mp4;base64,${clip}`, mimeType: "video/mp4" }],
      };
    }
    const status = await this.#inner.status(jobId);
    if (this.mode !== "truncated" || !status.outputs) return status;
    this.truncatedDeliveries += 1;
    return {
      ...status,
      outputs: status.outputs.map((output) => ({
        ...output,
        url: `data:${output.mimeType};base64,${truncatedHalf(output.url).toString("base64")}`,
      })),
    };
  }
}

/** The first half of a data: URL's bytes. */
function truncatedHalf(dataUrl: string): Buffer {
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  return bytes.subarray(0, Math.floor(bytes.length / 2));
}

function apiFor(h: Harness, cookie: string) {
  const headers = browserHeaders(cookie);
  return async <T>(method: "GET" | "POST", url: string, payload?: object) => {
    const response = await h.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    if (response.statusCode >= 300) {
      throw new Error(`${method} ${url} → ${response.statusCode}: ${response.body}`);
    }
    return response.json<T>();
  };
}

async function start(options: HarnessOptions, type: "STATIC" | "REEL" = "STATIC") {
  const h = (harness = await startHarness(options));
  const seeded = await seedProposedPlan(h, { postCount: 1, type });
  const api = apiFor(h, await sessionCookieFor(seeded.admin, { now: h.clock.now() }));
  await api<TaskGraphDto>("POST", `/v1/task-graphs/${seeded.graphId}/approve`, {});
  const post = await testDb().post.findFirstOrThrow({ where: { campaignId: seeded.campaignId } });
  return { h, seeded, api, postId: post.id };
}

function waitForDirect(h: Harness, postId: string, status: string, revision = 0) {
  return h.waitFor(async () => {
    const task = await testDb().agentTask.findFirst({
      where: { postId, action: "direct", revision },
    });
    return task?.status === status ? task : null;
  }, 30_000);
}

function waitForRound(h: Harness, postId: string, round: number) {
  return h.waitFor(
    () => testDb().approvalRequest.findFirst({ where: { postId, round, status: "PENDING" } }),
    30_000,
  );
}

/** Resolves once no agent works on the post any more (QA finishes just after opening its round). */
function waitForIdle(h: Harness, postId: string) {
  return h.waitFor(async () => {
    const busy = await testDb().agentTask.count({
      where: { postId, status: { in: [...UNFINISHED_STATUSES] } },
    });
    return busy === 0;
  }, 30_000);
}

function takesOf(postId: string): Promise<Asset[]> {
  return testDb().asset.findMany({ where: { postId }, orderBy: { version: "asc" } });
}

function alertsFor(entityId: string): Promise<AlertPayload[]> {
  return testDb()
    .realtimeEvent.findMany({
      where: { type: "alert", payload: { path: ["entityId"], equals: entityId } },
      orderBy: { id: "asc" },
    })
    .then((rows) => rows.map((row) => row.payload as AlertPayload));
}

/**
 * The entity's alerts once one has landed: a worker publishes its events just after the commit a
 * test waited on, so reading them straight after would race it.
 */
function alertsLanded(h: Harness, entityId: string): Promise<AlertPayload[]> {
  return h.waitFor(async () => {
    const alerts = await alertsFor(entityId);
    return alerts.length > 0 ? alerts : null;
  });
}

/** Runs a job's processor as BullMQ's last attempt would (nothing retries it after this). */
function runLastAttempt(h: Harness, name: JobName, data: object): Promise<unknown> {
  const processor = processorFor(processors, JOB_QUEUE[name], name);
  if (!processor) throw new Error(`No processor for ${name}`);
  return processor(
    { id: `${name}-last`, name, data, attemptsMade: 2, opts: { attempts: 3 } },
    h.deps,
  );
}

/** A STATIC post outside any plan, in approval with one accepted take (v1). */
async function offPlanPost(h: Harness) {
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
      chain: client.approvalChain ?? {},
      contentHash: await currentContentHash(db, post.id),
    },
  });
  const api = apiFor(h, await sessionCookieFor(admin, { now: h.clock.now() }));
  return { post, v1, round, api };
}

describe("phase3: a Vault regenerate goes round the review loop", () => {
  it("regenerates a weak Vault take twice, then escalates; the post keeps its take meanwhile", async () => {
    const llm = new WeakReviewsLlm();
    const { h, api, postId } = await start({ llm });
    const db = testDb();
    await waitForRound(h, postId, 1);
    const [v1] = (await api<PostDto>("GET", `/v1/posts/${postId}`)).currentAssets;

    llm.weak = 3;
    await api("POST", `/v1/assets/${v1!.id}/regenerate`, { instruction: INSTRUCTION });
    const direct = await waitForDirect(h, postId, "ESCALATED", 1);

    const takes = await takesOf(postId);
    expect(takes.map((t) => [t.version, t.status, t.isCurrent, t.regenCount])).toEqual([
      [1, "READY", true, 0],
      [2, "REJECTED", false, 1],
      [3, "REJECTED", false, 2],
      [4, "READY", false, 3],
    ]);
    const [, v2, v3, v4] = takes;
    expect(v3!.parentAssetId).toBe(v2!.id);
    expect(v4!.parentAssetId).toBe(v3!.id);
    expect(takes.map((t) => AssetParams.parse(t.params).origin)).toEqual([
      "direct",
      "vault",
      "review",
      "review",
    ]);
    for (const take of [v2, v3, v4]) {
      expect(AssetParams.parse(take!.params)).toMatchObject({ taskId: direct.id, onTrial: true });
    }
    // The review loop counts from the Vault take: attempts 1, 2, 3, then it gives up.
    expect([v2, v3, v4].map((t) => AssetReview.parse(t!.review).attempt)).toEqual([1, 2, 3]);
    expect([v2, v3, v4].map((t) => AssetReview.parse(t!.review).verdict)).toEqual([
      "regenerate",
      "regenerate",
      "regenerate",
    ]);
    expect(v3!.prompt).toBe(AssetReview.parse(v2!.review).revisedPrompt);

    // Nobody saw a weak take on the post: it kept v1 all along.
    const post = await api<PostDto>("GET", `/v1/posts/${postId}`);
    expect(post.currentAssets.map((thumb) => thumb.id)).toEqual([v1!.id]);
    expect(post.needsAttention).toBe(true);
    const escalation = await db.chatMessage.findFirstOrThrow({ where: { kind: "ESCALATION" } });
    expect(escalation.agent).toBe("VISUAL_DIRECTOR");
    expect(escalation.content).toContain("take 3 of s1 is still weak after 2 regenerations");
    expect(escalation.payload).toMatchObject({ taskId: direct.id, reason: "WEAK_TAKES" });

    // accept_best keeps each shot's best-scored take, and the take the post shows competes: v1
    // (accepted, 7.6+) beats the trial's best (6), so the post keeps v1. The trial is over: its
    // last take is set aside, and QA opens round 2 on v1.
    const resolved = await api<AgentTaskDto>("POST", `/v1/agent-tasks/${direct.id}/resolve`, {
      action: "accept_best",
    });
    expect(resolved.status).toBe("SUCCEEDED");
    const round = await waitForRound(h, postId, 2);
    const after = await takesOf(postId);
    expect(after.map((t) => [t.version, t.status, t.isCurrent])).toEqual([
      [1, "READY", true],
      [2, "REJECTED", false],
      [3, "REJECTED", false],
      [4, "REJECTED", false],
    ]);
    expect(AssetReview.parse(after[0]!.review).score).toBeGreaterThan(
      AssetReview.parse(v4!.review).score,
    );
    expect(round.contentHash).toBe(await currentContentHash(db, postId));
    expect((await db.post.findUniqueOrThrow({ where: { id: postId } })).needsAttention).toBe(false);

    // Nothing of the trial holds the shot: it can be regenerated again, and this time it passes.
    await waitForIdle(h, postId);
    await api("POST", `/v1/assets/${v1!.id}/regenerate`, { instruction: INSTRUCTION });
    await waitForRound(h, postId, 3);
    const retaken = await db.asset.findMany({ where: { postId, isCurrent: true } });
    expect(retaken.map((t) => [t.version, t.status])).toEqual([[5, "READY"]]);
  }, 60_000);

  it("keeps a trial take that scored higher than the post's take when people accept the best", async () => {
    const llm = new WeakReviewsLlm();
    const { h, api, postId } = await start({ llm });
    const db = testDb();
    await waitForRound(h, postId, 1);
    const [v1] = (await api<PostDto>("GET", `/v1/posts/${postId}`)).currentAssets;
    // The take on show scored low when it was accepted.
    const accepted = await db.asset.findUniqueOrThrow({ where: { id: v1!.id } });
    await db.asset.update({
      where: { id: v1!.id },
      data: { review: { ...AssetReview.parse(accepted.review), score: 5.5 } },
    });

    llm.weak = 3;
    await api("POST", `/v1/assets/${v1!.id}/regenerate`, { instruction: INSTRUCTION });
    const direct = await waitForDirect(h, postId, "ESCALATED", 1);
    await api<AgentTaskDto>("POST", `/v1/agent-tasks/${direct.id}/resolve`, {
      action: "accept_best",
    });
    const round = await waitForRound(h, postId, 2);
    // v4 (6) beats v1 (5.5): it goes up, off trial; the trial's other takes stay set aside.
    const takes = await takesOf(postId);
    expect(takes.map((t) => [t.version, t.status, t.isCurrent])).toEqual([
      [1, "READY", false],
      [2, "REJECTED", false],
      [3, "REJECTED", false],
      [4, "READY", true],
    ]);
    expect(AssetParams.parse(takes[3]!.params)).not.toHaveProperty("onTrial");
    expect(round.contentHash).toBe(await currentContentHash(db, postId));
  }, 60_000);

  it("sets aside a trial take whose review escalated, so the shot can be regenerated again", async () => {
    const llm = new WeakReviewsLlm();
    const { h, api, postId } = await start({ llm });
    const db = testDb();
    await waitForRound(h, postId, 1);
    const [v1] = (await api<PostDto>("GET", `/v1/posts/${postId}`)).currentAssets;

    // v2 is judged weak; v3's review keeps breaking its contract, so the task escalates with v3
    // rendered but never reviewed.
    llm.weak = 1;
    llm.invalid = 3;
    await api("POST", `/v1/assets/${v1!.id}/regenerate`, { instruction: INSTRUCTION });
    const direct = await waitForDirect(h, postId, "ESCALATED", 1);
    const escalated = await takesOf(postId);
    expect(escalated.map((t) => [t.version, t.status, t.isCurrent, t.review === null])).toEqual([
      [1, "READY", true, false],
      [2, "REJECTED", false, false],
      [3, "READY", false, true],
    ]);

    await api<AgentTaskDto>("POST", `/v1/agent-tasks/${direct.id}/resolve`, {
      action: "accept_best",
    });
    await waitForRound(h, postId, 2);
    const takes = await takesOf(postId);
    expect(takes.map((t) => [t.version, t.status, t.isCurrent])).toEqual([
      [1, "READY", true],
      [2, "REJECTED", false],
      [3, "REJECTED", false],
    ]);

    await waitForIdle(h, postId);
    const again = await h.app.inject({
      method: "POST",
      url: `/v1/assets/${v1!.id}/regenerate`,
      headers: browserHeaders(await sessionCookieFor(await testDb().user.findFirstOrThrow())),
      payload: { instruction: INSTRUCTION },
    });
    expect(again.statusCode, again.body).toBe(202);
    await waitForRound(h, postId, 3);
    const current = await db.asset.findMany({ where: { postId, isCurrent: true } });
    expect(current.map((t) => [t.version, t.status])).toEqual([[4, "READY"]]);
  }, 60_000);

  it("retries weak Vault takes as a fresh Vault take in the same lineage", async () => {
    const llm = new WeakReviewsLlm();
    const { h, api, postId } = await start({ llm });
    await waitForRound(h, postId, 1);
    const [v1] = (await api<PostDto>("GET", `/v1/posts/${postId}`)).currentAssets;
    llm.weak = 3;
    await api("POST", `/v1/assets/${v1!.id}/regenerate`, { instruction: INSTRUCTION });
    const direct = await waitForDirect(h, postId, "ESCALATED", 1);

    await api<AgentTaskDto>("POST", `/v1/agent-tasks/${direct.id}/resolve`, { action: "retry" });
    await waitForRound(h, postId, 2);
    const takes = await takesOf(postId);
    expect(takes.map((t) => [t.version, t.status, t.isCurrent])).toEqual([
      [1, "READY", false],
      [2, "REJECTED", false],
      [3, "REJECTED", false],
      [4, "REJECTED", false],
      [5, "READY", true],
    ]);
    // The retry re-plans from the same instruction, and its first take counts as attempt 1. Once
    // accepted it went up, and its trial is over.
    expect(AssetParams.parse(takes[4]!.params)).toMatchObject({
      origin: "vault",
      instruction: INSTRUCTION,
      taskId: direct.id,
    });
    expect(AssetParams.parse(takes[4]!.params)).not.toHaveProperty("onTrial");
    expect(AssetReview.parse(takes[4]!.review)).toMatchObject({ verdict: "accept", attempt: 1 });
    // ...from the original context (v1's shot, the one the person regenerated), not from the
    // weak series' own revisions, so the retry's direction passes on its first attempt.
    const v1Shot = AssetParams.parse(takes[0]!.params).shot!;
    const redirected = await testDb().agentTask.findUniqueOrThrow({ where: { id: direct.id } });
    expect(VisualDirectInput.parse(redirected.input)).toMatchObject({
      previousShots: [{ shotId: "s1", prompt: v1Shot.prompt }],
      feedback: { verbatim: INSTRUCTION, source: "HUMAN" },
    });
    const directRuns = await testDb().agentRun.findMany({
      where: { taskId: direct.id, action: "direct" },
      orderBy: { createdAt: "asc" },
    });
    expect(directRuns.map((run) => [run.attempt, run.outcome])).toEqual([
      [1, "OK"],
      [1, "OK"],
    ]);
    expect(takes[4]!.prompt).not.toBe(v1Shot.prompt);
  }, 60_000);

  it("makes a Vault take current only once a retake passes review", async () => {
    const llm = new WeakReviewsLlm();
    const { h, api, postId } = await start({ llm });
    const db = testDb();
    await waitForRound(h, postId, 1);
    const [v1] = (await api<PostDto>("GET", `/v1/posts/${postId}`)).currentAssets;

    llm.weak = 1;
    await api("POST", `/v1/assets/${v1!.id}/regenerate`, { instruction: INSTRUCTION });
    const round = await waitForRound(h, postId, 2);

    const takes = await takesOf(postId);
    expect(takes.map((t) => [t.version, t.status, t.isCurrent])).toEqual([
      [1, "READY", false],
      [2, "REJECTED", false],
      [3, "READY", true],
    ]);
    expect(AssetReview.parse(takes[2]!.review)).toMatchObject({ verdict: "accept", attempt: 2 });
    expect(await waitForDirect(h, postId, "SUCCEEDED", 1)).toBeTruthy();
    expect(round.contentHash).toBe(await currentContentHash(db, postId));
  }, 60_000);

  it("sets a weak Vault take aside outside any plan, with an alert, after two regenerations", async () => {
    const llm = new WeakReviewsLlm();
    const h = (harness = await startHarness({ llm }));
    const db = testDb();
    const { post, v1, round, api } = await offPlanPost(h);

    llm.weak = 3;
    const v2 = await api<{ id: string }>("POST", `/v1/assets/${v1.id}/regenerate`, {
      instruction: INSTRUCTION,
    });
    const v4 = await h.waitFor(async () => {
      const takes = await takesOf(post.id);
      const last = takes.at(-1)!;
      return takes.length === 4 && last.status === "REJECTED" ? last : null;
    }, 30_000);

    const takes = await takesOf(post.id);
    expect(takes.map((t) => [t.version, t.status, t.isCurrent])).toEqual([
      [1, "READY", true],
      [2, "REJECTED", false],
      [3, "REJECTED", false],
      [4, "REJECTED", false],
    ]);
    expect(takes[1]!.id).toBe(v2.id);
    expect(AssetReview.parse(v4.review)).toMatchObject({ verdict: "regenerate", attempt: 3 });
    const [alert] = await h.waitFor(async () => {
      const alerts = await alertsFor(v4.id);
      return alerts.length > 0 ? alerts : null;
    });
    expect(alert).toMatchObject({ kind: "escalated", entityType: "Asset" });
    expect(alert!.message).toContain("take 3 of s1 is still weak after 2 regenerations");
    expect(alert!.message).toContain("The post keeps its current take");
    // Nothing reopened: the round on v1 still stands, and nothing is left for the sweeper.
    expect(await db.approvalRequest.findMany({ where: { postId: post.id } })).toEqual([
      expect.objectContaining({ id: round.id, status: "PENDING" }),
    ]);
    expect(await db.chatMessage.count({ where: { kind: "ESCALATION" } })).toBe(0);
    h.clock.advance(6 * MINUTE_MS);
    await h.runTick("tick.sweeper");
    expect(await h.deps.queues.queue("agents").getJobs(["waiting", "delayed"])).toEqual([]);
    expect(await h.deps.queues.queue("media").getJobs(["waiting", "delayed"])).toEqual([]);
  }, 60_000);

  it("keeps the newest accepted Vault take current outside any plan, sweep after sweep", async () => {
    const h = (harness = await startHarness({}));
    const db = testDb();
    const { post, v1, api } = await offPlanPost(h);
    const isCurrent = (id: string) => async () =>
      (await db.asset.findUniqueOrThrow({ where: { id } })).isCurrent;

    const v2 = await api<{ id: string }>("POST", `/v1/assets/${v1.id}/regenerate`, {
      instruction: INSTRUCTION,
    });
    await h.waitFor(isCurrent(v2.id), 30_000);
    await waitForRound(h, post.id, 2);
    const v3 = await api<{ id: string }>("POST", `/v1/assets/${v2.id}/regenerate`, {
      instruction: "Warmer still.",
    });
    await h.waitFor(isCurrent(v3.id), 30_000);
    await waitForRound(h, post.id, 3);

    // A take that went up is off trial, so nothing re-drives its review once a newer one replaced
    // it (its stored "accept" would put it back up and reopen approval, every sweep).
    const takes = await takesOf(post.id);
    expect(takes.map((t) => [t.version, t.status, t.isCurrent])).toEqual([
      [1, "READY", false],
      [2, "READY", false],
      [3, "READY", true],
    ]);
    for (const take of takes) expect(AssetParams.parse(take.params)).not.toHaveProperty("onTrial");
    for (let sweep = 0; sweep < 3; sweep++) {
      h.clock.advance(6 * MINUTE_MS);
      expect(await driveStaleRenders(h.deps)).toBe(0);
      await h.runTick("tick.sweeper");
    }
    const current = await db.asset.findMany({ where: { postId: post.id, isCurrent: true } });
    expect(current.map((t) => t.id)).toEqual([v3.id]);
    const rounds = await db.approvalRequest.findMany({
      where: { postId: post.id },
      orderBy: { round: "asc" },
    });
    expect(rounds.map((r) => [r.round, r.status])).toEqual([
      [1, "CANCELLED"],
      [2, "CANCELLED"],
      [3, "PENDING"],
    ]);
  }, 60_000);

  it("leaves an accepted Vault take in the Vault when its post went out meanwhile", async () => {
    const h = (harness = await startHarness({ env: { RENDER_POLL_DELAY_MS: "1500" } }));
    const db = testDb();
    const { post, v1, round, api } = await offPlanPost(h);
    const v2 = await api<{ id: string }>("POST", `/v1/assets/${v1.id}/regenerate`, {
      instruction: INSTRUCTION,
    });
    await h.waitFor(() => db.asset.findFirst({ where: { id: v2.id, status: "RENDERING" } }));
    // Approved and published while the take rendered: its visuals can't change any more.
    await db.approvalRequest.update({ where: { id: round.id }, data: { status: "APPROVED" } });
    await db.post.update({ where: { id: post.id }, data: { status: "LIVE" } });

    const ended = await h.waitFor(async () => {
      const take = await db.asset.findUniqueOrThrow({ where: { id: v2.id } });
      return take.review !== null && !("onTrial" in AssetParams.parse(take.params)) ? take : null;
    }, 30_000);
    expect(ended).toMatchObject({ status: "READY", isCurrent: false });
    expect(AssetReview.parse(ended.review).verdict).toBe("accept");
    expect(await db.asset.findUniqueOrThrow({ where: { id: v1.id } })).toMatchObject({
      isCurrent: true,
    });
    expect(await db.approvalRequest.findMany({ where: { postId: post.id } })).toEqual([
      expect.objectContaining({ id: round.id, status: "APPROVED" }),
    ]);
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("LIVE");
    h.clock.advance(6 * MINUTE_MS);
    expect(await driveStaleRenders(h.deps)).toBe(0);
  }, 60_000);
});

describe("phase3: the Visual Director's contract failures", () => {
  it("accepts a take on the third review attempt after two invalid replies", async () => {
    const { h, postId } = await start({
      env: { MOCK_LLM_FAULTS: "VISUAL_DIRECTOR.review:invalid*2" },
    });
    const db = testDb();
    await waitForRound(h, postId, 1);
    const direct = await waitForDirect(h, postId, "SUCCEEDED");
    const [take] = await takesOf(postId);
    expect(take).toMatchObject({ status: "READY", isCurrent: true, version: 1 });
    expect(AssetReview.parse(take!.review).verdict).toBe("accept");
    const runs = await db.agentRun.findMany({
      where: { taskId: direct.id, agent: "VISUAL_DIRECTOR", action: "review" },
      orderBy: { attempt: "asc" },
    });
    expect(runs.map((run) => [run.attempt, run.outcome])).toEqual([
      [1, "INVALID_OUTPUT"],
      [2, "INVALID_OUTPUT"],
      [3, "OK"],
    ]);
  }, 60_000);

  it("escalates the direct task when the review keeps breaking its contract; accept_best keeps the take", async () => {
    const { h, api, postId } = await start({
      env: { MOCK_LLM_FAULTS: "VISUAL_DIRECTOR.review:invalid*3" },
    });
    const db = testDb();
    const direct = await waitForDirect(h, postId, "ESCALATED");
    expect(direct.error).toContain("kept returning output that breaks its contract");
    const [take] = await takesOf(postId);
    // Rendered, never judged: still the post's take, with no review.
    expect(take).toMatchObject({ status: "READY", isCurrent: true, review: null });
    expect((await db.post.findUniqueOrThrow({ where: { id: postId } })).needsAttention).toBe(true);
    expect((await alertsLanded(h, direct.id)).map((alert) => alert.kind)).toEqual(["escalated"]);

    await api<AgentTaskDto>("POST", `/v1/agent-tasks/${direct.id}/resolve`, {
      action: "accept_best",
    });
    const round = await waitForRound(h, postId, 1);
    expect(await db.asset.findMany({ where: { postId, isCurrent: true } })).toEqual([
      expect.objectContaining({ id: take!.id, status: "READY" }),
    ]);
    expect(round.contentHash).toBe(await currentContentHash(db, postId));
  }, 60_000);

  it("escalates a refused review, and a retry re-plans the shot and runs clean", async () => {
    const { h, api, postId } = await start({
      env: { MOCK_LLM_FAULTS: "VISUAL_DIRECTOR.review:refusal" },
    });
    const direct = await waitForDirect(h, postId, "ESCALATED");
    expect(direct.error).toContain("refused the request");
    await api<AgentTaskDto>("POST", `/v1/agent-tasks/${direct.id}/resolve`, { action: "retry" });
    await waitForRound(h, postId, 1);
    const takes = await takesOf(postId);
    expect(takes.map((t) => [t.version, t.status, t.isCurrent])).toEqual([
      [1, "REJECTED", false],
      [2, "READY", true],
    ]);
    expect(AssetReview.parse(takes[1]!.review).verdict).toBe("accept");
  }, 60_000);

  it("escalates a direct that keeps breaking its contract before any take exists", async () => {
    const { h, api, postId } = await start({
      env: { MOCK_LLM_FAULTS: "VISUAL_DIRECTOR.direct:invalid*3" },
    });
    const direct = await waitForDirect(h, postId, "ESCALATED");
    expect(direct.error).toContain("Visual Director (direct, p1)");
    expect(await takesOf(postId)).toEqual([]);
    // Nothing rendered, so there is nothing to accept; a retry directs it afresh.
    const noTake = await h.app.inject({
      method: "POST",
      url: `/v1/agent-tasks/${direct.id}/resolve`,
      headers: browserHeaders(await sessionCookieFor(await testDb().user.findFirstOrThrow())),
      payload: { action: "accept_best" },
    });
    expect(noTake.statusCode).toBe(409);
    await api<AgentTaskDto>("POST", `/v1/agent-tasks/${direct.id}/resolve`, { action: "retry" });
    await waitForRound(h, postId, 1);
    expect((await takesOf(postId)).map((t) => t.status)).toEqual(["READY"]);
  }, 60_000);

  it("fails a Vault take outside any plan the Visual Director can't review; the post keeps v1", async () => {
    const h = (harness = await startHarness({
      env: { MOCK_LLM_FAULTS: "VISUAL_DIRECTOR.review:invalid*3" },
    }));
    const db = testDb();
    const { post, v1, round, api } = await offPlanPost(h);
    const v2 = await api<{ id: string }>("POST", `/v1/assets/${v1.id}/regenerate`, {
      instruction: INSTRUCTION,
    });
    const failed = await h.waitFor(async () => {
      const take = await db.asset.findUniqueOrThrow({ where: { id: v2.id } });
      return take.status === "FAILED" ? take : null;
    }, 30_000);
    expect(failed).toMatchObject({ isCurrent: false, review: null });
    const [alert] = await h.waitFor(async () => {
      const alerts = await alertsFor(v2.id);
      return alerts.length > 0 ? alerts : null;
    });
    expect(alert).toMatchObject({ kind: "failed", entityType: "Asset" });
    expect(alert!.message).toContain("the Visual Director kept returning output");
    expect(await db.asset.findUniqueOrThrow({ where: { id: v1.id } })).toMatchObject({
      isCurrent: true,
    });
    expect(await db.approvalRequest.findMany({ where: { postId: post.id } })).toEqual([
      expect.objectContaining({ id: round.id, status: "PENDING" }),
    ]);
  }, 60_000);

  it("fails a Vault take outside any plan whose direct keeps breaking its contract", async () => {
    const h = (harness = await startHarness({
      env: { MOCK_LLM_FAULTS: "VISUAL_DIRECTOR.direct:invalid*3" },
    }));
    const db = testDb();
    const { v1, api } = await offPlanPost(h);
    const v2 = await api<{ id: string }>("POST", `/v1/assets/${v1.id}/regenerate`, {
      instruction: INSTRUCTION,
    });
    await h.waitFor(async () => {
      const take = await db.asset.findUniqueOrThrow({ where: { id: v2.id } });
      return take.status === "FAILED";
    }, 30_000);
    const [alert] = await h.waitFor(async () => {
      const alerts = await alertsFor(v2.id);
      return alerts.length > 0 ? alerts : null;
    });
    expect(alert!.message).toContain("the Visual Director kept returning output");
    expect(await db.asset.findUniqueOrThrow({ where: { id: v1.id } })).toMatchObject({
      isCurrent: true,
    });
  }, 60_000);
});

describe("phase3: asset jobs out of retries, and renders with nothing to review", () => {
  it("fails the task when the review's last attempt hits a transport error", async () => {
    const { h, postId } = await start({ llm: new FlakyLlm("VISUAL_DIRECTOR.review") });
    const db = testDb();
    const take = await h.waitFor(() => db.asset.findFirst({ where: { postId, status: "READY" } }));
    await expect(runLastAttempt(h, JOB.visualReview, { assetId: take.id })).rejects.toThrow(
      "socket hang up",
    );
    const direct = await waitForDirect(h, postId, "FAILED");
    expect(direct.error).toContain("couldn't review take 1 of s1: socket hang up");
    expect((await alertsLanded(h, direct.id)).map((alert) => alert.kind)).toEqual(["failed"]);
    expect(await db.asset.findUniqueOrThrow({ where: { id: take.id } })).toMatchObject({
      status: "READY",
      review: null,
    });
  }, 60_000);

  it("fails the take and its task when submitting keeps failing", async () => {
    const { h, postId } = await start({ visual: new BrokenProvider("submit") });
    const db = testDb();
    const take = await h.waitFor(() => db.asset.findFirst({ where: { postId, status: "QUEUED" } }));
    await waitForDirect(h, postId, "WAITING");
    await expect(runLastAttempt(h, JOB.renderSubmit, { assetId: take.id })).rejects.toThrow(
      "503 from the provider",
    );
    expect(await db.asset.findUniqueOrThrow({ where: { id: take.id } })).toMatchObject({
      status: "FAILED",
    });
    const direct = await waitForDirect(h, postId, "FAILED");
    expect(direct.error).toContain(
      "couldn't get take 1 of s1 rendered by the mock provider (submitting it failed after every retry: 503 from the provider)",
    );
    expect((await alertsLanded(h, direct.id)).map((alert) => alert.kind)).toEqual(["failed"]);
    expect((await db.post.findUniqueOrThrow({ where: { id: postId } })).needsAttention).toBe(true);
  }, 60_000);

  it("gives up on a render that never settles after RENDER_POLL_MAX_ATTEMPTS polls", async () => {
    const { h, postId } = await start({ visual: new BrokenProvider("stuck") });
    const db = testDb();
    const take = await h.waitFor(() =>
      db.asset.findFirst({ where: { postId, status: "RENDERING" } }),
    );
    await runLastAttempt(h, JOB.renderPoll, {
      assetId: take.id,
      attempt: RENDER_POLL_MAX_ATTEMPTS,
    });
    expect(await db.asset.findUniqueOrThrow({ where: { id: take.id } })).toMatchObject({
      status: "FAILED",
    });
    const direct = await waitForDirect(h, postId, "FAILED");
    expect(direct.error).toContain(
      `the render didn't finish after ${RENDER_POLL_MAX_ATTEMPTS} polls`,
    );
    expect((await alertsLanded(h, direct.id)).map((alert) => alert.kind)).toEqual(["failed"]);
  }, 60_000);

  it("fails the take and its task when storing a finished render keeps failing", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.reject(new Error("disk full")));
    const { h, postId } = await start({ fetch });
    const db = testDb();
    const take = await h.waitFor(() =>
      db.asset.findFirst({ where: { postId, status: "RENDERING" } }),
    );
    // The first attempts fail on the download; BullMQ would retry them.
    await h.waitFor(() => fetch.mock.calls.length > 0);
    await expect(
      runLastAttempt(h, JOB.renderPoll, { assetId: take.id, attempt: 5 }),
    ).rejects.toThrow("disk full");
    const direct = await waitForDirect(h, postId, "FAILED");
    expect(direct.error).toContain("storing the render failed: disk full");
    expect(await db.asset.findUniqueOrThrow({ where: { id: take.id } })).toMatchObject({
      status: "FAILED",
      url: null,
    });
  }, 60_000);

  it("fails a take whose file went missing from storage before its review", async () => {
    const { h, postId } = await start({ env: { RENDER_POLL_DELAY_MS: "1500" } });
    const db = testDb();
    await h.waitFor(() => db.asset.findFirst({ where: { postId, status: "RENDERING" } }));
    vi.spyOn(h.deps.storage, "get").mockResolvedValue(null);
    const direct = await waitForDirect(h, postId, "FAILED");
    expect(direct.error).toContain("its file is missing from storage");
    const [take] = await takesOf(postId);
    expect(take).toMatchObject({ status: "FAILED", review: null });
  }, 60_000);

  it("retries a render that arrives cut off, and fails the take on the poll's last attempt", async () => {
    const provider = new BrokenProvider("truncated");
    const { h, postId } = await start({ visual: provider });
    const db = testDb();
    const take = await h.waitFor(() =>
      db.asset.findFirst({ where: { postId, status: "RENDERING" } }),
    );
    // The header reads as a whole PNG, but the pixels don't decode: never stored as READY.
    await h.waitFor(() => provider.truncatedDeliveries > 0);
    expect(await db.asset.findUniqueOrThrow({ where: { id: take.id } })).toMatchObject({
      status: "RENDERING",
    });
    await expect(
      runLastAttempt(h, JOB.renderPoll, { assetId: take.id, attempt: 5 }),
    ).rejects.toThrow(/png/i);
    const direct = await waitForDirect(h, postId, "FAILED");
    expect(direct.error).toContain("storing the render failed");
    expect(await db.asset.findUniqueOrThrow({ where: { id: take.id } })).toMatchObject({
      status: "FAILED",
      url: null,
    });
  }, 60_000);

  it("fails a take whose stored file can't be decoded for its review, and hands its task on", async () => {
    const { h, postId } = await start({ env: { RENDER_POLL_DELAY_MS: "1500" } });
    const db = testDb();
    await h.waitFor(() => db.asset.findFirst({ where: { postId, status: "RENDERING" } }));
    const get = h.deps.storage.get.bind(h.deps.storage);
    vi.spyOn(h.deps.storage, "get").mockImplementation(async (key) => {
      const file = await get(key);
      return file && { ...file, body: file.body.subarray(0, Math.floor(file.body.length / 2)) };
    });
    const direct = await waitForDirect(h, postId, "FAILED");
    expect(direct.error).toContain("its file can't be decoded");
    expect((await alertsLanded(h, direct.id)).map((alert) => alert.kind)).toEqual(["failed"]);
    const [take] = await takesOf(postId);
    expect(take).toMatchObject({ status: "FAILED", review: null });
  }, 60_000);

  it("fails the task when storage stays out of reach through the review's last attempt", async () => {
    const { h, postId } = await start({ env: { RENDER_POLL_DELAY_MS: "1500" } });
    const db = testDb();
    await h.waitFor(() => db.asset.findFirst({ where: { postId, status: "RENDERING" } }));
    vi.spyOn(h.deps.storage, "get").mockRejectedValue(new Error("ECONNRESET"));
    const take = await h.waitFor(() => db.asset.findFirst({ where: { postId, status: "READY" } }));
    await expect(runLastAttempt(h, JOB.visualReview, { assetId: take.id })).rejects.toThrow(
      "ECONNRESET",
    );
    const direct = await waitForDirect(h, postId, "FAILED");
    expect(direct.error).toContain("couldn't review take 1 of s1: ECONNRESET");
    expect((await alertsLanded(h, direct.id)).map((alert) => alert.kind)).toEqual(["failed"]);
    expect(await db.asset.findUniqueOrThrow({ where: { id: take.id } })).toMatchObject({
      status: "READY",
      review: null,
    });
  }, 60_000);

  it("fails a clip that came back without a still frame to review", async () => {
    const { h, postId } = await start({ visual: new BrokenProvider("clip-only") }, "REEL");
    const direct = await waitForDirect(h, postId, "FAILED");
    expect(direct.error).toContain("the provider returned no still frame to review");
    const takes = await takesOf(postId);
    expect(takes.length).toBeGreaterThan(0);
    expect(takes.some((take) => take.status === "FAILED" && take.mimeType === "video/mp4")).toBe(
      true,
    );
  }, 60_000);
});

describe("phase3: the sweeper and lost hand-offs", () => {
  it("re-drives a lost poll behind hundreds of takes nobody waits on any more", async () => {
    const { h, seeded, postId } = await start({ env: { RENDER_POLL_DELAY_MS: "3000" } });
    const db = testDb();
    const take = await h.waitFor(() =>
      db.asset.findFirst({ where: { postId, status: "RENDERING" } }),
    );
    const media = h.deps.queues.queue("media");
    const poll = await h.waitFor(() => media.getJob(`render-${take.id}-poll1`));
    await poll.remove();

    // Takes that match the loop's statuses but whose tasks were resolved long ago: kept by
    // accept_best with a "regenerate" verdict, rendered after an escalation, or still queued.
    const settled = await db.agentTask.create({
      data: {
        graphId: seeded.graphId,
        nodeKey: "n90",
        agent: "VISUAL_DIRECTOR",
        action: "direct",
        status: "SUCCEEDED",
      },
    });
    const escalated = await db.agentTask.create({
      data: {
        graphId: seeded.graphId,
        nodeKey: "n91",
        agent: "VISUAL_DIRECTOR",
        action: "direct",
        status: "ESCALATED",
      },
    });
    const longAgo = new Date("2020-01-01T00:00:00Z");
    const shot = AssetParams.parse(take.params).shot;
    const weak = {
      verdict: "regenerate",
      score: 4,
      issues: ["Flat"],
      revisedPrompt: "Brighter",
      attempt: 3,
      reviewedAt: longAgo.toISOString(),
    };
    const junk = Array.from({ length: 240 }, (_, i) => {
      const kind = i % 3;
      return {
        clientId: seeded.client.id,
        campaignId: seeded.campaignId,
        role: "SHOT" as const,
        kind: "IMAGE" as const,
        status: kind === 2 ? ("QUEUED" as const) : ("READY" as const),
        provider: "mock",
        prompt: `Old take ${i}`,
        params: { shot, origin: "direct", taskId: kind === 0 ? settled.id : escalated.id },
        isCurrent: kind === 0,
        review: kind === 0 ? weak : undefined,
        updatedAt: new Date(longAgo.getTime() + i * 1000),
      };
    });
    await db.asset.createMany({ data: junk });

    h.clock.advance(6 * MINUTE_MS);
    await h.runTick("tick.sweeper");
    expect(await media.getJob(`render-${take.id}-poll1`)).toBeDefined();
    await waitForRound(h, postId, 1);
    expect(await db.asset.findUniqueOrThrow({ where: { id: take.id } })).toMatchObject({
      status: "READY",
      isCurrent: true,
    });
    // None of the others got a job.
    const agents = await h.deps.queues.queue("agents").getJobs(["waiting", "delayed", "completed"]);
    const media2 = await media.getJobs(["waiting", "delayed", "completed"]);
    const touched = new Set(
      [...agents, ...media2].map((job) => (job.data as { assetId?: string }).assetId),
    );
    const junkIds = await db.asset.findMany({
      where: { prompt: { startsWith: "Old take" } },
      select: { id: true },
    });
    expect(junkIds.filter(({ id }) => touched.has(id))).toEqual([]);
  }, 60_000);

  it("hands on a WAITING task whose take failed while its hand-off was lost", async () => {
    const { h, postId } = await start({ visual: new BrokenProvider("stuck") });
    const db = testDb();
    const take = await h.waitFor(() =>
      db.asset.findFirst({ where: { postId, status: "RENDERING" } }),
    );
    const waiting = await waitForDirect(h, postId, "WAITING");
    // The take failed, and then the worker died before the task heard of it.
    await db.asset.update({ where: { id: take.id }, data: { status: "FAILED" } });

    h.clock.advance(6 * MINUTE_MS);
    await h.runTick("tick.sweeper");
    const direct = await waitForDirect(h, postId, "FAILED");
    expect(direct.id).toBe(waiting.id);
    expect(direct.error).toContain("found by the sweeper after its hand-off was lost");
    expect((await alertsLanded(h, direct.id)).map((alert) => alert.kind)).toEqual(["failed"]);
    expect((await db.post.findUniqueOrThrow({ where: { id: postId } })).needsAttention).toBe(true);
  }, 60_000);

  it("rolls a failed take back when its task's hand-off fails, so a retry redoes both", async () => {
    const { h, postId } = await start({ visual: new BrokenProvider("stuck") });
    const db = testDb();
    const take = await h.waitFor(() =>
      db.asset.findFirst({ where: { postId, status: "RENDERING" } }),
    );
    await waitForDirect(h, postId, "WAITING");

    const flaky: Deps = { ...h.deps, prisma: failingTaskWrites(h.deps.prisma, 1) };
    await expect(failTake(flaky, take.id, "FAILED", "GPU on fire", ["RENDERING"])).rejects.toThrow(
      "connection reset",
    );
    // Neither half landed: the take is still rendering and the task still waits on it.
    expect(await db.asset.findUniqueOrThrow({ where: { id: take.id } })).toMatchObject({
      status: "RENDERING",
    });
    expect(
      (await db.agentTask.findFirstOrThrow({ where: { postId, action: "direct" } })).status,
    ).toBe("WAITING");

    await failTake(h.deps, take.id, "FAILED", "GPU on fire", ["RENDERING"]);
    expect(await db.asset.findUniqueOrThrow({ where: { id: take.id } })).toMatchObject({
      status: "FAILED",
    });
    const direct = await waitForDirect(h, postId, "FAILED");
    expect(direct.error).toContain("(GPU on fire)");
  }, 60_000);
});

/** `prisma`, except that the next `count` AgentTask updateMany calls inside a transaction fail. */
function failingTaskWrites(prisma: DbClient, count: number): DbClient {
  let remaining = count;
  const flakyTx = (tx: DbTransaction): DbTransaction =>
    new Proxy(tx, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property);
        if (property !== "agentTask") return value;
        return new Proxy(value as object, {
          get(delegate, method) {
            const fn: unknown = Reflect.get(delegate, method);
            if (method !== "updateMany" || remaining === 0) return fn;
            remaining -= 1;
            return () => Promise.reject(new Error("connection reset"));
          },
        });
      },
    });
  return new Proxy(prisma, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (property !== "$transaction") return value;
      return <T>(run: (tx: DbTransaction) => Promise<T>) =>
        target.$transaction((tx) => run(flakyTx(tx)));
    },
  });
}
