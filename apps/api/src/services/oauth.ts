import type { DbTransaction, Prisma } from "@enmo/db";
import { OAuthError, type OAuthAccount } from "@enmo/providers";
import {
  AUDIT_ACTIONS,
  can,
  oauthReturnPath,
  PLATFORM_LABEL,
  type ConnectOAuthSelectionBody,
  type ConnectOAuthSelectionResponse,
  type OAuthCallbackQuery,
  type OAuthResultQuery,
  type OAuthSelectionAccount,
  type OAuthSelectionDto,
  type OAuthStartResponse,
  type Platform,
} from "@enmo/shared";
import type { Deps } from "../deps";
import { AppError, conflict, isAppError, notFound } from "../lib/errors";
import type { ServiceUser } from "./actor";
import { auditChange, AUDITED_ENTITY, isPrismaError, requireEditableClient } from "./clients";
import { beginOAuthFlow, takeOAuthState, type StoredOAuthState } from "./oauth-state";
import {
  dropOAuthSelection,
  readOAuthSelection,
  saveOAuthSelection,
  selectionKeyOf,
  type StoredOAuthSelection,
} from "./oauth-selection";
import {
  lockClientAccounts,
  PUBLIC_COLUMNS,
  settlePrimary,
  statusFromExpiry,
  toSocialAccountDto,
} from "./social-accounts";

/*
 * Connecting Meta accounts over OAuth (DESIGN §E "OAuth", §F "Meta"):
 *   startMetaOAuth       mints the state (and PKCE pair) with @enmo/providers createOAuthState /
 *                        createPkcePair, keeps them in deps.redis for OAUTH_STATE_TTL_SECONDS bound
 *                        to the admin's session and the client (oauth-state.ts), and returns
 *                        deps.oauth.meta's consent URL
 *   completeMetaOAuth    checks the state against that session (one use only), exchanges the code,
 *                        lists the Pages and linked Instagram accounts, and keeps them as a
 *                        selection (oauth-selection.ts, tokens encrypted) for the admin to choose
 *                        from: Meta lists every Page the admin ever granted the app, other clients'
 *                        brands included, so none is stored yet. The browser goes back to the
 *                        client's accounts tab with outcome=choose and the selection's id.
 *   getMetaSelection     what the selection lists, each account available, already this client's,
 *                        or another client's (which can't be picked)
 *   connectMetaSelection upserts one SocialAccount per picked account with its encrypted long-lived
 *                        token (audited); a client's only account on a platform is the one it
 *                        publishes through (settlePrimary), several wait for an admin's choice
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
  selectionGone:
    "This list of Meta accounts expired or was already used; connect Meta again from the client's accounts tab.",
  unknownPick: "Pick accounts from the list Meta returned.",
  denied: "Meta refused the sign-in (it may have expired or been used already); start again.",
  notConfigured:
    "Connecting Meta accounts isn't set up on this server yet (META_APP_ID and META_APP_SECRET).",
  apiError: "Meta didn't answer as expected; try connecting again in a minute.",
  race: "One of these accounts was connected to another client meanwhile; reload the list and try again.",
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

type SelectedAccount = StoredOAuthSelection["accounts"][number];

function labelOf(account: Pick<SelectedAccount, "platform" | "handle">): string {
  return `${PLATFORM_LABEL[account.platform]} ${account.platform === "FACEBOOK" ? "Page" : "account"} "${account.handle}"`;
}

/** One picked account as a SocialAccount, created or refreshed in place; CONFLICT when taken. */
async function upsertAccount(
  tx: DbTransaction,
  deps: Deps,
  user: ServiceUser,
  clientId: string,
  account: SelectedAccount,
): Promise<string> {
  const existing = await tx.socialAccount.findUnique({
    where: {
      platform_externalId: { platform: account.platform, externalId: account.externalId },
    },
    select: { id: true, clientId: true, client: { select: { name: true } } },
  });
  if (existing && existing.clientId !== clientId) {
    throw conflict(
      `${labelOf(account)} is already connected to ${existing.client.name}. Disconnect it there first, or leave it out; nothing was connected.`,
      { socialAccountId: existing.id, clientId: existing.clientId },
    );
  }
  const now = deps.clock.now();
  const date = (iso: string | null) => (iso === null ? null : new Date(iso));
  const tokenExpiresAt = date(account.tokenExpiresAt);
  const refreshExpiresAt = date(account.refreshExpiresAt);
  const fields = {
    handle: account.handle,
    displayName: account.displayName,
    // Encrypted by the same cipher when the selection was saved: stored as they are.
    accessTokenEnc: account.accessTokenEnc,
    refreshTokenEnc: account.refreshTokenEnc,
    tokenExpiresAt,
    refreshExpiresAt,
    scopes: account.scopes,
    // SocialAccountMeta parses to plain JSON: strings plus the loose keys Meta sent.
    meta: { ...account.meta, source: "oauth" } as Prisma.InputJsonObject,
    status: statusFromExpiry(
      { tokenExpiresAt, refreshExpiresAt, hasRefreshToken: account.refreshTokenEnc !== null },
      now,
    ),
    // exchange() had Meta vouch for the token (debug_token) when the selection was made.
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
  return row.id;
}

/** Code → long-lived tokens → every Page and linked Instagram account, kept for the admin to pick. */
async function listMetaAccounts(
  deps: Deps,
  stored: StoredOAuthState,
  code: string,
): Promise<string> {
  const tokens = await deps.oauth.meta.exchange(code, { codeVerifier: stored.codeVerifier });
  const listed = await deps.oauth.meta.listAccounts(tokens);
  const accounts: OAuthAccount[] = [
    ...new Map(listed.map((account) => [selectionKeyOf(account), account])).values(),
  ];
  if (accounts.length === 0) throw new AppError("UNPROCESSABLE", MESSAGES.noAccounts);
  await requireEditableClient(deps.prisma, stored.clientId);
  const { sessionId, userId, clientId } = stored;
  return saveOAuthSelection(deps, "meta", { sessionId, userId, clientId }, accounts);
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
    const pick = await listMetaAccounts(deps, stored, query.code);
    deps.logger.info({ clientId }, "Meta OAuth: accounts listed for the admin to pick");
    return {
      redirectTo: oauthResultUrl(deps, clientId, { oauth: "meta", outcome: "choose", pick }),
    };
  } catch (error) {
    return failed(deps, clientId, connectFailure(deps, clientId, error));
  }
}

