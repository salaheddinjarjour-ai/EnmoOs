import type { OAuthProviderName, Platform, SocialAccountMeta } from "@enmo/shared";

/*
 * OAuth providers (DESIGN §E "OAuth", §F). The API's /oauth/{provider}/start route mints the state
 * (and a PKCE pair where the provider takes one), keeps them in Redis bound to the admin's
 * session, and redirects to authorizeUrl(); the callback exchanges the code, lists the accounts
 * the token reaches, and stores each as a SocialAccount with its tokens encrypted. tick.tokens
 * runs debugToken() daily and refresh() where the platform has refresh tokens. All HTTP goes
 * through an injected fetch against overridable base URLs.
 */

export interface OAuthTokens {
  accessToken: string;
  /** Null where the platform has none (Meta's long-lived tokens are re-exchanged instead). */
  refreshToken: string | null;
  /** Null when the token doesn't expire (Meta Page tokens from a long-lived user token). */
  expiresAt: Date | null;
  refreshExpiresAt: Date | null;
  /** Granted scopes, when the platform reports them with the token; [] when unknown. */
  scopes: string[];
}

/** One account the tokens reach, ready to upsert as a SocialAccount (unique on platform + externalId). */
export interface OAuthAccount {
  platform: Platform;
  /** Facebook Page id, Instagram user id, or TikTok open_id. */
  externalId: string;
  handle: string;
  displayName: string | null;
  /** The tokens this account publishes with (for Meta: the Page's token, for IG too). */
  tokens: OAuthTokens;
  meta: SocialAccountMeta;
}

/** A token as the platform describes it (Meta debug_token, TikTok token introspection). */
export interface TokenInfo {
  valid: boolean;
  expiresAt: Date | null;
  scopes: string[];
  /** The platform user or Page the token belongs to, when reported. */
  subjectId: string | null;
  /** Why it isn't valid, as the platform put it. */
  error: string | null;
}

export interface PkceChallenge {
  codeChallenge: string;
}

export interface PkceVerifier {
  codeVerifier: string;
}

export interface OAuthProvider {
  readonly name: OAuthProviderName;
  /** The consent screen URL for `state`; pure, no I/O. */
  authorizeUrl(state: string, pkce?: PkceChallenge): string;
  /** Code → tokens, already swapped for long-lived ones where the platform has them. */
  exchange(code: string, pkce?: PkceVerifier): Promise<OAuthTokens>;
  /** Every account the tokens can publish to (Meta: each Page plus its linked Instagram account). */
  listAccounts(tokens: OAuthTokens): Promise<OAuthAccount[]>;
  /** Present where the platform issues refresh tokens (TikTok). */
  refresh?(refreshToken: string): Promise<OAuthTokens>;
  debugToken(accessToken: string): Promise<TokenInfo>;
}

/**
 * - DENIED: the admin declined, or the code is invalid or already used
 * - NOT_CONFIGURED: the platform's app credentials aren't set
 * - API_ERROR: the platform failed or answered something unexpected
 */
export type OAuthErrorCode = "DENIED" | "NOT_CONFIGURED" | "API_ERROR";

export class OAuthError extends Error {
  override readonly name = "OAuthError";
  readonly code: OAuthErrorCode;
  readonly status: number | null;

  constructor(
    code: OAuthErrorCode,
    message: string,
    options: { status?: number | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.status = options.status ?? null;
  }
}
