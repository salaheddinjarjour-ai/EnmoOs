import {
  COPY_EDITABLE_STATUSES,
  postPlacement,
  type AlertPayload,
  type BudgetDto,
  type ChatMessageDto,
  type PostDto,
  type PostUpdatedPayload,
  type RealtimeEvent,
} from "@enmo/shared";
import type { QueryKey } from "@tanstack/react-query";
import { queryKeys } from "../hooks/query-keys";

/*
 * What each realtime event (DESIGN §D) does to the TanStack Query cache, as plain data so it can be
 * tested without a browser. lib/realtime.tsx applies the effects: patches land immediately, and
 * invalidations are batched so a burst of task transitions refetches each query once.
 */

export type CacheEffect =
  | { kind: "invalidate"; queryKey: QueryKey }
  | { kind: "upsertMessage"; threadId: string; message: ChatMessageDto }
  | { kind: "patchPost"; post: PostUpdatedPayload }
  | { kind: "setBudget"; budget: BudgetDto }
  | { kind: "alert"; alert: AlertPayload }
  | { kind: "resync" };

const invalidate = (queryKey: QueryKey): CacheEffect => ({ kind: "invalidate", queryKey });

/** Message kinds that move the campaign along (status, clarify count, latest plan). */
function messageEffects(message: ChatMessageDto): CacheEffect[] {
  switch (message.kind) {
    case "PROGRESS":
      // Upserted on every task transition: the payload carries the counts the feed draws.
      return [];
    case "TEXT":
    case "CLARIFY":
    case "BRIEF":
      return [invalidate(queryKeys.campaigns.all)];
    case "PLAN":
      // A new version supersedes the previous one's card.
      return [invalidate(queryKeys.campaigns.all), invalidate(queryKeys.taskGraphs.all)];
    case "POST_CARD":
      return [
        invalidate(queryKeys.campaigns.all),
        invalidate(queryKeys.posts.all),
        invalidate(queryKeys.approvals.all),
      ];
    case "ESCALATION":
      return [invalidate(queryKeys.campaigns.all), invalidate(queryKeys.posts.all)];
  }
}

export function effectsOf(event: RealtimeEvent): CacheEffect[] {
  switch (event.type) {
    case "message.created":
    case "message.updated":
      return [
        { kind: "upsertMessage", threadId: event.payload.threadId, message: event.payload.message },
        ...messageEffects(event.payload.message),
      ];
    case "agent.status":
      return [invalidate(queryKeys.campaigns.tasks(event.payload.campaignId))];
    case "plan.proposed":
      return [
        invalidate(queryKeys.campaigns.detail(event.payload.campaignId)),
        invalidate(queryKeys.campaigns.lists()),
        invalidate(queryKeys.taskGraphs.all),
      ];
    case "post.updated":
      return [{ kind: "patchPost", post: event.payload }, invalidate(queryKeys.posts.all)];
    case "asset.updated":
      // Cards read PostDto.currentAssets; the Vault lists and lineages read the assets.
      return [invalidate(queryKeys.posts.all), invalidate(queryKeys.assets.all)];
    case "publish.updated":
      return [invalidate(queryKeys.posts.all)];
    case "approval.created":
    case "approval.resolved":
      return [invalidate(queryKeys.approvals.all), invalidate(queryKeys.posts.all)];
    case "alert":
      return [
        { kind: "alert", alert: event.payload },
        event.payload.kind === "budget"
          ? invalidate(queryKeys.budget)
          : invalidate(queryKeys.posts.all),
        invalidate(queryKeys.campaigns.all),
      ];
    case "learning.created":
      // The learnings feed arrives with the Phase 6 Command Center; nothing caches them yet.
      return [];
    case "budget.updated":
      return [{ kind: "setBudget", budget: event.payload }];
    case "resync":
      return [{ kind: "resync" }];
  }
}

/* ── Cache patches, shared by live events and mutations ─────────────────────────────────────── */

/** Server order: createdAt, then id (both ascending). */
function compareMessages(a: ChatMessageDto, b: ChatMessageDto): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Inserts or replaces `message` by id, keeping the thread in server order. */
export function upsertMessage(
  messages: readonly ChatMessageDto[],
  message: ChatMessageDto,
): ChatMessageDto[] {
  const index = messages.findIndex((existing) => existing.id === message.id);
  if (index >= 0) {
    // An older copy (a replayed or reordered event) never overwrites a newer one.
    if (messages[index]!.updatedAt > message.updatedAt) return [...messages];
    const next = [...messages];
    next[index] = message;
    return next;
  }
  return [...messages, message].sort(compareMessages);
}

/** Applies a post.updated payload to a cached PostDto (the refetch then fills in the rest). */
export function patchPost(post: PostDto, update: PostUpdatedPayload): PostDto {
  if (post.id !== update.postId) return post;
  const failed = update.status === "FAILED";
  return {
    ...post,
    status: update.status,
    column: update.column,
    pill: update.pill,
    needsAttention: update.needsAttention,
    failed,
    approved: failed ? post.approved : postPlacement(update.status).approved,
    // Only the refetch can say a post became editable (it knows the tasks); leaving it can't wait.
    editable: post.editable && COPY_EDITABLE_STATUSES.includes(update.status),
  };
}

/** A stable identity for a query key, so a batch invalidates each key once. */
export function queryKeyId(queryKey: QueryKey): string {
  return JSON.stringify(queryKey);
}