/** The caller's own selection, or NOT_FOUND (unknown, expired, used, or another session's). */
async function selectionFor(
  deps: Deps,
  user: OAuthSessionUser,
  id: string,
): Promise<StoredOAuthSelection> {
  const selection = await readOAuthSelection(deps, "meta", id, {
    sessionId: user.sessionId,
    userId: user.id,
  });
  if (!selection) throw new AppError("NOT_FOUND", MESSAGES.selectionGone);
  return selection;
}

/** GET /oauth/meta/selections/:id: what the sign-in reached, and which of it can be picked. */
export async function getMetaSelection(
  deps: Deps,
  user: OAuthSessionUser,
  id: string,
): Promise<OAuthSelectionDto> {
  const selection = await selectionFor(deps, user, id);
  const client = await deps.prisma.client.findUnique({
    where: { id: selection.clientId },
    select: { id: true, name: true },
  });
  if (!client) throw notFound("Client");
  const known = await deps.prisma.socialAccount.findMany({
    where: {
      OR: selection.accounts.map((account) => ({
        platform: account.platform,
        externalId: account.externalId,
      })),
    },
    select: {
      platform: true,
      externalId: true,
      clientId: true,
      client: { select: { name: true } },
    },
  });
  const ownerOf = new Map(known.map((row) => [selectionKeyOf(row), row]));
  return {
    id,
    provider: "meta",
    clientId: client.id,
    clientName: client.name,
    expiresAt: new Date(selection.expiresAt).toISOString(),
    accounts: selection.accounts.map((account): OAuthSelectionAccount => {
      const key = selectionKeyOf(account);
      const owner = ownerOf.get(key);
      const taken = owner !== undefined && owner.clientId !== client.id;
      return {
        key,
        platform: account.platform,
        externalId: account.externalId,
        handle: account.handle,
        displayName: account.displayName,
        meta: account.meta,
        status: owner === undefined ? "available" : taken ? "taken" : "connected",
        takenBy: taken ? { clientId: owner.clientId, clientName: owner.client.name } : null,
      };
    }),
  };
}

/**
 * POST /oauth/meta/selections/:id {keys}: the picked accounts connected to the selection's client,
 * in one transaction (audited), each with its encrypted long-lived token. An account another
 * client has is refused (CONFLICT) and nothing is stored; the selection then stays for another
 * pick. Once connected, the selection is used up.
 */
export async function connectMetaSelection(
  deps: Deps,
  user: OAuthSessionUser,
  id: string,
  body: ConnectOAuthSelectionBody,
): Promise<ConnectOAuthSelectionResponse> {
  const selection = await selectionFor(deps, user, id);
  const byKey = new Map(selection.accounts.map((account) => [selectionKeyOf(account), account]));
  const picked = [...new Set(body.keys)].map((key) => byKey.get(key));
  if (picked.some((account) => account === undefined)) {
    throw new AppError("UNPROCESSABLE", MESSAGES.unknownPick);
  }
  const accounts = picked as SelectedAccount[];
  const { clientId } = selection;
  let ids: string[];
  try {
    ids = await deps.prisma.$transaction(async (tx) => {
      await requireEditableClient(tx, clientId);
      await lockClientAccounts(tx, clientId);
      const stored: string[] = [];
      for (const account of accounts) {
        stored.push(await upsertAccount(tx, deps, user, clientId, account));
      }
      const platforms = new Set<Platform>(accounts.map((account) => account.platform));
      for (const platform of platforms) {
        const primary = await settlePrimary(tx, clientId, platform);
        if (primary) {
          await auditChange(
            tx,
            user,
            AUDIT_ACTIONS.socialAccountPrimary,
            { type: AUDITED_ENTITY.socialAccount, id: primary.id },
            { clientId, platform, previousId: null, reason: "the only account on the platform" },
          );
        }
      }
      return stored;
    });
  } catch (error) {
    if (isPrismaError(error, "P2002")) throw conflict(MESSAGES.race);
    throw error;
  }
  await dropOAuthSelection(deps, "meta", id);
  const rows = await deps.prisma.socialAccount.findMany({
    where: { id: { in: ids } },
    select: PUBLIC_COLUMNS,
    orderBy: [{ platform: "asc" }, { handle: "asc" }, { id: "asc" }],
  });
  deps.logger.info({ clientId, connected: rows.length }, "Meta OAuth: accounts connected");
  return { connected: rows.length, items: rows.map(toSocialAccountDto) };
}
