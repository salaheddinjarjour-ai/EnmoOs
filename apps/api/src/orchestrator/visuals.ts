import type { Asset, Post } from "@enmo/db";
import {
  Feedback,
  VisualDirectInput,
  compareShotPosition,
  type QaVisual,
  type Shot,
  type VisualDirectCopy,
  type VisualReviewOutput,
} from "@enmo/shared";
import type { Deps } from "../deps";
import { conflict, notFound } from "../lib/errors";
import { parseStored } from "../lib/stored";
import { runAgentFor } from "./agent-run";
import { brandContextOf } from "./context";
import { asSentence, escalateTask, failTask, type HandOff } from "./escalation";
import { EventBatch } from "./events";
import { advance } from "./graph";
import { postUpdated } from "./post-status";
import { reportProgress } from "./progress";
import { completeIfSettled } from "./take-completion";
import {
  ON_TRIAL_WHERE,
  VAULT_ORIGIN_WHERE,
  assetUpdated,
  createTake,
  currentOfLineage,
  lastTakeAttempt,
  lineageRootId,
  lineageWhere,
  offTrial,
  postOf,
  postSlotKeys,
  runContextOf,
  slotKey,
  storedCopy,
  submitAll,
  supersedeTaskTakes,
  takeAttempt,
  takeParams,
  takeReview,
  takeSlot,
  taskTakesWhere,
  visualCopyOf,
  type TakeParams,
} from "./takes";
import { loadTask, type TaskWithContext } from "./tasks";
import { promoteVaultTake, redirectVaultTask } from "./vault-takes";

export { onRenderReady } from "./render-outcomes";
export { driveStaleRenders } from "./visual-sweep";

/*
 * The visual loop (DESIGN §D "task.run", §F): the Visual Director's shot list becomes shot Assets
 * that render (render.submit → render.poll → Storage, renders.ts) and get reviewed (visual.review,
 * the image goes to the LLM). A weak take is regenerated at most MAX_VISUAL_REGENERATIONS times as
 * a new Asset version (parentAssetId → the take it replaces, rootAssetId → v1, isCurrent moves),
 * then the task escalates. The direct task stays WAITING until every shot has an accepted take,
 * then SUCCEEDS and the graph advances.
 *
 *   renders          render.submit / render.poll: provider, download, Storage
 *   render-outcomes  READY → review; a failed or refused render hands the task to people
 *   visual-review    visual.review: the image goes to the LLM, the verdict comes back here
 *   take-completion  the WAITING task SUCCEEDS once every shot has an accepted take
 *   vault-takes      the Vault's regenerate: one take re-planned in its original context
 *   visual-sweep     tick.sweeper re-drives takes whose job was lost
 *   takes            Asset rows: lineages, params, events
 */

/**
 * The previous shot list, in post order, when it still covers every place of the post's current
 * copy (a revision of the same shape). A list that no longer fits the copy is left out: the
 * Visual Director would read it as a regenerate of just those shots.
 */
export function previousShotList(
  takes: readonly Asset[],
  post: Pick<Post, "type">,
  copy: VisualDirectCopy,
): Shot[] | null {
  const bySlot = new Map<string, Shot>();
  for (const take of takes) {
    const shot = takeParams(take).shot;
    if (shot) bySlot.set(slotKey(shot), shot);
  }
  const wanted = postSlotKeys(post.type, copy);
  if (bySlot.size === 0 || !wanted.every((key) => bySlot.has(key))) return null;
  return wanted.map((key) => bySlot.get(key)!);
}

/**
 * task.run for a VISUAL_DIRECTOR `direct` task (RUNNING): builds VisualDirectInput (brand, post,
 * copy, the task's feedback verbatim, the previous shot list on a revision, the provider's
 * capabilities), runs VISUAL_DIRECTOR.direct, creates one QUEUED shot Asset per shot (Asset.params
 * as AssetParams) plus their render.submit jobs, and leaves the task WAITING. AgentEscalation and
 * BudgetExceeded propagate to runTask, which hands them off like any other agent's. A task that
 * carries a Vault take re-plans just that take instead.
 */
