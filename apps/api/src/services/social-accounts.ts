import type { AccountStatus, DbClient, Prisma } from "@enmo/db";
import {
  AUDIT_ACTIONS,
  SocialAccountMeta,
  type CreateSocialAccountRequest,
  type Platform,
  type SocialAccountDto,
} from "@enmo/shared";
import { TokenCryptoError, type TokenCipher } from "../lib/crypto";
import { conflict, notFound } from "../lib/errors";
import {
  auditChange,
  AUDITED_ENTITY,
  isPrismaError,
  requireEditableClient,
  type Actor,
} from "./clients";

/*
 * Connected social accounts (DESIGN §B SocialAccount, §E routes). Tokens are encrypted with
 * lib/crypto before they reach the database and never leave this module: reads select only the
 * public columns below, and the DTO mapper lists its fields explicitly.
 */

const PUBLIC_COLUMNS = {
  id: true,
  clientId: true,
  platform: true,
  externalId: true,
  handle: true,
  displayName: true,
  status: true,
  scopes: true,
  meta: true,
  tokenExpiresAt: true,
  refreshExpiresAt: true,
  lastCheckedAt: true,
  connectedById: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.SocialAccountSelect;

type PublicSocialAccount = Prisma.SocialAccountGetPayload<{ select: typeof PUBLIC_COLUMNS }>;

const iso = (date: Date | null) => date?.toISOString() ?? null;

export function toSocialAccountDto(row: PublicSocialAccount): SocialAccountDto {
  const meta = SocialAccountMeta.safeParse(row.meta);
  return {
    id: row.id,
    clientId: row.clientId,
    platform: row.platform,
    externalId: row.externalId,
    handle: row.handle,
    displayName: row.displayName,
    status: row.status,
    scopes: row.scopes,
    meta: meta.success ? meta.data : {},
    tokenExpiresAt: iso(row.tokenExpiresAt),
    refreshExpiresAt: iso(row.refreshExpiresAt),
    lastCheckedAt: iso(row.lastCheckedAt),
    connectedById: row.connectedById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── Token status ────────────────────────────────────────────────────────────

export interface TokenExpiry {
  tokenExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
  hasRefreshToken: boolean;
}

/**
 * EXPIRED once the access token has lapsed and cannot be refreshed; an expired access token with
 * a live refresh token stays ACTIVE because the token-refresh tick renews it.
 */
export function statusFromExpiry(expiry: TokenExpiry, now: Date): "ACTIVE" | "EXPIRED" {
  const lapsed = (at: Date | null) => at !== null && at.getTime() <= now.getTime();
  if (!lapsed(expiry.tokenExpiresAt)) return "ACTIVE";
  return expiry.hasRefreshToken && !lapsed(expiry.refreshExpiresAt) ? "ACTIVE" : "EXPIRED";
}

export interface AccountTokens {
  accessToken: string;
  refreshToken: string | null;
}

export interface AccountVerification {
  account: PublicSocialAccount;
  tokens: AccountTokens;
  now: Date;
}

/**
 * Decides an account's status once its tokens have decrypted. Phase 1 only knows expiry; Phase 4/5
 * pass a verifier that also asks the platform (Graph `/me`, TikTok user info) via
 * checkSocialAccount's `verify` option.
 */
export type AccountVerifier = (input: AccountVerification) => Promise<AccountStatus>;

export const verifyByExpiry: AccountVerifier = ({ account, tokens, now }) => {
  const status = statusFromExpiry(
    {
      tokenExpiresAt: account.tokenExpiresAt,
      refreshExpiresAt: account.refreshExpiresAt,
      hasRefreshToken: tokens.refreshToken !== null,
    },
    now,
  );
  // Only the platform (or a reconnect) can clear a revocation it reported.
  return Promise.resolve(status === "ACTIVE" && account.status === "REVOKED" ? "REVOKED" : status);
};

// ── Service ─────────────────────────────────────────────────────────────────

export async function listSocialAccounts(
  db: DbClient,
  clientId: string,
): Promise<SocialAccountDto[]> {
  const client = await db.client.findUnique({
    where: { id: clientId },
    select: {
      socialAccounts: {
        select: PUBLIC_COLUMNS,
        orderBy: [{ platform: "asc" }, { handle: "asc" }, { id: "asc" }],
      },
    },
  });
  if (!client) throw notFound("Client");
  return client.socialAccounts.map(toSocialAccountDto);
}

export interface ConnectContext {
  cipher: TokenCipher;
  actor: Actor;
  now: Date;
}

/** Manual connect: the ADMIN pastes a token. OAuth (Phase 4/5) stores accounts the same way. */
export async function connectSocialAccount(
  db: DbClient,
  clientId: string,
  input: CreateSocialAccountRequest,
  { cipher, actor, now }: ConnectContext,
): Promise<SocialAccountDto> {
  const tokenExpiresAt = input.tokenExpiresAt ? new Date(input.tokenExpiresAt) : null;
  const refreshExpiresAt = input.refreshExpiresAt ? new Date(input.refreshExpiresAt) : null;
  const refreshToken = input.refreshToken ?? null;
  const status = statusFromExpiry(
    { tokenExpiresAt, refreshExpiresAt, hasRefreshToken: refreshToken !== null },
    now,
  );

  try {
    return await db.$transaction(async (tx) => {
      await requireEditableClient(tx, clientId);
      const existing = await tx.socialAccount.findUnique({
        where: { platform_externalId: { platform: input.platform, externalId: input.externalId } },
        select: { id: true, clientId: true },
      });
      if (existing) throw accountTaken(input.platform, existing);

      const row = await tx.socialAccount.create({
        data: {
          clientId,
          platform: input.platform,
          externalId: input.externalId,
          handle: input.handle,
          displayName: input.displayName ?? null,
          accessTokenEnc: cipher.encrypt(input.accessToken),
          refreshTokenEnc: refreshToken === null ? null : cipher.encrypt(refreshToken),
          tokenExpiresAt,
          refreshExpiresAt,
          scopes: input.scopes,
          // Loose object parsed from the JSON body, so every extra value is JSON already.
          meta: input.meta as Prisma.InputJsonObject,
          status,
          connectedById: actor.id,
        },
        select: PUBLIC_COLUMNS,
      });
      await auditChange(tx, actor, AUDIT_ACTIONS.socialAccountConnect, accountEntity(row.id), {
        clientId,
        platform: row.platform,
        externalId: row.externalId,
        handle: row.handle,
      });
      return toSocialAccountDto(row);
    });
  } catch (error) {
    // Lost a race with a concurrent connect of the same account.
    if (isPrismaError(error, "P2002")) throw accountTaken(input.platform);
    throw error;
  }
}

export async function disconnectSocialAccount(
  db: DbClient,
  id: string,
  actor: Actor,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const row = await tx.socialAccount.findUnique({
      where: { id },
      select: { clientId: true, platform: true, externalId: true, handle: true },
    });
    if (!row) throw notFound("Social account");
    await tx.socialAccount.delete({ where: { id } });
    await auditChange(tx, actor, AUDIT_ACTIONS.socialAccountDisconnect, accountEntity(id), row);
  });
}

export interface CheckContext {
  cipher: TokenCipher;
  actor: Actor;
  now: Date;
  verify?: AccountVerifier;
}

/**
 * Proves the stored tokens still decrypt with the current TOKEN_ENC_KEY (ERROR otherwise), then
 * lets `verify` decide the status, and records the result on the account.
 */
export async function checkSocialAccount(
  db: DbClient,
  id: string,
  { cipher, actor, now, verify = verifyByExpiry }: CheckContext,
): Promise<SocialAccountDto> {
  const account = await db.socialAccount.findUnique({
    where: { id },
    select: { ...PUBLIC_COLUMNS, accessTokenEnc: true, refreshTokenEnc: true },
  });
  if (!account) throw notFound("Social account");
  const { accessTokenEnc, refreshTokenEnc, ...publicFields } = account;

  let status: AccountStatus;
  let reason: string | undefined;
  try {
    const tokens: AccountTokens = {
      accessToken: cipher.decrypt(accessTokenEnc),
      refreshToken: refreshTokenEnc === null ? null : cipher.decrypt(refreshTokenEnc),
    };
    status = await verify({ account: publicFields, tokens, now });
  } catch (error) {
    if (!(error instanceof TokenCryptoError)) throw error;
    status = "ERROR";
    reason = "token_decrypt_failed";
  }

  // Written after the verifier returns: it may call the platform, which must not hold a transaction.
  return db.$transaction(async (tx) => {
    const row = await tx.socialAccount.update({
      where: { id },
      data: { status, lastCheckedAt: now },
      select: PUBLIC_COLUMNS,
    });
    await auditChange(tx, actor, AUDIT_ACTIONS.socialAccountCheck, accountEntity(id), {
      previousStatus: account.status,
      status,
      ...(reason === undefined ? {} : { reason }),
    });
    return toSocialAccountDto(row);
  });
}

// ── Internals ───────────────────────────────────────────────────────────────

const accountEntity = (id: string) => ({ type: AUDITED_ENTITY.socialAccount, id });

function accountTaken(platform: Platform, existing?: { id: string; clientId: string }) {
  return conflict(
    `This ${platform.toLowerCase()} account is already connected`,
    existing && { socialAccountId: existing.id, clientId: existing.clientId },
  );
}
