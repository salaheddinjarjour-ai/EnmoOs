import type { TaskStatus } from "@enmo/shared";
import type { Deps } from "../deps";
import { enqueueTaskRun, JOB, RequeueToken } from "../jobs/queues";
import { MINUTE_MS } from "../lib/clock";
import { hasBudgetToday, utcDay } from "../services/budget";
import { afterCommit } from "./after-commit";
import { failTask } from "./escalation";
import { advance } from "./graph";
import { reportProgress } from "./progress";
import { driveStaleRenders } from "./visuals";

/*
 * tick.sweeper (DESIGN §D "Sweeper"), every 5 minutes:
 *   - a task QUEUED or RUNNING for more than 15 minutes with no live job (a lost enqueue, a job
 *     that died with its worker) is re-queued once; stuck again, it becomes FAILED with an alert;
 *   - BLOCKED_BUDGET tasks are re-queued once today's budget has room again, i.e. after the UTC
 *     day rolls over (or the cap was raised);
 *   - an approved graph with PENDING tasks whose dependencies all SUCCEEDED is advanced: advance()
 *     runs after a commit (plan approval, a decision, a finished task), and a crash or a failure
 *     in between would otherwise leave those tasks unqueued for good;
 *   - renders whose next job was lost (a WAITING direct task's QUEUED, RENDERING or unreviewed
 *     assets) get it again (visuals.ts driveStaleRenders).
 */

export const STUCK_AFTER_MS = 15 * MINUTE_MS;

/** AgentTask.error while a task runs on its one sweeper re-queue. */
export const STALL_REQUEUE_NOTE =
  "Stalled for more than 15 minutes; re-queued once by the sweeper.";

/** Job states in which a task.run job will still run (or is running). */
const LIVE_JOB_STATES = [
  "active",
  "waiting",
  "delayed",
  "prioritized",
  "waiting-children",
] as const;

export interface SweepReport {
  requeuedStuck: number;
  failedStuck: number;
  requeuedBudget: number;
  /** Ready PENDING tasks that nothing had queued. */
  queuedReady: number;
  /** render.submit / render.poll / visual.review jobs queued again for stale assets. */
  drivenRenders: number;
}

export async function sweep(deps: Deps): Promise<SweepReport> {
  const report: SweepReport = {
    requeuedStuck: 0,
    failedStuck: 0,
    requeuedBudget: 0,
    queuedReady: 0,
    drivenRenders: 0,
  };
  await sweepStuck(deps, report);
  await sweepBudget(deps, report);
  await sweepReady(deps, report);
  report.drivenRenders = await driveStaleRenders(deps);
  return report;
}

async function sweepStuck(deps: Deps, report: SweepReport): Promise<void> {
  const now = deps.clock.now();
  const cutoff = new Date(now.getTime() - STUCK_AFTER_MS);
  const stuck = await deps.prisma.agentTask.findMany({
    where: {
      OR: [
        { status: "RUNNING", startedAt: { lt: cutoff } },
        { status: "QUEUED", queuedAt: { lt: cutoff } },
      ],
    },
    select: { id: true, status: true, error: true },
  });
  if (stuck.length === 0) return;

  const live = await liveTaskIds(deps);
  for (const task of stuck) {
    if (live.has(task.id)) continue;
    if (task.error === STALL_REQUEUE_NOTE) {
      const failed = await failTask(
        deps,
        task.id,
        {
          reason: "STUCK",
          issues: [],
          message: "was stuck for more than 15 minutes twice and has been stopped.",
        },
        "stuck",
      );
      if (failed) report.failedStuck += 1;
      continue;
    }
    const requeued = await requeueTask(deps, task.id, [task.status], {
      token: `stall-${now.getTime().toString(36)}`,
      error: STALL_REQUEUE_NOTE,
    });
    if (requeued) report.requeuedStuck += 1;
  }
}

