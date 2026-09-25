import { createHash, randomBytes } from "node:crypto";

/*
 * State and PKCE (RFC 7636, S256) for the OAuth start route. The state and verifier stay in Redis
 * for OAUTH_STATE_TTL_SECONDS, bound to the admin's session; only the state and the challenge go
 * to the provider.
 */

/** An unguessable `state` value (32 random bytes, base64url). */
export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
}

export function pkceChallengeFor(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

/** A 43-character verifier and its S256 challenge. */
export function createPkcePair(): PkcePair {
  const codeVerifier = randomBytes(32).toString("base64url");
  return {
    codeVerifier,
    codeChallenge: pkceChallengeFor(codeVerifier),
    codeChallengeMethod: "S256",
  };
}
