import { Prisma, type Asset } from "@enmo/db";
import type { Deps } from "../deps";
import {
  JOB,
  enqueueRenderPoll,
  enqueueRenderSubmit,
  enqueueVisualRegenerate,
  enqueueVisualReview,
  jobIds,
  renderPollDelayMs,
  type RequeueToken,
} from "../jobs/queues";
import { failTake, handOffFailedTake } from "./render-outcomes";
import { RENDER_POLL_MAX_ATTEMPTS } from "./renders";
import { blockingTake, completeIfSettled } from "./take-completion";
import { NO_TASK_WHERE, ON_TRIAL_WHERE, takeParams, taskTakesWhere } from "./takes";
import { loadTask } from "./tasks";

/*
 * tick.sweeper's part of the visual loop (DESIGN §D "Sweeper: drive any stale WAITING render
 * polls"). Each step of a take queues the next before its own job completes, so a take in the loop
 * always has a live job; one that has had none for RENDER_STALE_AFTER_MS lost it (Redis lost data,
 * an enqueue failed after a commit) and gets it again.
 */

/** A take whose next job hasn't shown up for this long may have lost it (sweeper). */
export const RENDER_STALE_AFTER_MS = 5 * 60_000;

/** Job states in which a job will still run (or is running). */
const LIVE_JOB_STATES = [
  "active",
  "waiting",
  "delayed",
  "prioritized",
  "waiting-children",
] as const;

const ASSET_JOBS: ReadonlySet<string> = new Set([
  JOB.renderSubmit,
  JOB.renderPoll,
  JOB.visualReview,
  JOB.visualRegenerate,
]);

/** Asset ids with a render or review job that will still run. */
async function liveAssetJobs(deps: Deps): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const queue of ["media", "agents"] as const) {
    const jobs = await deps.queues.queue(queue).getJobs([...LIVE_JOB_STATES]);
    for (const job of jobs) {
      const data: unknown = job?.data;
      if (
        job &&
        ASSET_JOBS.has(job.name) &&
        data &&
        typeof data === "object" &&
        "assetId" in data
      ) {
        ids.add(String(data.assetId));
      }
    }
  }
  return ids;
}

/** The first render.poll attempt whose job id is free (finished jobs keep theirs for a day). */
async function freePollAttempt(deps: Deps, assetId: string): Promise<number | null> {
  const media = deps.queues.queue("media");
  for (let attempt = 1; attempt <= RENDER_POLL_MAX_ATTEMPTS; attempt++) {
    if (!(await media.getJob(jobIds.renderPoll({ assetId, attempt })))) return attempt;
  }
  return null;
}

/**
 * Where a take in the loop can be stuck without a job: still to render, rendering, waiting for its
 * review, or reviewed without the verdict having been acted on (a weak take never regenerated or
 * escalated, a take on trial never made current). Only the takes someone still waits on are
 * looked at (awaitedBy): those of a WAITING direct task, and takes on trial outside any plan.
 * Takes of a task that escalated, failed or succeeded never come back into it.
 */
const IN_THE_LOOP: Prisma.AssetWhereInput = {
  OR: [
    { status: { in: ["QUEUED", "RENDERING"] } },
    { status: "READY", review: { equals: Prisma.DbNull } },
    { status: "READY", review: { path: ["verdict"], equals: "regenerate" } },
    { AND: [ON_TRIAL_WHERE, { status: "READY", isCurrent: false }] },
  ],
};

/** How many stale takes one query reads; the sweep pages on until it has seen them all. */
const REDRIVE_PAGE = 200;

/**
 * tick.sweeper (DESIGN §D "Sweeper: drive any stale WAITING render polls"): re-queues the next job
 * of every take in the loop whose job was lost, finishes WAITING direct tasks whose takes all
 * settled while their completion was lost, and hands on those whose take failed while the hand-off
 * was lost. Returns how many jobs it queued and tasks it moved on. Cheap when no render is in
 * flight: every sweep calls it.
 */
export async function driveStaleRenders(deps: Deps): Promise<number> {
  const now = deps.clock.now();
  const cutoff = new Date(now.getTime() - RENDER_STALE_AFTER_MS);
  const waiting = await deps.prisma.agentTask.findMany({
    where: { status: "WAITING", agent: "VISUAL_DIRECTOR", action: "direct" },
    select: { id: true, updatedAt: true },
  });
  const redriven = await redriveTakes(
    deps,
    cutoff,
    waiting.map((task) => task.id),
  );
  const stale = waiting.filter((task) => task.updatedAt < cutoff).map((task) => task.id);
  return redriven + (await moveOnWaitingTasks(deps, stale));
}

