import { createOAuthState, type OAuthAccount } from "@enmo/providers";
import {
  OAUTH_STATE_TTL_SECONDS,
  Platform,
  SocialAccountMeta,
  type OAuthProviderName,
} from "@enmo/shared";
import { z } from "zod";
import type { Deps } from "../deps";
import { SECOND_MS } from "../lib/clock";
import { sha256 } from "../lib/tokens";
import type { OAuthStateBinding } from "./oauth-state";

/*
 * The accounts an OAuth sign-in reached, kept while the admin picks which belong to the client
 * (DESIGN §E "OAuth"). Meta lists every Page the admin ever granted the app, so nothing is stored
 * as a SocialAccount until they choose. A selection lives in Redis for OAUTH_STATE_TTL_SECONDS
 * under its id's sha256, bound to the admin's session and the client like the state it came from;
 * its tokens are encrypted with deps.tokenCipher before they leave the process, as a stored
 * account's are. The stored expiry is checked against the injected clock, so tests can move time.
 */

const IsoDate = z.iso.datetime();

const StoredAccount = z.object({
  platform: Platform,
  externalId: z.string().min(1),
  handle: z.string(),
  displayName: z.string().nullable(),
  meta: SocialAccountMeta,
  accessTokenEnc: z.string().min(1),
  refreshTokenEnc: z.string().min(1).nullable(),
  tokenExpiresAt: IsoDate.nullable(),
  refreshExpiresAt: IsoDate.nullable(),
  scopes: z.array(z.string()),
});

export const StoredOAuthSelection = z.object({
  provider: z.enum(["meta", "tiktok"]),
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  clientId: z.string().min(1),
  /** Epoch ms by deps.clock. */
  expiresAt: z.number(),
  accounts: z.array(StoredAccount),
});
export type StoredOAuthSelection = z.infer<typeof StoredOAuthSelection>;

type SelectionDeps = Pick<Deps, "redis" | "clock" | "config" | "tokenCipher">;

function selectionKey(deps: Pick<Deps, "config">, provider: OAuthProviderName, id: string) {
  return `${deps.config.BULLMQ_PREFIX}:oauth:${provider}:selection:${sha256(id)}`;
}

/** "<PLATFORM>:<externalId>": how an account is picked from a selection. */
export function selectionKeyOf(account: Pick<OAuthAccount, "platform" | "externalId">): string {
  return `${account.platform}:${account.externalId}`;
}

/** Keeps the accounts (tokens encrypted) for the admin to choose from; returns the new id. */
export async function saveOAuthSelection(
  deps: SelectionDeps,
  provider: OAuthProviderName,
  binding: OAuthStateBinding,
  accounts: readonly OAuthAccount[],
): Promise<string> {
  const id = createOAuthState();
  const iso = (date: Date | null) => date?.toISOString() ?? null;
  const stored: StoredOAuthSelection = {
    provider,
    ...binding,
    expiresAt: deps.clock.now().getTime() + OAUTH_STATE_TTL_SECONDS * SECOND_MS,
    accounts: accounts.map(({ tokens, ...account }) => ({
      platform: account.platform,
      externalId: account.externalId,
      handle: account.handle,
      displayName: account.displayName,
      meta: account.meta,
      accessTokenEnc: deps.tokenCipher.encrypt(tokens.accessToken),
      refreshTokenEnc:
        tokens.refreshToken === null ? null : deps.tokenCipher.encrypt(tokens.refreshToken),
      tokenExpiresAt: iso(tokens.expiresAt),
      refreshExpiresAt: iso(tokens.refreshExpiresAt),
      scopes: tokens.scopes,
    })),
  };
  await deps.redis.set(
    selectionKey(deps, provider, id),
    JSON.stringify(stored),
    "EX",
    OAUTH_STATE_TTL_SECONDS,
  );
  return id;
}

/**
 * The selection, or null when it is unknown, expired, unreadable or another session's: a
 * selection made in one signed-in browser means nothing to anyone else.
 */
export async function readOAuthSelection(
  deps: SelectionDeps,
  provider: OAuthProviderName,
  id: string,
  caller: { sessionId: string; userId: string },
): Promise<StoredOAuthSelection | null> {
  const raw = await deps.redis.get(selectionKey(deps, provider, id));
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = StoredOAuthSelection.safeParse(value);
  if (!parsed.success) return null;
  const selection = parsed.data;
  if (selection.provider !== provider) return null;
  if (selection.expiresAt <= deps.clock.now().getTime()) return null;
  if (selection.sessionId !== caller.sessionId || selection.userId !== caller.userId) return null;
  return selection;
}

/** Ends a selection once its accounts are connected: it works once, like the state. */
export async function dropOAuthSelection(
  deps: Pick<Deps, "redis" | "config">,
  provider: OAuthProviderName,
  id: string,
): Promise<void> {
  await deps.redis.del(selectionKey(deps, provider, id));
}
