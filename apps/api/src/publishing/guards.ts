import { COPY_BANNED_SCAN_IGNORE } from "@enmo/agents";
import type { AccountStatus, DbTransaction, SocialAccount } from "@enmo/db";
import type { DecryptedAccount } from "@enmo/providers";
import {
  missingPublishScopes,
  PLATFORM_LABEL,
  scanForBannedWords,
  SocialAccountMeta,
  type ApprovalStatus,
  type BannedWordHit,
  type Platform,
} from "@enmo/shared";
import { currentContentHash } from "../orchestrator/approval-round";
import { TokenCryptoError, type TokenCipher } from "../lib/crypto";

/*
 * The publish guard (DESIGN §F "Publishing safety"): when a job's slot comes, nothing goes out
 * unless (0) neither its campaign nor its client is archived, (1) the post's latest approval round
 * is APPROVED, (2) its contentHash still matches what the post holds now, (3) no text going out
 * uses the client's banned words (the list may have grown since approval), and (4) for a live job,
 * the account is ACTIVE with a token that decrypts, hasn't expired and carries the publishing
 * scopes. evaluateGuards is the pure decision; checkPublishGuards reads its inputs inside the
 * publish transaction.
 */

export type GuardName = "archived" | "approval" | "contentHash" | "bannedWords" | "token";

export interface GuardFailure {
  guard: GuardName;
  /** One sentence for people. */
  message: string;
  /** For a token failure: what the account turned out to be (null leaves its status alone). */
  accountStatus: AccountStatus | null;
  /** For a banned-words failure: each hit in what goes out. */
  bannedHits?: readonly BannedWordHit[];
}

/** The account side of a live job, as read for the guard. */
export type TokenState =
  | { kind: "missing" }
  | {
      kind: "account";
      platform: Platform;
      status: AccountStatus;
      tokenExpiresAt: Date | null;
      /** [] when the platform never reported them (a pasted token): not held against it. */
      scopes: readonly string[];
      decrypts: boolean;
    };

export interface GuardSnapshot {
  platform: Platform;
  /** What of the post's is archived, if anything. */
  archived: "campaign" | "client" | null;
  latestRound: { status: ApprovalStatus; contentHash: string } | null;
  currentHash: string;
  bannedHits: readonly BannedWordHit[];
  /** Null for a dry run, which uses no token. */
  token: TokenState | null;
  now: Date;
}

function tokenFailure(snapshot: GuardSnapshot, token: TokenState): GuardFailure | null {
  const label = PLATFORM_LABEL[snapshot.platform];
  if (token.kind === "missing") {
    return {
      guard: "token",
      message: `No ${label} account is connected to publish through`,
      accountStatus: null,
    };
  }
  if (token.platform !== snapshot.platform) {
    return {
      guard: "token",
      message: `The job's account is a ${PLATFORM_LABEL[token.platform]} account, not ${label}`,
      accountStatus: null,
    };
  }
  if (token.status !== "ACTIVE") {
    return {
      guard: "token",
      message: `The ${label} account is ${token.status.toLowerCase()}; reconnect it`,
      accountStatus: null,
    };
  }
  if (!token.decrypts) {
    return {
      guard: "token",
      message: `The ${label} account's token can't be decrypted with the current key; reconnect it`,
      accountStatus: "ERROR",
    };
  }
  if (token.tokenExpiresAt && token.tokenExpiresAt.getTime() <= snapshot.now.getTime()) {
    return {
      guard: "token",
      message: `The ${label} account's token expired on ${token.tokenExpiresAt.toISOString()}; reconnect it`,
      accountStatus: "EXPIRED",
    };
  }
  const missing =
    token.scopes.length > 0 ? missingPublishScopes(snapshot.platform, token.scopes) : [];
  if (missing.length > 0) {
    return {
      guard: "token",
      message: `The ${label} account's token lacks ${missing.join(", ")}; reconnect it with publishing permissions`,
      accountStatus: null,
    };
  }
  return null;
}

