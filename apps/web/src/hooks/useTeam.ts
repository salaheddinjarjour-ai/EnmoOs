import {
  CreateInviteResponse,
  InviteListResponse,
  TeamDirectoryResponse,
  UserDto,
  UserListResponse,
  type CreateInviteRequest,
  type UpdateUserRequest,
} from "@enmo/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiPath } from "@/lib/api";
import { queryKeys } from "./query-keys";

/*
 * ADMIN team management: users (GET/PATCH /users) and invites (POST/GET/DELETE /invites), plus the
 * team directory everyone who reads clients may see (GET /users/directory).
 */

export function useUsers({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.users,
    queryFn: ({ signal }) => api("/users", { schema: UserListResponse, signal }),
    select: (data) => data.items,
    enabled,
  });
}

/** Everyone on the team by name, role and status, for picking and showing named approvers. */
export function useTeamDirectory() {
  return useQuery({
    queryKey: queryKeys.teamDirectory,
    queryFn: ({ signal }) => api("/users/directory", { schema: TeamDirectoryResponse, signal }),
    select: (data) => data.items,
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, changes }: { userId: string; changes: UpdateUserRequest }) =>
      api(apiPath("users", userId), { method: "PATCH", body: changes, schema: UserDto }),
    onSuccess: (user) => {
      queryClient.setQueryData<UserListResponse>(queryKeys.users, (current) =>
        current
          ? { items: current.items.map((item) => (item.id === user.id ? user : item)) }
          : current,
      );
      // Roles and deactivations decide who can complete each client's approval chain.
      void queryClient.invalidateQueries({ queryKey: queryKeys.teamDirectory });
    },
  });
}

export function useInvites({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.invites,
    queryFn: ({ signal }) => api("/invites", { schema: InviteListResponse, signal }),
    select: (data) => data.items,
    enabled,
  });
}

export function useCreateInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateInviteRequest) =>
      api("/invites", { method: "POST", body, schema: CreateInviteResponse }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.invites }),
  });
}

export function useRevokeInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => api(apiPath("invites", inviteId), { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.invites }),
  });
}
