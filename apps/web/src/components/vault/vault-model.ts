import {
  ASSET_SEARCH_MAX_LENGTH,
  AssetKind,
  COPY_LIMITS,
  type AssetDetailDto,
  type AssetDto,
  type AssetListQuery,
  type AssetOrigin,
  type NamedRef,
} from "@enmo/shared";
import { isRendering } from "./media";

/*
 * The Vault's view model (DESIGN §E "vault", MASTER_PLAN §03): its filters as GET /assets reads
 * them, the lineage as the drawer draws it, and the optimistic take a Regenerate shows until the
 * API answers. Pure, so it is unit-tested.
 */

/* ── Filters ─────────────────────────────────────────────────────────────────────────────────── */

export interface VaultFilters {
  /** The search box as typed (the screen debounces it); matches prompt, campaign and shot id. */
  q: string;
  clientId: string | null;
  campaignId: string | null;
  /** One script scene, 0-based as the copy counts them (shown as "Scene 1"); null for any. */
  sceneIndex: number | null;
  /** One carousel slide, 0-based; null for any. Never set together with sceneIndex. */
  slideIndex: number | null;
  kind: AssetKind | null;
  /** Every version of every lineage, not only the current takes. */
  allVersions: boolean;
}

export const EMPTY_FILTERS: VaultFilters = {
  q: "",
  clientId: null,
  campaignId: null,
  sceneIndex: null,
  slideIndex: null,
  kind: null,
  allVersions: false,
};

/** GET /assets filters without the cursor, which the infinite query pages with. */
export type AssetListFilters = Partial<Omit<AssetListQuery, "cursor" | "limit">>;

/** The query for the Vault's controls: a blank search and the "all" choices are left out. */
export function toAssetListFilters(filters: VaultFilters): AssetListFilters {
  const q = filters.q.trim().slice(0, ASSET_SEARCH_MAX_LENGTH);
  return {
    ...(q && { q }),
    ...(filters.clientId && { clientId: filters.clientId }),
    ...(filters.campaignId && { campaignId: filters.campaignId }),
    ...(filters.sceneIndex !== null && { sceneIndex: filters.sceneIndex }),
    ...(filters.sceneIndex === null &&
      filters.slideIndex !== null && { slideIndex: filters.slideIndex }),
    ...(filters.kind && { kind: filters.kind }),
    ...(filters.allVersions && { allVersions: true }),
  };
}

export function hasActiveFilters(filters: VaultFilters): boolean {
  return Object.keys(toAssetListFilters(filters)).length > 0;
}

/** The filters a Vault address carries (`/vault?campaignId=…&q=…`); anything unknown is dropped. */
export function filtersFromSearchParams(params: {
  get(name: string): string | null;
}): VaultFilters {
  const kind = AssetKind.safeParse(params.get("kind"));
  const sceneIndex = placeIndex(params.get("sceneIndex"), COPY_LIMITS.scenesMax);
  return {
    q: (params.get("q") ?? "").slice(0, ASSET_SEARCH_MAX_LENGTH),
    clientId: params.get("clientId") || null,
    campaignId: params.get("campaignId") || null,
    sceneIndex,
    // A take fills a scene or a slide, never both: a scene wins.
    slideIndex:
      sceneIndex === null ? placeIndex(params.get("slideIndex"), COPY_LIMITS.slidesMax) : null,
    kind: kind.success ? kind.data : null,
    allVersions: params.get("allVersions") === "true",
  };
}

/** A scene or slide index from the address: a whole number below `count`, else null. */
function placeIndex(value: string | null, count: number): number | null {
  if (value === null || !/^\d{1,3}$/.test(value)) return null;
  const index = Number(value);
  return index < count ? index : null;
}

/* ── Scene or slide ──────────────────────────────────────────────────────────────────────────── */

export interface PlaceOption {
  /** "" for any place, else "scene:<index>" or "slide:<index>". */
  value: string;
  label: string;
}

export const ANY_PLACE = "";

