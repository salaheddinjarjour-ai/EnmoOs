import { SessionResponse } from "@enmo/shared";
import type { QueryClient } from "@tanstack/react-query";
import { api, ApiError, setUnauthenticatedHandler } from "./api";
import { DEFAULT_LANDING } from "./safe-next-path";

/*
 * The session as the query cache holds it (DESIGN §E/§G): `null` means signed out. React-free, so
 * the path from a 401 to /login can be unit-tested; lib/auth.tsx wires it into the AuthGate.
 */

export const SESSION_QUERY_KEY = ["auth", "me"] as const;

/** GET /auth/me: the session, or null when there is none (a 401 here is an answer, not an error). */
export async function fetchSession(signal?: AbortSignal): Promise<SessionResponse | null> {
  try {
    return await api("/auth/me", { schema: SessionResponse, signal, allowUnauthenticated: true });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

/**
 * Any 401 from an authenticated call means the session ended (expired, signed out elsewhere, the
 * user deactivated or given a new role): mark the cached session signed out, which the AuthGate
 * turns into a redirect to /login. Returns the unregister function.
 */
export function endSessionOnUnauthenticated(queryClient: QueryClient): () => void {
  return setUnauthenticatedHandler(() => {
    queryClient.setQueryData(SESSION_QUERY_KEY, null);
  });
}

/** Where the AuthGate sends a signed-out visitor of `pathname`, keeping the way back. */
export function loginHref(pathname: string): string {
  return pathname === "/" || pathname === DEFAULT_LANDING
    ? "/login"
    : `/login?next=${encodeURIComponent(pathname)}`;
}
