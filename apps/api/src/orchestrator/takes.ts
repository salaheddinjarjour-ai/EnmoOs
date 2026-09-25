import { shotCoverageIssues } from "@enmo/agents";
import { Prisma, type Asset, type DbClient, type DbTransaction, type Post } from "@enmo/db";
import {
  AssetParams,
  AssetReview,
  COPY_SHAPE_BY_POST_TYPE,
  CopywriterOutput,
  type AssetOrigin,
  type Issue,
  type PostType,
  type Shot,
  type ShotPosition,
  type VisualConsistency,
  type VisualDirectCopy,
} from "@enmo/shared";
import type { Deps } from "../deps";
import { enqueueRenderSubmit, type RequeueToken } from "../jobs/queues";
import { parseStored } from "../lib/stored";
import { nextUtcMidnight, utcDay } from "../services/budget";
import type { RunContext } from "./agent-run";
import type { EventBatch } from "./events";
import type { TaskWithContext } from "./tasks";

/*
 * Takes: the shot Assets the visual loop renders (DESIGN §B "Asset", §F). A take never changes into
 * another take: a regeneration is a new row in the same lineage (parentAssetId → the take it
 * replaces, rootAssetId → v1, which points at itself), and isCurrent marks the one a post shows.
 * Asset.params holds AssetParams plus two keys only the loop reads (see TakeParams).
 */

type Db = DbClient | DbTransaction;

/** AssetParams plus the loop's own bookkeeping; each key is absent while it doesn't apply. */
export type TakeParams = AssetParams & {
  /** A Vault take whose shot the Visual Director hasn't re-planned yet: not ready to submit. */
  pendingDirection?: boolean;
  /** A real video's poster frame in Storage (the review looks at it). */
  posterStorageKey?: string;
  /**
   * Which take of its shot this is since the shot was last planned (by a direct task or a Vault
   * regenerate); absent on the planned take itself (1). The review loop regenerates a weak take
   * while this is at most MAX_VISUAL_REGENERATIONS, then escalates.
   */
  attempt?: number;
  /**
   * A take on trial: a Vault regenerate, and the takes its review regenerated. The post keeps its
   * current take until the Visual Director (or people, with accept_best) accepts one of these,
   * which then becomes current and leaves its trial (offTrial).
   */
  onTrial?: true;
};

export function takeParams(asset: Pick<Asset, "id" | "params">): TakeParams {
  return parseStored(AssetParams, asset.params, `Asset ${asset.id}.params`);
}

/**
 * The params of a take whose trial is over (it became current, or a newer take replaced it): no
 * longer on trial, so the review loop and the sweeper leave it be.
 */
export function offTrial(params: TakeParams): Prisma.InputJsonObject {
  const { onTrial: _onTrial, ...rest } = params;
  return jsonParams(rest);
}

/** TakeParams.attempt, 1 on a planned take. */
export function takeAttempt(params: TakeParams): number {
  return params.attempt ?? 1;
}

/**
 * A shot's last take before people decide: the planned take plus the configured regenerations.
 * The loop escalates a weak take at this attempt, and the review is told the same number.
 */
export function lastTakeAttempt(config: Pick<Deps["config"], "MAX_VISUAL_REGENERATIONS">): number {
  return 1 + config.MAX_VISUAL_REGENERATIONS;
}

export function takeReview(asset: Pick<Asset, "id" | "review">): AssetReview | null {
  return asset.review === null
    ? null
    : parseStored(AssetReview, asset.review, `Asset ${asset.id}.review`);
}

/** Prisma needs Json input without an index signature; AssetParams is a loose object. */
export function jsonParams(params: TakeParams): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(params)) as Prisma.InputJsonObject;
}

/** The lineage's v1. Rows written before rootAssetId pointed at itself carry null on v1. */
export function lineageRootId(asset: Pick<Asset, "id" | "rootAssetId">): string {
  return asset.rootAssetId ?? asset.id;
}

export function lineageWhere(rootId: string): Prisma.AssetWhereInput {
  return { OR: [{ id: rootId }, { rootAssetId: rootId }] };
}

/** The takes a VISUAL_DIRECTOR direct task rendered (AssetParams.taskId). */
export function taskTakesWhere(taskId: string): Prisma.AssetWhereInput {
  return { role: "SHOT", params: { path: ["taskId"], equals: taskId } };
}

export const VAULT_ORIGIN_WHERE: Prisma.AssetWhereInput = {
  params: { path: ["origin"], equals: "vault" },
};

/** Takes on trial (TakeParams.onTrial). */
export const ON_TRIAL_WHERE: Prisma.AssetWhereInput = {
  params: { path: ["onTrial"], equals: true },
};

