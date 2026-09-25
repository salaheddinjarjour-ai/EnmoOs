import { createOAuthState, createPkcePair, type PkceChallenge } from "@enmo/providers";
import { OAUTH_STATE_TTL_SECONDS, type OAuthProviderName } from "@enmo/shared";
import { z } from "zod";
import type { Deps } from "../deps";
import { SECOND_MS } from "../lib/clock";
import { sha256 } from "../lib/tokens";

/*
 * The OAuth `state` between /start and the callback (DESIGN §E "OAuth"): an unguessable value
 * sent to the provider, kept in Redis for OAUTH_STATE_TTL_SECONDS with the PKCE verifier, bound to
 * the admin's session and the client being connected. It is taken with GETDEL, so it works once.
 * The key holds the state's sha256, not the state itself; the stored expiry is checked against the
 * injected clock too, so expiry doesn't depend on Redis timing (and tests can move time).
 */

export const StoredOAuthState = z.object({
  provider: z.enum(["meta", "tiktok"]),
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  clientId: z.string().min(1),
  codeVerifier: z.string().min(1),
  /** Epoch ms by deps.clock. */
  expiresAt: z.number(),
});
export type StoredOAuthState = z.infer<typeof StoredOAuthState>;

export interface OAuthStateBinding {
  sessionId: string;
  userId: string;
  clientId: string;
}

type StateDeps = Pick<Deps, "redis" | "clock" | "config">;

function stateKey(deps: Pick<Deps, "config">, provider: OAuthProviderName, state: string): string {
  return `${deps.config.BULLMQ_PREFIX}:oauth:${provider}:${sha256(state)}`;
}

/**
 * Starts a flow: a fresh state and PKCE pair, the provider's consent URL for them, and (once that
 * URL could be built) the state stored with its binding and the verifier. Returns the URL.
 */
export async function beginOAuthFlow(
  deps: StateDeps,
  provider: OAuthProviderName,
  binding: OAuthStateBinding,
  authorizeUrl: (state: string, pkce: PkceChallenge) => string,
): Promise<string> {
  const state = createOAuthState();
  const pkce = createPkcePair();
  const url = authorizeUrl(state, { codeChallenge: pkce.codeChallenge });
  const stored: StoredOAuthState = {
    provider,
    ...binding,
    codeVerifier: pkce.codeVerifier,
    expiresAt: deps.clock.now().getTime() + OAUTH_STATE_TTL_SECONDS * SECOND_MS,
  };
  await deps.redis.set(
    stateKey(deps, provider, state),
    JSON.stringify(stored),
    "EX",
    OAUTH_STATE_TTL_SECONDS,
  );
  return url;
}

/** The state's record, removed as it is read; null when unknown, used, expired or unreadable. */
export async function takeOAuthState(
  deps: StateDeps,
  provider: OAuthProviderName,
  state: string,
): Promise<StoredOAuthState | null> {
  const raw = await deps.redis.getdel(stateKey(deps, provider, state));
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = StoredOAuthState.safeParse(value);
  if (!parsed.success || parsed.data.provider !== provider) return null;
  return parsed.data.expiresAt > deps.clock.now().getTime() ? parsed.data : null;
}
