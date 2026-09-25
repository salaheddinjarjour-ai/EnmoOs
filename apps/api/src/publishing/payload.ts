import type { Asset } from "@enmo/db";
import { PublishPayload, validatePublishPayload, type PublishMedia } from "@enmo/providers";
import {
  AssetParams,
  compareShotPosition,
  MASTER_ASPECT_RATIO,
  pixelSizeFor,
  type CopywriterOutput,
  type Issue,
  type Platform,
  type PostType,
} from "@enmo/shared";

/*
 * What a variant publishes (DESIGN §F): its caption and hashtags, the copy's alt text, and the
 * post's current takes as absolute public URLs the platform fetches. Until the Adapter (Phase 5)
 * cuts native frames, every variant publishes the 9:16 masters as they are: a carousel its
 * slides in order, anything else its first take (a reel's first scene, as the NoopAssembler would
 * cut it).
 */

export interface VariantCopy {
  caption: string;
  hashtags: string[];
}

/** A variant's text: the copy's caption for that platform (the main caption without one). */
export function variantCopyOf(copy: CopywriterOutput, platform: Platform): VariantCopy {
  const own = copy.platformCaptions.find((entry) => entry.platform === platform);
  return { caption: own?.caption ?? copy.caption, hashtags: [...copy.hashtags] };
}

export type PayloadTake = Pick<
  Asset,
  | "id"
  | "kind"
  | "status"
  | "url"
  | "posterUrl"
  | "mimeType"
  | "width"
  | "height"
  | "durationSec"
  | "shotId"
  | "sceneIndex"
  | "params"
>;

export interface PayloadSource {
  platform: Platform;
  postType: PostType;
  variantId: string;
  caption: string;
  hashtags: readonly string[];
  /** The post's copy (alt text, the reel's length); null when it has none. */
  copy: CopywriterOutput | null;
  /** The post's current takes, in any order. */
  takes: readonly PayloadTake[];
  /** Resolves a stored relative URL (PUBLIC_ASSET_BASE_URL). */
  publicBaseUrl: string;
}

export type PreparedPayload =
  { ok: true; payload: PublishPayload } | { ok: false; issues: Issue[] };

function absolute(url: string, base: string): string {
  return /^https?:\/\//.test(url) ? url : new URL(url, `${base.replace(/\/+$/, "")}/`).toString();
}

function positionOf(take: PayloadTake) {
  const params = AssetParams.safeParse(take.params);
  const shot = params.success ? params.data.shot : null;
  return {
    shotId: take.shotId,
    sceneIndex: shot?.sceneIndex ?? take.sceneIndex,
    slideIndex: shot?.slideIndex ?? null,
  };
}

function isReel(postType: PostType): boolean {
  return postType === "REEL" || postType === "TIKTOK";
}

function mediaOf(take: PayloadTake, source: PayloadSource): PublishMedia {
  const fallback = pixelSizeFor(MASTER_ASPECT_RATIO);
  // A reel publishes at its script's length; any other video is the clip itself.
  const durationSec =
    take.kind !== "VIDEO"
      ? undefined
      : isReel(source.postType)
        ? (source.copy?.script?.totalDurationSec ?? undefined)
        : (take.durationSec ?? undefined);
  return {
    kind: take.kind,
    url: absolute(take.url ?? "", source.publicBaseUrl),
    width: take.width ?? fallback.width,
    height: take.height ?? fallback.height,
    ...(durationSec ? { durationSec } : {}),
    ...(take.mimeType ? { mimeType: take.mimeType } : {}),
  };
}

/**
 * The variant's PublishPayload, validated exactly as every publisher validates it, or the rules it
 * breaks (a take that isn't READY counts as one).
 */
export function preparePayload(source: PayloadSource): PreparedPayload {
  const issues: Issue[] = [];
  const ordered = [...source.takes].sort((a, b) =>
    compareShotPosition(positionOf(a), positionOf(b)),
  );
  const usable = source.postType === "CAROUSEL" ? ordered : ordered.slice(0, 1);
  for (const take of usable) {
    if (take.status !== "READY" || !take.url) {
      issues.push({
        path: "media",
        message: `Take ${take.shotId ?? take.id} isn't ready to publish (${take.status}).`,
      });
    }
  }
  if (usable.length === 0) {
    issues.push({ path: "media", message: "The post has no visuals to publish." });
  }
  const ready = usable.filter((take) => take.status === "READY" && take.url);
  const cover = ready[0];
  const coverUrl =
    isReel(source.postType) &&
    cover?.kind === "VIDEO" &&
    cover.posterUrl &&
    cover.posterUrl !== cover.url
      ? absolute(cover.posterUrl, source.publicBaseUrl)
      : undefined;
  const altText = source.copy?.altText.trim() ? source.copy.altText : null;
  const draft = {
    platform: source.platform,
    postType: source.postType,
    variantId: source.variantId,
    caption: source.caption,
    altText,
    hashtags: [...source.hashtags],
    media: ready.map((take) => mediaOf(take, source)),
    ...(coverUrl ? { coverUrl } : {}),
  };
  const rules = validatePublishPayload(draft);
  // With no ready take, the schema's own complaint about an empty media list adds nothing.
  issues.push(...(ready.length === 0 ? rules.filter((issue) => issue.path !== "media") : rules));
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, payload: PublishPayload.parse(draft) };
}

/** One line for people: the first few broken rules. */
export function describeIssues(issues: readonly Issue[]): string {
  const shown = issues.slice(0, 3).map((issue) => issue.message.replace(/[.\s]+$/u, ""));
  const more = issues.length > 3 ? ` (and ${issues.length - 3} more)` : "";
  return `${shown.join("; ")}${more}`;
}
