import { ConnectOAuthSelectionResponse, OAuthSelectionDto, OAuthStartResponse } from "@enmo/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiPath } from "@/lib/api";
import { queryKeys } from "./query-keys";

/*
 * Connecting accounts over OAuth (DESIGN §E "OAuth"): the API mints the state (bound to this
 * session, 10 minutes) and answers with the provider's consent URL; the browser goes there, and
 * the provider's redirect comes back through the API's callback to the client's accounts tab with
 * an OAuthResultQuery (see components/clients/OAuthResultNotice). A Meta sign-in comes back with a
 * pick list (`outcome=choose&pick=…`): the admin ticks this client's Pages and Instagram accounts
 * (components/clients/MetaAccountPicker), and only those are connected.
 */

/** GET /oauth/meta/start?clientId, then the whole window goes to Meta's consent screen. */
export function useStartMetaOAuth() {
  return useMutation({
    mutationFn: (clientId: string) =>
      api("/oauth/meta/start", { query: { clientId }, schema: OAuthStartResponse }),
    onSuccess: ({ authorizeUrl }) => window.location.assign(authorizeUrl),
  });
}

/** GET /oauth/meta/selections/:id: what the sign-in reached, and which of it can be picked. */
export function useOAuthSelection(selectionId: string | null) {
  return useQuery({
    queryKey: queryKeys.oauthSelection(selectionId ?? ""),
    queryFn: ({ signal }) =>
      api(apiPath("oauth", "meta", "selections", selectionId ?? ""), {
        schema: OAuthSelectionDto,
        signal,
      }),
    enabled: selectionId !== null,
    // A used or expired list answers 404 for good: asking again changes nothing.
    retry: false,
    staleTime: Infinity,
  });
}

/** POST /oauth/meta/selections/:id {keys}: the picked accounts connected to the client. */
export function useConnectOAuthSelection(clientId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ selectionId, keys }: { selectionId: string; keys: string[] }) =>
      api(apiPath("oauth", "meta", "selections", selectionId), {
        method: "POST",
        body: { keys },
        schema: ConnectOAuthSelectionResponse,
      }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.clients.socialAccounts(clientId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.clients.lists() }),
      ]),
  });
}
