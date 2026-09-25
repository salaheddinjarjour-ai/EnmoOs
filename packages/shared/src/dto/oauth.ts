import { z } from "zod";
import { Id } from "./common";

/*
 * Connecting social accounts over OAuth (DESIGN §E "OAuth", §F "Meta"). The web app asks the API
 * for the provider's consent URL and sends the admin there; the provider redirects back to the
 * API's callback, which checks the state (kept in Redis for 10 minutes, bound to the admin's
 * session), stores one SocialAccount per Facebook Page and per linked Instagram account with
 * encrypted long-lived tokens, and redirects the browser to the client's accounts tab with an
 * OAuthResultQuery.
 */

export const OAuthProviderName = z.enum(["meta", "tiktok"]);
export type OAuthProviderName = z.infer<typeof OAuthProviderName>;

/** The state and PKCE verifier expire this long after /start. */
export const OAUTH_STATE_TTL_SECONDS = 600;

/** GET /v1/oauth/{meta,tiktok}/start?clientId (socialAccounts.manage) */
export const OAuthStartQuery = z.object({
  clientId: Id,
});
export type OAuthStartQuery = z.infer<typeof OAuthStartQuery>;

export const OAuthStartResponse = z.object({
  /** The provider's consent screen; the browser navigates to it. */
  authorizeUrl: z.url(),
});
export type OAuthStartResponse = z.infer<typeof OAuthStartResponse>;

/**
 * GET /v1/oauth/{meta,tiktok}/callback, as the provider sends it: a code and our state on
 * success, an error (Meta: error, error_reason, error_description) when the admin declined.
 */
export const OAuthCallbackQuery = z.looseObject({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
  error_reason: z.string().optional(),
  error_description: z.string().optional(),
});
export type OAuthCallbackQuery = z.infer<typeof OAuthCallbackQuery>;

export const OAuthOutcome = z.enum(["connected", "error"]);
export type OAuthOutcome = z.infer<typeof OAuthOutcome>;

/**
 * The query the callback's redirect lands on the web app with, next to `tab=accounts` on
 * /clients/:clientId: which provider, whether it worked, how many accounts were stored, and a
 * message a person can read when it didn't.
 */
export const OAuthResultQuery = z.object({
  oauth: OAuthProviderName,
  outcome: OAuthOutcome,
  connected: z.coerce.number().int().nonnegative().optional(),
  message: z.string().max(500).optional(),
});
export type OAuthResultQuery = z.infer<typeof OAuthResultQuery>;

/** Where the callback sends the browser back to (relative to the web app's origin). */
export function oauthReturnPath(clientId: string, result: OAuthResultQuery): string {
  const params: [string, string][] = [
    ["tab", "accounts"],
    ["oauth", result.oauth],
    ["outcome", result.outcome],
  ];
  if (result.connected !== undefined) params.push(["connected", String(result.connected)]);
  if (result.message !== undefined) params.push(["message", result.message]);
  const query = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
  return `/clients/${encodeURIComponent(clientId)}?${query}`;
}
