import { AgentEscalation, BudgetExceeded, InvalidAgentInput } from "@enmo/agents";
import { Prisma, type Asset } from "@enmo/db";
import {
  rendersPlaceholders,
  toReviewImage,
  type ReviewImage,
  type StoredObject,
} from "@enmo/providers";
import type { AssetReview, TaskStatus, VisualReviewInput, VisualReviewOutput } from "@enmo/shared";
import type { Deps } from "../deps";
import { enqueueVisualReview } from "../jobs/queues";
import type { RunAttempt } from "../jobs/types";
import { getBudget } from "../services/budget";
import { runAgentFor, type RunContext } from "./agent-run";
import { brandContextOf } from "./context";
import {
  escalateTask,
  failTask,
  handOffFromEscalation,
  handOffFromInvalidInput,
} from "./escalation";
import { EventBatch } from "./events";
import { failTake } from "./render-outcomes";
import {
  assetUpdated,
  budgetDeferral,
  lastTakeAttempt,
  takeAttempt,
  takeParams,
  takeReview,
  type TakeParams,
} from "./takes";
import { onReviewDone } from "./visuals";

/*
 * visual.review (DESIGN §C "Visual Director review"): the Visual Director looks at one READY take,
 * the render itself sent as an image block, and its verdict drives the loop (visuals.ts
 * onReviewDone).
 */

/** Whether the visual loop is waiting on this READY take's review. */
function awaitsReview(
  take: Pick<Asset, "isCurrent">,
  params: TakeParams,
  taskStatus: TaskStatus | null,
): boolean {
  if (params.taskId) return taskStatus === "WAITING";
  return params.onTrial === true && !take.isCurrent;
}

/**
 * visual.review: the Visual Director looks at the render (downscaled to a 1568px long edge, sent
 * as an image block) against its shot and the brand. The verdict is stored as Asset.review, then
 * onReviewDone acts on it. A budget stop defers the review to just after UTC midnight (the task
 * stays WAITING); an escalation hands the task to people, and fails a take outside any plan (with
 * an alert: it never passed review, so the post keeps its current take). A take whose file is gone
 * or won't decode fails the same way; storage out of reach is retried, and the job's last attempt
 * hands the task on. The reviewer is told when the take is a placeholder (rendersPlaceholders).
 */
export async function reviewTake(deps: Deps, assetId: string, attempt: RunAttempt): Promise<void> {
  const take = await deps.prisma.asset.findUnique({
    where: { id: assetId },
    include: { client: true, campaign: { select: { status: true } } },
  });
  if (!take || take.status !== "READY" || !take.storageKey) return;
  if (take.campaign?.status === "ARCHIVED") return;
  const stored = takeReview(take);
  if (stored) {
    // A retry after the verdict was stored: acting on it again is idempotent.
    await onReviewDone(deps, take.id, stored);
    return;
  }
  const params = takeParams(take);
  const shot = params.shot;
  if (!shot) return;
  const task = params.taskId
    ? await deps.prisma.agentTask.findUnique({
        where: { id: params.taskId },
        select: { id: true, status: true },
      })
    : null;
  if (!awaitsReview(take, params, task?.status ?? null)) return;

  const stillKey =
    params.posterStorageKey ?? (take.mimeType?.startsWith("image/") ? take.storageKey : null);
  if (!stillKey) {
    // A clip without a poster frame: there is nothing the Visual Director could look at.
    await failTake(deps, take.id, "FAILED", "the provider returned no still frame to review", [
      "READY",
    ]);
    return;
  }
  const taskId = task?.id ?? null;
  let file: StoredObject | null;
  try {
    file = await deps.storage.get(stillKey);
  } catch (error) {
    // Storage may be briefly out of reach: BullMQ retries, and the last attempt hands it on.
    await reviewFailed(deps, take, taskId, error, attempt);
    return;
  }
  if (!file) {
    await failTake(deps, take.id, "FAILED", "its file is missing from storage", ["READY"]);
    return;
  }
  let image: ReviewImage;
  try {
    image = await toReviewImage(file.body);
  } catch (error) {
    // The same bytes never decode on a retry: the take can't be reviewed, so it goes to people.
    const reason = error instanceof Error ? error.message : String(error);
    await failTake(deps, take.id, "FAILED", `its file can't be decoded (${reason})`, ["READY"]);
    return;
  }
  const input: VisualReviewInput = {
    shot,
    render: {
      assetId: take.id,
      kind: take.kind,
      width: take.width ?? image.width,
      height: take.height ?? image.height,
      durationSec: take.durationSec,
      placeholder: rendersPlaceholders(take.provider),
    },
    attempt: takeAttempt(params),
    maxAttempts: lastTakeAttempt(deps.config),
    brand: brandContextOf(take.client),
  };
  const context: RunContext = {
    taskId,
    campaignId: take.campaignId,
    clientId: take.clientId,
  };

  let output: VisualReviewOutput;
  try {
    ({ output } = await runAgentFor(deps, "VISUAL_DIRECTOR.review", input, context, {
      images: [image],
    }));
  } catch (error) {
    await reviewFailed(deps, take, taskId, error, attempt);
    return;
  }

  const review: AssetReview = {
    ...output,
    attempt: input.attempt,
    reviewedAt: deps.clock.now().toISOString(),
  };
  const [reviewed] = await deps.prisma.asset.updateManyAndReturn({
    where: { id: take.id, status: "READY", review: { equals: Prisma.DbNull } },
    data: { review },
  });
  if (!reviewed) return;
  await assetUpdated(new EventBatch(), reviewed).publish(deps);
  await onReviewDone(deps, take.id, output);
}

async function reviewFailed(
  deps: Deps,
  take: Asset,
  taskId: string | null,
  error: unknown,
  attempt: RunAttempt,
): Promise<void> {
  if (error instanceof BudgetExceeded) {
    const deferral = budgetDeferral(deps);
    await enqueueVisualReview(deps.queues, { assetId: take.id }, deferral);
    deps.logger.info(
      { assetId: take.id, ...deferral },
      "visual review deferred by the token budget",
    );
    await new EventBatch().global("budget.updated", await getBudget(deps)).publish(deps);
    return;
  }
  if (error instanceof AgentEscalation || error instanceof InvalidAgentInput) {
    const handOff =
      error instanceof AgentEscalation
        ? handOffFromEscalation(error)
        : handOffFromInvalidInput(error);
    if (!taskId) {
      // Outside a plan the take never passed review, so the post keeps its current take.
      await failTake(deps, take.id, "FAILED", `the Visual Director ${handOff.message}`, ["READY"]);
    } else if (error instanceof AgentEscalation) {
      await escalateTask(deps, taskId, handOff);
    } else {
      await failTask(deps, taskId, handOff);
    }
    if (error instanceof InvalidAgentInput) throw error;
    return;
  }
  if (attempt.isLast) {
    const reason = error instanceof Error ? error.message : String(error);
    const why = `couldn't review take ${take.version} of ${take.shotId ?? "a shot"}: ${reason}`;
    if (taskId) {
      await failTask(deps, taskId, { reason: "FAILED", issues: [], message: why });
    } else {
      await failTake(deps, take.id, "FAILED", `the Visual Director ${why}`, ["READY"]);
    }
  }
  throw error;
}
