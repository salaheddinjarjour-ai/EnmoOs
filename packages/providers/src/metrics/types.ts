import type { Platform, PostType } from "@enmo/shared";
import type { DecryptedAccount } from "../publish/types";

/*
 * Metrics pull-back (DESIGN §F "Metrics", Phase 6). tick.metrics finds published variants due a
 * checkpoint (24h, 72h and 168h after publishedAt; 20h for Instagram stories, which expire at 24h)
 * and asks the platform's MetricsProvider for their numbers, normalised so scoring never needs to
 * know where they came from. Dry-run posts are measured by SyntheticMetrics. Interfaces only: the
 * Meta, TikTok and synthetic providers arrive with Phase 6.
 */

/** PerformanceMetric.source */
export type MetricsSource = "meta" | "tiktok" | "synthetic";

/** What was published, from the variant's PublishJob. */
export interface MetricsTarget {
  variantId: string;
  platform: Platform;
  postType: PostType;
  /** The platform's media id (PublishJob.externalId). */
  externalId: string;
  liveUrl: string;
  publishedAt: Date;
  dryRun: boolean;
}

/** One capture; a count the platform doesn't report for this media is null. */
export interface NormalizedMetrics {
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  /** The account's followers at capture time: the last-resort denominator of the engagement rate. */
  followers: number | null;
  /** The platform's response as received (PerformanceMetric.raw). */
  raw: unknown;
}

export interface MetricsProvider {
  readonly source: MetricsSource;
  /**
   * The target's metrics at `ageHours` after publishing. `account` is null for dry-run targets.
   * Throws when the platform can't answer; the tick retries the checkpoint later.
   */
  fetch(
    target: MetricsTarget,
    account: DecryptedAccount | null,
    ageHours: number,
  ): Promise<NormalizedMetrics>;
}