/**
 * The scene-or-slide filter's choices: every scene a script can have and every slide a carousel
 * can have (COPY_LIMITS), labelled 1-based as the post drawer and the take details label them.
 */
export const PLACE_OPTIONS: readonly PlaceOption[] = [
  { value: ANY_PLACE, label: "Any scene or slide" },
  ...Array.from({ length: COPY_LIMITS.scenesMax }, (_, index) => ({
    value: `scene:${index}`,
    label: `Scene ${index + 1}`,
  })),
  ...Array.from({ length: COPY_LIMITS.slidesMax }, (_, index) => ({
    value: `slide:${index}`,
    label: `Slide ${index + 1}`,
  })),
];

/** The filters' place as a PLACE_OPTIONS value. */
export function placeOf(filters: Pick<VaultFilters, "sceneIndex" | "slideIndex">): string {
  if (filters.sceneIndex !== null) return `scene:${filters.sceneIndex}`;
  if (filters.slideIndex !== null) return `slide:${filters.slideIndex}`;
  return ANY_PLACE;
}

/** The filters narrowed to the place a PLACE_OPTIONS value names (any place for anything else). */
export function withPlace(filters: VaultFilters, value: string): VaultFilters {
  const match = /^(scene|slide):(\d+)$/.exec(value);
  const index = match ? Number(match[2]) : null;
  return {
    ...filters,
    sceneIndex: match?.[1] === "scene" ? index : null,
    slideIndex: match?.[1] === "slide" ? index : null,
  };
}

/**
 * The Vault's address for the applied filters and the open take (`?asset=`), so a view can be
 * shared or linked to (the post drawer links a shot straight to its take). Empty for the bare Vault.
 */
export function vaultSearch(filters: VaultFilters, assetId: string | null): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(toAssetListFilters(filters))) {
    params.set(key, String(value));
  }
  if (assetId) params.set("asset", assetId);
  const search = params.toString();
  return search ? `?${search}` : "";
}

/** Where the post drawer sends a shot: the Vault, with that take's drawer open. */
export function vaultTakeHref(assetId: string): string {
  return `/vault${vaultSearch(EMPTY_FILTERS, assetId)}`;
}

/* ── Labels ──────────────────────────────────────────────────────────────────────────────────── */

type Placed = Pick<AssetDto, "post" | "shotId">;

/** "p3 · s2": where the take sits; "Take" for one outside any post. */
export function shotLabel(asset: Placed): string {
  return [asset.post?.ref, asset.shotId].filter(Boolean).join(" · ") || "Take";
}

/** "p3 · s2 · v2": one version of one shot. */
export function takeLabel(asset: Placed & Pick<AssetDto, "version">): string {
  return `${shotLabel(asset)} · v${asset.version}`;
}

export const ORIGIN_LABEL: Readonly<Record<AssetOrigin, string>> = {
  direct: "The Visual Director's shot list",
  review: "The Visual Director's review asked for another take",
  vault: "Regenerated from the Vault",
};

/** "higgsfield · soul-v2", or the provider alone. */
export function providerLabel(asset: Pick<AssetDto, "provider" | "providerModel">): string {
  return asset.providerModel ? `${asset.provider} · ${asset.providerModel}` : asset.provider;
}

/** 7 → "7", 7.25 → "7.3". */
export function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