/** Takes no direct task waits on: a Vault regenerate on a post outside any plan. */
export const NO_TASK_WHERE: Prisma.AssetWhereInput = {
  params: { path: ["taskId"], equals: Prisma.AnyNull },
};

/* ─── places in a post ───────────────────────────────────────────────────────────────────────── */

type Slot = Pick<ShotPosition, "sceneIndex" | "slideIndex">;

/** One key per place a shot fills: a script scene, a carousel slide, or the single image. */
export function slotKey(slot: Slot): string {
  return `${slot.sceneIndex ?? "-"}/${slot.slideIndex ?? "-"}`;
}

/** Where a take sits in its post (its shot's scene or slide). */
export function takeSlot(asset: Pick<Asset, "sceneIndex">, params: AssetParams): Slot {
  return {
    sceneIndex: params.shot?.sceneIndex ?? asset.sceneIndex,
    slideIndex: params.shot?.slideIndex ?? null,
  };
}

/** The places the post's copy asks the Visual Director to fill (its scenes, slides, or one). */
export function postSlotKeys(type: PostType, copy: VisualDirectCopy): string[] {
  const shape = COPY_SHAPE_BY_POST_TYPE[type];
  if (shape === "script" && copy.script?.scenes.length) {
    return copy.script.scenes.map((scene) =>
      slotKey({ sceneIndex: scene.index, slideIndex: null }),
    );
  }
  if (shape === "slides" && copy.slides?.length) {
    return copy.slides.map((slide) => slotKey({ sceneIndex: null, slideIndex: slide.index }));
  }
  return [slotKey({ sceneIndex: null, slideIndex: null })];
}

/** The post's current take of each shot. */
export function currentTakes(db: Db, postId: string): Promise<Asset[]> {
  return db.asset.findMany({ where: { postId, role: "SHOT", isCurrent: true } });
}

/**
 * The post's current takes of `slot` from another lineage than `rootId`. A post shows one take per
 * scene or slide, but a slot's lineage can change: a revision that drops a scene leaves its
 * lineage without a current take, and one that adds it back starts a new lineage there.
 */
export async function slotRivals(
  db: Db,
  postId: string,
  slot: Slot,
  rootId: string,
): Promise<Asset[]> {
  const current = await currentTakes(db, postId);
  return current.filter(
    (take) =>
      lineageRootId(take) !== rootId && slotKey(takeSlot(take, takeParams(take))) === slotKey(slot),
  );
}

/**
 * Where the post's current takes are out of step with `copy`: a scene or slide without a take, or
 * a take of one the copy no longer has (shotCoverageIssues). [] when they fit, and for a post with
 * no takes at all (no Visual Director in its pipeline).
 */
export async function shotGaps(
  db: Db,
  post: Pick<Post, "id" | "type">,
  copy: CopywriterOutput,
): Promise<Issue[]> {
  const any = await db.asset.count({ where: { postId: post.id, role: "SHOT" } });
  if (any === 0) return [];
  const current = await currentTakes(db, post.id);
  const shots = current.map((take) => ({
    shotId: take.shotId,
    ...takeSlot(take, takeParams(take)),
  }));
  return shotCoverageIssues(post, visualCopyOf(copy), shots);
}

/* ─── writing takes ──────────────────────────────────────────────────────────────────────────── */

export interface NewTake {
  post: { id: string; clientId: string; campaignId: string };
  shot: Shot;
  consistency: VisualConsistency | null;
  origin: AssetOrigin;
  /** The direct task that waits on this take; null for a Vault take outside any plan. */
  taskId: string | null;
  /** The Vault instruction, verbatim. */
  instruction: string | null;
  /** The take this one replaces; null starts a new lineage. */
  parent: Pick<Asset, "id" | "rootAssetId" | "regenCount"> | null;
  regenCount: number;
  /** TakeParams.attempt; 1 (the default) for a planned take. */
  attempt?: number;
  isCurrent: boolean;
  /** TakeParams.onTrial: current only once the Visual Director accepts it. */
  onTrial?: boolean;
  /** VisualProvider.name. */
  provider: string;
  createdById?: string | null;
  pendingDirection?: boolean;
}

