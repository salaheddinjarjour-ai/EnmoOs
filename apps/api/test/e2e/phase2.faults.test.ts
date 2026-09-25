import {
  correctionMessage,
  MockLlm,
  type LlmClient,
  type LlmMessage,
  type LlmRequest,
  type LlmResponse,
} from "@enmo/agents";
import type {
  AlertPayload,
  CopywriterInput,
  CopywriterOutput,
  Issue,
  PostCardPayload,
} from "@enmo/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { managerIntakeProcessor } from "../../src/jobs/processors/manager-intake";
import { managerPlanProcessor } from "../../src/jobs/processors/manager-plan";
import {
  JOB,
  jobIds,
  QUEUE_NAMES,
  type ManagerIntakeJob,
  type ManagerPlanJob,
} from "../../src/jobs/queues";
import { startWorkers } from "../../src/jobs/runtime";
import { DAY_MS, FakeClock, HOUR_MS, MINUTE_MS } from "../../src/lib/clock";
import {
  INTAKE_UNAVAILABLE_REPLY,
  PLAN_UNAVAILABLE_REPLY,
} from "../../src/orchestrator/agent-failure";
import { STALL_REQUEUE_NOTE } from "../../src/orchestrator/sweeper";
import { toServiceUser } from "../../src/services/actor";
import { resolveTask } from "../../src/services/agent-tasks";
import { decide } from "../../src/services/approvals";
import { getBudget, utcDayStart } from "../../src/services/budget";
import {
  archiveCampaign,
  createCampaignFromMessage,
  listMessages,
  postUserMessage,
} from "../../src/services/campaigns";
import { editCopy } from "../../src/services/posts";
import { approvePlan } from "../../src/services/task-graphs";
import { testDb } from "../helpers/db";
import { createClient, createUser } from "../helpers/factories";
import {
  seedProposedPlan,
  PHASE2_PIPELINE,
  startHarness as startAnyHarness,
  type Harness,
  type HarnessOptions,
} from "../helpers/harness";

/*
 * Phase 2 "also covered" checks, on an approved plan seeded straight into the database (so only
 * the Copywriter and QA calls touch the MockLlm):
 *   (a) MOCK_LLM_FAULTS="COPYWRITER.write:invalid*2" → the draft succeeds on attempt 3;
 *   (b) "COPYWRITER.write:invalid*3" → ESCALATED (needs attention, Manager ESCALATION message,
 *       alert), and a retry from the task list finishes the post;
 *   (c) DAILY_TOKEN_CAP=1 → BLOCKED_BUDGET, re-queued by the sweeper after the UTC day rolls over.
 * Plus: one post escalating in a larger campaign, the sweeper's stuck-task and never-queued paths,
 * tick.prune, and the campaign-level Manager jobs (intake, plan) failing for good or parked for
 * the budget.
 */

/** Phase 2's copy pipeline (write → qa); the Visual Director's direct has its own suites. */
const startHarness = (options: HarnessOptions = {}) =>
  startAnyHarness({ pipeline: PHASE2_PIPELINE, ...options });

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

async function start(options: HarnessOptions, postCount: number) {
  const h = (harness = await startHarness(options));
  const seeded = await seedProposedPlan(h, { postCount });
  const user = toServiceUser(seeded.admin, null);
  return { h, seeded, user };
}

/** MockLlm that keeps a copy of every conversation it was sent. */
class RecordingLlm implements LlmClient {
  readonly provider = "mock" as const;
  readonly requests: { meta: LlmRequest["meta"]; messages: LlmMessage[] }[] = [];
  readonly #inner: MockLlm;

  constructor(faults: string) {
    this.#inner = new MockLlm({ faults });
  }

  get model(): string {
    return this.#inner.model;
  }

  complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push({ meta: request.meta, messages: [...request.messages] });
    return this.#inner.complete(request);
  }
}

/** MockLlm, except that one post's calls for `key` go through a MockLlm with `faults`. */
class FaultyPostLlm implements LlmClient {
  readonly provider = "mock" as const;
  readonly #clean = new MockLlm();
  readonly #faulty: MockLlm;

  constructor(
    private readonly key: string,
    private readonly ref: string,
    faults: string,
  ) {
    this.#faulty = new MockLlm({ faults });
  }

  get model(): string {
    return this.#clean.model;
  }

