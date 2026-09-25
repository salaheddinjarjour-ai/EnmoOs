import type { DbTransaction, Prisma } from "@enmo/db";
import { OAuthError, type OAuthAccount } from "@enmo/providers";
import {
  AUDIT_ACTIONS,
  can,
  oauthReturnPath,
  PLATFORM_LABEL,
  type OAuthCallbackQuery,
  type OAuthResultQuery,
  type OAuthStartResponse,
} from "@enmo/shared";
import type { Deps } from "../deps";
import { AppError, conflict, isAppError } from "../lib/errors";
import type { ServiceUser } from "./actor";
import { auditChange, AUDITED_ENTITY, isPrismaError, requireEditableClient } from "./clients";
import { beginOAuthFlow, takeOAuthState, type StoredOAuthState } from "./oauth-state";
import { statusFromExpiry } from "./social-accounts";

/*
 * Connecting Meta accounts over OAuth (DESIGN §E "OAuth", §F "Meta"):
 *   startMetaOAuth     mints the state (and PKCE pair) with @enmo/providers createOAuthState /
 *                      createPkcePair, keeps them in deps.redis for OAUTH_STATE_TTL_SECONDS bound
 *                      to the admin's session and the client (oauth-state.ts), and returns
 *                      deps.oauth.meta's consent URL
 *   completeMetaOAuth  checks the state against that session (one use only), exchanges the code,
 *                      lists the Pages and linked Instagram accounts, upserts one SocialAccount
 *                      each with deps.tokenCipher-encrypted long-lived tokens (audited), and sends
 *                      the browser back to the client's accounts tab with an OAuthResultQuery
 * Codes, states and tokens never reach a log line, a message or the redirect.
 */

/** The signed-in admin behind an OAuth request; the state is bound to their session. */
export interface OAuthSessionUser extends ServiceUser {
  readonly sessionId: string;
}

export interface OAuthCallbackResult {
  /** Absolute URL on the web app (APP_PUBLIC_URL) the callback redirects the browser to. */
  redirectTo: string;
}

/** OAuthResultQuery.message's limit. */
const MESSAGE_MAX = 500;

const MESSAGES = {
  missingState: "The Meta sign-in didn't come back with our state; start the connection again.",
  staleState:
    "This Meta sign-in expired or was already used; start the connection again from the client's accounts tab.",
  wrongSession:
    "Finish connecting in the same signed-in browser session that started it: sign in and start the connection again.",
  notAllowed: "You no longer have permission to connect social accounts.",
  declined: "The Meta sign-in was cancelled, so nothing was connected.",
  noCode: "Meta didn't send a sign-in code back; start the connection again.",
  noAccounts:
    "Meta returned no Facebook Page you manage. Start again and tick the client's Pages on Meta's screen.",
  denied: "Meta refused the sign-in (it may have expired or been used already); start again.",
  notConfigured:
    "Connecting Meta accounts isn't set up on this server yet (META_APP_ID and META_APP_SECRET).",
  apiError: "Meta didn't answer as expected; try connecting again in a minute.",
  race: "One of these accounts was connected to another client meanwhile; check the accounts and try again.",
  unexpected: "Something went wrong while connecting the Meta accounts; try again.",
} as const;

function clip(message: string): string {
  return message.length <= MESSAGE_MAX ? message : `${message.slice(0, MESSAGE_MAX - 1)}…`;
}

/**
 * Where the browser lands after the callback: the client's accounts tab, or the client list when
 * the state doesn't say which client (it was missing, expired or already used).
 */
export function oauthResultUrl(
  deps: Pick<Deps, "config">,
  clientId: string | null,
  result: OAuthResultQuery,
): string {
  const base = deps.config.APP_PUBLIC_URL;
  if (clientId) return `${base}${oauthReturnPath(clientId, result)}`;
  const query = new URLSearchParams({ oauth: result.oauth, outcome: result.outcome });
  if (result.message !== undefined) query.set("message", result.message);
  return `${base}/clients?${query.toString()}`;
}

