import { AgentEscalation, BudgetExceeded, InvalidAgentInput } from "@enmo/agents";
import type { Asset, DbTransaction } from "@enmo/db";
import type { Shot, VisualDirectInput } from "@enmo/shared";
import type { Deps } from "../deps";
import { enqueueVisualRegenerate } from "../jobs/queues";
import type { RunAttempt } from "../jobs/types";
import { runAgentFor, type RunContext } from "./agent-run";
import {
  approvalCreated,
  approvalResolved,
  cancelOpenRounds,
  openApprovalRound,
} from "./approval-round";
import { brandContextOf } from "./context";
import { handOffFromEscalation, handOffFromInvalidInput } from "./escalation";
import { EventBatch } from "./events";
import { shareLockCampaign } from "./locks";
import { FROZEN_POST_STATUSES, postUpdated, requireTransition } from "./post-status";
import { reportProgress } from "./progress";
import { cancelScheduledForPost } from "./publishing";
import { failTake } from "./render-outcomes";
import {
  assetUpdated,
  budgetDeferral,
  createTake,
  currentOfLineage,
  jsonParams,
  lineageRootId,
  lineageWhere,
  offTrial,
  postOf,
  runContextOf,
  slotKey,
  slotRivals,
  storedCopy,
  submitAll,
  supersedeTaskTakes,
  takeParams,
  takeSlot,
  visualCopyOf,
  type TakeParams,
} from "./takes";
import type { TaskWithContext } from "./tasks";

/*
 * The Vault's regenerate (DESIGN §F, services/assets.ts): one QUEUED take waiting for direction
 * (TakeParams.pendingDirection). The Visual Director gets the take's original context back (its
 * shot, the post's copy, the brand) with the instruction verbatim and re-plans just that shot. On a
 * planned post the take belongs to a revision `direct` task (its task.run directs it); outside any
 * plan the visual.regenerate job does. The take is on trial (TakeParams.onTrial): it goes through
 * the same review loop as any take (a weak one is regenerated at most MAX_VISUAL_REGENERATIONS
 * times, then escalated) and becomes its lineage's current take only once accepted, so the post
 * keeps showing its current take until then.
 */

/** planShots for a revision task a Vault regenerate created: direct its take (again, on a retry). */
export async function redirectVaultTask(
  deps: Deps,
  task: TaskWithContext,
  takes: readonly Asset[],
): Promise<void> {
  let take = takes.find((t) => t.status === "QUEUED");
  if (!take) {
    // A retry after the take failed or was judged weak: a fresh take of the same lineage with the
    // same instruction, re-planned from the same original context as the first (the shot the
    // person regenerated), like any re-run of a direct task. Re-planning from the last take's
    // shot would hand the Visual Director its own revision back as the thing to revise.
    const last = takes.at(-1)!;
    const params = takeParams(last);
    const origin = await originalContext(deps, takes[0]!);
    const { shot, consistency } = origin?.shot ? origin : params;
    if (!task.post || !shot) {
      throw new Error(`Vault take ${last.id} has no post or shot to regenerate`);
    }
    const { post } = task;
    const events = new EventBatch();
    take = await deps.prisma.$transaction(async (tx) => {
      await supersedeTaskTakes(tx, task.id, events);
      const parent = (await currentOfLineage(tx, lineageRootId(last))) ?? last;
      const created = await createTake(tx, {
        post: postOf(post),
        shot,
        consistency,
        origin: "vault",
        taskId: task.id,
        instruction: params.instruction,
        parent,
        regenCount: last.regenCount,
        isCurrent: false,
        onTrial: true,
        provider: deps.visual.name,
        createdById: last.createdById,
        pendingDirection: true,
      });
      assetUpdated(events, created);
      return created;
    });
    await events.publish(deps);
  }
  await directVaultTake(deps, take.id, task);
}

/**
 * The params of the take a Vault regenerate was made from (the first Vault take's parent): the
 * shot and consistency the Visual Director was given to revise. Null when it is gone.
 */
async function originalContext(deps: Deps, first: Asset): Promise<TakeParams | null> {
  if (!first.parentAssetId) return null;
  const parent = await deps.prisma.asset.findUnique({ where: { id: first.parentAssetId } });
  return parent ? takeParams(parent) : null;
}