/** The first guard the job fails, in the order DESIGN lists them; null when it may publish. */
export function evaluateGuards(snapshot: GuardSnapshot): GuardFailure | null {
  if (snapshot.archived) {
    return {
      guard: "archived",
      message:
        snapshot.archived === "campaign" ? "The post's campaign is archived" : "The client is archived",
      accountStatus: null,
    };
  }
  const round = snapshot.latestRound;
  if (!round || round.status !== "APPROVED") {
    return {
      guard: "approval",
      message: round
        ? `The post's latest approval round is ${round.status.toLowerCase().replaceAll("_", " ")}, not approved`
        : "The post has no approval round",
      accountStatus: null,
    };
  }
  if (round.contentHash !== snapshot.currentHash) {
    return {
      guard: "contentHash",
      message: "The post's content changed after it was approved",
      accountStatus: null,
    };
  }
  if (snapshot.bannedHits.length > 0) {
    const terms = [...new Set(snapshot.bannedHits.map((hit) => hit.term))];
    return {
      guard: "bannedWords",
      message: `The post uses the client's banned words: ${terms.map((term) => `"${term}"`).join(", ")}`,
      accountStatus: null,
      bannedHits: snapshot.bannedHits,
    };
  }
  return snapshot.token ? tokenFailure(snapshot, snapshot.token) : null;
}

export interface GuardInput {
  postId: string;
  archived: "campaign" | "client" | null;
  /** Post.copy as stored. */
  copy: unknown;
  bannedWords: readonly string[];
  variant: { platform: Platform; caption: string; hashtags: readonly string[] };
  job: { dryRun: boolean; socialAccountId: string | null };
  now: Date;
}

export type GuardOutcome =
  { ok: true; account: DecryptedAccount | null } | { ok: false; failure: GuardFailure };

type AccountRow = Pick<
  SocialAccount,
  "id" | "platform" | "externalId" | "handle" | "meta" | "accessTokenEnc"
>;

/** The account with its token decrypted, or null when the token doesn't decrypt. */
export function decryptAccount(row: AccountRow, cipher: TokenCipher): DecryptedAccount | null {
  let accessToken: string;
  try {
    accessToken = cipher.decrypt(row.accessTokenEnc);
  } catch (error) {
    if (error instanceof TokenCryptoError) return null;
    throw error;
  }
  const meta = SocialAccountMeta.safeParse(row.meta);
  return {
    id: row.id,
    platform: row.platform,
    externalId: row.externalId,
    handle: row.handle,
    accessToken,
    meta: meta.success ? meta.data : {},
  };
}

/** Every string that goes out with the variant, plus the copy it was approved from. */
function publishedText(input: GuardInput) {
  return {
    copy: input.copy,
    variant: { caption: input.variant.caption, hashtags: [...input.variant.hashtags] },
  };
}

/**
 * Runs the guard for one job inside the publish transaction (after its rounds and post are
 * locked). A passing live job gets its account with the token decrypted, for this publish only.
 */
export async function checkPublishGuards(
  tx: DbTransaction,
  cipher: TokenCipher,
  input: GuardInput,
): Promise<GuardOutcome> {
  const round = await tx.approvalRequest.findFirst({
    where: { postId: input.postId },
    orderBy: { round: "desc" },
    select: { status: true, contentHash: true },
  });
  const currentHash = await currentContentHash(tx, input.postId);
  const bannedHits = scanForBannedWords(publishedText(input), input.bannedWords, {
    ignoreKeys: COPY_BANNED_SCAN_IGNORE,
    limit: 20,
  });

  let token: TokenState | null = null;
  let account: DecryptedAccount | null = null;
  if (!input.job.dryRun) {
    const row = input.job.socialAccountId
      ? await tx.socialAccount.findUnique({ where: { id: input.job.socialAccountId } })
      : null;
    if (!row) {
      token = { kind: "missing" };
    } else {
      account = decryptAccount(row, cipher);
      token = {
        kind: "account",
        platform: row.platform,
        status: row.status,
        tokenExpiresAt: row.tokenExpiresAt,
        scopes: row.scopes,
        decrypts: account !== null,
      };
    }
  }

  const failure = evaluateGuards({
    platform: input.variant.platform,
    archived: input.archived,
    latestRound: round,
    currentHash,
    bannedHits,
    token,
    now: input.now,
  });
  return failure ? { ok: false, failure } : { ok: true, account };
}
