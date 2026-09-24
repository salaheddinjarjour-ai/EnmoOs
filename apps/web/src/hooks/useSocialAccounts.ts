import {
  CheckSocialAccountResponse,
  SocialAccountDto,
  SocialAccountListResponse,
  type CreateSocialAccountInput,
} from "@enmo/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiPath } from "@/lib/api";
import { queryKeys } from "./query-keys";

/*
 * A client's connected social accounts. Tokens go in through the manual connect form and never
 * come back: SocialAccountDto has no token fields at all.
 */

export function useSocialAccounts(clientId: string) {
  return useQuery({
    queryKey: queryKeys.clients.socialAccounts(clientId),
    queryFn: ({ signal }) =>
      api(apiPath("clients", clientId, "social-accounts"), {
        schema: SocialAccountListResponse,
        signal,
      }),
    select: (data) => data.items,
  });
}

function useRefreshAccounts(clientId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.clients.socialAccounts(clientId) }),
      // List rows show an account count.
      queryClient.invalidateQueries({ queryKey: queryKeys.clients.lists() }),
    ]);
}

export function useConnectSocialAccount(clientId: string) {
  const refresh = useRefreshAccounts(clientId);
  return useMutation({
    mutationFn: (body: CreateSocialAccountInput) =>
      api(apiPath("clients", clientId, "social-accounts"), {
        method: "POST",
        body,
        schema: SocialAccountDto,
      }),
    onSuccess: refresh,
  });
}

export function useDisconnectSocialAccount(clientId: string) {
  const refresh = useRefreshAccounts(clientId);
  return useMutation({
    mutationFn: (accountId: string) =>
      api(apiPath("social-accounts", accountId), { method: "DELETE" }),
    onSuccess: refresh,
  });
}

export function useCheckSocialAccount(clientId: string) {
  const refresh = useRefreshAccounts(clientId);
  return useMutation({
    mutationFn: (accountId: string) =>
      api(apiPath("social-accounts", accountId, "check"), {
        method: "POST",
        schema: CheckSocialAccountResponse,
      }),
    onSuccess: refresh,
  });
}
