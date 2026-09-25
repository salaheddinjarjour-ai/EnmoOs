import type { Asset, DbClient, DbTransaction, Prisma } from "@enmo/db";
import { DryRunPublisher, type Publisher } from "@enmo/providers";
import { CopywriterOutput, type AlertKind, type Platform } from "@enmo/shared";
import type { Deps } from "../deps";
import type { EventBatch } from "../orchestrator/events";
import { createAgentMessage, messageCreated } from "../orchestrator/messages";
import { preparePayload, type PreparedPayload } from "./payload";

/*
 * What every publish step reads about a job (its variant, post, client, campaign thread and the
 * post's current takes), which publisher it goes through, and how the Publisher tells people:
 * a signed note in the campaign thread plus, when someone has to act, an `alert`.
 */

type Db = DbClient | DbTransaction;

export const PUBLISH_JOB_CONTEXT = {
  variant: {
    include: {
      post: {
        include: {
          client: {
            select: { id: true, name: true, timezone: true, bannedWords: true, archivedAt: true },
          },
          campaign: {
            select: { id: true, name: true, status: true, thread: { select: { id: true } } },
          },
        },
      },
    },
  },
} as const satisfies Prisma.PublishJobInclude;

export type PublishJobWithContext = Prisma.PublishJobGetPayload<{
  include: typeof PUBLISH_JOB_CONTEXT;
}> & {
  /** The post's current takes (what it publishes). */
  takes: Asset[];
};

/** The post's current take of each shot. */
export function currentTakesOf(db: Db, postId: string): Promise<Asset[]> {
  return db.asset.findMany({ where: { postId, role: "SHOT", isCurrent: true } });
}

export async function loadPublishJob(db: Db, jobId: string): Promise<PublishJobWithContext | null> {
  const job = await db.publishJob.findUnique({
    where: { id: jobId },
    include: PUBLISH_JOB_CONTEXT,
  });
  return job && { ...job, takes: await currentTakesOf(db, job.variant.postId) };
}

/** The post's copy, or null when it has none (or it no longer parses). */
export function copyOf(post: { copy: unknown }): CopywriterOutput | null {
  const parsed = CopywriterOutput.safeParse(post.copy);
  return parsed.success ? parsed.data : null;
}

/** The job's payload from the variant and the post's current takes. */
export function payloadOf(
  deps: Pick<Deps, "config" | "storage">,
  job: PublishJobWithContext,
): PreparedPayload {
  const { variant } = job;
  return preparePayload({
    platform: variant.platform,
    postType: variant.post.type,
    variantId: variant.id,
    caption: variant.caption,
    hashtags: variant.hashtags,
    copy: copyOf(variant.post),
    takes: job.takes,
    publicBaseUrl: deps.config.PUBLIC_ASSET_BASE_URL,
    storageUrl: (key) => deps.storage.publicUrl(key),
  });
}

/** The client's newest ACTIVE account on the platform, which its jobs publish through. */
export function activeAccountOf(
  db: Db,
  clientId: string,
  platform: Platform,
): Promise<{ id: string } | null> {
  return db.socialAccount.findFirst({
    where: { clientId, platform, status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
}

/** Whether the platform's publisher calls the platform (PUBLISH_MODE live, with credentials). */
export function publishesLive(deps: Pick<Deps, "publishers">, platform: Platform): boolean {
  return deps.publishers[platform].mode === "live";
}

/**
 * The publisher for a job as its claim settled it (PublishJob.dryRun): a DryRunPublisher for a dry
 * run, the platform's live publisher for a live one, or null when that one isn't live any more
 * (PUBLISH_MODE switched to dry-run while the job was out): nothing simulated may stand in for a
 * publish that already reached the platform.
 */
export function publisherFor(
  deps: Pick<Deps, "publishers">,
  job: Pick<PublishJobWithContext, "dryRun" | "platform">,
): Publisher | null {
  if (job.dryRun) return new DryRunPublisher(job.platform);
  return publishesLive(deps, job.platform) ? deps.publishers[job.platform] : null;
}

/** "campaign" or "client" when the job's post belongs to archived work, which never goes out. */
export function archivedOf(job: PublishJobWithContext): "campaign" | "client" | null {
  const { post } = job.variant;
  if (post.campaign.status === "ARCHIVED") return "campaign";
  return post.client.archivedAt ? "client" : null;
}

/** A TEXT message the Publisher signs in the campaign thread. */
export async function publisherNote(
  tx: DbTransaction,
  events: EventBatch,
  threadId: string | null | undefined,
  content: string,
): Promise<void> {
  if (!threadId) return;
  const message = await createAgentMessage(tx, {
    threadId,
    kind: "TEXT",
    agent: "PUBLISHER",
    content,
    payload: null,
  });
  messageCreated(events, message);
}

type AlertPost = Pick<PublishJobWithContext["variant"]["post"], "clientId" | "campaignId">;

export function jobAlert(
  events: EventBatch,
  kind: Extract<AlertKind, "failed" | "stuck">,
  job: { id: string },
  post: AlertPost,
  message: string,
): void {
  events.alert({
    kind,
    entityType: "PublishJob",
    entityId: job.id,
    message,
    clientId: post.clientId,
    campaignId: post.campaignId,
  });
}

export function accountAlert(
  events: EventBatch,
  account: { id: string; clientId: string },
  message: string,
): void {
  events.alert({
    kind: "token_expiring",
    entityType: "SocialAccount",
    entityId: account.id,
    message,
    clientId: account.clientId,
    campaignId: null,
  });
}

/** "p3 on Instagram" */
export function variantLabel(ref: string, platformLabel: string): string {
  return `${ref} on ${platformLabel}`;
}
