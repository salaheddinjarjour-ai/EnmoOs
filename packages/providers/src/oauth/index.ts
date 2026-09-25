import { MetaOAuthProvider } from "./meta";
import type { MetaConfig } from "../meta/config";

export { MetaOAuthProvider, type MetaOAuthOptions } from "./meta";
export { createOAuthState, createPkcePair, pkceChallengeFor, type PkcePair } from "./pkce";

export interface MetaOAuthConfig extends MetaConfig {
  /** The API's own callback: `${API_PUBLIC_URL}/v1/oauth/meta/callback`. */
  redirectUri: string;
}

export interface OAuthDeps {
  /** HTTP to the platform; tests inject one aimed at a fake server. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

/**
 * The Meta OAuth provider. Construction does no I/O and never throws; without META_APP_ID and
 * META_APP_SECRET its calls fail with OAuthError("NOT_CONFIGURED").
 */
export function createMetaOAuthProvider(
  config: MetaOAuthConfig,
  deps: OAuthDeps = {},
): MetaOAuthProvider {
  return new MetaOAuthProvider({ ...config, fetch: deps.fetch ?? globalThis.fetch });
}
