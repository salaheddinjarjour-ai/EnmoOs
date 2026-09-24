import {
  PostDto,
  PostListResponse,
  type PostListQuery,
  type UpdatePostCopyRequest,
} from "@enmo/shared";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, apiPath } from "../lib/api";
import { queryKeys } from "./query-keys";

/*
 * Posts (DESIGN §E "posts"). Each PostDto carries its board placement and the viewer's say on its
 * open approval round, so cards in chat, the queue and the kanban read from these queries.
 */

export function usePosts(
  filters: PostListQuery = {},
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.posts.list(filters),
    queryFn: ({ signal }) =>
      api("/posts", { query: { ...filters }, schema: PostListResponse, signal }),
    select: (data) => data.items,
    enabled,
  });
}

export function usePost(postId: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.posts.detail(postId),
    queryFn: ({ signal }) => api(apiPath("posts", postId), { schema: PostDto, signal }),
    enabled,
  });
}

/** Replaces the post in every cached list and its detail entry. */
export function storePost(queryClient: QueryClient, post: PostDto): void {
  queryClient.setQueryData(queryKeys.posts.detail(post.id), post);
  queryClient.setQueriesData<PostListResponse>({ queryKey: queryKeys.posts.lists() }, (current) =>
    current ? { items: current.items.map((item) => (item.id === post.id ? post : item)) } : current,
  );
}

/**
 * PATCH /posts/:id/copy. A 422 carries BannedWordsErrorDetails; an edit of a post in (or past)
 * approval opens a new round, so approvals refresh too.
 */
export function useUpdatePostCopy(postId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdatePostCopyRequest) =>
      api(apiPath("posts", postId, "copy"), { method: "PATCH", body, schema: PostDto }),
    onSuccess: (post) => {
      storePost(queryClient, post);
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.posts.lists() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.approvals.all }),
      ]);
    },
  });
}