/**
 * The Vault's regenerate: the Visual Director gets the take's original context back (the brand,
 * the post and its copy, the take's shot as previousShots) plus the instruction verbatim as HUMAN
 * feedback, and re-plans just that shot. The take keeps its place and shot id and is submitted.
 * With a task (RUNNING) the call is recorded against it and the task goes WAITING.
 */
export async function directVaultTake(
  deps: Deps,
  takeId: string,
  task: TaskWithContext | null,
): Promise<void> {
  const take = await deps.prisma.asset.findUnique({
    where: { id: takeId },
    include: { post: true, client: true },
  });
  if (!take || take.status !== "QUEUED") return;
  const params = takeParams(take);
  if (!params.pendingDirection) {
    // Directed on an earlier run that didn't get to queue it.
    if (task) {
      await deps.prisma.agentTask.updateMany({
        where: { id: task.id, status: "RUNNING" },
        data: { status: "WAITING" },
      });
    }
    await submitAll(deps, [take]);
    return;
  }
  const copy = take.post ? storedCopy(take.post) : null;
  if (!take.post || !copy || !params.shot) {
    throw new Error(`Vault take ${take.id} has no post copy or shot to regenerate from`);
  }
  const { post } = take;
  const previous = params.shot;
  const input: VisualDirectInput = {
    brand: brandContextOf(take.client),
    post: { ref: post.ref, type: post.type, platforms: post.platforms },
    copy: visualCopyOf(copy),
    feedback:
      params.instruction === null
        ? null
        : { verbatim: params.instruction, source: "HUMAN", decisionId: null },
    previousShots: [previous],
    capabilities: deps.visual.capabilities(),
  };
  if (task) await deps.prisma.agentTask.update({ where: { id: task.id }, data: { input } });

  const context: RunContext = task
    ? runContextOf(task)
    : { taskId: null, campaignId: take.campaignId, clientId: take.clientId };
  const { output } = await runAgentFor(deps, "VISUAL_DIRECTOR.direct", input, context);

  // The validator holds the list to the copy's places, and regenerateAsset to a place the copy
  // has, so the take's own place is always in it; another place's shot would mislabel the take.
  const planned = output.shots.find((shot) => slotKey(shot) === slotKey(previous));
  if (!planned) {
    throw new Error(`The Visual Director's shot list has no shot for take ${take.id}'s place`);
  }
  const shot: Shot = { ...planned, shotId: previous.shotId };
  const { pendingDirection: _pending, ...rest } = params;
  const directed: TakeParams = {
    ...rest,
    shot,
    consistency: output.consistency,
    mockVideo: shot.kind === "VIDEO" && deps.visual.name === "mock",
  };

  const events = new EventBatch();
  const updated = await deps.prisma.$transaction(async (tx) => {
    const [row] = await tx.asset.updateManyAndReturn({
      where: { id: take.id, status: "QUEUED" },
      data: {
        kind: shot.kind,
        provider: deps.visual.name,
        prompt: shot.prompt,
        negativePrompt: shot.negativePrompt.trim() || null,
        params: jsonParams(directed),
        shotId: shot.shotId,
        sceneIndex: shot.sceneIndex,
      },
    });
    if (!row) return null;
    assetUpdated(events, row);
    if (task) {
      await tx.agentTask.updateMany({
        where: { id: task.id, status: "RUNNING" },
        data: { status: "WAITING", output, error: null },
      });
    }
    return row;
  });
  if (!updated) return;
  await events.publish(deps);
  await submitAll(deps, [updated]);
  if (task) {
    await reportProgress(deps, task.graphId, [
      { taskId: task.id, agent: task.agent, postRef: post.ref, state: "waiting" },
    ]);
  }
}

/**
 * visual.regenerate: a Vault take on a post outside any plan (no task to run it). A budget stop
 * defers the job to just after UTC midnight; a Visual Director that can't re-plan it fails the take.
 */
