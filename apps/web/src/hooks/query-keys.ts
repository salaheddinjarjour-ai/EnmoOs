import type {
  ApprovalListQuery,
  AssetListQuery,
  CampaignListQuery,
  PostListQuery,
} from "@enmo/shared";

/*
 * TanStack Query keys, in one place so invalidation stays consistent. Client lists are invalidated
 * whenever a client or one of its accounts changes, because list rows carry counts. Each resource's
 * first element is its root, so `{ queryKey: queryKeys.posts.all }` refreshes every post query (a
 * realtime `post.updated`), and `resync` can simply invalidate everything.
 */
export const queryKeys = {
  clients: {
    lists: () => ["clients", "list"] as const,
    list: (includeArchived: boolean) => ["clients", "list", { includeArchived }] as const,
    detail: (clientId: string) => ["clients", "detail", clientId] as const,
    socialAccounts: (clientId: string) =>
      ["clients", "detail", clientId, "social-accounts"] as const,
  },
  users: ["users"] as const,
  teamDirectory: ["users", "directory"] as const,
  invites: ["invites"] as const,
  invitePreview: (token: string) => ["invite-preview", token] as const,

  campaigns: {
    all: ["campaigns"] as const,
    lists: () => ["campaigns", "list"] as const,
    list: (filters: CampaignListQuery = {}) => ["campaigns", "list", filters] as const,
    detail: (campaignId: string) => ["campaigns", "detail", campaignId] as const,
    /** GET /campaigns/:id/tasks */
    tasks: (campaignId: string) => ["campaigns", "detail", campaignId, "tasks"] as const,
  },
  threads: {
    all: ["threads"] as const,
    /** GET /threads/:id/messages, the whole thread (the `after` cursor only fetches the tail). */
    messages: (threadId: string) => ["threads", threadId, "messages"] as const,
  },
  taskGraphs: {
    all: ["task-graphs"] as const,
    detail: (graphId: string) => ["task-graphs", graphId] as const,
  },
  posts: {
    all: ["posts"] as const,
    lists: () => ["posts", "list"] as const,
    list: (filters: PostListQuery = {}) => ["posts", "list", filters] as const,
    detail: (postId: string) => ["posts", "detail", postId] as const,
  },
  /** The Vault: GET /assets (searchable, paginated) and GET /assets/:id (with lineage). */
  assets: {
    all: ["assets"] as const,
    lists: () => ["assets", "list"] as const,
    /** Filters without the cursor: an infinite query pages through them. */
    list: (filters: Partial<Omit<AssetListQuery, "cursor">> = {}) =>
      ["assets", "list", filters] as const,
    detail: (assetId: string) => ["assets", "detail", assetId] as const,
  },
  approvals: {
    all: ["approvals"] as const,
    lists: () => ["approvals", "list"] as const,
    list: (filters: ApprovalListQuery = {}) => ["approvals", "list", filters] as const,
  },
  budget: ["budget"] as const,
};
