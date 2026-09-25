import { z } from "zod";
import type { Platform } from "@enmo/shared";
import { metaConfigured, metaUrl, type MetaConfig } from "../meta/config";
import { PublishError } from "./errors";
import { publishFlowOf } from "./flow";
import { GraphClient, META_DEFAULT_TIMEOUT_MS, type GraphRequest } from "./graph-client";
import { graphPath, type GraphGet, type MetaFlowContext } from "./meta-context";
import { toPublishError } from "./meta-errors";
import { runFacebook } from "./meta-facebook";
import { instagramQuota, runInstagram } from "./meta-instagram";
import {
  formatProgress,
  isMetaFlow,
  parseProgress,
  type MetaFlow,
  type MetaProgress,
} from "./meta-progress";
import { isLoopbackUrl } from "./public-url";
import type {
  DecryptedAccount,
  PublishOutcome,
  PublishPayload,
  PublishQuota,
  PublishResume,
  Publisher,
} from "./types";
import { assertPublishable } from "./validate";

/*
 * MetaPublisher (DESIGN §F "Meta"): Instagram and Facebook over the Graph API through the injected
 * fetch and MetaConfig's base URLs (meta-instagram.ts and meta-facebook.ts hold the flows).
 *   Instagram: check content_publishing_limit, create the container (image, REELS, STORIES, or up
 *   to 10 is_carousel_item children plus the CAROUSEL parent), hand its id to resume.onContainer
 *   at once, poll status_code until FINISHED, POST media_publish, read the permalink.
 *   Facebook: /{page}/photos; video_reels start → rupload with a file_url header → finish with
 *   PUBLISHED; unpublished photos attached to one /{page}/feed post; photo_stories/video_stories.
 * A resumed job (resume.containerId, see meta-progress.ts) continues where it stopped instead of
 * creating anything again. Every failure is a PublishError (meta-errors.ts).
 */

export const META_PLATFORMS = ["INSTAGRAM", "FACEBOOK"] as const satisfies readonly Platform[];
export type MetaPlatform = (typeof META_PLATFORMS)[number];

export function isMetaPlatform(platform: Platform): platform is MetaPlatform {
  return (META_PLATFORMS as readonly Platform[]).includes(platform);
}

export interface MetaPublisherOptions extends MetaConfig {
  platform: MetaPlatform;
  fetch: typeof globalThis.fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
}

/** Where a post goes: the Instagram user or Facebook Page, and the token that publishes there. */
interface Target {
  nodeId: string;
  handle: string;
  token: string;
}

const RuploadAck = z.looseObject({ success: z.boolean().optional() });

const PLATFORM_NAME: Readonly<Record<MetaPlatform, string>> = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
};

/** How many ids each flow records per media file, at most (a resumed job can't have more). */
function maxItems(flow: MetaFlow, payload: PublishPayload): number {
  switch (flow) {
    case "IG_CAROUSEL":
    case "FB_MULTI_PHOTO":
      return payload.media.length;
    case "FB_PHOTO":
      return 0;
    case "IG_IMAGE":
    case "IG_REEL":
    case "IG_STORY":
    case "FB_PHOTO_STORY":
    case "FB_REEL":
    case "FB_VIDEO_STORY":
      return 1;
  }
}

function resumeRefused(containerId: string, why: string): PublishError {
  return new PublishError(
    "REJECTED",
    `Cannot resume container "${containerId}": ${why}. Cancel the job and approve the post again to start over.`,
  );
}

export class MetaPublisher implements Publisher {
  readonly mode = "live" as const;
  readonly platform: MetaPlatform;
  readonly options: MetaPublisherOptions;
  /**
   * Instagram reports a publishing quota (content_publishing_limit); Facebook doesn't, so a
   * Facebook publisher has no checkLimit at all (declared, so it isn't even an undefined field).
   */
  declare readonly checkLimit?: (account: DecryptedAccount) => Promise<PublishQuota>;
  readonly #graph: GraphClient;

