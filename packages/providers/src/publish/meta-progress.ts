import type { PublishFlow } from "./flow";

/*
 * How far a Meta publish got, kept in PublishJob.containerId (DESIGN §F "persist containerId right
 * away, so a retry resumes the existing container instead of creating a new one"). Each id is
 * persisted through resume.onContainer the moment Meta hands it out, so a crash, retry or poll
 * picks up where the last call left off and never creates a container, photo or video twice.
 *
 * Written as `<flow>;items=<id>,<id>;parent=<id>;finished;result=<id>` (parts left out when
 * empty), e.g.
 *   IG_IMAGE;items=17890000000000001
 *   IG_CAROUSEL;items=17890000000000001,17890000000000002;parent=17890000000000003
 *   FB_REEL;items=1200000000001;finished
 *   FB_MULTI_PHOTO;items=301,302;result=100000000000001_400
 */

export const META_FLOWS = [
  "IG_IMAGE",
  "IG_REEL",
  "IG_STORY",
  "IG_CAROUSEL",
  "FB_PHOTO",
  "FB_REEL",
  "FB_PHOTO_STORY",
  "FB_VIDEO_STORY",
  "FB_MULTI_PHOTO",
] as const satisfies readonly PublishFlow[];
export type MetaFlow = (typeof META_FLOWS)[number];

export function isMetaFlow(flow: PublishFlow): flow is MetaFlow {
  return (META_FLOWS as readonly PublishFlow[]).includes(flow);
}

export interface MetaProgress {
  flow: MetaFlow;
  /**
   * What Meta holds for each media file, in payload order: the Instagram container (or carousel
   * children), Facebook's unpublished photos, or the Facebook video being uploaded.
   */
  items: string[];
  /** Instagram carousels: the CAROUSEL container built from the children. */
  parent: string | null;
  /** Facebook video flows: the upload was finished (the video is processing or live). */
  finished: boolean;
  /** The post the flow produced (Instagram media id, Facebook post id), once Meta created it. */
  result: string | null;
}

export function startProgress(flow: MetaFlow): MetaProgress {
  return { flow, items: [], parent: null, finished: false, result: null };
}

const ID = /^[A-Za-z0-9_.-]+$/;

export function formatProgress(progress: MetaProgress): string {
  const parts: string[] = [progress.flow];
  if (progress.items.length > 0) parts.push(`items=${progress.items.join(",")}`);
  if (progress.parent !== null) parts.push(`parent=${progress.parent}`);
  if (progress.finished) parts.push("finished");
  if (progress.result !== null) parts.push(`result=${progress.result}`);
  return parts.join(";");
}

/** The progress a containerId records, or null when it isn't one of ours. */
export function parseProgress(containerId: string): MetaProgress | null {
  const [flow, ...parts] = containerId.split(";");
  if (!flow || !(META_FLOWS as readonly string[]).includes(flow)) return null;
  const progress = startProgress(flow as MetaFlow);
  const seen = new Set<string>();
  for (const part of parts) {
    const [key, value, ...rest] = part.split("=");
    if (!key || seen.has(key) || rest.length > 0) return null;
    seen.add(key);
    if (key === "finished") {
      if (value !== undefined) return null;
      progress.finished = true;
      continue;
    }
    if (value === undefined) return null;
    if (key === "items") {
      const items = value.split(",");
      if (!items.every((id) => ID.test(id))) return null;
      progress.items = items;
    } else if ((key === "parent" || key === "result") && ID.test(value)) {
      progress[key] = value;
    } else {
      return null;
    }
  }
  return progress;
}
