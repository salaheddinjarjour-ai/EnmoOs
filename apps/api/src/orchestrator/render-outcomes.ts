import { Prisma, type Asset, type DbTransaction } from "@enmo/db";
import type { AlertPayload, AssetStatus } from "@enmo/shared";
import type { Deps } from "../deps";
import { enqueueVisualReview } from "../jobs/queues";
import { afterCommit } from "./after-commit";
import { asSentence, handOffTaskIn, reportHandOff, type HandOff } from "./escalation";
import { EventBatch } from "./events";
import { assetUpdated, takeParams } from "./takes";
import type { TaskWithContext } from "./tasks";

/*
 * How a render ends for the visual loop: a READY take goes to the Visual Director's review; a take
 * that won't render hands its direct task to people (or raises an alert when no task waits on it).
 */

/** render.poll stored a READY take: queue its visual.review. */
export async function onRenderReady(deps: Deps, assetId: string): Promise<void> {
  await enqueueVisualReview(deps.queues, { assetId });
}

/**
 * A take that won't render (the provider failed or refused it, polling gave up, or its job ran out
 * of retries): FAILED or REJECTED, and the task waiting on it handed to people in the same
 * transaction. Every job that could run again finds the take out of the loop and stops, so the
 * two must commit together or not at all. Only a take still in the loop moves.
 */
export async function failTake(
  deps: Deps,
  assetId: string,
  status: "FAILED" | "REJECTED",
  reason: string,
  from: readonly AssetStatus[] = ["QUEUED", "RENDERING", "READY"],
): Promise<void> {
  const events = new EventBatch();
  const outcome = await deps.prisma.$transaction(async (tx) => {
    const [failed] = await tx.asset.updateManyAndReturn({
      where: { id: assetId, status: { in: [...from] }, review: { equals: Prisma.DbNull } },
      data: { status },
    });
    if (!failed) return null;
    assetUpdated(events, failed);
    const task = await handOffWaitingTask(tx, deps, failed, reason, events);
    if (!task) events.alert(takeAlert(failed, reason));
    return { task };
  });
  if (!outcome) return;
  await announce(deps, events, outcome.task);
}

/**
 * tick.sweeper's backstop for a WAITING task whose take failed (or was refused) without the task
 * being handed on: hands it on now, as failTake would have.
 */
export async function handOffFailedTake(deps: Deps, take: Asset): Promise<boolean> {
  const events = new EventBatch();
  const task = await deps.prisma.$transaction((tx) =>
    handOffWaitingTask(tx, deps, take, "found by the sweeper after its hand-off was lost", events),
  );
  await announce(deps, events, task);
  return task !== null;
}

/**
 * The task waiting on a take that didn't render is handed to people: a refusal (content policy)
 * escalates, since the prompt needs a human's eye; a provider failure fails the task, so a retry
 * re-plans once the provider is back. Only a WAITING task waits on its takes (a running one is
 * re-planning, and supersedes them). Returns the task handed on, or null when none waited.
 */
async function handOffWaitingTask(
  tx: DbTransaction,
  deps: Deps,
  take: Asset,
  reason: string,
  events: EventBatch,
): Promise<TaskWithContext | null> {
  const { taskId } = takeParams(take);
  if (!taskId) return null;
  const shotId = take.shotId ?? "the shot";
  const refused = take.status === "REJECTED";
  const handOff: HandOff = {
    reason: refused ? "RENDER_REJECTED" : "RENDER_FAILED",
    issues: [{ path: shotId, message: reason }],
    message: refused
      ? `had take ${take.version} of ${shotId} refused by the ${take.provider} provider (${reason})`
      : `couldn't get take ${take.version} of ${shotId} rendered by the ${take.provider} provider (${reason})`,
  };
  return handOffTaskIn(
    tx,
    deps,
    {
      taskId,
      status: refused ? "ESCALATED" : "FAILED",
      handOff,
      alert: refused ? "escalated" : "failed",
      from: ["WAITING"],
    },
    events,
  );
}

/** The alert for a take no task waits on (a Vault regenerate outside any plan). */
function takeAlert(take: Asset, reason: string): AlertPayload {
  const shotId = take.shotId ?? "the shot";
  const refused = take.status === "REJECTED";
  return {
    kind: "failed",
    entityType: "Asset",
    entityId: take.id,
    message: asSentence(
      `Take ${take.version} of ${shotId} ${refused ? "was refused" : "failed"}: ${reason}`,
    ),
    clientId: take.clientId,
    campaignId: take.campaignId,
  };
}

/** After the commit: the events, and the progress line of a task that was handed on. */
async function announce(
  deps: Deps,
  events: EventBatch,
  task: TaskWithContext | null,
): Promise<void> {
  await afterCommit(deps, "announcing a take that didn't render", () => events.publish(deps));
  if (task) await afterCommit(deps, "reporting a hand-off", () => reportHandOff(deps, task));
}
