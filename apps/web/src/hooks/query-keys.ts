/*
 * TanStack Query keys, in one place so invalidation stays consistent. Client lists are invalidated
 * whenever a client or one of its accounts changes, because list rows carry counts.
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
};
