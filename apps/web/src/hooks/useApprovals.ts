import {
  ApprovalListResponse,
  ApprovalRequestDto,
  ApproveAllResponse,
  postPlacement,
  type ApprovalDecisionRequest,
  type ApprovalListQuery,
  type PostDto,
  type PostListResponse,
} from "@enmo/shared";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, apiPath } from "../lib/api";
import { queryKeys } from "./query-keys";
import { storePost } from "./usePosts";

/*
 * Approvals (DESIGN §E "approvals", "Approve-all"): pending rounds with the viewer's `canDecide`,
 * single decisions (optimistic for Approve) and the logged one-click approve-all. The API walks
 * the chain; the client only predicts what an approval will look like until the answer lands.
 */

export function useApprovals(
  filters: ApprovalListQuery = {},
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.approvals.list(filters),
    queryFn: ({ signal }) =>
      api("/approvals", { query: { ...filters }, schema: ApprovalListResponse, signal }),
    select: (data) => data.items,
    enabled,
  });
}

/** What the post looks like once the viewer's approval of its current step is recorded. */
export function optimisticallyApproved(post: PostDto): PostDto {
  const approval = post.currentApproval;
  if (!approval || approval.status !== "PENDING") return post;
  const lastStep = approval.currentStep >= approval.stepCount - 1;
  if (!lastStep) {
    return { ...post, currentApproval: { ...approval, canDecide: false } };
  }
  const placement = postPlacement("APPROVED");
  return {
    ...post,
    status: "APPROVED",
    column: placement.column,
    pill: placement.pill,
    approved: true,
    currentApproval: { ...approval, status: "APPROVED", canDecide: false },
  };
}

interface PostSnapshot {
  detail: PostDto | undefined;
  lists: Array<[readonly unknown[], PostListResponse | undefined]>;
}

function snapshotPost(queryClient: QueryClient, postId: string): PostSnapshot {
  return {
    detail: queryClient.getQueryData<PostDto>(queryKeys.posts.detail(postId)),
    lists: queryClient.getQueriesData<PostListResponse>({ queryKey: queryKeys.posts.lists() }),
  };
}

function restorePost(queryClient: QueryClient, postId: string, snapshot: PostSnapshot): void {
  queryClient.setQueryData(queryKeys.posts.detail(postId), snapshot.detail);
  for (const [queryKey, data] of snapshot.lists) queryClient.setQueryData(queryKey, data);
}

function findCachedPost(queryClient: QueryClient, postId: string): PostDto | undefined {
  const detail = queryClient.getQueryData<PostDto>(queryKeys.posts.detail(postId));
  if (detail) return detail;
  for (const [, data] of queryClient.getQueriesData<PostListResponse>({
    queryKey: queryKeys.posts.lists(),
  })) {
    const found = data?.items.find((item) => item.id === postId);
    if (found) return found;
  }
  return undefined;
}

export interface DecisionInput extends ApprovalDecisionRequest {
  requestId: string;
  postId: string;
}

/** POST /approvals/:id/decision. Feedback is sent exactly as typed (VerbatimText). */
export function useDecide() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, decision, feedback, target }: DecisionInput) =>
      api(apiPath("approvals", requestId, "decision"), {
        method: "POST",
        body: { decision, feedback, target },
        schema: ApprovalRequestDto,
      }),
    onMutate: async ({ postId, decision }) => {
      if (decision !== "APPROVE") return undefined;
      await queryClient.cancelQueries({ queryKey: queryKeys.posts.all });
      const snapshot = snapshotPost(queryClient, postId);
      const current = findCachedPost(queryClient, postId);
      if (current) storePost(queryClient, optimisticallyApproved(current));
      return snapshot;
    },
    onError: (_error, { postId }, snapshot) => {
      if (snapshot) restorePost(queryClient, postId, snapshot);
    },
    onSuccess: (request) => storePost(queryClient, request.post),
    // Not awaited: the answer is already in the cache, and a card that moves on (a revised post is
    // announced again further down the thread) must not hold up the caller's callbacks.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.posts.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.approvals.all });
    },
  });
}

/** POST /approvals/approve-all: one logged action over the current step of each request. */
export function useApproveAll() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (requestIds: string[]) =>
      api("/approvals/approve-all", {
        method: "POST",
        body: { requestIds },
        schema: ApproveAllResponse,
      }),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.posts.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.approvals.all }),
      ]),
  });
}