function failed(deps: Deps, clientId: string | null, message: string): OAuthCallbackResult {
  return {
    redirectTo: oauthResultUrl(deps, clientId, {
      oauth: "meta",
      outcome: "error",
      message: clip(message),
    }),
  };
}

/** GET /oauth/meta/start?clientId. NOT_FOUND for an unknown client, CONFLICT for an archived one. */
export async function startMetaOAuth(
  deps: Deps,
  user: OAuthSessionUser,
  clientId: string,
): Promise<OAuthStartResponse> {
  await requireEditableClient(deps.prisma, clientId);
  const binding = { sessionId: user.sessionId, userId: user.id, clientId };
  try {
    const authorizeUrl = await beginOAuthFlow(deps, "meta", binding, (state, pkce) =>
      deps.oauth.meta.authorizeUrl(state, pkce),
    );
    return { authorizeUrl };
  } catch (error) {
    if (error instanceof OAuthError && error.code === "NOT_CONFIGURED") {
      throw new AppError("UNAVAILABLE", MESSAGES.notConfigured);
    }
    throw error;
  }
}

/** What Meta's error redirect (the admin declined, or the dialog failed) means for people. */
function declinedMessage(query: OAuthCallbackQuery): string {
  if (query.error === "access_denied" || query.error_reason === "user_denied") {
    return MESSAGES.declined;
  }
  const detail = query.error_description?.trim() || query.error_reason?.trim() || query.error;
  return `The Meta sign-in failed: ${detail ?? "no reason given"}.`;
}

function accountKey(account: Pick<OAuthAccount, "platform" | "externalId">): string {
  return `${account.platform}:${account.externalId}`;
}

/** One SocialAccount per account, created or refreshed in place; CONFLICT when another client has one. */
async function upsertAccount(
  tx: DbTransaction,
  deps: Deps,
  user: OAuthSessionUser,
  clientId: string,
  account: OAuthAccount,
): Promise<void> {
  const existing = await tx.socialAccount.findUnique({
    where: {
      platform_externalId: { platform: account.platform, externalId: account.externalId },
    },
    select: { id: true, clientId: true, client: { select: { name: true } } },
  });
  const label = `${PLATFORM_LABEL[account.platform]} ${account.platform === "FACEBOOK" ? "Page" : "account"} "${account.handle}"`;
  if (existing && existing.clientId !== clientId) {
    throw conflict(
      `${label} is already connected to ${existing.client.name}. Disconnect it there first, or leave it unticked on Meta's screen; nothing was connected.`,
      { socialAccountId: existing.id, clientId: existing.clientId },
    );
  }
  const now = deps.clock.now();
  const { tokens } = account;
  const fields = {
    handle: account.handle,
    displayName: account.displayName,
    accessTokenEnc: deps.tokenCipher.encrypt(tokens.accessToken),
    refreshTokenEnc:
      tokens.refreshToken === null ? null : deps.tokenCipher.encrypt(tokens.refreshToken),
    tokenExpiresAt: tokens.expiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
    scopes: tokens.scopes,
    // SocialAccountMeta parses to plain JSON: strings plus the loose keys Meta sent.
    meta: { ...account.meta, source: "oauth" } as Prisma.InputJsonObject,
    status: statusFromExpiry(
      {
        tokenExpiresAt: tokens.expiresAt,
        refreshExpiresAt: tokens.refreshExpiresAt,
        hasRefreshToken: tokens.refreshToken !== null,
      },
      now,
    ),
    // exchange() just had Meta vouch for the token (debug_token).
    lastCheckedAt: now,
    connectedById: user.id,
  };
  const row = existing
    ? await tx.socialAccount.update({
        where: { id: existing.id },
        data: fields,
        select: { id: true },
      })
    : await tx.socialAccount.create({
        data: {
          clientId,
          platform: account.platform,
          externalId: account.externalId,
          ...fields,
        },
        select: { id: true },
      });
  await auditChange(
    tx,
    user,
    AUDIT_ACTIONS.socialAccountConnect,
    { type: AUDITED_ENTITY.socialAccount, id: row.id },
    {
      clientId,
      platform: account.platform,
      externalId: account.externalId,
      handle: account.handle,
      source: "oauth",
      reconnected: existing !== null,
    },
  );
}

