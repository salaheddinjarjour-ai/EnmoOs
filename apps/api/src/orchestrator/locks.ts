import type { DbTransaction } from "@enmo/db";

/*
 * Row locks for transactions that must not interleave. Prisma has no SELECT … FOR UPDATE, so these
 * go through raw SQL; the lock is held until the surrounding transaction ends. FOR NO KEY UPDATE
 * serialises the lockers without blocking inserts of child rows (their foreign-key checks take
 * KEY SHARE locks, which it doesn't conflict with).
 */

/** Serialises plan creation and plan approval for one campaign. */
export async function lockCampaign(tx: DbTransaction, campaignId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${campaignId} FOR NO KEY UPDATE`;
}

/**
 * Keeps the campaign's status (an archive) from changing until the transaction ends, without
 * serialising readers against each other.
 */
export async function shareLockCampaign(tx: DbTransaction, campaignId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${campaignId} FOR SHARE`;
}

/*
 * Lock order: the Campaign row, then ApprovalRequest rows, then their Post row. An archive updates
 * the campaign before it cancels rounds; decisions lock the round and then move the post; anything
 * else that writes more than one of them (a copy edit cancelling a round) must follow the same
 * order, or two such transactions can each hold one lock and wait for the other (a 40P01 deadlock).
 */

/** Serialises decisions on one approval round. */
export async function lockApprovalRequests(
  tx: DbTransaction,
  requestIds: readonly string[],
): Promise<void> {
  if (requestIds.length === 0) return;
  // A stable order, so two batches locking overlapping sets can't deadlock.
  const ids = [...requestIds].sort();
  await tx.$queryRaw`SELECT id FROM "ApprovalRequest" WHERE id = ANY(${ids}) ORDER BY id FOR NO KEY UPDATE`;
}

/** Locks a post's rounds in `statuses` (in id order, like lockApprovalRequests). */
export async function lockPostRounds(
  tx: DbTransaction,
  postId: string,
  statuses: readonly string[],
): Promise<void> {
  const wanted = [...statuses];
  await tx.$queryRaw`SELECT id FROM "ApprovalRequest" WHERE "postId" = ${postId} AND status::text = ANY(${wanted}) ORDER BY id FOR NO KEY UPDATE`;
}

/** Locks the rounds in `statuses` of every post of a campaign (in id order). */
export async function lockCampaignRounds(
  tx: DbTransaction,
  campaignId: string,
  statuses: readonly string[],
): Promise<void> {
  const wanted = [...statuses];
  await tx.$queryRaw`SELECT r.id FROM "ApprovalRequest" r JOIN "Post" p ON p.id = r."postId" WHERE p."campaignId" = ${campaignId} AND r.status::text = ANY(${wanted}) ORDER BY r.id FOR NO KEY UPDATE OF r`;
}

/**
 * Holds the post still: every status change, copy store and QA hand-off updates this row, so they
 * wait until the transaction ends (inserting its child rows doesn't).
 */
export async function lockPost(tx: DbTransaction, postId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Post" WHERE id = ${postId} FOR NO KEY UPDATE`;
}
