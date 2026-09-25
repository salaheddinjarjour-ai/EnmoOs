import { z } from "zod";
import {
  AssetKind,
  PostType,
  type Platform,
  type PublishMode,
  type SocialAccountMeta,
} from "@enmo/shared";

/*
 * The publisher abstraction (DESIGN §F "Meta", "Dry-run"). The publish service builds one
 * PublishPayload per PostVariant, decrypts the variant's SocialAccount into a DecryptedAccount
 * (never stored, never logged) and hands both to the platform's Publisher. Platforms that process
 * media asynchronously (Instagram containers, Facebook reels) answer `processing` with a container
 * id; the ops queue then calls poll() until the post is live. Every live publisher goes through an
 * injected fetch against an overridable base URL, so tests aim it at a fake server.
 */

/** One media file, fetched by the platform from its public URL (Meta and TikTok pull by URL). */
export const PublishMedia = z.object({
  kind: AssetKind,
  url: z.string().regex(/^https?:\/\//, "Expected an absolute http(s) URL"),
  width: z.int().positive(),
  height: z.int().positive(),
  /** A video's length as it will be published, in seconds; unknown when left out. */
  durationSec: z.number().positive().optional(),
  mimeType: z.string().optional(),
});
export type PublishMedia = z.infer<typeof PublishMedia>;

const payloadFields = {
  /** The PostVariant being published; dry-run live URLs are built from it. */
  variantId: z.string().min(1),
  /** The variant's caption without its hashtags (publishedCaption() joins them). */
  caption: z.string(),
  altText: z.string().nullable(),
  hashtags: z.array(z.string()),
  /**
   * In reading order: the single image or video, or the carousel's items. Until the Adapter
   * (Phase 5) cuts native frames, these are the post's current 9:16 master takes.
   */
  media: z.array(PublishMedia).min(1),
  /** A video's cover image (reels); left out to let the platform pick a frame. */
  coverUrl: z
    .string()
    .regex(/^https?:\/\//, "Expected an absolute http(s) URL")
    .optional(),
};

/**
 * What one variant publishes, discriminated by platform; each platform takes the post types its
 * native format table allows (TikTok has no stories). validatePublishPayload checks the rest.
 */
export const PublishPayload = z.discriminatedUnion("platform", [
  z.object({ platform: z.literal("INSTAGRAM"), postType: PostType, ...payloadFields }),
  z.object({ platform: z.literal("FACEBOOK"), postType: PostType, ...payloadFields }),
  z.object({
    platform: z.literal("TIKTOK"),
    postType: PostType.exclude(["STORY"]),
    ...payloadFields,
  }),
]);
export type PublishPayload = z.infer<typeof PublishPayload>;

/** A SocialAccount with its access token decrypted, for the length of one publish call. */
export interface DecryptedAccount {
  /** SocialAccount.id */
  id: string;
  platform: Platform;
  /** Facebook Page id, Instagram user id, or TikTok open_id. */
  externalId: string;
  handle: string;
  accessToken: string;
  /** For an Instagram account: the Page it publishes through (meta.pageId). */
  meta: SocialAccountMeta;
}

export interface PublishResume {
  /** PublishJob.containerId from an earlier attempt: resume that container, never create another. */
  containerId: string | null;
  /**
   * Called as soon as the platform assigns a container, before waiting on it, so the caller can
   * persist PublishJob.containerId and a crash or retry resumes the same container.
   */
  onContainer?(containerId: string): Promise<void>;
}

export type PublishOutcome =
  | {
      status: "published";
      /** The platform's id of the live media (PublishJob.externalId). */
      externalId: string;
      /** The live post (Instagram permalink, Facebook post URL, dry-run URL). */
      liveUrl: string;
    }
  | {
      /** The platform is still processing the media; call poll() with this id later. */
      status: "processing";
      containerId: string;
    };

/** An account's publishing quota (Instagram's content_publishing_limit). */
export interface PublishQuota {
  used: number;
  limit: number;
  windowHours: number;
}

export interface Publisher {
  readonly platform: Platform;
  /** "dry-run" publishers validate and simulate; "live" ones call the platform. */
  readonly mode: PublishMode;
  /**
   * Publishes the payload, or resumes `resume.containerId`. `account` is null only for dry-run.
   * Throws PublishError (./errors.ts).
   */
  publish(
    payload: PublishPayload,
    account: DecryptedAccount | null,
    resume: PublishResume,
  ): Promise<PublishOutcome>;
  /** Checks a `processing` container again and publishes it once the platform is done with it. */
  poll(
    containerId: string,
    account: DecryptedAccount | null,
    payload: PublishPayload,
  ): Promise<PublishOutcome>;
  /** The account's remaining quota, where the platform reports one. */
  checkLimit?(account: DecryptedAccount): Promise<PublishQuota>;
}
