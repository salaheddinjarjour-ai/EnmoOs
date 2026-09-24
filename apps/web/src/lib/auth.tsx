"use client";

import {
  can,
  SessionResponse,
  type Capability,
  type ChangePasswordRequest,
  type LoginRequest,
} from "@enmo/shared";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { api } from "./api";
import { safeNextPath } from "./safe-next-path";
import { endSessionOnUnauthenticated, fetchSession, loginHref, SESSION_QUERY_KEY } from "./session";

/*
 * Session state for the web app (DESIGN §E/§G). The API owns the session (httpOnly cookie); the
 * browser only ever asks GET /auth/me. `null` means "signed out"; an error means the API could not
 * be reached. There is no middleware (OpenNext has none): the (app) routes sit behind <AuthGate>,
 * which redirects to /login on the client.
 */

export function useMe() {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: ({ signal }) => fetchSession(signal),
    staleTime: 60_000,
    // Role changes and deactivations should show up when someone comes back to the tab.
    refetchOnWindowFocus: true,
  });
}

/** True when the signed-in user's role holds the capability (the API enforces it regardless). */
export function useCan(capability: Capability): boolean {
  const { data } = useMe();
  return data ? can(data.user.role, capability) : false;
}

const SessionContext = createContext<SessionResponse | null>(null);

/** The current session inside <AuthGate>. */
export function useSession(): SessionResponse {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside <AuthGate>");
  return session;
}

/** Where to go after signing in: the `next` the gate put on /login, if it stays on this origin. */
export function postLoginPath(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return safeNextPath(next, window.location.origin);
}

export interface AuthGateProps {
  children: ReactNode;
  /** Shown while the session is being resolved (and while redirecting to /login). */
  loading: ReactNode;
  /** Shown when the API can't be reached; `retry` re-runs the session probe. */
  failed: (retry: () => void) => ReactNode;
}

export function AuthGate({ children, loading, failed }: AuthGateProps) {
  const me = useMe();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();

  // A 401 from any authenticated call drops the session, and the redirect below takes over.
  useEffect(() => endSessionOnUnauthenticated(queryClient), [queryClient]);

  const signedOut = me.data === null;
  useEffect(() => {
    if (signedOut) router.replace(loginHref(pathname));
  }, [signedOut, pathname, router]);

  if (me.data) return <SessionContext value={me.data}>{children}</SessionContext>;
  if (me.isError) return failed(() => void me.refetch());
  return loading;
}

/** Forget everything cached for the previous user, keeping only the session entry. */
function resetUserData(queryClient: QueryClient, session: SessionResponse | null): void {
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== SESSION_QUERY_KEY[0] });
  queryClient.setQueryData(SESSION_QUERY_KEY, session);
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) =>
      api("/auth/login", {
        method: "POST",
        body,
        schema: SessionResponse,
        allowUnauthenticated: true,
      }),
    onSuccess: (session) => resetUserData(queryClient, session),
  });
}

/** Stores the session returned by invite accept (it signs the new user in). */
export function useSignedIn(): (session: SessionResponse) => void {
  const queryClient = useQueryClient();
  return (session) => resetUserData(queryClient, session);
}

export function useLogout() {
  return useMutation({
    mutationFn: () => api("/auth/logout", { method: "POST", allowUnauthenticated: true }),
    // A full navigation drops every cached query and component state from the old session, and
    // happens even if the API call failed (the cookie may already be gone).
    onSettled: () => window.location.replace("/login"),
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (body: ChangePasswordRequest) => api("/auth/password", { method: "POST", body }),
  });
}
