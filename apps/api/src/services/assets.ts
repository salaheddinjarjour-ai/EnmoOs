import type { Prisma } from "@enmo/db";
import {
  AssetParams,
  AssetReview,
  aspectRatioOf,
  type AssetDetailDto,
  type AssetDto,
  type AssetListQuery,
  type AssetListResponse,
  type PostStatus,
} from "@enmo/shared";
import type { Deps } from "../deps";
import { enqueueVisualRegenerate } from "../jobs/queues";
import { conflict, notFound } from "../lib/errors";
import { parseStored } from "../lib/stored";
import { afterCommit } from "../orchestrator/after-commit";
import { approvalResolved, lockReopenableRounds } from "../orchestrator/approval-round";
import { EventBatch } from "../orchestrator/events";
import { routeVisualRevision } from "../orchestrator/feedback";
import { advance } from "../orchestrator/graph";
import { lockPost, shareLockCampaign } from "../orchestrator/locks";
import { FROZEN_POST_STATUSES, postUpdated } from "../orchestrator/post-status";
import {
  NO_TASK_WHERE,
  ON_TRIAL_WHERE,
  assetUpdated,
  createTake,
  lineageRootId,
  lineageWhere,
  postSlotKeys,
  slotKey,
  slotRivals,
  storedCopy,
  takeParams,
  visualCopyOf,
} from "../orchestrator/takes";
import { UNFINISHED_STATUSES } from "../orchestrator/tasks";
import type { ServiceUser } from "./actor";

/*
 * The Vault (DESIGN §E "vault", §F): every generated asset, versioned and searchable, and the
 * Regenerate that hands the Visual Director its original context back.
 */

const ASSET_INCLUDE = {
  client: { select: { id: true, name: true } },
  campaign: { select: { id: true, name: true } },
  post: { select: { id: true, ref: true, type: true } },
  createdBy: { select: { id: true, name: true } },
} as const satisfies Prisma.AssetInclude;

type AssetRow = Prisma.AssetGetPayload<{ include: typeof ASSET_INCLUDE }>;

