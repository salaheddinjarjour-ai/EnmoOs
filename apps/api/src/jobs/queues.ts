import { Id, VerbatimText } from "@enmo/shared";
import { Queue, UnrecoverableError, type DefaultJobOptions, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { Config } from "../config";
import { AppError } from "../lib/errors";
import type { Logger } from "../lib/logger";
import { closeRedis, createProducerConnection } from "./connection";

/*
 * The three BullMQ queues, every job name with its payload schema and deterministic job id, and
 * the producer side (DESIGN §D). Processors live in processors/*.ts and are wired by registry.ts;
 * runtime.ts consumes.
 *
 *   agents  LLM work (visual.review too)     concurrency AGENT_CONCURRENCY
 *   media   rendering and adapting            concurrency MEDIA_CONCURRENCY
 *   ops     publishing, metrics, ticks        concurrency 2
 */

export const QUEUE_NAMES = ["agents", "media", "ops"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export const OPS_CONCURRENCY = 2;

export function queueConcurrency(config: Config, queue: QueueName): number {
  switch (queue) {
    case "agents":
      return config.AGENT_CONCURRENCY;
    case "media":
      return config.MEDIA_CONCURRENCY;
    case "ops":
      return OPS_CONCURRENCY;
  }
}

/* ─── job names and payloads ─────────────────────────────────────────────────────────────────── */

export const JOB = {
  /** Read the thread, then ask the one clarifying question or lock the brief. */
  managerIntake: "manager.intake",
  /** Propose TaskGraph `version` for the campaign's brief (a re-plan carries the change request). */
  managerPlan: "manager.plan",
  /** Run one AgentTask of an approved graph. */
  taskRun: "task.run",
  /** Hand one QUEUED shot Asset to the visual provider (Asset.providerJobId, RENDERING). */
  renderSubmit: "render.submit",
  /** Ask the provider how an Asset's job is doing; re-enqueued with a 3-10s delay until it settles. */
  renderPoll: "render.poll",
  /** The Visual Director looks at one READY take: accept, regenerate or escalate. */
  visualReview: "visual.review",
  /** A Vault regenerate: the Visual Director re-plans one shot in its original context. */
  visualRegenerate: "visual.regenerate",
  /** After a post's final approval: slot candidates, the Publisher's pick, one PublishJob each. */
  publisherSchedule: "publisher.schedule",
  /** Publish one due PublishJob (or resume its container) through the platform's publisher. */
  publishRun: "publish.run",
  /** Check media the platform is still processing; re-enqueued until it is live or times out. */
  publishPoll: "publish.poll",
  /** Every 5 min: stuck RUNNING tasks, BLOCKED_BUDGET after the UTC day rolls, stale WAITING. */
  tickSweeper: "tick.sweeper",
  /** Daily: RealtimeEvent rows older than 7 days and expired Session rows. */
  tickPrune: "tick.prune",
  /** Every minute: SCHEDULED PublishJobs whose slot has come are QUEUED and handed to publish.run. */
  tickPublish: "tick.publish",
  /** Hourly: social account tokens checked (debug_token), expired ones marked with an alert. */
  tickTokens: "tick.tokens",
} as const;
export type JobName = (typeof JOB)[keyof typeof JOB];

export const TICK_JOB_NAMES = [
  JOB.tickSweeper,
  JOB.tickPrune,
  JOB.tickPublish,
  JOB.tickTokens,
] as const;
export type TickJobName = (typeof TICK_JOB_NAMES)[number];

/** The queue each job runs on. */
export const JOB_QUEUE: Readonly<Record<JobName, QueueName>> = {
  "manager.intake": "agents",
  "manager.plan": "agents",
  "task.run": "agents",
  "render.submit": "media",
  "render.poll": "media",
  "visual.review": "agents",
  "visual.regenerate": "agents",
  "publisher.schedule": "agents",
  "publish.run": "ops",
  "publish.poll": "ops",
  "tick.sweeper": "ops",
  "tick.prune": "ops",
  "tick.publish": "ops",
  "tick.tokens": "ops",
};

/** A short token that makes a deliberate re-queue a new job, e.g. "stall1" or "budget-2026-09-25". */
export const RequeueToken = z.string().regex(/^[A-Za-z0-9._-]{1,48}$/);
export type RequeueToken = z.infer<typeof RequeueToken>;

export const ManagerIntakeJob = z.object({
  campaignId: Id,
  /** The USER ChatMessage this intake answers (the brief, or the reply to the clarify). */
  messageId: Id,
});
export type ManagerIntakeJob = z.infer<typeof ManagerIntakeJob>;

export const ManagerPlanJob = z.object({
  campaignId: Id,
  /** The TaskGraph version to create: 1, or n+1 after a plan change request. */
  version: z.int().positive(),
  /** The reviewer's plan feedback, byte-for-byte; null for version 1. */
  changeRequest: VerbatimText.nullable(),
  /** The graph being replaced (SUPERSEDED once the new one is proposed). */
  previousGraphId: Id.nullable(),
});
export type ManagerPlanJob = z.infer<typeof ManagerPlanJob>;

export const TaskRunJob = z.object({
  taskId: Id,
  /** AgentTask.revision (0 for the planned node, N for an .rN revision node). */
  revision: z.int().nonnegative(),
  /** Set when the sweeper, the budget roll-over or a manual retry queues the task again. */
  requeue: RequeueToken.nullable(),
});
export type TaskRunJob = z.infer<typeof TaskRunJob>;

/** render.submit: the Asset row carries the shot (prompt, params); the job only names it. */
export const RenderSubmitJob = z.object({ assetId: Id });
export type RenderSubmitJob = z.infer<typeof RenderSubmitJob>;

export const RenderPollJob = z.object({
  assetId: Id,
  /** 1 for the first poll after submit; each re-enqueue adds one (and backs off, see below). */
  attempt: z.int().positive(),
});
export type RenderPollJob = z.infer<typeof RenderPollJob>;

/** visual.review: one review per Asset row; a regeneration is a new row with its own review. */
export const VisualReviewJob = z.object({ assetId: Id });
export type VisualReviewJob = z.infer<typeof VisualReviewJob>;

/**
 * visual.regenerate: the new QUEUED version POST /assets/:id/regenerate created. The Visual
 * Director re-plans its shot from Asset.params (the shot, the Vault instruction verbatim) before
 * it is submitted.
 */
export const VisualRegenerateJob = z.object({ assetId: Id });
export type VisualRegenerateJob = z.infer<typeof VisualRegenerateJob>;

/**
 * publisher.schedule: the post whose approval round `round` just ended APPROVED. The round makes a
 * re-approval (an edit after approval reopens it) a new job, and lets a late job for an older round
 * see that it is stale.
 */
export const PublisherScheduleJob = z.object({
  postId: Id,
  round: z.int().positive(),
});
export type PublisherScheduleJob = z.infer<typeof PublisherScheduleJob>;

/**
 * publish.run: one attempt at publishing a PublishJob. `attempt` is the PublishJob.attempts value
 * this run makes (+1 for each run, automatic or manual retry, over the job's whole life: it never
 * starts again at 1 when the job is scheduled anew), so every run is a new BullMQ job while a
 * duplicate trigger of the same attempt is not.
 */
export const PublishRunJob = z.object({
  publishJobId: Id,
  attempt: z.int().positive(),
  /**
   * The attempt that began this chain of automatic retries; left out, this run begins one (a due
   * slot, a teammate's retry). PUBLISH_MAX_ATTEMPTS counts from it, so a job scheduled again after
   * earlier runs still gets its full allowance.
   */
  firstAttempt: z.int().positive().optional(),
});
export type PublishRunJob = z.infer<typeof PublishRunJob>;

export const PublishPollJob = z.object({
  publishJobId: Id,
  /** The publish.run attempt whose container this polls. */
  attempt: z.int().positive(),
  /** 1 for the first check after the container was created; each re-enqueue adds one. */
  poll: z.int().positive(),
});
export type PublishPollJob = z.infer<typeof PublishPollJob>;

/** Scheduler ticks carry no data; everything they act on is read from the database. */
export const TickJob = z.object({});
export type TickJob = z.infer<typeof TickJob>;

export const JOB_PAYLOADS = {
  "manager.intake": ManagerIntakeJob,
  "manager.plan": ManagerPlanJob,
  "task.run": TaskRunJob,
  "render.submit": RenderSubmitJob,
  "render.poll": RenderPollJob,
  "visual.review": VisualReviewJob,
  "visual.regenerate": VisualRegenerateJob,
  "publisher.schedule": PublisherScheduleJob,
  "publish.run": PublishRunJob,
  "publish.poll": PublishPollJob,
  "tick.sweeper": TickJob,
  "tick.prune": TickJob,
  "tick.publish": TickJob,
  "tick.tokens": TickJob,
} as const satisfies Record<JobName, z.ZodType>;
export type JobData<N extends JobName> = z.infer<(typeof JOB_PAYLOADS)[N]>;

/**
 * Validates a job's data inside its processor. Jobs outlive deploys, so a processor never trusts
 * the shape its producer had in mind. Malformed data fails the job for good: a retry carries the
 * same data.
 */
export function parseJobData<N extends JobName>(name: N, data: unknown): JobData<N> {
  const parsed = JOB_PAYLOADS[name].safeParse(data);
  if (!parsed.success) {
    throw new UnrecoverableError(`Invalid ${name} job data: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data as JobData<N>;
}

/* ─── job ids ────────────────────────────────────────────────────────────────────────────────── */

/*
 * Deterministic ids make every enqueue idempotent: BullMQ ignores an add whose id already exists,
 * and finished jobs are kept for a day (removeOnComplete), so a duplicate trigger in that window
 * is a no-op. DESIGN writes them as task:<id>:r<revision>, but BullMQ rejects custom ids containing
 * ":" (it tolerates exactly three segments only for legacy repeatable jobs), hence "-".
 */
export const jobIds = {
  managerIntake: ({ campaignId, messageId }: ManagerIntakeJob) =>
    `intake-${campaignId}-${messageId}`,
  managerPlan: ({ campaignId, version }: Pick<ManagerPlanJob, "campaignId" | "version">) =>
    `plan-${campaignId}-v${version}`,
  taskRun: ({ taskId, revision, requeue }: TaskRunJob) =>
    `task-${taskId}-r${revision}${requeue ? `-${requeue}` : ""}`,
  /** DESIGN's render:<assetId>:submit; a requeue token lets the sweeper submit a lost job again. */
  renderSubmit: ({ assetId }: RenderSubmitJob, requeue?: RequeueToken | null) =>
    `render-${assetId}-submit${requeueSuffix(requeue)}`,
  renderPoll: ({ assetId, attempt }: RenderPollJob) => `render-${assetId}-poll${attempt}`,
  /** DESIGN's review:<assetId>. */
  visualReview: ({ assetId }: VisualReviewJob, requeue?: RequeueToken | null) =>
    `review-${assetId}${requeueSuffix(requeue)}`,
  visualRegenerate: ({ assetId }: VisualRegenerateJob, requeue?: RequeueToken | null) =>
    `regenerate-${assetId}${requeueSuffix(requeue)}`,
  /** A requeue token lets the sweeper schedule a post whose job was lost. */
  publisherSchedule: ({ postId, round }: PublisherScheduleJob, requeue?: RequeueToken | null) =>
    `schedule-${postId}-r${round}${requeueSuffix(requeue)}`,
  /** DESIGN's publish:<id>:run, one per attempt. */
  publishRun: ({ publishJobId, attempt }: PublishRunJob) => `publish-${publishJobId}-run${attempt}`,
  /** DESIGN's publish:<id>:poll:<n>, scoped to the attempt that created the container. */
  publishPoll: ({ publishJobId, attempt, poll }: PublishPollJob) =>
    `publish-${publishJobId}-run${attempt}-poll${poll}`,
} as const;

function requeueSuffix(requeue: RequeueToken | null | undefined): string {
  return requeue ? `-${RequeueToken.parse(requeue)}` : "";
}

/* ─── render polling ─────────────────────────────────────────────────────────────────────────── */

/** The longest wait between two polls of one render (DESIGN §D: 3-10s). */
export const RENDER_POLL_MAX_DELAY_MS = 10_000;

/**
 * How long to wait before poll `attempt`: RENDER_POLL_DELAY_MS for the first, then ×1.5 per poll
 * up to RENDER_POLL_MAX_DELAY_MS, so quick mock renders settle fast and slow video renders cost
 * few queue commands.
 */
export function renderPollDelayMs(
  config: Pick<Config, "RENDER_POLL_DELAY_MS">,
  attempt: number,
): number {
  const base = config.RENDER_POLL_DELAY_MS;
  const delay = Math.round(base * 1.5 ** Math.max(0, attempt - 1));
  return Math.min(Math.max(base, RENDER_POLL_MAX_DELAY_MS), delay);
}

/* ─── publish polling ────────────────────────────────────────────────────────────────────────── */

/** The wait before each publish.poll (PUBLISH_POLL_INTERVAL_SEC). */
export function publishPollDelayMs(config: Pick<Config, "PUBLISH_POLL_INTERVAL_SEC">): number {
  return config.PUBLISH_POLL_INTERVAL_SEC * 1_000;
}

/**
 * The polls one container gets before the publish fails as timed out: as many intervals as fit
 * in PUBLISH_POLL_MAX_MIN, at least one.
 */
export function publishPollMaxPolls(
  config: Pick<Config, "PUBLISH_POLL_INTERVAL_SEC" | "PUBLISH_POLL_MAX_MIN">,
): number {
  return Math.max(
    1,
    Math.floor((config.PUBLISH_POLL_MAX_MIN * 60) / config.PUBLISH_POLL_INTERVAL_SEC),
  );
}

/* ─── options ────────────────────────────────────────────────────────────────────────────────── */

const KEEP_COMPLETED = { age: 86_400, count: 1_000 } as const;
const KEEP_FAILED = { age: 604_800 } as const;

/**
 * Transport errors (429, 5xx, connection) are retried by the Anthropic SDK first, then by BullMQ:
 * 3 attempts with exponential backoff from 5s. Contract failures escalate instead of throwing, so
 * only transport and infrastructure errors reach these attempts; a processor may still have done
 * part of its work before one, so every processor must be safe to run again.
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: KEEP_COMPLETED,
  removeOnFail: KEEP_FAILED,
} as const satisfies DefaultJobOptions;

/** Per-job overrides of DEFAULT_JOB_OPTIONS: a failed tick is simply redone by the next one. */
export const JOB_OPTIONS: Readonly<Partial<Record<JobName, JobsOptions>>> = {
  "tick.sweeper": { attempts: 1 },
  "tick.prune": { attempts: 1 },
  "tick.publish": { attempts: 1 },
  "tick.tokens": { attempts: 1 },
};

/** BullMQ Worker settings shared by every queue (runtime.ts adds concurrency and drainDelay). */
export const WORKER_SETTINGS = {
  stalledInterval: 60_000,
  removeOnComplete: KEEP_COMPLETED,
  removeOnFail: KEEP_FAILED,
} as const;

/* ─── producer ───────────────────────────────────────────────────────────────────────────────── */

/** How long an enqueue waits for a producer connection that never came up (Redis down at boot). */
export const ENQUEUE_READY_TIMEOUT_MS = 5_000;

export interface EnqueueOptions {
  /** Deterministic id from `jobIds` (or another stable key); a repeat add is a no-op. */
  jobId: string;
  delayMs?: number;
}

/** The producer side of the queues, shared by the API and the worker (deps.queues). */
export interface JobQueues {
  /** BULLMQ_PREFIX, or a test's override. Workers must consume with this same prefix. */
  readonly prefix: string;
  /** The BullMQ Queue for `name`, created (and connected) on first use. */
  queue(name: QueueName): Queue;
  /**
   * Validates `data` against the job's schema and adds it to its queue. Resolves to the job id;
   * rejects with UNAVAILABLE when Redis can't take the job.
   */
  add<N extends JobName>(name: N, data: JobData<N>, options: EnqueueOptions): Promise<string>;
  /** Closes the Queue instances and their connection. */
  close(): Promise<void>;
}

export interface JobQueuesOptions {
  redisUrl: string;
  prefix: string;
  logger: Logger;
  /** Defaults to ENQUEUE_READY_TIMEOUT_MS. */
  readyTimeoutMs?: number;
}

function unavailable(cause?: unknown): AppError {
  return new AppError("UNAVAILABLE", "The job queue is unavailable, try again shortly", { cause });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(unavailable()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createJobQueues({
  redisUrl,
  prefix,
  logger,
  readyTimeoutMs = ENQUEUE_READY_TIMEOUT_MS,
}: JobQueuesOptions): JobQueues {
  let connection: Redis | undefined;
  const queues = new Map<QueueName, Queue>();
  let closing: Promise<void> | undefined;

  const queue = (name: QueueName): Queue => {
    if (closing) throw new Error("Job queues are closed");
    let existing = queues.get(name);
    if (!existing) {
      // Created on first use, so processes and tests that never enqueue never connect.
      connection ??= createProducerConnection(redisUrl, logger);
      existing = new Queue(name, { connection, prefix, defaultJobOptions: DEFAULT_JOB_OPTIONS });
      existing.on("error", (error: Error) =>
        logger.warn({ err: error, queue: name }, "job queue error"),
      );
      queues.set(name, existing);
    }
    return existing;
  };

  const add = async <N extends JobName>(
    name: N,
    data: JobData<N>,
    options: EnqueueOptions,
  ): Promise<string> => {
    const payload = JOB_PAYLOADS[name].parse(data);
    if (options.jobId.includes(":")) {
      throw new Error(`Job ids must not contain ":" (BullMQ rejects them): ${options.jobId}`);
    }
    const target = queue(JOB_QUEUE[name]);
    // Until the first connection is up BullMQ waits forever; bound that for the caller.
    await withTimeout(target.waitUntilReady(), readyTimeoutMs);
    try {
      const job = await target.add(name, payload, {
        ...JOB_OPTIONS[name],
        jobId: options.jobId,
        ...(options.delayMs ? { delay: options.delayMs } : {}),
      });
      return job.id ?? options.jobId;
    } catch (error) {
      // With the offline queue off, an outage surfaces here immediately.
      if (connection?.status !== "ready") throw unavailable(error);
      throw error;
    }
  };

  const close = (): Promise<void> =>
    (closing ??= (async () => {
      const results = await Promise.allSettled([...queues.values()].map((q) => q.close()));
      for (const result of results) {
        if (result.status === "rejected")
          logger.warn({ err: result.reason }, "error while closing job queues");
      }
      if (connection) await closeRedis(connection);
    })());

  return { prefix, queue, add, close };
}

/* ─── typed enqueue helpers ──────────────────────────────────────────────────────────────────── */

export function enqueueManagerIntake(queues: JobQueues, data: ManagerIntakeJob): Promise<string> {
  return queues.add(JOB.managerIntake, data, { jobId: jobIds.managerIntake(data) });
}

export function enqueueManagerPlan(queues: JobQueues, data: ManagerPlanJob): Promise<string> {
  return queues.add(JOB.managerPlan, data, { jobId: jobIds.managerPlan(data) });
}

export function enqueueTaskRun(
  queues: JobQueues,
  data: TaskRunJob,
  options: { delayMs?: number } = {},
): Promise<string> {
  return queues.add(JOB.taskRun, data, { jobId: jobIds.taskRun(data), ...options });
}

/** Options of the asset jobs' enqueue helpers. */
export interface AssetJobOptions {
  /** Makes the job id new, for a deliberate re-queue (e.g. the sweeper re-driving a lost job). */
  requeue?: RequeueToken | null;
  delayMs?: number;
}

export function enqueueRenderSubmit(
  queues: JobQueues,
  data: RenderSubmitJob,
  { requeue, delayMs }: AssetJobOptions = {},
): Promise<string> {
  return queues.add(JOB.renderSubmit, data, {
    jobId: jobIds.renderSubmit(data, requeue),
    ...(delayMs ? { delayMs } : {}),
  });
}

/** Pass `delayMs: renderPollDelayMs(deps.config, data.attempt)`. */
export function enqueueRenderPoll(
  queues: JobQueues,
  data: RenderPollJob,
  options: { delayMs: number },
): Promise<string> {
  return queues.add(JOB.renderPoll, data, {
    jobId: jobIds.renderPoll(data),
    delayMs: options.delayMs,
  });
}

export function enqueueVisualReview(
  queues: JobQueues,
  data: VisualReviewJob,
  { requeue, delayMs }: AssetJobOptions = {},
): Promise<string> {
  return queues.add(JOB.visualReview, data, {
    jobId: jobIds.visualReview(data, requeue),
    ...(delayMs ? { delayMs } : {}),
  });
}

export function enqueueVisualRegenerate(
  queues: JobQueues,
  data: VisualRegenerateJob,
  { requeue, delayMs }: AssetJobOptions = {},
): Promise<string> {
  return queues.add(JOB.visualRegenerate, data, {
    jobId: jobIds.visualRegenerate(data, requeue),
    ...(delayMs ? { delayMs } : {}),
  });
}

export function enqueuePublisherSchedule(
  queues: JobQueues,
  data: PublisherScheduleJob,
  { requeue }: { requeue?: RequeueToken | null } = {},
): Promise<string> {
  return queues.add(JOB.publisherSchedule, data, {
    jobId: jobIds.publisherSchedule(data, requeue),
  });
}

/** `delayMs` holds an automatic retry back (e.g. until a rate limit resets). */
export function enqueuePublishRun(
  queues: JobQueues,
  data: PublishRunJob,
  { delayMs }: { delayMs?: number } = {},
): Promise<string> {
  return queues.add(JOB.publishRun, data, {
    jobId: jobIds.publishRun(data),
    ...(delayMs ? { delayMs } : {}),
  });
}

/** Pass `delayMs: publishPollDelayMs(deps.config)`. */
export function enqueuePublishPoll(
  queues: JobQueues,
  data: PublishPollJob,
  options: { delayMs: number },
): Promise<string> {
  return queues.add(JOB.publishPoll, data, {
    jobId: jobIds.publishPoll(data),
    delayMs: options.delayMs,
  });
}