export async function regenerateVaultTake(
  deps: Deps,
  takeId: string,
  attempt: RunAttempt,
): Promise<void> {
  try {
    await directVaultTake(deps, takeId, null);
  } catch (error) {
    if (error instanceof BudgetExceeded) {
      await enqueueVisualRegenerate(deps.queues, { assetId: takeId }, budgetDeferral(deps));
      return;
    }
    if (error instanceof AgentEscalation || error instanceof InvalidAgentInput) {
      const handOff =
        error instanceof AgentEscalation
          ? handOffFromEscalation(error)
          : handOffFromInvalidInput(error);
      await failTake(deps, takeId, "FAILED", `the Visual Director ${handOff.message}`);
      if (error instanceof InvalidAgentInput) throw error;
      return;
    }
    if (attempt.isLast) {
      const reason = error instanceof Error ? error.message : String(error);
      await failTake(deps, takeId, "FAILED", `regenerating it failed after every retry: ${reason}`);
    }
    throw error;
  }
}

/**
 * A take on trial the Visual Director accepted becomes its lineage's current take, and the post's
 * only current take of its scene or slide, and leaves its trial, so a review re-driven later (the
 * sweeper) finds nothing left to do. Outside a plan nothing
 * re-checks the post, so an open or approved round is reopened right away (the content hash
 * changed); there, a take that can no longer go up (a newer take of the shot went up meanwhile, or
 * the post was published) only leaves its trial and stays in the Vault.
 */
export async function promoteVaultTake(deps: Deps, takeId: string): Promise<void> {
  const events = new EventBatch();
  const promoted = await deps.prisma.$transaction(async (tx) => {
    const take = await tx.asset.findUnique({
      where: { id: takeId },
      include: { post: { select: { status: true } } },
    });
    if (!take || take.isCurrent || take.status !== "READY") return null;
    const params = takeParams(take);
    const rootId = lineageRootId(take);
    if (!params.taskId) {
      const onShow = await currentOfLineage(tx, rootId);
      const superseded = onShow !== null && onShow.version > take.version;
      const published = take.post !== null && FROZEN_POST_STATUSES.has(take.post.status);
      if (superseded || published) {
        const ended = await tx.asset.update({
          where: { id: take.id },
          data: { params: offTrial(params) },
        });
        assetUpdated(events, ended);
        deps.logger.info(
          { assetId: take.id, superseded, postStatus: take.post?.status },
          "an accepted Vault take stays in the Vault: its post can't take it any more",
        );
        return true;
      }
    }
    // The take steps in for its lineage's take on show and for any other lineage's take of its
    // place: a post shows one take per scene or slide. regenerateAsset refuses a lineage that isn't
    // the place's own, so the rivals are only ever a backstop.
    const rivals = take.postId
      ? await slotRivals(tx, take.postId, takeSlot(take, params), rootId)
      : [];
    const replaced = await tx.asset.updateManyAndReturn({
      where: {
        AND: [
          { isCurrent: true },
          { OR: [lineageWhere(rootId), { id: { in: rivals.map((rival) => rival.id) } }] },
        ],
      },
      data: { isCurrent: false },
    });
    const current = await tx.asset.update({
      where: { id: take.id },
      data: { isCurrent: true, params: offTrial(params) },
    });
    for (const row of [...replaced, current]) assetUpdated(events, row);
    if (!params.taskId && take.postId) {
      await reopenApproval(tx, take.postId, deps, events);
    }
    return true;
  });
  if (promoted) await events.publish(deps);
}

async function reopenApproval(
  tx: DbTransaction,
  postId: string,
  deps: Deps,
  events: EventBatch,
): Promise<void> {
  const post = await tx.post.findUnique({ where: { id: postId }, select: { campaignId: true } });
  if (!post) return;
  await shareLockCampaign(tx, post.campaignId);
  const cancelled = await cancelOpenRounds(tx, postId, deps.clock.now());
  if (cancelled.length === 0) return;
  await cancelScheduledForPost(tx, events, postId, "takeReplaced");
  const updated = await requireTransition(tx, postId, "PENDING_APPROVAL", { approvedAt: null });
  const request = await openApprovalRound(tx, updated);
  const context = { campaignId: updated.campaignId, clientId: updated.clientId };
  for (const round of cancelled) approvalResolved(events, round, context);
  approvalCreated(events, request, context);
  postUpdated(events, updated);
}
