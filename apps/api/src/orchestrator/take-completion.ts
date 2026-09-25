import type { Asset } from "@enmo/db";
import type { Deps } from "../deps";
import { advance } from "./graph";
import { reportProgress } from "./progress";
import { lineageRootId, takeParams, takeReview, taskTakesWhere } from "./takes";
import type { TaskWithContext } from "./tasks";

/*
 * A VISUAL_DIRECTOR direct task waits (WAITING) on its takes and SUCCEEDS once every shot has an
 * accepted current take; then the graph advances (DESIGN §D "task.run").
 */

/** Every shot of the task has a current take the Visual Director accepted. */
export function settled(takes: readonly Asset[]): boolean {
  const current = takes.filter((take) => take.isCurrent);
  return (
    current.length > 0 &&
    current.every((take) => take.status === "READY" && takeReview(take)?.verdict === "accept")
  );
}

/**
 * The takes a WAITING direct task is waiting on: its current takes, plus the newest take of each
 * lineage still on trial (a Vault regenerate, or a take its review regenerated, not yet current).
 */
export function awaitedTakes(takes: readonly Asset[]): Asset[] {
  const newestOnTrial = new Map<string, Asset>();
  for (const take of takes) {
    if (take.isCurrent || !takeParams(take).onTrial) continue;
    const root = lineageRootId(take);
    const newest = newestOnTrial.get(root);
    if (!newest || take.version > newest.version) newestOnTrial.set(root, take);
  }
  return [...takes.filter((take) => take.isCurrent), ...newestOnTrial.values()];
}

/**
 * An awaited take that will never be accepted without a person: it failed to render or the
 * provider refused it (a take the review rejected always has a successor or an escalation).
 */
export function blockingTake(takes: readonly Asset[]): Asset | undefined {
  return awaitedTakes(takes).find(
    (take) => take.status === "FAILED" || (take.status === "REJECTED" && take.review === null),
  );
}

/** The WAITING task SUCCEEDS once every shot is settled, and the graph moves on. */
export async function completeIfSettled(deps: Deps, task: TaskWithContext): Promise<boolean> {
  const takes = await deps.prisma.asset.findMany({ where: taskTakesWhere(task.id) });
  if (!settled(takes)) return false;
  const { count } = await deps.prisma.agentTask.updateMany({
    where: { id: task.id, status: "WAITING" },
    data: { status: "SUCCEEDED", error: null, finishedAt: deps.clock.now() },
  });
  if (count === 0) return false;
  try {
    await reportProgress(deps, task.graphId, [
      { taskId: task.id, agent: task.agent, postRef: task.post?.ref ?? null, state: "done" },
    ]);
  } finally {
    await advance(deps, task.graphId);
  }
  return true;
}
