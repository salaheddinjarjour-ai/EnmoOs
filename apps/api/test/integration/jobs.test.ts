import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createDeps, type Deps } from "../../src/deps";
import {
  JOB,
  QUEUE_NAMES,
  createJobQueues,
  enqueueManagerIntake,
  enqueueManagerPlan,
  enqueueTaskRun,
  jobIds,
  parseJobData,
  type TaskRunJob,
} from "../../src/jobs/queues";
import type { ProcessorRegistry, QueuedJob } from "../../src/jobs/registry";
import { startWorkers, type WorkerRuntime } from "../../src/jobs/runtime";
import { isAppError } from "../../src/lib/errors";
import { createLogger } from "../../src/lib/logger";
import { testConfig } from "../helpers/app";

/*
 * The Phase 2 queue wiring (DESIGN §D) against the real Redis: payload validation and idempotent
 * job ids on the producer side, dispatch by job name in the worker runtime, and producers that
 * fail fast when Redis is gone. Each test gets its own BULLMQ_PREFIX and removes its keys.
 */

const open: { deps: Deps; runtime?: WorkerRuntime }[] = [];

function setup(): Deps {
  const deps = createDeps(testConfig(), { queuePrefix: `jobs-test-${randomUUID().slice(0, 8)}` });
  open.push({ deps });
  return deps;
}

async function start(deps: Deps, registry: ProcessorRegistry): Promise<WorkerRuntime> {
  const runtime = await startWorkers(deps, { registry });
  const entry = open.find((candidate) => candidate.deps === deps);
  if (entry) entry.runtime = runtime;
  return runtime;
}

afterEach(async () => {
  for (const { deps, runtime } of open.splice(0)) {
    await runtime?.close();
    for (const name of QUEUE_NAMES) await deps.queues.queue(name).obliterate({ force: true });
    await deps.close();
  }
});

/** A processor that resolves `received` with each job it is handed. */
function recorder() {
  const jobs: QueuedJob[] = [];
  let notify: () => void = () => undefined;
  const next = () =>
    new Promise<void>((resolve) => {
      notify = resolve;
    });
  return {
    jobs,
    next,
    processor: (job: QueuedJob) => {
      jobs.push(job);
      notify();
      return Promise.resolve({ ok: true });
    },
  };
}

const TASK: TaskRunJob = { taskId: "task_1", revision: 0, requeue: null };

describe("producers", () => {
  it("use the configured or overridden prefix", () => {
    const deps = setup();
    expect(deps.queues.prefix).toMatch(/^jobs-test-/);
    expect(deps.queues.queue("agents").opts.prefix).toBe(deps.queues.prefix);
  });

  it("validate payloads before anything reaches Redis", async () => {
    const deps = setup();
    await expect(
      enqueueTaskRun(deps.queues, { taskId: "", revision: -1, requeue: null }),
    ).rejects.toThrow();
    await expect(
      enqueueManagerPlan(deps.queues, {
        campaignId: "c1",
        version: 2,
        changeRequest: "   ",
        previousGraphId: "g1",
      }),
    ).rejects.toThrow(/blank/);
    expect(await deps.queues.queue("agents").count()).toBe(0);
  });

  it("add each deterministic job id once", async () => {
    const deps = setup();
    const first = await enqueueTaskRun(deps.queues, TASK);
    const again = await enqueueTaskRun(deps.queues, TASK);
    expect(first).toBe("task-task_1-r0");
    expect(again).toBe(first);

    const requeued = await enqueueTaskRun(deps.queues, { ...TASK, requeue: "stall1" });
    expect(requeued).toBe("task-task_1-r0-stall1");

    const agents = deps.queues.queue("agents");
    expect(await agents.getJobCounts("waiting")).toEqual({ waiting: 2 });
    const job = await agents.getJob(first);
    expect(job?.name).toBe(JOB.taskRun);
    expect(parseJobData(JOB.taskRun, job?.data)).toEqual(TASK);
    expect(job?.opts).toMatchObject({ attempts: 3, backoff: { type: "exponential", delay: 5000 } });
  });

  it("keep the plan's change request byte-for-byte", async () => {
    const deps = setup();
    const changeRequest = "  Fewer reels —\nmore carousels, please.  ";
    const id = await enqueueManagerPlan(deps.queues, {
      campaignId: "camp_1",
      version: 2,
      changeRequest,
      previousGraphId: "graph_1",
    });
    expect(id).toBe(jobIds.managerPlan({ campaignId: "camp_1", version: 2 }));
    const job = await deps.queues.queue("agents").getJob(id);
    expect(parseJobData(JOB.managerPlan, job?.data).changeRequest).toBe(changeRequest);
  });

  it("refuse job ids BullMQ would reject", async () => {
    const deps = setup();
    await expect(
      deps.queues.add(JOB.taskRun, TASK, { jobId: "task:task_1:r0:again" }),
    ).rejects.toThrow(/must not contain ":"/);
  });

  it("fail fast with UNAVAILABLE when Redis is unreachable", async () => {
    const queues = createJobQueues({
      redisUrl: "redis://127.0.0.1:1",
      prefix: "unreachable",
      logger: createLogger({ level: "silent", name: "jobs-test" }),
      readyTimeoutMs: 200,
    });
    try {
      const error: unknown = await enqueueTaskRun(queues, TASK).catch((caught: unknown) => caught);
      expect(isAppError(error) && error.code).toBe("UNAVAILABLE");
    } finally {
      await queues.close();
    }
  });
});

describe("worker runtime", () => {
  it("hands each job to the processor registered for its name, on the deps prefix", async () => {
    const deps = setup();
    const intake = recorder();
    const taskRun = recorder();
    await start(deps, {
      agents: { [JOB.managerIntake]: intake.processor, [JOB.taskRun]: taskRun.processor },
      media: {},
      ops: {},
    });

    const received = taskRun.next();
    await enqueueTaskRun(deps.queues, TASK);
    await received;
    expect(taskRun.jobs.map((job) => [job.name, job.data])).toEqual([[JOB.taskRun, TASK]]);
    expect(taskRun.jobs[0]?.opts.attempts).toBe(3);
    expect(intake.jobs).toEqual([]);

    const intakeReceived = intake.next();
    await enqueueManagerIntake(deps.queues, { campaignId: "camp_1", messageId: "msg_1" });
    await intakeReceived;
    expect(intake.jobs[0]?.id).toBe("intake-camp_1-msg_1");
  });

  it("fails a job with no registered processor without retrying it", async () => {
    const deps = setup();
    const taskRun = recorder();
    await start(deps, { agents: { [JOB.taskRun]: taskRun.processor }, media: {}, ops: {} });

    const agents = deps.queues.queue("agents");
    const job = await agents.add("no.such.job", {}, { jobId: "orphan-1" });
    let state = await job.getState();
    for (let i = 0; i < 100 && state !== "failed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      state = await job.getState();
    }
    expect(state).toBe("failed");
    const failed = await agents.getJob("orphan-1");
    expect(failed?.attemptsMade).toBe(1);
    expect(failed?.failedReason).toMatch(/No processor is registered for no\.such\.job/);
  });

  it("stays idle, and closes cleanly, when no queue has processors", async () => {
    const deps = setup();
    const runtime = await start(deps, { agents: {}, media: {}, ops: {} });
    await runtime.close();
  });
});