/** The takes someone waits on: a WAITING direct task's, or on trial outside any plan. */
function awaitedBy(waitingTaskIds: readonly string[]): Prisma.AssetWhereInput {
  return {
    OR: [
      { AND: [NO_TASK_WHERE, ON_TRIAL_WHERE, { isCurrent: false }] },
      ...waitingTaskIds.map((id) => taskTakesWhere(id)),
    ],
  };
}

async function redriveTakes(
  deps: Deps,
  cutoff: Date,
  waitingTaskIds: readonly string[],
): Promise<number> {
  const where: Prisma.AssetWhereInput = {
    AND: [
      { role: "SHOT", updatedAt: { lt: cutoff }, NOT: { campaign: { status: "ARCHIVED" } } },
      awaitedBy(waitingTaskIds),
      IN_THE_LOOP,
    ],
  };
  const requeue: RequeueToken = `drive-${deps.clock.now().getTime().toString(36)}`;
  let live: Set<string> | null = null;
  let queued = 0;
  // Keyset pages: takes with a live job are skipped, never allowed to hide the ones behind them.
  let after: { updatedAt: Date; id: string } | null = null;
  for (;;) {
    const page: Asset[] = await deps.prisma.asset.findMany({
      where: after
        ? {
            AND: [
              where,
              {
                OR: [
                  { updatedAt: { gt: after.updatedAt } },
                  { updatedAt: after.updatedAt, id: { gt: after.id } },
                ],
              },
            ],
          }
        : where,
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: REDRIVE_PAGE,
    });
    if (page.length === 0) break;
    live ??= await liveAssetJobs(deps);
    for (const take of page) {
      if (live.has(take.id)) continue;
      if (await redrive(deps, take, requeue)) queued += 1;
    }
    if (page.length < REDRIVE_PAGE) break;
    const last = page.at(-1)!;
    after = { updatedAt: last.updatedAt, id: last.id };
  }
  return queued;
}

/** Queues the job a take in the loop lost; true when one was queued. */
async function redrive(deps: Deps, take: Asset, requeue: RequeueToken): Promise<boolean> {
  const params = takeParams(take);
  try {
    if (take.status === "QUEUED" && params.pendingDirection) {
      // A pending Vault take of a planned post is its task.run's to direct.
      if (params.taskId) return false;
      await enqueueVisualRegenerate(deps.queues, { assetId: take.id }, { requeue });
    } else if (take.status === "QUEUED") {
      await enqueueRenderSubmit(deps.queues, { assetId: take.id }, { requeue });
    } else if (take.status === "RENDERING") {
      const attempt = await freePollAttempt(deps, take.id);
      if (attempt === null) {
        await failTake(deps, take.id, "FAILED", "its render stopped reporting progress", [
          "RENDERING",
        ]);
        return false;
      }
      await enqueueRenderPoll(
        deps.queues,
        { assetId: take.id, attempt },
        { delayMs: renderPollDelayMs(deps.config, attempt) },
      );
    } else {
      // A review job both reviews an unreviewed take and re-acts on a stored verdict.
      await enqueueVisualReview(deps.queues, { assetId: take.id }, { requeue });
    }
    return true;
  } catch (error) {
    deps.logger.warn({ err: error, assetId: take.id }, "could not re-drive a stale render");
    return false;
  }
}

/**
 * WAITING direct tasks that stopped moving: one whose takes all settled SUCCEEDS (its completion
 * was lost), and one waiting on a take that failed or was refused is handed on (the hand-off
 * was lost).
 */
async function moveOnWaitingTasks(deps: Deps, taskIds: readonly string[]): Promise<number> {
  let moved = 0;
  for (const id of taskIds) {
    const task = await loadTask(deps.prisma, id);
    if (!task || task.status !== "WAITING") continue;
    if (await completeIfSettled(deps, task)) {
      moved += 1;
      continue;
    }
    const takes = await deps.prisma.asset.findMany({ where: taskTakesWhere(id) });
    const blocked = blockingTake(takes);
    if (blocked && (await handOffFailedTake(deps, blocked))) moved += 1;
  }
  return moved;
}