export async function planShots(deps: Deps, task: TaskWithContext): Promise<void> {
  const vaultTakes = await deps.prisma.asset.findMany({
    where: { AND: [taskTakesWhere(task.id), VAULT_ORIGIN_WHERE] },
    orderBy: { createdAt: "asc" },
  });
  if (vaultTakes.length > 0) {
    await redirectVaultTask(deps, task, vaultTakes);
    return;
  }

  const { post } = task;
  const client = task.graph.campaign.client;
  if (!post || !client)
    throw new Error(`AgentTask ${task.id} is not attached to a post of a client`);
  const copy = storedCopy(post);
  if (!copy) {
    await failTask(deps, task.id, {
      reason: "FAILED",
      issues: [],
      message: "has no copy to direct.",
    });
    return;
  }
  const visualCopy = visualCopyOf(copy);
  // A re-run (retry, budget roll-over) revises what the first run was given, not its own takes.
  const earlier = VisualDirectInput.safeParse(task.input);
  const current = earlier.success
    ? []
    : await deps.prisma.asset.findMany({
        where: { postId: post.id, role: "SHOT", isCurrent: true },
      });
  const input: VisualDirectInput = {
    brand: brandContextOf(client),
    post: { ref: post.ref, type: post.type, platforms: post.platforms },
    copy: visualCopy,
    feedback:
      task.feedback === null
        ? null
        : parseStored(Feedback, task.feedback, `AgentTask ${task.id}.feedback`),
    previousShots: earlier.success
      ? earlier.data.previousShots
      : previousShotList(current, post, visualCopy),
    capabilities: deps.visual.capabilities(),
  };
  await deps.prisma.agentTask.update({ where: { id: task.id }, data: { input } });

  const { output } = await runAgentFor(deps, "VISUAL_DIRECTOR.direct", input, runContextOf(task));

  const events = new EventBatch();
  const takes = await deps.prisma.$transaction(async (tx) => {
    const { count } = await tx.agentTask.updateMany({
      where: { id: task.id, status: "RUNNING" },
      data: { status: "WAITING", output, error: null },
    });
    if (count === 0) return null;
    await supersedeTaskTakes(tx, task.id, events);

    // Each shot continues the lineage of the take now in its place; the post shows the new list.
    const replaced = await tx.asset.updateManyAndReturn({
      where: { postId: post.id, role: "SHOT", isCurrent: true },
      data: { isCurrent: false },
    });
    const lineageBySlot = new Map(
      replaced.map((take) => [slotKey(takeSlot(take, takeParams(take))), take]),
    );
    for (const take of replaced) assetUpdated(events, take);

    const created: Asset[] = [];
    for (const shot of output.shots) {
      const take = await createTake(tx, {
        post: postOf(post),
        shot,
        consistency: output.consistency,
        origin: "direct",
        taskId: task.id,
        instruction: null,
        parent: lineageBySlot.get(slotKey(shot)) ?? null,
        regenCount: 0,
        isCurrent: true,
        provider: deps.visual.name,
      });
      assetUpdated(events, take);
      created.push(take);
    }
    return created;
  });
  if (!takes) return;

  await events.publish(deps);
  await submitAll(deps, takes);
  await reportProgress(deps, task.graphId, [
    { taskId: task.id, agent: task.agent, postRef: post.ref, state: "waiting" },
  ]);
}

/**
 * The Visual Director's verdict on one take (Asset.review as AssetReview). `accept` keeps it
 * current (a take on trial becomes current now); `regenerate` renders revisedPrompt as the next
 * version, until the shot has used MAX_VISUAL_REGENERATIONS since it was last planned: then the
 * task escalates (outside any plan, the take is set aside with an alert and the post keeps its
 * current take). Once every shot of the task has an accepted take, the task SUCCEEDS and the graph
 * advances. A Vault regenerate goes through the same loop as the Visual Director's own takes.
 */
export async function onReviewDone(
  deps: Deps,
  assetId: string,
  review: VisualReviewOutput,
): Promise<void> {
  const take = await deps.prisma.asset.findUnique({ where: { id: assetId } });
  if (!take) return;
  const params = takeParams(take);
  const task = params.taskId ? await loadTask(deps.prisma, params.taskId) : null;
  // A task that stopped waiting leaves its takes to its resolver; outside a plan, only a take on
  // trial is still in the loop.
  if (params.taskId ? task?.status !== "WAITING" : !params.onTrial) return;

  if (review.verdict === "accept") {
    if (params.onTrial) await promoteVaultTake(deps, take.id);
    if (task) await completeIfSettled(deps, task);
  } else if (takeAttempt(params) < lastTakeAttempt(deps.config)) {
    await regenerateTake(deps, take, params, review);
  } else if (task) {
    await escalateTask(deps, task.id, weakTakesHandOff(take, params, review));
  } else {
    await setAsideWeakTake(deps, take, weakTakesHandOff(take, params, review));
  }
}

