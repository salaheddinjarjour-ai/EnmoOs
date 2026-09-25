import type { Asset } from "@enmo/db";
import { PublishPayload, validatePublishPayload, type PublishMedia } from "@enmo/providers";
import {
  AssetParams,
  compareShotPosition,
  MASTER_ASPECT_RATIO,
  pixelSizeFor,
  variantTextOf,
  type CopywriterOutput,
  type Issue,
  type Platform,
  type PostType,
  type VariantText,
} from "@enmo/shared";
import { takeFrameOf, type Rendition } from "./renditions";

/*
 * What a variant publishes (DESIGN §F): its caption and hashtags, the copy's alt text, and the
 * post's current takes as absolute public URLs the platform fetches: a carousel its slides in
 * order, anything else its first take (a reel's first scene, as the NoopAssembler would cut it).
 * Until the Adapter (Phase 5) cuts native frames, a take goes out as its 9:16 master, or as a
 * rendition of it where the platform won't fetch the master (Instagram images: renditions.ts).
 */

/**
 * A variant's text: the copy's caption for that platform (the main caption without one). The
 * Copywriter's publish_limits rule checks this same text, so approved copy fits every platform.
 */
export function variantCopyOf(copy: CopywriterOutput, platform: Platform): VariantText {
  return variantTextOf(copy, platform);
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
  | "storageKey"
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
  /** The public URL of a storage key (deps.storage.publicUrl), where renditions are served. */
  storageUrl: (key: string) => string;
}

export type PreparedPayload =
  | {
      ok: true;
      payload: PublishPayload;
      /** Files the payload names that ensureRenditions writes before the platform fetches them. */
      renditions: Rendition[];
    }
  | { ok: false; issues: Issue[] };

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

type MediaOf = { media: PublishMedia; rendition: Rendition | null } | { issue: Issue };

function mediaOf(take: PayloadTake, source: PayloadSource): MediaOf {
  const fallback = pixelSizeFor(MASTER_ASPECT_RATIO);
  const width = take.width ?? fallback.width;
  const height = take.height ?? fallback.height;
  const frame = takeFrameOf(source.platform, source.postType, {
    kind: take.kind,
    storageKey: take.storageKey,
    mimeType: take.mimeType,
    width,
    height,
  });
  if (frame.kind === "unavailable") {
    return {
      issue: {
        path: "media",
        message: `Take ${take.shotId ?? take.id} can't go out: ${frame.reason}.`,
      },
    };
  }
  if (frame.kind === "rendition") {
    const { rendition } = frame;
    return {
      media: {
        kind: take.kind,
        url: source.storageUrl(rendition.key),
        width: rendition.width,
        height: rendition.height,
        mimeType: rendition.mimeType,
      },
      rendition,
    };
  }
  // A reel publishes at its script's length; any other video is the clip itself.
  const durationSec =
    take.kind !== "VIDEO"
      ? undefined
      : isReel(source.postType)
        ? (source.copy?.script?.totalDurationSec ?? undefined)
        : (take.durationSec ?? undefined);
  return {
    media: {
      kind: take.kind,
      url: absolute(take.url ?? "", source.publicBaseUrl),
      width,
      height,
      ...(durationSec ? { durationSec } : {}),
      ...(take.mimeType ? { mimeType: take.mimeType } : {}),
    },
    rendition: null,
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
  const media: PublishMedia[] = [];
  const renditions: Rendition[] = [];
  for (const take of ready) {
    const item = mediaOf(take, source);
    if ("issue" in item) {
      issues.push(item.issue);
      continue;
    }
    media.push(item.media);
    if (item.rendition) renditions.push(item.rendition);
  }
  const draft = {
    platform: source.platform,
    postType: source.postType,
    variantId: source.variantId,
    caption: source.caption,
    altText,
    hashtags: [...source.hashtags],
    media,
    ...(coverUrl ? { coverUrl } : {}),
  };
  const rules = validatePublishPayload(draft);
  // With no usable take, the schema's own complaint about an empty media list adds nothing.
  issues.push(...(media.length === 0 ? rules.filter((issue) => issue.path !== "media") : rules));
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, payload: PublishPayload.parse(draft), renditions };
}

/** One line for people: the first few broken rules. */
export function describeIssues(issues: readonly Issue[]): string {
  const shown = issues.slice(0, 3).map((issue) => issue.message.replace(/[.\s]+$/u, ""));
  const more = issues.length > 3 ? ` (and ${issues.length - 3} more)` : "";
  return `${shown.join("; ")}${more}`;
}
