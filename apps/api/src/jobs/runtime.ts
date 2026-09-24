import { InvalidAgentInput } from "@enmo/agents";
import { UnrecoverableError, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import type { Deps } from "../deps";
import type { Logger } from "../lib/logger";
import { closeRedis, createWorkerConnection } from "./connection";
import { WORKER_SETTINGS, queueConcurrency, type QueueName } from "./queues";
import { activeQueues, processorFor, processors, type ProcessorRegistry } from "./registry";
import { registerSchedulers } from "./schedulers";

/*
 * Starts the queue consumers, either in the worker process or inside the API
 * (EMBEDDED_WORKER=true): one BullMQ Worker per queue that has processors in registry.ts, sharing
 * one worker connection (BullMQ duplicates it for each worker's blocking fetch), on the prefix of
 * deps.queues so producers and consumers always agree. Once the workers are up, the tick
 * schedulers are registered (schedulers.ts; skipped when SCHEDULERS_ENABLED=false, as in tests,
 * which run the ticks directly). close() lets active jobs finish, then drops the connection.
 */

export interface WorkerRuntime {
  close(): Promise<void>;
}

export interface StartWorkersOptions {
  /** Defaults to registry.ts; tests pass their own processors. */
  registry?: ProcessorRegistry;
  /** Defaults to SCHEDULERS_ENABLED. */
  schedulers?: boolean;
}

export async function startWorkers(
  deps: Deps,
  options: StartWorkersOptions = {},
): Promise<WorkerRuntime> {
  const registry = options.registry ?? processors;
  const queues = activeQueues(registry);
  if (queues.length === 0) return idleRuntime(deps.logger);

  const connection = createWorkerConnection(deps.config.REDIS_URL, deps.logger);
  const workers = queues.map((queue) => createWorker(deps, registry, queue, connection));
  const close = () => closeWorkers(workers, connection, deps.logger);
  try {
    await Promise.all(workers.map((worker) => worker.waitUntilReady()));
    // The ticks run on the ops queue, so only a runtime consuming it schedules them.
    if ((options.schedulers ?? deps.config.SCHEDULERS_ENABLED) && queues.includes("ops")) {
      await registerSchedulers(deps.queues, deps.logger);
    }
  } catch (error) {
    await close();
    throw error;
  }
  deps.logger.info({ queues, prefix: deps.queues.prefix }, "queue workers started");

  let closing: Promise<void> | undefined;
  return { close: () => (closing ??= close()) };
}

function createWorker(
  deps: Deps,
  registry: ProcessorRegistry,
  queue: QueueName,
  connection: Redis,
): Worker {
  const logger = deps.logger.child({ queue });
  const worker = new Worker(queue, (job: Job) => runJob(deps, registry, queue, job), {
    connection,
    prefix: deps.queues.prefix,
    concurrency: queueConcurrency(deps.config, queue),
    drainDelay: deps.config.BULLMQ_DRAIN_DELAY_SEC,
    ...WORKER_SETTINGS,
  });
  worker.on("error", (error: Error) => logger.warn({ err: error }, "queue worker error"));
  worker.on("failed", (job: Job | undefined, error: Error) =>
    logger.warn(
      { err: error, jobId: job?.id, job: job?.name, attemptsMade: job?.attemptsMade },
      "job failed",
    ),
  );
  return worker;
}

async function runJob(
  deps: Deps,
  registry: ProcessorRegistry,
  queue: QueueName,
  job: Job,
): Promise<unknown> {
  const processor = processorFor(registry, queue, job.name);
  if (!processor) {
    // Retrying cannot make a processor appear; fail the job for good.
    throw new UnrecoverableError(
      `No processor is registered for ${job.name} on the ${queue} queue`,
    );
  }
  try {
    return await processor(job, deps);
  } catch (error) {
    throw asUnrecoverable(error);
  }
}

/**
 * An agent input its contract rejects is an orchestrator bug: the processor has already told
 * people, and rebuilding the input from the same rows on a retry would fail the same way.
 */
export function asUnrecoverable(error: unknown): unknown {
  return error instanceof InvalidAgentInput ? new UnrecoverableError(error.message) : error;
}

async function closeWorkers(workers: Worker[], connection: Redis, logger: Logger): Promise<void> {
  // Worker.close() lets active jobs finish; shutdown.ts bounds how long that may take.
  const results = await Promise.allSettled(workers.map((worker) => worker.close()));
  for (const result of results) {
    if (result.status === "rejected")
      logger.warn({ err: result.reason }, "error while closing a queue worker");
  }
  await closeRedis(connection);
}

function idleRuntime(logger: Logger): Promise<WorkerRuntime> {
  logger.info("worker idle: no queue has processors");
  // Nothing else holds the event loop open; a standalone worker process must not exit.
  const keepAlive = setInterval(() => undefined, 2 ** 30);
  return Promise.resolve({
    close: () => {
      clearInterval(keepAlive);
      return Promise.resolve();
    },
  });
}