function weakTakesHandOff(take: Asset, params: TakeParams, review: VisualReviewOutput): HandOff {
  const shotId = take.shotId ?? "a shot";
  const why = review.issues[0] ? `: ${review.issues[0].replace(/[.\s]+$/u, "")}` : "";
  const regenerations = takeAttempt(params) - 1;
  return {
    reason: "WEAK_TAKES",
    // The Visual Director's own verdict, so it signs the hand-off (the Manager signs the rest).
    signedBy: "VISUAL_DIRECTOR",
    issues: review.issues.map((message) => ({ path: shotId, message })),
    message: `says take ${regenerations + 1} of ${shotId} is still weak after ${regenerations} regeneration${regenerations === 1 ? "" : "s"} (${review.score}/10${why})`,
  };
}

/**
 * The last weak take of a Vault regenerate outside any plan: no task to escalate, so the take is
 * set aside (REJECTED, out of the loop), the post keeps its current take and people get an alert
 * to regenerate it again.
 */
async function setAsideWeakTake(deps: Deps, take: Asset, handOff: HandOff): Promise<void> {
  const [rejected] = await deps.prisma.asset.updateManyAndReturn({
    where: { id: take.id, status: "READY", isCurrent: false },
    data: { status: "REJECTED" },
  });
  if (!rejected) return;
  await assetUpdated(new EventBatch(), rejected)
    .alert({
      kind: "escalated",
      entityType: "Asset",
      entityId: take.id,
      message: asSentence(
        `The Visual Director ${handOff.message}. The post keeps its current take; regenerate it again from the Vault`,
      ),
      clientId: take.clientId,
      campaignId: take.campaignId,
    })
    .publish(deps);
}

/**
 * The next take of a weak one: the revised prompt, same lineage, the old take REJECTED. A take on
 * trial is followed by one on trial too, so the post keeps its current take meanwhile.
 */
async function regenerateTake(
  deps: Deps,
  take: Asset,
  params: TakeParams,
  review: VisualReviewOutput,
): Promise<void> {
  const shot = params.shot;
  if (!shot || !take.postId || !take.campaignId) {
    throw new Error(`Take ${take.id} has no shot or post to regenerate for`);
  }
  const onTrial = params.onTrial === true;
  const post = { id: take.postId, clientId: take.clientId, campaignId: take.campaignId };
  const events = new EventBatch();
  const next = await deps.prisma.$transaction(async (tx) => {
    const [rejected] = await tx.asset.updateManyAndReturn({
      where: { id: take.id, status: "READY", isCurrent: !onTrial },
      data: { status: "REJECTED", isCurrent: false },
    });
    if (!rejected) return null;
    assetUpdated(events, rejected);
    const created = await createTake(tx, {
      post,
      shot: { ...shot, prompt: review.revisedPrompt ?? shot.prompt },
      consistency: params.consistency,
      origin: "review",
      taskId: params.taskId,
      instruction: null,
      parent: take,
      regenCount: take.regenCount + 1,
      attempt: takeAttempt(params) + 1,
      isCurrent: !onTrial,
      onTrial,
      provider: deps.visual.name,
    });
    assetUpdated(events, created);
    return created;
  });
  if (!next) return;
  await events.publish(deps);
  await submitAll(deps, [next]);
}

const finished = (take: Asset) =>
  take.url !== null && (take.status === "READY" || take.status === "REJECTED");
const reviewScore = (take: Asset) => takeReview(take)?.score ?? -1;

/**
 * A take's rank when people take the best so far: its review score, the latest take on a tie.
 * `incumbent` (the take the post shows while a Vault regenerate is on trial) competes too, and
 * stays unless a take scored higher.
 */
export function bestTake(
  takes: readonly Asset[],
  incumbent: Asset | null = null,
): Asset | undefined {
  const [best] = takes
    .filter(finished)
    .sort((a, b) => reviewScore(b) - reviewScore(a) || b.version - a.version);
  if (!incumbent || !finished(incumbent)) return best;
  return best && reviewScore(best) > reviewScore(incumbent) ? best : incumbent;
}

/**
 * POST /agent-tasks/:id/resolve `accept_best` on an ESCALATED (or FAILED) VISUAL_DIRECTOR direct
 * task: every shot keeps its best-scored take as current, the task SUCCEEDS, the post's
 * needsAttention clears and the graph advances. A Vault regenerate's takes are on trial against the
 * take the post shows (DESIGN §B: the post keeps its current take until a take passes review), so
 * that take competes as well and stays unless one of the trial scored higher; either way the
 * trial ends, and its takes that lost are set aside (REJECTED). Throws CONFLICT when a shot has no
 * finished take.
 */
