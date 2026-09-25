import type { Client, Post, PostStatus, PostVariant, PublishJob, PublishStatus } from "@enmo/db";
import {
  defaultApprovalChain,
  platformVariantFormat,
  type Platform,
  type PostType,
  type SlotSource,
} from "@enmo/shared";
import { testDb } from "./db";
import { seedCampaign, testBrief, testCopy } from "./route-fixtures";

/*
 * Phase 4 rows for the calendar and publish-job route tests, written straight through Prisma: an
 * approved post of a client, one variant per platform and the publish jobs the Publisher would
 * have scheduled, without running the worker.
 */

/** Tuesday 2 March 2027 in Riyadh (UTC+3 all year) is the fixtures' planned day. */
export const RIYADH = "Asia/Riyadh";

export interface SeedJobInput {
  platform: Platform;
  status?: PublishStatus;
  scheduledFor: Date | string;
  attempts?: number;
  lastError?: string | null;
  dryRun?: boolean;
  socialAccountId?: string | null;
  slotSource?: SlotSource;
  publishedAt?: Date | null;
  liveUrl?: string | null;
}

export interface SeedPublishedPostInput {
  createdBy: { id: string };
  client: Client;
  /** The campaign the post joins; a new PRODUCING one when left out. */
  campaignId?: string;
  ref?: string;
  type?: PostType;
  platforms?: readonly Platform[];
  status?: PostStatus;
  /** YYYY-MM-DD, or null for none. */
  targetDate?: string | null;
  hook?: string | null;
  angle?: string | null;
  jobs?: readonly SeedJobInput[];
  needsAttention?: boolean;
}

export interface SeededPublishPost {
  post: Post;
  campaignId: string;
  variants: Record<string, PostVariant>;
  /** By platform. */
  jobs: Record<string, PublishJob>;
}

/**
 * A post whose round 1 is APPROVED, a variant for each platform that takes its type, and a
 * PublishJob per `jobs` entry (SCHEDULED dry runs unless told otherwise).
 */
export async function seedPublishPost(input: SeedPublishedPostInput): Promise<SeededPublishPost> {
  const db = testDb();
  const campaignId =
    input.campaignId ??
    (
      await seedCampaign({
        createdBy: input.createdBy,
        client: input.client,
        brief: testBrief(input.client),
        status: "PRODUCING",
      })
    ).campaign.id;
  const type = input.type ?? "STATIC";
  const platforms = [...(input.platforms ?? ["INSTAGRAM", "FACEBOOK"])];
  const post = await db.post.create({
    data: {
      campaignId,
      clientId: input.client.id,
      ref: input.ref ?? "p1",
      type,
      platforms,
      status: input.status ?? "SCHEDULED",
      targetDate:
        input.targetDate === null
          ? null
          : new Date(`${input.targetDate ?? "2027-03-02"}T00:00:00Z`),
      hook: input.hook === undefined ? "Iced, after iftar" : input.hook,
      angle: input.angle === undefined ? "Golden hour" : input.angle,
      copy: testCopy(),
      approvedAt: new Date(),
      needsAttention: input.needsAttention ?? false,
      attentionReason: input.needsAttention ? "Publishing failed" : null,
    },
  });
  await db.approvalRequest.create({
    data: {
      postId: post.id,
      round: 1,
      status: "APPROVED",
      chain: defaultApprovalChain(),
      currentStep: 0,
      contentHash: `fixture-${post.id}`,
      resolvedAt: new Date(),
    },
  });

  const variants: Record<string, PostVariant> = {};
  for (const platform of platforms) {
    const format = platformVariantFormat(type, platform);
    if (!format) continue;
    variants[platform] = await db.postVariant.create({
      data: { postId: post.id, platform, format, caption: "Cold brew", hashtags: ["#Iced"] },
    });
  }

  const jobs: Record<string, PublishJob> = {};
  for (const job of input.jobs ?? []) {
    const variant = variants[job.platform];
    if (!variant) throw new Error(`seedPublishPost: no ${job.platform} variant for a ${type}`);
    jobs[job.platform] = await db.publishJob.create({
      data: {
        variantId: variant.id,
        platform: job.platform,
        status: job.status ?? "SCHEDULED",
        scheduledFor: new Date(job.scheduledFor),
        slotSource: job.slotSource ?? "publisher",
        slotReason: "Seeded by the test",
        dryRun: job.dryRun ?? true,
        attempts: job.attempts ?? 0,
        lastError: job.lastError ?? null,
        socialAccountId: job.socialAccountId ?? null,
        publishedAt: job.publishedAt ?? null,
        liveUrl: job.liveUrl ?? null,
      },
    });
  }
  return { post, campaignId, variants, jobs };
}
