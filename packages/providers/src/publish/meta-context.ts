import type { z } from "zod";
import { formatProgress, type MetaFlow, type MetaProgress } from "./meta-progress";
import type { PublishMedia, PublishOutcome, PublishPayload } from "./types";

/*
 * What one publish (or poll) of one variant works with: the validated payload, the Instagram user
 * or Facebook Page it goes to, Graph calls already carrying the account's token and mapped to
 * PublishError, and `save`, which hands each new id to resume.onContainer before anything waits.
 */

export interface MetaFlowContext {
  readonly payload: PublishPayload;
  readonly flow: MetaFlow;
  /** The Instagram user id or Facebook Page id the post goes to. */
  readonly nodeId: string;
  /** The Instagram username or Facebook Page handle, for fallback live URLs. */
  readonly handle: string;
  /**
   * publish() resuming a job may replace a container Meta gave up on (ERROR, EXPIRED): that is
   * what a manual retry is for. poll() never does; it reports MEDIA_FAILED.
   */
  readonly restartDead: boolean;
  readonly get: GraphGet;
  readonly post: <T extends z.ZodType>(
    path: string,
    body: Readonly<Record<string, unknown>>,
    schema: T,
  ) => Promise<z.output<T>>;
  /** Facebook video: rupload pulls the file from `fileUrl`. */
  readonly upload: (videoId: string, fileUrl: string) => Promise<void>;
  /** Hands the progress to resume.onContainer; polling has nothing to hand it to. */
  readonly save: (progress: MetaProgress) => Promise<void>;
}

/** A Graph GET with the account's token, its body parsed with `schema`. */
export type GraphGet = <T extends z.ZodType>(
  path: string,
  query: Readonly<Record<string, string>>,
  schema: T,
) => Promise<z.output<T>>;

export function processing(progress: MetaProgress): PublishOutcome {
  return { status: "processing", containerId: formatProgress(progress) };
}

/** `a/b/c` from Graph ids and edges, each segment URL-encoded. */
export function graphPath(...segments: string[]): string {
  return segments.map(encodeURIComponent).join("/");
}

/** The single media file of a one-file post (validation guarantees it exists). */
export function onlyMedia(payload: PublishPayload): PublishMedia {
  const [media] = payload.media;
  if (!media) throw new Error("A validated payload always carries media");
  return media;
}

/** Only the keys whose value is set: Graph reads an empty string as a value. */
export function defined(
  entries: Readonly<Record<string, string | boolean | null | undefined>>,
): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== null && value !== undefined && value !== "") result[key] = value;
  }
  return result;
}
