import { createHash } from "node:crypto";
import type { ApprovalRequest, DbClient, DbTransaction } from "@enmo/db";
import { ApprovalChain, type ApprovalStatus } from "@enmo/shared";
import { parseStored } from "../lib/stored";
import type { EventBatch } from "./events";
import { lockPostRounds } from "./locks";

/*
 * Approval rounds (DESIGN §B "ApprovalRequest", §D). A round snapshots the client's chain and
 * hashes exactly what the reviewers are approving, so the publish guard (Phase 4) can refuse
 * content that changed after approval.
 */

type Db = DbClient | DbTransaction;

/** JSON with object keys sorted at every level, so equal content always hashes the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return Object.fromEntries(
        Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
      );
    }
    return inner;
  });
}

export interface ApprovedContent {
  copy: unknown;
  variants: readonly { platform: string; caption: string; hashtags: readonly string[] }[];
  assetIds: readonly string[];
}

/** sha256 of the copy, the variant captions and the current asset ids (order-independent). */
export function contentHash(content: ApprovedContent): string {
  const normalized = {
    copy: content.copy ?? null,
    variants: [...content.variants]
      .map(({ platform, caption, hashtags }) => ({ platform, caption, hashtags: [...hashtags] }))
      .sort((a, b) => (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0)),
    assetIds: [...content.assetIds].sort(),
  };
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

/** What the post looks like right now, as a round would approve it. */
export async function currentContentHash(db: Db, postId: string): Promise<string> {
  const post = await db.post.findUniqueOrThrow({
    where: { id: postId },
    select: {
      copy: true,
      variants: { select: { platform: true, caption: true, hashtags: true } },
      assets: { where: { isCurrent: true }, select: { id: true } },
    },
  });
  return contentHash({
    copy: post.copy,
    variants: post.variants,
    assetIds: post.assets.map((asset) => asset.id),
  });
}

/** Opens round N+1 for the post with a snapshot of the client's current chain. */
export async function openApprovalRound(
  db: Db,
  post: { id: string; clientId: string },
): Promise<ApprovalRequest> {
  // Sequential: `db` is usually a transaction, which runs one query at a time.
  const client = await db.client.findUniqueOrThrow({
    where: { id: post.clientId },
    select: { approvalChain: true },
  });
  const latest = await db.approvalRequest.findFirst({
    where: { postId: post.id },
    orderBy: { round: "desc" },
    select: { round: true },
  });
  const hash = await currentContentHash(db, post.id);
  const chain = parseStored(
    ApprovalChain,
    client.approvalChain,
    `Client ${post.clientId}.approvalChain`,
  );
  return db.approvalRequest.create({
    data: {
      postId: post.id,
      round: (latest?.round ?? 0) + 1,
      status: "PENDING",
      chain,
      currentStep: 0,
      contentHash: hash,
    },
  });
}

/** Rounds a new edit supersedes: the open one, or an approval not yet published. */
const REOPENABLE: readonly ApprovalStatus[] = ["PENDING", "APPROVED"];

/**
 * Locks the rounds cancelOpenRounds would cancel, for a caller that must check the post (locked
 * after its rounds, locks.ts) before deciding to cancel them.
 */
export function lockReopenableRounds(tx: DbTransaction, postId: string): Promise<void> {
  return lockPostRounds(tx, postId, REOPENABLE);
}

/**
 * Cancels the post's open or approved rounds; returns the cancelled rows. Call it before writing
 * the Post row in the same transaction: rounds are locked before their post (locks.ts).
 */
export async function cancelOpenRounds(
  tx: DbTransaction,
  postId: string,
  resolvedAt: Date,
): Promise<ApprovalRequest[]> {
  await lockPostRounds(tx, postId, REOPENABLE);
  return tx.approvalRequest.updateManyAndReturn({
    where: { postId, status: { in: [...REOPENABLE] } },
    data: { status: "CANCELLED", resolvedAt },
  });
}

interface RoundEventContext {
  campaignId: string;
  clientId: string;
}

export function approvalCreated(
  events: EventBatch,
  request: Pick<ApprovalRequest, "id" | "postId" | "round">,
  context: RoundEventContext,
): EventBatch {
  return events.global("approval.created", {
    requestId: request.id,
    postId: request.postId,
    round: request.round,
    ...context,
  });
}

export function approvalResolved(
  events: EventBatch,
  request: Pick<ApprovalRequest, "id" | "postId" | "round" | "status">,
  context: RoundEventContext,
): EventBatch {
  return events.global("approval.resolved", {
    requestId: request.id,
    postId: request.postId,
    round: request.round,
    status: request.status,
    ...context,
  });
}