  complete(request: LlmRequest): Promise<LlmResponse> {
    const { agent, action, input } = request.meta;
    const post = (input as Partial<Pick<CopywriterInput, "post">>).post;
    const faulty = `${agent}.${action}` === this.key && post?.ref === this.ref;
    return (faulty ? this.#faulty : this.#clean).complete(request);
  }
}

/** Delegates to `target`, which a test may replace between calls. */
class SwitchableLlm implements LlmClient {
  readonly provider = "mock" as const;
  constructor(public target: LlmClient) {}
  get model(): string {
    return this.target.model;
  }
  complete(request: LlmRequest): Promise<LlmResponse> {
    return this.target.complete(request);
  }
}

/** A provider outage that outlasts the SDK's own retries: every call rejects. */
class DownLlm implements LlmClient {
  readonly provider = "mock" as const;
  readonly model = "mock-down";
  calls = 0;
  complete(): Promise<LlmResponse> {
    this.calls += 1;
    return Promise.reject(new Error("529 overloaded_error: Overloaded"));
  }
}

async function alerts(kind: AlertPayload["kind"]) {
  const rows = await testDb().realtimeEvent.findMany({ where: { type: "alert" } });
  return rows.map((row) => row.payload as AlertPayload).filter((alert) => alert.kind === kind);
}

describe("phase2 faults", () => {
  it("(a) invalid*2: the Copywriter's third attempt passes, with the issues fed back", async () => {
    const llm = new RecordingLlm("COPYWRITER.write:invalid*2");
    const { h, seeded, user } = await start({ llm }, 1);
    const db = testDb();
    await approvePlan(h.deps, user, seeded.graphId);

    await h.waitFor(() =>
      db.post.findFirst({ where: { campaignId: seeded.campaignId, status: "PENDING_APPROVAL" } }),
    );
    const write = await db.agentTask.findFirstOrThrow({ where: { action: "write" } });
    expect(write.status).toBe("SUCCEEDED");
    expect(write.contractAttempts).toBe(3);
    const runs = await db.agentRun.findMany({
      where: { taskId: write.id },
      orderBy: { attempt: "asc" },
    });
    expect(runs.map((run) => [run.attempt, run.outcome])).toEqual([
      [1, "INVALID_OUTPUT"],
      [2, "INVALID_OUTPUT"],
      [3, "OK"],
    ]);
    expect(runs.every((run) => run.campaignId === seeded.campaignId)).toBe(true);
    expect(await db.agentTask.count({ where: { status: "ESCALATED" } })).toBe(0);

    // Each retry continues the conversation: the rejected reply, then every zod issue it broke.
    const writes = llm.requests.filter((request) => request.meta.agent === "COPYWRITER");
    expect(writes.map((request) => request.meta.attempt)).toEqual([1, 2, 3]);
    for (const [index, failed] of runs.slice(0, 2).entries()) {
      const issues = failed.validationErrors as Issue[] | null;
      expect(issues?.length, `attempt ${failed.attempt}`).toBeGreaterThan(0);
      const retry = writes[index + 1]?.messages ?? [];
      expect(retry.slice(-2)).toEqual([
        { role: "assistant", content: failed.responseText },
        { role: "user", content: correctionMessage(issues ?? []) },
      ]);
      for (const issue of issues ?? []) {
        expect(retry.at(-1)?.content).toContain(issue.message);
      }
    }
    expect(writes[2]?.messages).toHaveLength(5);
  });

  it("(b) invalid*3: the task escalates, and a retry finishes the post", async () => {
    const { h, seeded, user } = await start(
      { env: { MOCK_LLM_FAULTS: "COPYWRITER.write:invalid*3" } },
      1,
    );
    const db = testDb();
    await approvePlan(h.deps, user, seeded.graphId);

    const escalated = await h.waitFor(() =>
      db.agentTask.findFirst({ where: { action: "write", status: "ESCALATED" } }),
    );
    expect(escalated.contractAttempts).toBe(3);
    expect(
      await db.agentRun.count({ where: { taskId: escalated.id, outcome: "INVALID_OUTPUT" } }),
    ).toBe(3);

    const post = await db.post.findFirstOrThrow({ where: { campaignId: seeded.campaignId } });
    expect(post.needsAttention).toBe(true);
    expect(post.attentionReason).toMatch(/Copywriter/);
    const message = await db.chatMessage.findFirstOrThrow({
      where: { threadId: seeded.threadId, kind: "ESCALATION" },
    });
    expect(message.agent).toBe("MANAGER");
    expect(message.payload).toMatchObject({
      taskId: escalated.id,
      agent: "COPYWRITER",
      postRef: "p1",
      reason: "INVALID_OUTPUT",
    });
    expect((await alerts("escalated")).map((alert) => alert.entityId)).toContain(escalated.id);
    // QA never ran: the chain stops at the escalated draft.
    expect(await db.agentTask.count({ where: { action: "qa", status: "PENDING" } })).toBe(1);

    const resolved = await resolveTask(h.deps, user, escalated.id, "retry");
    // The worker may already have picked it up.
    expect(["QUEUED", "RUNNING", "SUCCEEDED"]).toContain(resolved.status);
    expect(resolved.error).toBeNull();

    await h.waitFor(() =>
      db.post.findFirst({ where: { id: post.id, status: "PENDING_APPROVAL" } }),
    );
    const after = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(after.needsAttention).toBe(false);
    const retried = await db.agentTask.findUniqueOrThrow({ where: { id: escalated.id } });
    expect(retried).toMatchObject({ status: "SUCCEEDED", contractAttempts: 1 });
    await expect(resolveTask(h.deps, user, escalated.id, "retry")).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("one post's escalated draft doesn't keep the other posts' cards out of the thread", async () => {
    const llm = new FaultyPostLlm("COPYWRITER.write", "p2", "COPYWRITER.write:invalid*3");
    const { h, seeded, user } = await start({ llm }, 3);
    const db = testDb();
    await approvePlan(h.deps, user, seeded.graphId);
    const cards = () =>
      db.chatMessage.findMany({
        where: { threadId: seeded.threadId, kind: "POST_CARD" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });

    // p1 and p3 pass QA while p2's draft escalates, so p2's QA can't run: the card still lands.
    const [first] = await h.waitFor(async () => {
      const found = await cards();
      return found.length > 0 ? found : null;
    });
    const posts = await db.post.findMany({ where: { campaignId: seeded.campaignId } });
    const post = (ref: string) => {
      const found = posts.find((candidate) => candidate.ref === ref);
      if (!found) throw new Error(`No post ${ref}`);
      return found;
    };
    expect(first?.payload as PostCardPayload).toEqual({ postIds: [post("p1").id, post("p3").id] });
    expect(first?.content).toBe(
      "2 posts passed QA and are waiting for approval. 1 task on hold until an escalated task is resolved.",
    );
    expect(post("p2")).toMatchObject({ status: "DRAFTING", needsAttention: true });
    const escalated = await db.agentTask.findFirstOrThrow({
      where: { postId: post("p2").id, action: "write" },
    });
    expect(escalated.status).toBe("ESCALATED");
    expect(
      await db.approvalRequest.count({ where: { status: "PENDING", postId: post("p2").id } }),
    ).toBe(0);
    const copywriter = await db.chatMessage.findFirstOrThrow({
      where: { threadId: seeded.threadId, agent: "COPYWRITER", kind: "TEXT" },
    });
    expect(copywriter.content).toBe(
      "Copywriter ✓ 2/3 — copy drafted. 1 task escalated to a human.",
    );

    // Once the escalation is retried, p2 gets a card of its own.
    await resolveTask(h.deps, user, escalated.id, "retry");
    const second = await h.waitFor(async () => (await cards())[1]);
    expect(second.payload as PostCardPayload).toEqual({ postIds: [post("p2").id] });
    expect(second.content).toBe("1 post passed QA and is waiting for approval.");
    expect(await db.approvalRequest.count({ where: { status: "PENDING" } })).toBe(3);
    expect(await cards()).toHaveLength(2);
  });

  it("(c) DAILY_TOKEN_CAP=1: tasks wait in BLOCKED_BUDGET until the UTC day rolls over", async () => {
    const { h, seeded, user } = await start(
      { env: { DAILY_TOKEN_CAP: "1", AGENT_CONCURRENCY: "1" } },
      2,
    );
    const db = testDb();
    await approvePlan(h.deps, user, seeded.graphId);

    // The first call fits under the cap (nothing spent yet); every later one is blocked.
    await h.waitFor(
      async () =>
        (await db.agentTask.count({ where: { status: "BLOCKED_BUDGET" } })) === 2 &&
        (await db.agentTask.count({ where: { status: { in: ["QUEUED", "RUNNING"] } } })) === 0,
    );
    expect(await db.agentTask.count({ where: { status: "SUCCEEDED" } })).toBe(1);
    const blocked = await db.agentTask.findMany({ where: { status: "BLOCKED_BUDGET" } });
    const budget = await getBudget(h.deps);
    expect(budget).toMatchObject({ cap: 1, remaining: 0, blockedTasks: 2 });
    expect(budget.used).toBeGreaterThan(1);
    expect(await alerts("budget")).toHaveLength(1);
    expect(await db.realtimeEvent.count({ where: { type: "budget.updated" } })).toBeGreaterThan(0);

    // Same day: the sweeper leaves them alone.
    await h.runTick(JOB.tickSweeper);
    expect(await db.agentTask.count({ where: { status: "BLOCKED_BUDGET" } })).toBe(2);

    h.clock.advance(DAY_MS);
    await h.runTick(JOB.tickSweeper);
    await h.waitFor(async () => {
      const tasks = await db.agentTask.findMany({
        where: { id: { in: blocked.map((t) => t.id) } },
      });
      return tasks.some((task) => task.status === "SUCCEEDED");
    });
  });

  it("DAILY_TOKEN_CAP=1 with 4 workers: tasks blocked together send one budget alert", async () => {
    const { h, seeded, user } = await start(
      { env: { DAILY_TOKEN_CAP: "1", AGENT_CONCURRENCY: "4" } },
      6,
    );
    const db = testDb();
    await approvePlan(h.deps, user, seeded.graphId);

    // Settled: nothing queued or running, and nothing ready that advance() hasn't queued yet.
    await h.waitFor(async () => {
      const tasks = await db.agentTask.findMany({ select: { status: true, dependsOn: true } });
      const done = new Set(
        (await db.agentTask.findMany({ where: { status: "SUCCEEDED" }, select: { id: true } })).map(
          (task) => task.id,
        ),
      );
      return (
        tasks.every((task) => task.status !== "QUEUED" && task.status !== "RUNNING") &&
        !tasks.some(
          (task) => task.status === "PENDING" && task.dependsOn.every((dep) => done.has(dep)),
        )
      );
    });
    expect(
      await db.agentTask.count({ where: { status: "BLOCKED_BUDGET" } }),
    ).toBeGreaterThanOrEqual(4);
    expect(await alerts("budget")).toHaveLength(1);
  });

  it("a revision parked on the budget keeps the post closed to edits, then lands", async () => {
    const { h, seeded, user } = await start(
      { env: { DAILY_TOKEN_CAP: "1000000", AGENT_CONCURRENCY: "1" } },
      1,
    );
    const db = testDb();
    await approvePlan(h.deps, user, seeded.graphId);
    const round1 = await h.waitFor(() => db.approvalRequest.findFirst({ where: { round: 1 } }));
    const drafted = await db.post.findUniqueOrThrow({ where: { id: round1.postId } });

    // Spend the day's budget, then ask for changes: the Copywriter's revision can't run today.
    await db.tokenUsage.upsert({
      where: { day: utcDayStart(h.clock.now()) },
      create: { day: utcDayStart(h.clock.now()), inputTokens: 1_000_000n, calls: 1 },
      update: { inputTokens: { increment: 1_000_000n } },
    });
    await decide(h.deps, user, round1.id, {
      decision: "REQUEST_CHANGES",
      feedback: "Warmer, please.",
      target: "COPY",
    });
    const parked = await h.waitFor(() =>
      db.agentTask.findFirst({ where: { postId: drafted.id, status: "BLOCKED_BUDGET" } }),
    );
    expect(parked).toMatchObject({ action: "write", revision: 1 });

    await expect(
      editCopy(h.deps, user, drafted.id, {
        copy: { ...(drafted.copy as CopywriterOutput), caption: "A human's own words." },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.post.findUniqueOrThrow({ where: { id: drafted.id } })).toMatchObject({
      humanEditCount: 0,
      copy: drafted.copy,
    });

    // Next day the revision runs, reads the feedback and opens round 2 on the Copywriter's copy.
    h.clock.advance(DAY_MS);
    await h.runTick(JOB.tickSweeper);
    await h.waitFor(() => db.approvalRequest.findFirst({ where: { round: 2, status: "PENDING" } }));
    const revised = await db.post.findUniqueOrThrow({ where: { id: drafted.id } });
    expect(revised).toMatchObject({ status: "PENDING_APPROVAL", humanEditCount: 0 });
    expect((revised.copy as CopywriterOutput).caption).toMatch(/^\[rev\]/);
  });

  it("fails a task whose agent input breaks its contract, without spend or retries", async () => {
    const { h, seeded, user } = await start({ workers: false }, 1);
    const db = testDb();
    await approvePlan(h.deps, user, seeded.graphId);
    const task = await db.agentTask.findFirstOrThrow({ where: { status: "QUEUED" } });
    // A post with no platforms can't make a valid Copywriter input (post.platforms ≥ 1).
    await db.post.update({ where: { id: task.postId ?? "" }, data: { platforms: [] } });

    const runtime = await startWorkers(h.deps, { schedulers: false });
    try {
      const failed = await h.waitFor(() =>
        db.agentTask.findFirst({ where: { id: task.id, status: "FAILED" } }),
      );
      expect(failed.error).toMatch(/input that breaks its contract/);
      const job = await h.deps.queues
        .queue("agents")
        .getJob(jobIds.taskRun({ taskId: task.id, revision: 0, requeue: null }));
      await h.waitFor(async () => (await job?.getState()) === "failed");
      expect((await h.deps.queues.queue("agents").getJob(job?.id ?? ""))?.attemptsMade).toBe(1);
    } finally {
      await runtime.close();
    }
    expect(await db.agentRun.count()).toBe(0);
    const post = await db.post.findUniqueOrThrow({ where: { id: task.postId ?? "" } });
    expect(post.needsAttention).toBe(true);
    const message = await db.chatMessage.findFirstOrThrow({
      where: { threadId: seeded.threadId, kind: "ESCALATION" },
    });
    expect(message.agent).toBe("MANAGER");
    expect(message.payload).toMatchObject({ taskId: task.id, reason: "INVALID_INPUT" });
    expect((await alerts("failed")).map((alert) => alert.entityId)).toEqual([task.id]);
  });

  it("re-queues a stuck task once, then fails it with an alert", async () => {
    const { h, seeded, user } = await start({ workers: false }, 1);
    const db = testDb();
    await approvePlan(h.deps, user, seeded.graphId);
    const task = await db.agentTask.findFirstOrThrow({ where: { status: "QUEUED" } });

    // A queued job that is still waiting is not stuck, however old.
    h.clock.advance(20 * MINUTE_MS);
    await h.runTick(JOB.tickSweeper);
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: task.id } })).error).toBeNull();

    // Lose the job: the sweeper re-queues the task once.
    for (const name of QUEUE_NAMES) await h.deps.queues.queue(name).obliterate({ force: true });
    await h.runTick(JOB.tickSweeper);
    const requeued = await db.agentTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(requeued).toMatchObject({ status: "QUEUED", error: STALL_REQUEUE_NOTE });
    const job = (await h.deps.queues.queue("agents").getJobs(["waiting"])).find(
      (candidate) => (candidate.data as { taskId: string }).taskId === task.id,
    );
    expect(job?.id).toMatch(new RegExp(`^task-${task.id}-r0-stall-`));

    // Stuck again: FAILED, the post needs attention and an alert goes out.
    for (const name of QUEUE_NAMES) await h.deps.queues.queue(name).obliterate({ force: true });
    h.clock.advance(20 * MINUTE_MS);
    await h.runTick(JOB.tickSweeper);
    const failed = await db.agentTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(failed.status).toBe("FAILED");
    expect(
      (await db.post.findFirstOrThrow({ where: { id: task.postId ?? "" } })).needsAttention,
    ).toBe(true);
    expect((await alerts("stuck")).map((alert) => alert.entityId)).toContain(task.id);
  });

  it("queues an approved plan's ready tasks that nothing queued (a crash after the commit)", async () => {
    const { h, seeded, user } = await start({ workers: false }, 2);
    const db = testDb();
    await approvePlan(h.deps, user, seeded.graphId);
    // The state a crash between approvePlan's commit and advance() leaves: nothing queued, no jobs.
    await db.agentTask.updateMany({
      where: { status: "QUEUED" },
      data: { status: "PENDING", queuedAt: null },
    });
    for (const name of QUEUE_NAMES) await h.deps.queues.queue(name).obliterate({ force: true });

    await h.runTick(JOB.tickSweeper);
    const writes = await db.agentTask.findMany({ where: { action: "write" } });
    expect(writes.map((task) => task.status)).toEqual(["QUEUED", "QUEUED"]);
    // QA still waits for its draft.
    expect(await db.agentTask.count({ where: { action: "qa", status: "PENDING" } })).toBe(2);
    const jobs = await h.deps.queues.queue("agents").getJobs(["waiting"]);
    expect(jobs.map((job) => (job.data as { taskId: string }).taskId).sort()).toEqual(
      writes.map((task) => task.id).sort(),
    );

    // A second sweep finds nothing left to do.
    await h.runTick(JOB.tickSweeper);
    expect(await h.deps.queues.queue("agents").count()).toBe(2);

    const runtime = await startWorkers(h.deps, { schedulers: false });
    try {
      await h.waitFor(
        async () =>
          (await db.post.count({
            where: { campaignId: seeded.campaignId, status: "PENDING_APPROVAL" },
          })) === 2,
      );
    } finally {
      await runtime.close();
    }
  });

  it("leaves the ready tasks of an archived campaign alone", async () => {
    const { h, seeded, user } = await start({ workers: false }, 1);
    const db = testDb();
    await approvePlan(h.deps, user, seeded.graphId);
    await archiveCampaign(h.deps, user, seeded.campaignId);
    // Even a task somehow left PENDING and ready stays put once the campaign is archived.
    await db.agentTask.updateMany({ where: { action: "write" }, data: { status: "PENDING" } });
    for (const name of QUEUE_NAMES) await h.deps.queues.queue(name).obliterate({ force: true });

    await h.runTick(JOB.tickSweeper);
    expect(await db.agentTask.count({ where: { status: "QUEUED" } })).toBe(0);
    expect(await h.deps.queues.queue("agents").count()).toBe(0);
  });

  it("keeps an approval when what follows its commit fails, and still starts the plan", async () => {
    const { h, seeded, user } = await start({ workers: false }, 1);
    const db = testDb();
    const transaction = h.deps.prisma.$transaction.bind(h.deps.prisma) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    // The approval's own transaction commits; every later one (the progress recounts) fails.
    let calls = 0;
    const spy = vi.spyOn(h.deps.prisma, "$transaction").mockImplementation((...args: unknown[]) => {
      calls += 1;
      if (calls > 1) return Promise.reject(new Error("P2028: transaction API error"));
      return transaction(...args);
    });
    try {
      const approved = await approvePlan(h.deps, user, seeded.graphId);
      expect(approved.status).toBe("APPROVED");
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBeGreaterThan(1);
    const write = await db.agentTask.findFirstOrThrow({ where: { action: "write" } });
    expect(write.status).toBe("QUEUED");
    const job = await h.deps.queues
      .queue("agents")
      .getJob(jobIds.taskRun({ taskId: write.id, revision: 0, requeue: null }));
    expect(job).toBeTruthy();
  });

  it("registers the tick schedulers when the workers boot with schedulers on", async () => {
    const h = (harness = await startHarness({ workers: false }));
    const runtime = await startWorkers(h.deps, { schedulers: true });
    try {
      const schedulers = await h.deps.queues.queue("ops").getJobSchedulers();
      expect(schedulers.map((scheduler) => [scheduler.key, scheduler.every]).sort()).toEqual([
        ["tick.prune", DAY_MS],
        ["tick.publish", MINUTE_MS],
        ["tick.sweeper", 5 * MINUTE_MS],
        ["tick.tokens", HOUR_MS],
      ]);
    } finally {
      await runtime.close();
    }
  });

  it("tick.prune deletes week-old realtime events and expired sessions", async () => {
    const h = (harness = await startHarness({ workers: false }));
    const db = testDb();
    const user = await createUser();
    const now = h.clock.now();
    await db.realtimeEvent.createMany({
      data: [
        {
          channel: "global",
          type: "resync",
          payload: { reason: "old" },
          createdAt: new Date(now.getTime() - 8 * DAY_MS),
        },
        { channel: "global", type: "resync", payload: { reason: "new" }, createdAt: now },
      ],
    });
    await db.session.createMany({
      data: [
        { tokenHash: "expired", userId: user.id, expiresAt: new Date(now.getTime() - 1000) },
        { tokenHash: "live", userId: user.id, expiresAt: new Date(now.getTime() + DAY_MS) },
      ],
    });
    await h.runTick(JOB.tickPrune);
    expect((await db.realtimeEvent.findMany()).map((row) => row.payload)).toEqual([
      { reason: "new" },
    ]);
    expect((await db.session.findMany()).map((row) => row.tokenHash)).toEqual(["live"]);
  });
});

/* ─── campaign-level Manager jobs ─────────────────────────────────────────────────────────────── */

/** Runs a queued job's processor now, as BullMQ attempt `attemptsMade + 1` of 3 would. */
function attempt<T>(name: string, data: T, attemptsMade: number) {
  return { id: `${name}-attempt-${attemptsMade}`, name, data, attemptsMade, opts: { attempts: 3 } };
}

async function managerMessages(threadId: string) {
  return testDb().chatMessage.findMany({
    where: { threadId, role: "AGENT", agent: "MANAGER" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

const FULL_BRIEF = "Ramadan campaign — 4 posts on Instagram, March 1–30";

describe("manager jobs that fail every attempt", () => {
  it("intake: the Manager says so on the last attempt, and a resend is read again", async () => {
    const llm = new SwitchableLlm(new DownLlm());
    const h = (harness = await startHarness({ llm, workers: false }));
    const db = testDb();
    const admin = await createUser({ role: "ADMIN" });
    const client = await createClient({ name: "Qahwa Co", enabledPlatforms: ["INSTAGRAM"] });
    const user = toServiceUser(admin, null);
    const campaign = await createCampaignFromMessage(h.deps, user, {
      clientId: client.id,
      message: FULL_BRIEF,
    });
    const [message] = await listMessages(h.deps, campaign.threadId);
    const job: ManagerIntakeJob = { campaignId: campaign.id, messageId: message?.id ?? "" };

    // While BullMQ has retries left the thread is left alone: the next attempt may well work.
    for (const made of [0, 1]) {
      await expect(
        managerIntakeProcessor(attempt(JOB.managerIntake, job, made), h.deps),
      ).rejects.toThrow(/Overloaded/);
    }
    expect(await managerMessages(campaign.threadId)).toEqual([]);
    expect(await alerts("failed")).toEqual([]);

    // The last attempt fails too: the Manager answers the turn, so the composer opens again.
    await expect(
      managerIntakeProcessor(attempt(JOB.managerIntake, job, 2), h.deps),
    ).rejects.toThrow(/Overloaded/);
    const replies = await managerMessages(campaign.threadId);
    expect(replies.map((reply) => [reply.kind, reply.content])).toEqual([
      ["TEXT", INTAKE_UNAVAILABLE_REPLY],
    ]);
    const failed = await alerts("failed");
    expect(failed).toEqual([
      expect.objectContaining({ entityType: "Campaign", entityId: campaign.id }),
    ]);
    expect(failed[0]?.message).toMatch(/^Manager intake failed after every retry: 529/);
    expect(await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({
      status: "BRIEFING",
      briefLockedAt: null,
    });

    // The model is back: sending the brief again queues a fresh intake that locks it.
    llm.target = new MockLlm();
    const resent = await postUserMessage(h.deps, user, campaign.threadId, FULL_BRIEF);
    const retry = { campaignId: campaign.id, messageId: resent.id };
    expect(await h.deps.queues.queue("agents").getJob(jobIds.managerIntake(retry))).toBeTruthy();
    await managerIntakeProcessor(attempt(JOB.managerIntake, retry, 0), h.deps);
    expect((await managerMessages(campaign.threadId)).map((reply) => reply.kind)).toEqual([
      "TEXT",
      "BRIEF",
    ]);
  });

  it("plan: the Manager says so on the last attempt, and the next message re-plans", async () => {
    const llm = new SwitchableLlm(new DownLlm());
    const h = (harness = await startHarness({ llm, workers: false }));
    const seeded = await seedProposedPlan(h, { postCount: 1 });
    const user = toServiceUser(seeded.admin, null);
    // The brief is locked and its first plan was queued, but never landed.
    await testDb().taskGraph.deleteMany({ where: { campaignId: seeded.campaignId } });
    const job: ManagerPlanJob = {
      campaignId: seeded.campaignId,
      version: 1,
      changeRequest: null,
      previousGraphId: null,
    };

    await expect(managerPlanProcessor(attempt(JOB.managerPlan, job, 0), h.deps)).rejects.toThrow(
      /Overloaded/,
    );
    expect(await managerMessages(seeded.threadId)).toEqual([]);

    await expect(managerPlanProcessor(attempt(JOB.managerPlan, job, 2), h.deps)).rejects.toThrow(
      /Overloaded/,
    );
    expect(
      (await managerMessages(seeded.threadId)).map((reply) => [reply.kind, reply.content]),
    ).toEqual([["TEXT", PLAN_UNAVAILABLE_REPLY]]);
    expect(await alerts("failed")).toEqual([
      expect.objectContaining({ entityType: "Campaign", entityId: seeded.campaignId }),
    ]);

    llm.target = new MockLlm();
    const resent = await postUserMessage(h.deps, user, seeded.threadId, "Plan it again, please.");
    const replan = await h.deps.queues
      .queue("agents")
      .getJob(`${jobIds.managerPlan(job)}-${resent.id}`);
    expect(replan?.data).toEqual({ ...job, changeRequest: "Plan it again, please." });
    await managerPlanProcessor(attempt(JOB.managerPlan, replan?.data as ManagerPlanJob, 0), h.deps);
    expect(
      await testDb().taskGraph.findFirst({
        where: { campaignId: seeded.campaignId, version: 1, status: "PROPOSED" },
      }),
    ).toBeTruthy();
  });
});

describe("manager jobs parked for the budget", () => {
  /** 09:00 UTC: the next UTC midnight is 15 hours away. */
  const NOW = "2027-01-11T09:00:00.000Z";
  const UNTIL_MIDNIGHT_MS = 15 * 60 * MINUTE_MS;

  /** Adds the whole 1,000-token cap to today's spend. */
  async function spendTodaysBudget(h: Harness) {
    const day = utcDayStart(h.clock.now());
    await testDb().tokenUsage.upsert({
      where: { day },
      create: { day, inputTokens: 1_000n, calls: 1 },
      update: { inputTokens: { increment: 1_000n } },
    });
  }

  it("re-queues intake and plan for just after UTC midnight, then runs them", async () => {
    const h = (harness = await startHarness({
      clock: new FakeClock(NOW),
      env: { DAILY_TOKEN_CAP: "1000" },
      workers: false,
    }));
    const db = testDb();
    const admin = await createUser({ role: "ADMIN" });
    const client = await createClient({ name: "Qahwa Co", enabledPlatforms: ["INSTAGRAM"] });
    const user = toServiceUser(admin, null);
    await spendTodaysBudget(h);
    const campaign = await createCampaignFromMessage(h.deps, user, {
      clientId: client.id,
      message: FULL_BRIEF,
    });
    const [message] = await listMessages(h.deps, campaign.threadId);
    const intake: ManagerIntakeJob = { campaignId: campaign.id, messageId: message?.id ?? "" };

    // The budget is spent: intake is parked, not failed, and nothing reaches the model.
    await managerIntakeProcessor(attempt(JOB.managerIntake, intake, 0), h.deps);
    expect(await db.agentRun.count()).toBe(0);
    expect((await managerMessages(campaign.threadId)).map((reply) => reply.content)).toEqual([
      "Today's token budget is spent (1,000/1,000 tokens). I'll pick this up after UTC midnight.",
    ]);
    expect(await alerts("budget")).toEqual([
      expect.objectContaining({ entityType: "Campaign", entityId: campaign.id }),
    ]);
    expect(await db.realtimeEvent.count({ where: { type: "budget.updated" } })).toBe(1);
    const parkedIntake = await h.deps.queues
      .queue("agents")
      .getJob(`${jobIds.managerIntake(intake)}-budget-2027-01-12`);
    expect(await parkedIntake?.getState()).toBe("delayed");
    expect(parkedIntake?.data).toEqual(intake);
    // Just after midnight: the 15 hours left today plus a few seconds' margin.
    expect(parkedIntake?.opts.delay).toBeGreaterThan(UNTIL_MIDNIGHT_MS);
    expect(parkedIntake?.opts.delay).toBeLessThanOrEqual(UNTIL_MIDNIGHT_MS + 60_000);

    // Next day, the parked job runs: the brief locks and plan v1 is queued…
    h.clock.advance(DAY_MS);
    await managerIntakeProcessor(attempt(JOB.managerIntake, parkedIntake?.data, 0), h.deps);
    expect(await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({
      status: "PLANNING",
      clientId: client.id,
    });
    const plan: ManagerPlanJob = {
      campaignId: campaign.id,
      version: 1,
      changeRequest: null,
      previousGraphId: null,
    };
    expect(await h.deps.queues.queue("agents").getJob(jobIds.managerPlan(plan))).toBeTruthy();

    // …into a budget that is spent again, so the plan is parked the same way, until the day after.
    await spendTodaysBudget(h);
    await managerPlanProcessor(attempt(JOB.managerPlan, plan, 0), h.deps);
    expect(await db.taskGraph.count()).toBe(0);
    expect(await alerts("budget")).toHaveLength(2);
    const parkedPlan = await h.deps.queues
      .queue("agents")
      .getJob(`${jobIds.managerPlan(plan)}-budget-2027-01-13`);
    expect(await parkedPlan?.getState()).toBe("delayed");
    expect(parkedPlan?.opts.delay).toBeGreaterThan(UNTIL_MIDNIGHT_MS);

    h.clock.advance(DAY_MS);
    await managerPlanProcessor(attempt(JOB.managerPlan, parkedPlan?.data, 0), h.deps);
    expect(
      await db.taskGraph.findFirstOrThrow({ where: { campaignId: campaign.id } }),
    ).toMatchObject({ version: 1, status: "PROPOSED" });
    expect((await managerMessages(campaign.threadId)).map((reply) => reply.kind)).toEqual([
      "TEXT",
      "BRIEF",
      "TEXT",
      "PLAN",
    ]);
  });
});

describe("two brief turns parked for the budget", () => {
  const NOW = "2027-01-11T09:00:00.000Z";

  it("fire together after midnight: only the newest is answered, with the one question", async () => {
    const h = (harness = await startHarness({
      clock: new FakeClock(NOW),
      env: { DAILY_TOKEN_CAP: "1000" },
      workers: false,
    }));
    const db = testDb();
    const admin = await createUser({ role: "ADMIN" });
    const client = await createClient({ name: "Qahwa Co", enabledPlatforms: ["INSTAGRAM"] });
    const user = toServiceUser(admin, null);
    const day = utcDayStart(h.clock.now());
    await db.tokenUsage.create({ data: { day, inputTokens: 1_000n, calls: 1 } });

    // The brief is parked; the budget notice reopens the composer, so the team adds to it.
    const campaign = await createCampaignFromMessage(h.deps, user, {
      clientId: client.id,
      message: "Ramadan campaign — 4 posts",
    });
    const [first] = await listMessages(h.deps, campaign.threadId);
    const firstJob: ManagerIntakeJob = { campaignId: campaign.id, messageId: first?.id ?? "" };
    await managerIntakeProcessor(attempt(JOB.managerIntake, firstJob, 0), h.deps);
    const second = await postUserMessage(h.deps, user, campaign.threadId, "Push the iced line");
    const secondJob: ManagerIntakeJob = { campaignId: campaign.id, messageId: second.id };
    await managerIntakeProcessor(attempt(JOB.managerIntake, secondJob, 0), h.deps);
    const parked = await Promise.all(
      [firstJob, secondJob].map((job) =>
        h.deps.queues.queue("agents").getJob(`${jobIds.managerIntake(job)}-budget-2027-01-12`),
      ),
    );
    expect(parked.map((job) => job?.data as unknown)).toEqual([firstJob, secondJob]);

    // Both parked jobs fire at the same moment after midnight.
    h.clock.advance(DAY_MS);
    await Promise.all(
      parked.map((job) => managerIntakeProcessor(attempt(JOB.managerIntake, job?.data, 0), h.deps)),
    );
    expect((await managerMessages(campaign.threadId)).map((reply) => reply.kind)).toEqual([
      "TEXT",
      "TEXT",
      "CLARIFY",
    ]);
    expect(await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({
      status: "BRIEFING",
      clarifyCount: 1,
      briefLockedAt: null,
    });

    // The team's answer (a day later: the question spent that day's small budget) locks the brief.
    h.clock.advance(DAY_MS);
    const answer = await postUserMessage(h.deps, user, campaign.threadId, "Instagram, March 1–30");
    await managerIntakeProcessor(
      attempt(JOB.managerIntake, { campaignId: campaign.id, messageId: answer.id }, 0),
      h.deps,
    );
    expect((await managerMessages(campaign.threadId)).map((reply) => reply.kind)).toEqual([
      "TEXT",
      "TEXT",
      "CLARIFY",
      "BRIEF",
    ]);
    expect(await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({
      status: "PLANNING",
      clientId: client.id,
    });
  });
});