  constructor(options: MetaPublisherOptions) {
    this.platform = options.platform;
    this.options = options;
    this.#graph = new GraphClient({
      fetch: options.fetch,
      appSecret: options.appSecret,
      timeoutMs: options.timeoutMs ?? META_DEFAULT_TIMEOUT_MS,
    });
    if (options.platform === "INSTAGRAM") {
      this.checkLimit = (account) => this.#instagramLimit(account);
    }
  }

  publish(
    payload: PublishPayload,
    account: DecryptedAccount | null,
    resume: PublishResume,
  ): Promise<PublishOutcome> {
    return this.#run(payload, account, resume.containerId, resume);
  }

  poll(
    containerId: string,
    account: DecryptedAccount | null,
    payload: PublishPayload,
  ): Promise<PublishOutcome> {
    return this.#run(payload, account, containerId, null);
  }

  /** `resume` is null when polling: nothing new is persisted then, and dead containers stay dead. */
  async #run(
    payload: PublishPayload,
    account: DecryptedAccount | null,
    containerId: string | null,
    resume: PublishResume | null,
  ): Promise<PublishOutcome> {
    const valid = this.#validate(payload);
    const flow = publishFlowOf(valid);
    if (!isMetaFlow(flow)) throw new Error(`${flow} is not a Meta flow`);
    const target = this.#target(account);
    const progress = containerId === null ? null : this.#progress(containerId, flow, valid);
    const ctx = this.#context(valid, flow, target, {
      restartDead: resume !== null,
      save: async (next) => {
        await resume?.onContainer?.(formatProgress(next));
      },
    });
    return this.platform === "INSTAGRAM" ? runInstagram(ctx, progress) : runFacebook(ctx, progress);
  }

  /**
   * The payload checks every publisher runs, before any HTTP. Graph pulls the media itself, so it
   * must be public https, unless Graph is on this machine (a contract fake) and can reach it.
   */
  #validate(payload: PublishPayload): PublishPayload {
    const valid = assertPublishable(payload, {
      requirePublicUrls: !isLoopbackUrl(this.options.graphBaseUrl),
    });
    if (valid.platform !== this.platform) {
      throw new PublishError(
        "INVALID_PAYLOAD",
        `A ${valid.platform} payload reached the ${this.platform} publisher`,
        { issues: [{ path: "platform", message: `Expected ${this.platform}` }] },
      );
    }
    return valid;
  }

  #target(account: DecryptedAccount | null): Target {
    const name = PLATFORM_NAME[this.platform];
    if (!metaConfigured(this.options)) {
      throw new PublishError(
        "NOT_CONFIGURED",
        "Live Meta publishing needs META_APP_ID and META_APP_SECRET",
      );
    }
    if (!account) {
      throw new PublishError(
        "NOT_CONFIGURED",
        `Publishing to ${name} needs a connected ${name} account`,
      );
    }
    if (account.platform !== this.platform) {
      throw new PublishError(
        "NOT_CONFIGURED",
        `The ${name} publisher was handed a ${account.platform} account`,
      );
    }
    if (!account.accessToken) {
      throw new PublishError("AUTH", `The ${name} account ${account.handle} has no access token`);
    }
    const nodeId =
      (this.platform === "INSTAGRAM" ? account.meta.igUserId : account.meta.pageId) ??
      account.externalId;
    const handle =
      (this.platform === "INSTAGRAM" ? account.meta.username : undefined) ?? account.handle;
    return { nodeId, handle: handle.replace(/^@/, ""), token: account.accessToken };
  }

  #progress(containerId: string, flow: MetaFlow, payload: PublishPayload): MetaProgress {
    const progress = parseProgress(containerId);
    if (!progress) throw resumeRefused(containerId, "it isn't a Meta publish in progress");
    if (progress.flow !== flow) {
      throw resumeRefused(containerId, `it was started as ${progress.flow}, not ${flow}`);
    }
    if (progress.items.length > maxItems(flow, payload)) {
      throw resumeRefused(containerId, "it holds more media than the post has");
    }
    return progress;
  }

  async #call<T extends z.ZodType>(request: GraphRequest, schema: T): Promise<z.output<T>> {
    try {
      return await this.#graph.call(request, schema);
    } catch (error) {
      throw toPublishError(error);
    }
  }

  #getter(token: string): GraphGet {
    const { graphBaseUrl, graphVersion } = this.options;
    return (path, query, schema) =>
      this.#call(
        { method: "GET", url: metaUrl(graphBaseUrl, graphVersion, path, query), token },
        schema,
      );
  }

  #context(
    payload: PublishPayload,
    flow: MetaFlow,
    target: Target,
    extra: Pick<MetaFlowContext, "restartDead" | "save">,
  ): MetaFlowContext {
    const { graphBaseUrl, graphVersion, ruploadBaseUrl } = this.options;
    const { token } = target;
    return {
      payload,
      flow,
      nodeId: target.nodeId,
      handle: target.handle,
      ...extra,
      get: this.#getter(token),
      post: (path, body, schema) =>
        this.#call(
          { method: "POST", url: metaUrl(graphBaseUrl, graphVersion, path), token, json: body },
          schema,
        ),
      upload: async (videoId, fileUrl) => {
        // rupload's path puts the version after the endpoint, unlike Graph's.
        const base = ruploadBaseUrl.replace(/\/+$/, "");
        const url = `${base}/${graphPath("video-upload", graphVersion, videoId)}`;
        let ack: z.output<typeof RuploadAck>;
        try {
          ack = await this.#graph.call(
            { method: "POST", url, token, proof: false, headers: { file_url: fileUrl } },
            RuploadAck,
          );
        } catch (error) {
          const mapped = toPublishError(error);
          // rupload has no error codes; a refusal that isn't retriable is about the file itself.
          if (mapped.code !== "REJECTED") throw mapped;
          throw new PublishError("MEDIA_FAILED", mapped.message, {
            status: mapped.status,
            cause: error,
          });
        }
        if (ack.success === false) {
          throw new PublishError("MEDIA_FAILED", `Facebook could not fetch ${fileUrl}`);
        }
      },
    };
  }

  async #instagramLimit(account: DecryptedAccount): Promise<PublishQuota> {
    const target = this.#target(account);
    const quota = await instagramQuota(this.#getter(target.token), target.nodeId);
    if (!quota) {
      throw new PublishError("REJECTED", "Instagram reported no publishing limit for the account");
    }
    return quota;
  }
}