/** A QUEUED take: v1 of a new lineage, or the next version of `parent`'s. */
export async function createTake(tx: DbTransaction, take: NewTake): Promise<Asset> {
  const rootId = take.parent ? lineageRootId(take.parent) : null;
  const latest = rootId
    ? await tx.asset.aggregate({ where: lineageWhere(rootId), _max: { version: true } })
    : null;
  const params: TakeParams = {
    shot: take.shot,
    consistency: take.consistency,
    origin: take.origin,
    instruction: take.instruction,
    taskId: take.taskId,
    mockVideo: take.shot.kind === "VIDEO" && take.provider === "mock",
    ...(take.pendingDirection ? { pendingDirection: true } : {}),
    ...(take.attempt && take.attempt > 1 ? { attempt: take.attempt } : {}),
    ...(take.onTrial ? { onTrial: true } : {}),
  };
  const created = await tx.asset.create({
    data: {
      clientId: take.post.clientId,
      campaignId: take.post.campaignId,
      postId: take.post.id,
      role: "SHOT",
      kind: take.shot.kind,
      status: "QUEUED",
      provider: take.provider,
      prompt: take.shot.prompt,
      negativePrompt: take.shot.negativePrompt.trim() || null,
      params: jsonParams(params),
      shotId: take.shot.shotId,
      sceneIndex: take.shot.sceneIndex,
      version: (latest?._max.version ?? 0) + 1,
      parentAssetId: take.parent?.id ?? null,
      rootAssetId: rootId,
      isCurrent: take.isCurrent,
      regenCount: take.regenCount,
      createdById: take.createdById ?? null,
    },
  });
  if (rootId) return created;
  return tx.asset.update({ where: { id: created.id }, data: { rootAssetId: created.id } });
}

type AssetEventFields = Pick<
  Asset,
  "id" | "clientId" | "campaignId" | "postId" | "status" | "version" | "isCurrent"
>;

export function assetUpdated(events: EventBatch, asset: AssetEventFields): EventBatch {
  return events.global("asset.updated", {
    assetId: asset.id,
    clientId: asset.clientId,
    campaignId: asset.campaignId,
    postId: asset.postId,
    status: asset.status,
    version: asset.version,
    isCurrent: asset.isCurrent,
  });
}

/** The newest version of a lineage that is current, if any. */
export function currentOfLineage(db: Db, rootId: string): Promise<Asset | null> {
  return db.asset.findFirst({
    where: { AND: [lineageWhere(rootId), { isCurrent: true }] },
    orderBy: { version: "desc" },
  });
}

/* ─── helpers of the visual loop ─────────────────────────────────────────────────────────────── */

export function runContextOf(task: TaskWithContext): RunContext {
  return {
    taskId: task.id,
    campaignId: task.graph.campaignId,
    clientId: task.graph.campaign.clientId,
  };
}

export function storedCopy(post: Pick<Post, "id" | "copy">): CopywriterOutput | null {
  return post.copy === null
    ? null
    : parseStored(CopywriterOutput, post.copy, `Post ${post.id}.copy`);
}

export function visualCopyOf(copy: CopywriterOutput): VisualDirectCopy {
  return { script: copy.script, slides: copy.slides, onScreenText: copy.onScreenText };
}

export function postOf(post: Pick<Post, "id" | "clientId" | "campaignId">) {
  return { id: post.id, clientId: post.clientId, campaignId: post.campaignId };
}

/** Queues render.submit for each take; a lost enqueue is picked up by the sweeper. */
export async function submitAll(deps: Deps, takes: readonly Pick<Asset, "id">[]): Promise<void> {
  for (const take of takes) {
    try {
      await enqueueRenderSubmit(deps.queues, { assetId: take.id });
    } catch (error) {
      deps.logger.warn({ err: error, assetId: take.id }, "could not enqueue a render");
    }
  }
}

/**
 * How an asset job stopped by the daily token budget is queued again: once per day (the token),
 * just after the next UTC midnight, while its task keeps WAITING.
 */
export function budgetDeferral(deps: Pick<Deps, "clock">): {
  requeue: RequeueToken;
  delayMs: number;
} {
  const now = deps.clock.now();
  const resumeAt = nextUtcMidnight(now);
  return {
    requeue: `budget-${utcDay(resumeAt)}`,
    delayMs: resumeAt.getTime() - now.getTime() + 5_000,
  };
}

/**
 * Takes of `taskId` a re-run replaces: renders still in flight or waiting for review, and takes
 * already judged weak. Their jobs find them REJECTED and stop.
 */
export async function supersedeTaskTakes(
  tx: DbTransaction,
  taskId: string,
  events: EventBatch,
): Promise<void> {
  const superseded = await tx.asset.updateManyAndReturn({
    where: {
      AND: [
        taskTakesWhere(taskId),
        {
          OR: [
            { status: { in: ["QUEUED", "RENDERING"] } },
            { status: "READY", review: { equals: Prisma.DbNull } },
            { status: "READY", review: { path: ["verdict"], equals: "regenerate" } },
          ],
        },
      ],
    },
    data: { status: "REJECTED" },
  });
  for (const take of superseded) assetUpdated(events, take);
}
