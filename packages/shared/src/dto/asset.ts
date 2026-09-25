import { z } from "zod";
import { AssetKind, AssetRole, AssetStatus, PostType } from "../enums";
import { AspectRatio } from "../platform-rules";
import { Shot, VisualConsistency, VisualReviewOutput } from "../contracts/visual-director";
import { Id, IsoDateTime, NamedRef, VerbatimText } from "./common";

/*
 * The Vault (DESIGN §E "vault", §F): every generated asset, versioned. A regenerate never
 * overwrites a take: it adds a version to the lineage (parentAssetId → the take it replaces,
 * rootAssetId → v1) and moves isCurrent to it.
 */

/** Why a version exists. */
export const AssetOrigin = z.enum([
  /** The Visual Director's shot list (first take, or a revision round's). */
  "direct",
  /** The Visual Director's own review asked for another take. */
  "review",
  /** A teammate pressed Regenerate in the Vault. */
  "vault",
]);
export type AssetOrigin = z.infer<typeof AssetOrigin>;

/**
 * Asset.params as stored: the context a take was rendered from, so a regenerate can hand the
 * Visual Director its original shot back. Every key defaults, because rows from other producers
 * (the Adapter's sharp frames) carry only some of them; unknown keys (provider settings) pass
 * through untouched.
 */
export const AssetParams = z.looseObject({
  /** The shot as planned for this take (its prompt is the take's prompt). */
  shot: Shot.nullable().default(null),
  consistency: VisualConsistency.nullable().default(null),
  origin: AssetOrigin.nullable().default(null),
  /** The Vault regenerate instruction this version was made from, verbatim; null when none. */
  instruction: z.string().nullable().default(null),
  /** The VISUAL_DIRECTOR direct task this take belongs to (it waits on its renders). */
  taskId: Id.nullable().default(null),
  /** MockProvider's VIDEO shots are poster PNGs. */
  mockVideo: z.boolean().default(false),
});
export type AssetParams = z.infer<typeof AssetParams>;

/** Asset.review as stored: the Visual Director's latest verdict on this take. */
export const AssetReview = VisualReviewOutput.extend({
  /** Which take of the shot this was (1 = first render). */
  attempt: z.int().positive(),
  reviewedAt: IsoDateTime,
});
export type AssetReview = z.infer<typeof AssetReview>;

export const AssetPostRef = z.object({
  id: Id,
  ref: z.string(),
  type: PostType,
});
export type AssetPostRef = z.infer<typeof AssetPostRef>;

export const AssetDto = z.object({
  id: Id,
  client: NamedRef,
  campaign: NamedRef.nullable(),
  post: AssetPostRef.nullable(),
  /** Set on the Adapter's frames (Phase 5), with their order in the variant. */
  variantId: Id.nullable(),
  position: z.int().nonnegative().nullable(),
  role: AssetRole,
  kind: AssetKind,
  status: AssetStatus,
  /* Lineage summary. */
  version: z.int().positive(),
  isCurrent: z.boolean(),
  /** The take this version replaced; null on v1. */
  parentAssetId: Id.nullable(),
  /** The lineage's v1 (this asset's own id when it is v1): the key GET /assets/:id groups by. */
  rootAssetId: Id,
  /** mock | higgsfield | sharp */
  provider: z.string(),
  providerModel: z.string().nullable(),
  prompt: z.string(),
  negativePrompt: z.string().nullable(),
  params: AssetParams,
  shotId: z.string().nullable(),
  sceneIndex: z.int().nonnegative().nullable(),
  /** params.shot.slideIndex, lifted for display. */
  slideIndex: z.int().nonnegative().nullable(),
  aspectRatio: AspectRatio.nullable(),
  /* The file; null until READY. */
  url: z.string().nullable(),
  /** Still frame for VIDEO (and the whole take for mock video). */
  posterUrl: z.string().nullable(),
  mimeType: z.string().nullable(),
  width: z.int().positive().nullable(),
  height: z.int().positive().nullable(),
  durationSec: z.number().positive().nullable(),
  bytes: z.int().nonnegative().nullable(),
  review: AssetReview.nullable(),
  /** How many regenerations led to this version (0 on v1). */
  regenCount: z.int().nonnegative(),
  /** The teammate who asked for this version (Vault regenerate); null for agent work. */
  createdBy: NamedRef.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AssetDto = z.infer<typeof AssetDto>;

export const AssetLineageDto = z.object({
  rootAssetId: Id,
  /** The version that is current now; null while none is (every take failed or was rejected). */
  currentAssetId: Id.nullable(),
  /** Every version, oldest (v1) first. */
  versions: z.array(AssetDto).min(1),
});
export type AssetLineageDto = z.infer<typeof AssetLineageDto>;

/** GET /v1/assets/:id — the asset plus its whole lineage. */
export const AssetDetailDto = AssetDto.extend({
  lineage: AssetLineageDto,
});
export type AssetDetailDto = z.infer<typeof AssetDetailDto>;

export const ASSET_SEARCH_MAX_LENGTH = 200;
export const ASSET_PAGE_DEFAULT = 48;
export const ASSET_PAGE_MAX = 100;

/**
 * GET /v1/assets — newest first, keyset-paginated by id. `q` searches case-insensitively in the
 * prompt, the campaign name and the shot id; `sceneIndex` narrows to one script scene and
 * `slideIndex` to one carousel slide (both 0-based, as in the copy). Only current versions unless
 * `allVersions=true`.
 */
export const AssetListQuery = z.object({
  q: z.string().trim().max(ASSET_SEARCH_MAX_LENGTH).optional(),
  clientId: Id.optional(),
  campaignId: Id.optional(),
  postId: Id.optional(),
  sceneIndex: z.coerce.number().int().nonnegative().optional(),
  slideIndex: z.coerce.number().int().nonnegative().optional(),
  kind: AssetKind.optional(),
  allVersions: z.stringbool().default(false),
  cursor: Id.optional(),
  limit: z.coerce.number().int().min(1).max(ASSET_PAGE_MAX).default(ASSET_PAGE_DEFAULT),
});
export type AssetListQuery = z.infer<typeof AssetListQuery>;

export const AssetListResponse = z.object({
  items: z.array(AssetDto),
  /** Pass as `cursor` for the next page; null on the last one. */
  nextCursor: Id.nullable(),
});
export type AssetListResponse = z.infer<typeof AssetListResponse>;

/**
 * POST /v1/assets/:id/regenerate → AssetDto (the new version, QUEUED). The Visual Director gets the
 * take's original context back (its shot, the post's copy and brand) plus the instruction, which
 * reaches it byte-for-byte as HUMAN feedback.
 */
export const RegenerateAssetBody = z.object({
  instruction: VerbatimText.nullable().default(null),
});
export type RegenerateAssetBody = z.infer<typeof RegenerateAssetBody>;

/** A post's current take of one shot, as cards and previews show it (PostDto.currentAssets). */
export const AssetThumbDto = z.object({
  id: Id,
  kind: AssetKind,
  /** QUEUED and RENDERING show the shimmer. */
  status: AssetStatus,
  version: z.int().positive(),
  shotId: z.string().nullable(),
  sceneIndex: z.int().nonnegative().nullable(),
  slideIndex: z.int().nonnegative().nullable(),
  url: z.string().nullable(),
  posterUrl: z.string().nullable(),
  mimeType: z.string().nullable(),
  width: z.int().positive().nullable(),
  height: z.int().positive().nullable(),
  durationSec: z.number().positive().nullable(),
});
export type AssetThumbDto = z.infer<typeof AssetThumbDto>;