async function sweepBudget(deps: Deps, report: SweepReport): Promise<void> {
  const blocked = await deps.prisma.agentTask.findMany({
    where: { status: "BLOCKED_BUDGET" },
    orderBy: { updatedAt: "asc" },
    select: { id: true },
  });
  if (blocked.length === 0 || !(await hasBudgetToday(deps))) return;
  const now = deps.clock.now();
  const token = `budget-${utcDay(now)}-${now.getTime().toString(36)}`;
  for (const task of blocked) {
    if (await requeueTask(deps, task.id, ["BLOCKED_BUDGET"], { token, error: null })) {
      report.requeuedBudget += 1;
    }
  }
}

async function sweepReady(deps: Deps, report: SweepReport): Promise<void> {
  const pending = await deps.prisma.agentTask.findMany({
    where: {
      status: "PENDING",
      graph: { status: "APPROVED", campaign: { status: { not: "ARCHIVED" } } },
    },
    select: { graphId: true, dependsOn: true },
  });
  if (pending.length === 0) return;
  const upstream = await deps.prisma.agentTask.findMany({
    where: { id: { in: [...new Set(pending.flatMap((task) => task.dependsOn))] } },
    select: { id: true, status: true },
  });
  const succeeded = new Set(upstream.filter((t) => t.status === "SUCCEEDED").map((t) => t.id));
  const graphIds = new Set(
    pending
      .filter((task) => task.dependsOn.every((dep) => succeeded.has(dep)))
      .map((task) => task.graphId),
  );
  // advance() is idempotent, so racing a worker that is about to advance the same graph is safe.
  for (const graphId of graphIds) report.queuedReady += await advance(deps, graphId);
}

/** Ids of tasks that have a task.run job waiting, delayed or running. */
async function liveTaskIds(deps: Deps): Promise<Set<string>> {
  const jobs = await deps.queues.queue("agents").getJobs([...LIVE_JOB_STATES]);
  const ids = new Set<string>();
  for (const job of jobs) {
    const data: unknown = job?.data;
    if (job?.name === JOB.taskRun && data && typeof data === "object" && "taskId" in data) {
      ids.add(String(data.taskId));
    }
  }
  return ids;
}

export interface RequeueOptions {
  /** Makes the job id new (task-<id>-r<rev>-<token>), so BullMQ doesn't treat it as a repeat. */
  token: string;
  /** AgentTask.error to leave on the task (null clears it). */
  error: string | null;
  /** Also restart the contract attempt count (a manual retry). */
  resetAttempts?: boolean;
}

/**
 * Puts a task back in the queue from one of `from`: status QUEUED plus a fresh task.run job.
 * Returns false when the task was no longer in one of those statuses.
 */
export async function requeueTask(
  deps: Deps,
  taskId: string,
  from: readonly TaskStatus[],
  options: RequeueOptions,
): Promise<boolean> {
  const [task] = await deps.prisma.agentTask.updateManyAndReturn({
    where: { id: taskId, status: { in: [...from] } },
    data: {
      status: "QUEUED",
      queuedAt: deps.clock.now(),
      startedAt: null,
      finishedAt: null,
      error: options.error,
      ...(options.resetAttempts ? { contractAttempts: 0 } : {}),
    },
    select: {
      id: true,
      graphId: true,
      revision: true,
      agent: true,
      post: { select: { ref: true } },
    },
  });
  if (!task) return false;
  try {
    await enqueueTaskRun(deps.queues, {
      taskId: task.id,
      revision: task.revision,
      requeue: RequeueToken.parse(options.token),
    });
  } catch (error) {
    // Left QUEUED without a job, which the next sweep picks up again.
    deps.logger.warn({ err: error, taskId: task.id }, "could not enqueue a re-queued task");
  }
  await afterCommit(deps, "recounting progress for a re-queued task", () =>
    reportProgress(deps, task.graphId, [
      { taskId: task.id, agent: task.agent, postRef: task.post?.ref ?? null, state: "queued" },
    ]),
  );
  return true;
}
