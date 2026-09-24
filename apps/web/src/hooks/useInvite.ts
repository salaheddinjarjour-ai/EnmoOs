import { InvitePreviewResponse, SessionResponse, type AcceptInviteRequest } from "@enmo/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, apiPath } from "@/lib/api";
import { useSignedIn } from "@/lib/auth";
import { queryKeys } from "./query-keys";

/* The public invite flow: preview the invite behind a token, then accept it (which signs in). */

export function useInvitePreview(token: string) {
  return useQuery({
    queryKey: queryKeys.invitePreview(token),
    queryFn: ({ signal }) =>
      api(apiPath("invites", token), {
        schema: InvitePreviewResponse,
        signal,
        allowUnauthenticated: true,
      }),
    // An invalid token stays invalid; don't hammer the endpoint.
    retry: false,
    staleTime: Infinity,
  });
}

export function useAcceptInvite(token: string) {
  const signedIn = useSignedIn();
  return useMutation({
    mutationFn: (body: AcceptInviteRequest) =>
      api(apiPath("invites", token, "accept"), {
        method: "POST",
        body,
        schema: SessionResponse,
        allowUnauthenticated: true,
      }),
    onSuccess: signedIn,
  });
}