/** Code → long-lived tokens → every Page and linked Instagram account, stored in one go. */
async function connectMetaAccounts(
  deps: Deps,
  user: OAuthSessionUser,
  stored: StoredOAuthState,
  code: string,
): Promise<number> {
  const tokens = await deps.oauth.meta.exchange(code, { codeVerifier: stored.codeVerifier });
  const listed = await deps.oauth.meta.listAccounts(tokens);
  const accounts = [...new Map(listed.map((account) => [accountKey(account), account])).values()];
  if (accounts.length === 0) throw new AppError("UNPROCESSABLE", MESSAGES.noAccounts);
  await deps.prisma.$transaction(async (tx) => {
    await requireEditableClient(tx, stored.clientId);
    for (const account of accounts) {
      await upsertAccount(tx, deps, user, stored.clientId, account);
    }
  });
  return accounts.length;
}

/** A failed connect as a message people can act on; unexpected failures are logged. */
function connectFailure(deps: Deps, clientId: string, error: unknown): string {
  if (isAppError(error)) return error.message;
  if (isPrismaError(error, "P2002")) return MESSAGES.race;
  if (error instanceof OAuthError) {
    deps.logger.warn({ err: error, clientId }, "Meta OAuth: connecting accounts failed");
    if (error.code === "DENIED") return MESSAGES.denied;
    if (error.code === "NOT_CONFIGURED") return MESSAGES.notConfigured;
    return MESSAGES.apiError;
  }
  deps.logger.error({ err: error, clientId }, "Meta OAuth: unexpected error in the callback");
  return MESSAGES.unexpected;
}

/**
 * GET /oauth/meta/callback, public (Meta redirects the browser here) but state-verified:
 * `caller` is the session the browser still carries, or null. Never throws for a bad state or a
 * declined consent: every outcome is a redirect with a message a person can read.
 */
export async function completeMetaOAuth(
  deps: Deps,
  query: OAuthCallbackQuery,
  caller: OAuthSessionUser | null,
): Promise<OAuthCallbackResult> {
  if (!query.state) return failed(deps, null, MESSAGES.missingState);
  let stored: StoredOAuthState | null;
  try {
    stored = await takeOAuthState(deps, "meta", query.state);
  } catch (error) {
    deps.logger.error({ err: error }, "Meta OAuth: the state store is unavailable");
    return failed(deps, null, MESSAGES.unexpected);
  }
  if (!stored) return failed(deps, null, MESSAGES.staleState);
  // A state from another browser or session proves nothing about who is signed in here.
  if (!caller || caller.sessionId !== stored.sessionId || caller.id !== stored.userId) {
    return failed(deps, null, MESSAGES.wrongSession);
  }
  const { clientId } = stored;
  if (!can(caller.role, "socialAccounts.manage"))
    return failed(deps, clientId, MESSAGES.notAllowed);
  if (query.error) return failed(deps, clientId, declinedMessage(query));
  if (!query.code) return failed(deps, clientId, MESSAGES.noCode);

  try {
    const connected = await connectMetaAccounts(deps, caller, stored, query.code);
    deps.logger.info({ clientId, connected }, "Meta OAuth: accounts connected");
    return {
      redirectTo: oauthResultUrl(deps, clientId, {
        oauth: "meta",
        outcome: "connected",
        connected,
      }),
    };
  } catch (error) {
    return failed(deps, clientId, connectFailure(deps, clientId, error));
  }
}
