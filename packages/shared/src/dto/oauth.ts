import { z } from "zod";
import { Platform } from "../enums";
import { Id, IsoDateTime } from "./common";
import { SocialAccountDto, SocialAccountMeta } from "./social-account";

/*
 * Connecting social accounts over OAuth (DESIGN §E "OAuth", §F "Meta"). The web app asks the API
 * for the provider's consent URL and sends the admin there; the provider redirects back to the
 * API's callback, which checks the state (kept in Redis for 10 minutes, bound to the admin's
 * session) and exchanges the code for long-lived tokens. Meta hands back every Page the admin
 * ever granted the app, often other clients' too, so the callback stores none of them yet: it keeps
 * the list (tokens encrypted) as a selection and redirects to the client's accounts tab with
 * `outcome=choose`. There the admin picks which Pages and linked Instagram accounts belong to this
 * client; only those become SocialAccounts, and accounts already connected to another client can't
 * be picked.
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

/** "choose": the admin picks which of the listed accounts to connect (`pick` names the list). */
export const OAuthOutcome = z.enum(["choose", "connected", "error"]);
export type OAuthOutcome = z.infer<typeof OAuthOutcome>;

/** A selection's id: unguessable, and only ever read by the session that made it. */
export const OAuthSelectionId = z.string().regex(/^[\w-]{20,128}$/);

/**
 * The query the callback's redirect lands on the web app with, next to `tab=accounts` on
 * /clients/:clientId: which provider, whether it worked (or which selection to choose from), how
 * many accounts were stored, and a message a person can read when it didn't.
 */
export const OAuthResultQuery = z.object({
  oauth: OAuthProviderName,
  outcome: OAuthOutcome,
  connected: z.coerce.number().int().nonnegative().optional(),
  pick: OAuthSelectionId.optional(),
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
  if (result.pick !== undefined) params.push(["pick", result.pick]);
  if (result.message !== undefined) params.push(["message", result.message]);
  const query = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
  return `/clients/${encodeURIComponent(clientId)}?${query}`;
}

/** GET|POST /v1/oauth/meta/selections/:id */
export const OAuthSelectionParams = z.object({ id: OAuthSelectionId });
export type OAuthSelectionParams = z.infer<typeof OAuthSelectionParams>;

/**
 * Where a listed account stands: free to connect, already this client's (connecting it again
 * refreshes its token), or another client's (it can't be picked; disconnect it there first).
 */
export const OAuthSelectionStatus = z.enum(["available", "connected", "taken"]);
export type OAuthSelectionStatus = z.infer<typeof OAuthSelectionStatus>;

/** One account a selection lists: a Facebook Page, or the Instagram account linked to one. */
export const OAuthSelectionAccount = z.object({
  /** "<PLATFORM>:<externalId>", what POST picks it by. */
  key: z.string().min(1).max(200),
  platform: Platform,
  externalId: z.string(),
  handle: z.string(),
  displayName: z.string().nullable(),
  meta: SocialAccountMeta,
  status: OAuthSelectionStatus,
  /** The client a "taken" account belongs to. */
  takenBy: z.object({ clientId: Id, clientName: z.string() }).nullable(),
});
export type OAuthSelectionAccount = z.infer<typeof OAuthSelectionAccount>;

/** GET /v1/oauth/meta/selections/:id (socialAccounts.manage; the session that started it). */
export const OAuthSelectionDto = z.object({
  id: OAuthSelectionId,
  provider: OAuthProviderName,
  clientId: Id,
  clientName: z.string(),
  expiresAt: IsoDateTime,
  accounts: z.array(OAuthSelectionAccount),
});
export type OAuthSelectionDto = z.infer<typeof OAuthSelectionDto>;

/** POST /v1/oauth/meta/selections/:id: the listed accounts to connect to the client, by key. */
export const ConnectOAuthSelectionBody = z.object({
  keys: z.array(z.string().min(1).max(200)).min(1).max(100),
});
export type ConnectOAuthSelectionBody = z.infer<typeof ConnectOAuthSelectionBody>;

/** The accounts connected (created or refreshed), each with whether it publishes. */
export const ConnectOAuthSelectionResponse = z.object({
  connected: z.int().nonnegative(),
  items: z.array(SocialAccountDto),
});
export type ConnectOAuthSelectionResponse = z.infer<typeof ConnectOAuthSelectionResponse>;