export function toAssetDto(row: AssetRow): AssetDto {
  const params = parseStored(AssetParams, row.params, `Asset ${row.id}.params`);
  const measured = row.width && row.height ? aspectRatioOf(row.width, row.height) : null;
  return {
    id: row.id,
    client: row.client,
    campaign: row.campaign,
    post: row.post,
    variantId: row.variantId,
    position: row.position,
    role: row.role,
    kind: row.kind,
    status: row.status,
    version: row.version,
    isCurrent: row.isCurrent,
    parentAssetId: row.parentAssetId,
    rootAssetId: lineageRootId(row),
    provider: row.provider,
    providerModel: row.providerModel,
    prompt: row.prompt,
    negativePrompt: row.negativePrompt,
    params,
    shotId: row.shotId,
    sceneIndex: row.sceneIndex,
    slideIndex: params.shot?.slideIndex ?? null,
    aspectRatio: params.shot?.aspectRatio ?? measured,
    url: row.url,
    posterUrl: row.posterUrl,
    mimeType: row.mimeType,
    width: row.width,
    height: row.height,
    durationSec: row.durationSec,
    bytes: row.bytes,
    review:
      row.review === null ? null : parseStored(AssetReview, row.review, `Asset ${row.id}.review`),
    regenCount: row.regenCount,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * GET /assets: newest first, keyset-paginated on (createdAt, id): `cursor` is the id of the last
 * row of the previous page, `nextCursor` the next one's. `q` (trimmed, "" means absent) matches the
 * prompt, the campaign name and the shot id case-insensitively; `sceneIndex` and `slideIndex` narrow
 * to one scene or slide of the posts' copy. Only current versions unless `allVersions`.
 */
export async function listAssets(deps: Deps, query: AssetListQuery): Promise<AssetListResponse> {
  const q = query.q?.trim();
  const where: Prisma.AssetWhereInput = {
    clientId: query.clientId,
    campaignId: query.campaignId,
    postId: query.postId,
    sceneIndex: query.sceneIndex,
    kind: query.kind,
    // A slide lives in the shot the take was rendered from; only a scene has a column of its own.
    ...(query.slideIndex === undefined
      ? {}
      : { params: { path: ["shot", "slideIndex"], equals: query.slideIndex } }),
    ...(query.allVersions ? {} : { isCurrent: true }),
    ...(q
      ? {
          OR: [
            { prompt: { contains: q, mode: "insensitive" } },
            { campaign: { name: { contains: q, mode: "insensitive" } } },
            { shotId: { equals: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  let after: Prisma.AssetWhereInput | null = null;
  if (query.cursor) {
    const cursor = await deps.prisma.asset.findUnique({
      where: { id: query.cursor },
      select: { id: true, createdAt: true },
    });
    if (!cursor) return { items: [], nextCursor: null };
    // An explicit keyset, not Prisma's cursor + skip: the cursor take may no longer match the
    // filters (superseded since the last page), and skipping "it" would drop a real row instead.
    after = {
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    };
  }
  const rows = await deps.prisma.asset.findMany({
    where: after ? { AND: [where, after] } : where,
    include: ASSET_INCLUDE,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
  });
  const items = rows.slice(0, query.limit);
  return {
    items: items.map(toAssetDto),
    nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
  };
}

/** GET /assets/:id: the asset plus its whole lineage (versions oldest first). NOT_FOUND if missing. */
export async function getAsset(deps: Deps, assetId: string): Promise<AssetDetailDto> {
  const row = await deps.prisma.asset.findUnique({
    where: { id: assetId },
    include: ASSET_INCLUDE,
  });
  if (!row) throw notFound("Asset");
  const rootAssetId = lineageRootId(row);
  const versions = await deps.prisma.asset.findMany({
    where: lineageWhere(rootAssetId),
    include: ASSET_INCLUDE,
    orderBy: [{ version: "asc" }, { createdAt: "asc" }],
  });
  return {
    ...toAssetDto(row),
    lineage: {
      rootAssetId,
      currentAssetId: versions.find((version) => version.isCurrent)?.id ?? null,
      versions: versions.map(toAssetDto),
    },
  };
}

/** Where a planned post can take a visual change: waiting on, or past, its approval. */
const REVISABLE_POST_STATUSES: ReadonlySet<PostStatus> = new Set([
  "PENDING_APPROVAL",
  "APPROVED",
  "SCHEDULED",
]);

/**
 * A take of the lineage is still rendering, or a take on trial outside any plan is still in the
 * review loop (waiting for its review, or for the verdict to be acted on). A planned post's trial
 * is its direct task's: the task-status checks cover it, and a take its resolved task left behind
 * never blocks the shot.
 */
function lineageInFlight(tx: Prisma.TransactionClient, rootId: string): Promise<number> {
  return tx.asset.count({
    where: {
      AND: [
        lineageWhere(rootId),
        {
          OR: [
            { status: { in: ["QUEUED", "RENDERING"] } },
            { AND: [NO_TASK_WHERE, ON_TRIAL_WHERE, { status: "READY", isCurrent: false }] },
          ],
        },
      ],
    },
  });
}

/**
 * POST /assets/:id/regenerate: a new QUEUED version of the asset's lineage (origin "vault",
 * createdById = the user, the instruction verbatim in AssetParams) that gives the Visual Director
 * the take's original context back. The take is on trial: it goes through the review loop like any
 * take (a weak one is regenerated at most MAX_VISUAL_REGENERATIONS times, then escalated) and
 * becomes current only once the Visual Director accepts it, so the post keeps its current take
 * meanwhile. On a planned post it is a revision (routeVisualRevision): open or approved rounds are
 * cancelled, the post goes to CHANGES_REQUESTED and a `direct → qa` chain is appended whose direct
 * task carries the instruction as HUMAN feedback; QA opens the next approval round (the content
 * hash changed). A post outside any plan gets the visual.regenerate job instead. Returns the new
 * version. NOT_FOUND if missing; CONFLICT while a take of the lineage is still rendering or under
 * review, while an agent works on the post or a task of it waits on a human, for published posts,
 * and for a take whose scene or slide the copy dropped or the post now fills from another lineage.
 */
export async function regenerateAsset(
  deps: Deps,
  user: ServiceUser,
  assetId: string,
  instruction: string | null,
): Promise<AssetDto> {
  const asset = await deps.prisma.asset.findUnique({
    where: { id: assetId },
    include: { post: { include: { campaign: { select: { status: true } } } } },
  });
  if (!asset) throw notFound("Asset");
  const params = takeParams(asset);
  const shot = params.shot;
  if (asset.role !== "SHOT" || !shot) {
    throw conflict("Only the Visual Director's shots can be regenerated");
  }
  const { post } = asset;
  if (!post) {
    throw conflict(
      "This take isn't attached to a post, so the Visual Director has no context to regenerate it from",
    );
  }
  if (post.campaign.status === "ARCHIVED") throw conflict("The campaign is archived");
  if (FROZEN_POST_STATUSES.has(post.status)) {
    throw conflict("This post's visuals can't change any more");
  }
  const copy = storedCopy(post);
  if (copy === null) {
    throw conflict("The post has no copy yet; regenerate once the Copywriter has drafted it");
  }
  // Takes follow the copy (one per scene or slide): an old take of a scene or slide the copy has
  // since dropped has no place in the post for the Visual Director to re-plan.
  if (!postSlotKeys(post.type, visualCopyOf(copy)).includes(slotKey(shot))) {
    throw conflict(
      "This take's scene or slide is no longer in the post's copy; regenerate one of the post's current takes",
    );
  }

  const now = deps.clock.now();
  const events = new EventBatch();
  const created = await deps.prisma.$transaction(async (tx) => {
    // Campaign, rounds, then the post: the order every other writer locks them in (locks.ts).
    await shareLockCampaign(tx, post.campaignId);
    await lockReopenableRounds(tx, post.id);
    await lockPost(tx, post.id);
    const state = await tx.post.findUniqueOrThrow({
      where: { id: post.id },
      include: {
        tasks: { select: { status: true, graphId: true }, orderBy: { createdAt: "asc" } },
      },
    });
    if (state.tasks.some((task) => UNFINISHED_STATUSES.includes(task.status))) {
      throw conflict("An agent is working on this post right now; regenerate once it's done");
    }
    if (state.tasks.some((task) => task.status === "ESCALATED" || task.status === "FAILED")) {
      throw conflict(
        "A task of this post is waiting on a human; accept the best take or retry it first",
      );
    }
    if ((await lineageInFlight(tx, lineageRootId(asset))) > 0) {
      throw conflict(
        "A take of this shot is still rendering or under review; try again once it's done",
      );
    }
    // The scene or slide is still in the copy, but the post may show another lineage's take there
    // now (a revision dropped it and a later one added it back): promoting this lineage would give
    // the place two current takes.
    const [onShow] = await slotRivals(tx, post.id, shot, lineageRootId(asset));
    if (onShow) {
      throw conflict(
        `The post shows another take of this ${shot.sceneIndex !== null ? "scene" : shot.slideIndex !== null ? "slide" : "shot"} now (${onShow.shotId ?? "its shot"} v${onShow.version}); regenerate that one instead`,
      );
    }

    const graphId = state.tasks[0]?.graphId ?? null;
    let taskId: string | null = null;
    if (graphId) {
      if (!REVISABLE_POST_STATUSES.has(state.status)) {
        throw conflict(
          "The agents haven't finished this post yet; regenerate once it's in approval",
        );
      }
      const revision = await routeVisualRevision(tx, {
        postId: post.id,
        graphId,
        feedback:
          instruction === null
            ? null
            : { verbatim: instruction, source: "HUMAN", decisionId: null },
        enabledActions: deps.config.PIPELINE_ACTIONS,
        now,
      });
      taskId = revision.direct.id;
      const context = { campaignId: revision.post.campaignId, clientId: revision.post.clientId };
      for (const round of revision.cancelled) approvalResolved(events, round, context);
      postUpdated(events, revision.post);
    }

    const take = await createTake(tx, {
      post: { id: post.id, clientId: post.clientId, campaignId: post.campaignId },
      shot,
      consistency: params.consistency,
      origin: "vault",
      taskId,
      instruction,
      parent: asset,
      regenCount: asset.regenCount + 1,
      isCurrent: false,
      onTrial: true,
      provider: deps.visual.name,
      createdById: user.id,
      pendingDirection: true,
    });
    assetUpdated(events, take);
    return { take, graphId };
  });

  await afterCommit(deps, "publishing the regenerate", () => events.publish(deps));
  const { take, graphId } = created;
  await afterCommit(deps, "starting the regenerate", () =>
    graphId ? advance(deps, graphId) : enqueueVisualRegenerate(deps.queues, { assetId: take.id }),
  );
  const row = await deps.prisma.asset.findUniqueOrThrow({
    where: { id: take.id },
    include: ASSET_INCLUDE,
  });
  return toAssetDto(row);
}