export async function acceptBestTake(deps: Deps, taskId: string): Promise<void> {
  const task = await loadTask(deps.prisma, taskId);
  if (!task) throw notFound("Task");
  const takes = await deps.prisma.asset.findMany({ where: taskTakesWhere(taskId) });
  if (takes.length === 0) throw conflict("This task has no takes to accept; retry it instead");

  const lineages = new Map<string, Asset[]>();
  for (const take of takes) {
    const root = lineageRootId(take);
    lineages.set(root, [...(lineages.get(root) ?? []), take]);
  }
  const best: Asset[] = [];
  for (const [root, lineage] of lineages) {
    const onTrial = lineage.some((take) => takeParams(take).onTrial);
    const incumbent = onTrial ? await currentOfLineage(deps.prisma, root) : null;
    const pick = bestTake(lineage, incumbent);
    if (!pick) {
      throw conflict(
        `${lineage[0]?.shotId ?? "A shot"} has no finished take to accept; retry the task instead`,
      );
    }
    best.push(pick);
  }

  const events = new EventBatch();
  await deps.prisma.$transaction(async (tx) => {
    const { count } = await tx.agentTask.updateMany({
      where: { id: taskId, status: { in: ["ESCALATED", "FAILED"] } },
      data: { status: "SUCCEEDED", error: null, finishedAt: deps.clock.now() },
    });
    if (count === 0) throw conflict("The task was resolved by someone else meanwhile");

    const keep = best.map((take) => take.id);
    const dropped = await tx.asset.updateManyAndReturn({
      where: {
        AND: [
          { OR: [...lineages.keys()].map((root) => lineageWhere(root)) },
          { id: { notIn: keep } },
          { OR: [{ isCurrent: true }, { status: { in: ["QUEUED", "RENDERING"] } }] },
        ],
      },
      data: { isCurrent: false },
    });
    const stopped = await tx.asset.updateManyAndReturn({
      where: {
        id: { in: dropped.map((take) => take.id) },
        status: { in: ["QUEUED", "RENDERING"] },
      },
      data: { status: "REJECTED" },
    });
    // The trial is over and nothing will review its takes any more: those that lost are set aside
    // as the loop sets aside a weak take, rather than left READY as if still under review.
    const setAside = await tx.asset.updateManyAndReturn({
      where: {
        AND: [taskTakesWhere(taskId), ON_TRIAL_WHERE, { status: "READY", id: { notIn: keep } }],
      },
      data: { status: "REJECTED", isCurrent: false },
    });
    const kept: Asset[] = [];
    for (const take of best) {
      const params = takeParams(take);
      kept.push(
        await tx.asset.update({
          where: { id: take.id },
          data: {
            isCurrent: true,
            status: "READY",
            ...(params.onTrial ? { params: offTrial(params) } : {}),
          },
        }),
      );
    }
    // Each take once, as it ended up.
    const changed = new Map<string, Asset>();
    for (const row of [...dropped, ...stopped, ...setAside, ...kept]) changed.set(row.id, row);
    for (const row of changed.values()) assetUpdated(events, row);

    if (task.postId) {
      const stuck = await tx.agentTask.count({
        where: { postId: task.postId, status: { in: ["ESCALATED", "FAILED"] } },
      });
      if (stuck === 0) {
        const post = await tx.post.update({
          where: { id: task.postId },
          data: { needsAttention: false, attentionReason: null },
        });
        postUpdated(events, post);
      }
    }
  });
  await events.publish(deps);
  try {
    await reportProgress(deps, task.graphId, [
      { taskId, agent: task.agent, postRef: task.post?.ref ?? null, state: "done" },
    ]);
  } finally {
    await advance(deps, task.graphId);
  }
}

/**
 * ManagerQaInput.visuals: the post's current shot takes, in post order (compareShotPosition);
 * null when the post has no shots (a pipeline without direct).
 */
export async function qaVisualsOf(deps: Deps, postId: string): Promise<QaVisual[] | null> {
  const takes = await deps.prisma.asset.findMany({ where: { postId, role: "SHOT" } });
  if (takes.length === 0) return null;
  return takes
    .filter((take) => take.isCurrent)
    .map((take) => {
      const params = takeParams(take);
      return {
        assetId: take.id,
        shotId: take.shotId,
        sceneIndex: take.sceneIndex,
        slideIndex: params.shot?.slideIndex ?? null,
        prompt: take.prompt,
        url: take.url,
        reviewScore: takeReview(take)?.score ?? null,
      };
    })
    .sort(compareShotPosition);
}