/** "1080×1350 · PNG · 412 KB"; only the parts that are known. */
export function fileLine(
  asset: Pick<AssetDto, "width" | "height" | "mimeType" | "bytes">,
): string | null {
  const parts = [
    asset.width && asset.height ? `${asset.width}×${asset.height}` : null,
    asset.mimeType ? (asset.mimeType.split("/")[1] ?? asset.mimeType).toUpperCase() : null,
    asset.bytes === null ? null : formatBytes(asset.bytes),
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ── Lineage ─────────────────────────────────────────────────────────────────────────────────── */

export interface LineageStep {
  take: AssetDto;
  /** The version posts use now. */
  current: boolean;
  /** Rejected by the review or failed to render: shown, but dimmed. */
  dimmed: boolean;
  /** The optimistic placeholder of a Regenerate the API hasn't answered yet. */
  pending: boolean;
}

/** v1 → v2 → v3, oldest first, as the drawer's timeline draws them. */
export function lineageSteps(detail: AssetDetailDto): LineageStep[] {
  return detail.lineage.versions.map((take) => ({
    take,
    current: take.id === detail.lineage.currentAssetId,
    dimmed: take.status === "REJECTED" || take.status === "FAILED",
    pending: isPendingTake(take.id),
  }));
}

/** The version the drawer shows: the one picked, else the one opened, else the current one. */
export function selectedTake(detail: AssetDetailDto, selectedId: string | null): AssetDto {
  const { versions } = detail.lineage;
  return (
    versions.find((take) => take.id === selectedId) ??
    versions.find((take) => take.id === detail.id) ??
    versions.find((take) => take.id === detail.lineage.currentAssetId) ??
    versions.at(-1) ??
    detail
  );
}

/** Whether a take of the lineage is still rendering (the API refuses a Regenerate meanwhile). */
export function lineageInFlight(detail: AssetDetailDto): boolean {
  return detail.lineage.versions.some((take) => isRendering(take.status));
}

/** Only the Visual Director's shots on a post can be regenerated: it needs their context back. */
export function canRegenerate(asset: Pick<AssetDto, "role" | "post" | "params">): boolean {
  return asset.role === "SHOT" && asset.post !== null && asset.params.shot !== null;
}

/** A Regenerate's instruction as the API gets it: the note verbatim, or null when it is blank. */
export function instructionOf(note: string): string | null {
  return note.trim().length > 0 ? note : null;
}

const PENDING_PREFIX = "pending:";

export function isPendingTake(id: string): boolean {
  return id.startsWith(PENDING_PREFIX);
}

/** The placeholder's id while the API decides on a Regenerate of `sourceId`. */
export function pendingTakeId(sourceId: string): string {
  return `${PENDING_PREFIX}${sourceId}`;
}

/**
 * The take a Regenerate will add, drawn at once (QUEUED, shimmering) and replaced by the API's
 * answer: the next version of the lineage, from `source`, carrying the instruction verbatim.
 */
export function pendingTake(
  source: AssetDto,
  detail: AssetDetailDto,
  {
    instruction,
    createdBy,
    now,
  }: { instruction: string | null; createdBy: NamedRef | null; now: string },
): AssetDto {
  const version = Math.max(...detail.lineage.versions.map((take) => take.version)) + 1;
  return {
    ...source,
    id: pendingTakeId(source.id),
    status: "QUEUED",
    version,
    isCurrent: false,
    parentAssetId: source.id,
    rootAssetId: detail.lineage.rootAssetId,
    params: { ...source.params, origin: "vault", instruction },
    url: null,
    posterUrl: null,
    mimeType: null,
    width: null,
    height: null,
    durationSec: null,
    bytes: null,
    review: null,
    regenCount: source.regenCount + 1,
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

/** The detail with `take` added to (or replacing its id in) the lineage, kept in version order. */
export function withTake(detail: AssetDetailDto, take: AssetDto): AssetDetailDto {
  if (detail.lineage.rootAssetId !== take.rootAssetId) return detail;
  const versions = [...detail.lineage.versions.filter((existing) => existing.id !== take.id), take];
  versions.sort((a, b) => a.version - b.version || a.createdAt.localeCompare(b.createdAt));
  return { ...detail, lineage: { ...detail.lineage, versions } };
}

/** The detail without optimistic placeholders (the API answered, or refused). */
export function withoutPendingTakes(detail: AssetDetailDto): AssetDetailDto {
  const versions = detail.lineage.versions.filter((take) => !isPendingTake(take.id));
  if (versions.length === detail.lineage.versions.length) return detail;
  return { ...detail, lineage: { ...detail.lineage, versions } };
}
