import type { AccountStatus } from "@enmo/db";
import { META_PLATFORMS, OAuthError, type TokenInfo } from "@enmo/providers";
import { missingPublishScopes, PLATFORM_LABEL, type Platform } from "@enmo/shared";
import type { Deps } from "../deps";
import { DAY_MS } from "../lib/clock";
import { TokenCryptoError } from "../lib/crypto";
import { EventBatch } from "../orchestrator/events";
import { accountAlert } from "./context";

/*
 * tick.tokens, hourly (DESIGN §D, §F "Meta OAuth"): each ACTIVE Meta account is checked once a day
 * with debug_token. A token Meta no longer honours marks the account EXPIRED (it lapsed) or
 * REVOKED (withdrawn: a password change, the app removed) with a `token_expiring` alert, as does
 * one that can't be decrypted (ERROR); a valid token expiring within TOKEN_EXPIRY_WARNING_MS, or
 * one lacking the publishing scopes, gets the alert while the account stays ACTIVE. Without a Meta
 * app configured the check falls back to the stored expiry.
 */

export const TOKEN_CHECK_INTERVAL_MS = DAY_MS;
export const TOKEN_EXPIRY_WARNING_MS = 7 * DAY_MS;

export interface TokenTickReport {
  checked: number;
  /** Accounts that left ACTIVE. */
  deactivated: number;
  /** ACTIVE accounts that got a warning. */
  warned: number;
  /** Accounts left for the next tick (Meta unreachable). */
  skipped: number;
}

interface CheckedAccount {
  id: string;
  clientId: string;
  platform: Platform;
  handle: string;
  accessTokenEnc: string;
  tokenExpiresAt: Date | null;
  scopes: string[];
}

interface Verdict {
  status: AccountStatus;
  tokenExpiresAt: Date | null;
  scopes: string[];
  /** Why it left ACTIVE, for the alert. */
  reason: string | null;
}

function expired(at: Date | null, now: Date): boolean {
  return at !== null && at.getTime() <= now.getTime();
}

/** The account's status per Meta, or null when Meta couldn't be asked (try again next tick). */
async function assess(deps: Deps, account: CheckedAccount, now: Date): Promise<Verdict | null> {
  const stored = { tokenExpiresAt: account.tokenExpiresAt, scopes: account.scopes };
  let token: string;
  try {
    token = deps.tokenCipher.decrypt(account.accessTokenEnc);
  } catch (error) {
    if (!(error instanceof TokenCryptoError)) throw error;
    return {
      ...stored,
      status: "ERROR",
      reason: "its token can't be decrypted with the current key",
    };
  }
  if (expired(account.tokenExpiresAt, now)) {
    return { ...stored, status: "EXPIRED", reason: "its token expired" };
  }
  let info: TokenInfo;
  try {
    info = await deps.oauth.meta.debugToken(token);
  } catch (error) {
    if (error instanceof OAuthError && error.code === "NOT_CONFIGURED") {
      return { ...stored, status: "ACTIVE", reason: null };
    }
    deps.logger.warn({ err: error, socialAccountId: account.id }, "debug_token failed");
    return null;
  }
  const scopes = info.scopes.length > 0 ? info.scopes : account.scopes;
  if (!info.valid) {
    const lapsed = expired(info.expiresAt, now);
    return {
      status: lapsed ? "EXPIRED" : "REVOKED",
      tokenExpiresAt: info.expiresAt ?? account.tokenExpiresAt,
      scopes,
      reason: info.error ?? (lapsed ? "its token expired" : "Meta no longer accepts its token"),
    };
  }
  return { status: "ACTIVE", tokenExpiresAt: info.expiresAt, scopes, reason: null };
}

/** What an ACTIVE account should hear about, if anything. */
function warningFor(account: CheckedAccount, verdict: Verdict, now: Date): string | null {
  const missing =
    verdict.scopes.length > 0 ? missingPublishScopes(account.platform, verdict.scopes) : [];
  if (missing.length > 0) return `its token lacks ${missing.join(", ")}; reconnect it`;
  const at = verdict.tokenExpiresAt;
  if (at && at.getTime() - now.getTime() <= TOKEN_EXPIRY_WARNING_MS) {
    const days = Math.max(1, Math.ceil((at.getTime() - now.getTime()) / DAY_MS));
    return `its token expires in ${days === 1 ? "1 day" : `${days} days`}; reconnect it before then`;
  }
  return null;
}

/** tick.tokens. */
export async function checkAccountTokens(deps: Deps): Promise<TokenTickReport> {
  const report: TokenTickReport = { checked: 0, deactivated: 0, warned: 0, skipped: 0 };
  const now = deps.clock.now();
  const due = await deps.prisma.socialAccount.findMany({
    where: {
      platform: { in: [...META_PLATFORMS] },
      status: "ACTIVE",
      OR: [
        { lastCheckedAt: null },
        { lastCheckedAt: { lte: new Date(now.getTime() - TOKEN_CHECK_INTERVAL_MS) } },
      ],
    },
    select: {
      id: true,
      clientId: true,
      platform: true,
      handle: true,
      accessTokenEnc: true,
      tokenExpiresAt: true,
      scopes: true,
    },
    orderBy: { id: "asc" },
  });

  for (const account of due) {
    const verdict = await assess(deps, account, now);
    if (!verdict) {
      report.skipped += 1;
      continue;
    }
    // Only an account still ACTIVE: a reconnect meanwhile wrote a new token.
    const [row] = await deps.prisma.socialAccount.updateManyAndReturn({
      where: { id: account.id, status: "ACTIVE" },
      data: {
        status: verdict.status,
        lastCheckedAt: now,
        tokenExpiresAt: verdict.tokenExpiresAt,
        scopes: verdict.scopes,
      },
      select: { id: true },
    });
    if (!row) continue;
    report.checked += 1;
    const label = `${PLATFORM_LABEL[account.platform]} account ${account.handle}`;
    const events = new EventBatch();
    if (verdict.status !== "ACTIVE") {
      report.deactivated += 1;
      accountAlert(
        events,
        account,
        `${label} is ${verdict.status.toLowerCase()}: ${verdict.reason ?? "its token no longer works"}. Reconnect it; nothing can publish through it until then.`,
      );
    } else {
      const warning = warningFor(account, verdict, now);
      if (warning) {
        report.warned += 1;
        accountAlert(events, account, `${label}: ${warning}.`);
      }
    }
    await events.publish(deps);
  }
  return report;
}
