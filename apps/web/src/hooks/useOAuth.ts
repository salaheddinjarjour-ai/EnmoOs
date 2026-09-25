import { OAuthStartResponse } from "@enmo/shared";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";

/*
 * Connecting accounts over OAuth (DESIGN §E "OAuth"): the API mints the state (bound to this
 * session, 10 minutes) and answers with the provider's consent URL; the browser goes there, and
 * the provider's redirect comes back through the API's callback to the client's accounts tab with
 * an OAuthResultQuery (see components/clients/OAuthResultNotice).
 */

/** GET /oauth/meta/start?clientId, then the whole window goes to Meta's consent screen. */
export function useStartMetaOAuth() {
  return useMutation({
    mutationFn: (clientId: string) =>
      api("/oauth/meta/start", { query: { clientId }, schema: OAuthStartResponse }),
    onSuccess: ({ authorizeUrl }) => window.location.assign(authorizeUrl),
  });
}
