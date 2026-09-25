import {
  missingPublishScopes,
  OAuthResultQuery,
  PLATFORM_LABEL,
  type OAuthProviderName,
  type OAuthSelectionAccount,
  type Platform,
  type SocialAccountDto,
} from "@enmo/shared";

/*
 * The Accounts tab's view model (DESIGN §E "OAuth", §F "Meta"): how a connected account is named
 * (a Page by its name, an Instagram account by its @username and the Page it publishes through),
 * whether its token can publish, which account each platform publishes through, the result the
 * OAuth callback redirects back with (`?tab=accounts&oauth=meta&outcome=choose&pick=…`), read once
 * and then taken out of the address, and the pick list a Meta sign-in comes back with. Pure, so
 * it is unit-tested.
 */

const DAY_MS = 86_400_000;
/** Tokens this close to expiry get flagged before tick.tokens marks them EXPIRED. */
export const TOKEN_EXPIRY_WARNING_DAYS = 7;

export interface AccountNames {
  /** "@qahwaco", or a Page's name. */
  primary: string;
  /** "Instagram · via Qahwa Co", "Facebook Page · 1029384756". */
  secondary: string;
}

export function accountNames(account: SocialAccountDto): AccountNames {
  const { meta } = account;
  switch (account.platform) {
    case "INSTAGRAM":
      return {
        primary: `@${meta.username ?? account.handle}`,
        secondary: meta.pageName
          ? `Instagram · via ${meta.pageName}`
          : `Instagram · ${account.displayName ?? account.externalId}`,
      };
    case "FACEBOOK":
      return {
        primary: meta.pageName ?? `@${account.handle}`,
        secondary: `Facebook Page · ${account.externalId}`,
      };
    case "TIKTOK":
      return {
        primary: `@${meta.username ?? account.handle}`,
        secondary: `TikTok · ${account.displayName ?? account.externalId}`,
      };
  }
}

export function accountSource(account: SocialAccountDto): "OAuth" | "Manual" | null {
  if (account.meta.source === "oauth") return "OAuth";
  if (account.meta.source === "manual") return "Manual";
  return null;
}

export type ScopeCheck =
  | { kind: "ok" }
  /** A pasted token with no scopes written down: nobody knows. */
  | { kind: "unknown" }
  | { kind: "missing"; scopes: string[] };

/** Whether the token's granted scopes cover publishing on the account's platform. */
export function scopeCheck(account: SocialAccountDto): ScopeCheck {
  if (account.scopes.length === 0) return { kind: "unknown" };
  const missing = missingPublishScopes(account.platform, account.scopes);
  return missing.length === 0 ? { kind: "ok" } : { kind: "missing", scopes: missing };
}

export type TokenExpiry =
  | { kind: "never" }
  | { kind: "valid"; at: string }
  | { kind: "soon"; at: string }
  | { kind: "expired"; at: string };

export function tokenExpiry(account: SocialAccountDto, now: number = Date.now()): TokenExpiry {
  const at = account.tokenExpiresAt;
  if (!at) return { kind: "never" };
  const left = Date.parse(at) - now;
  if (left <= 0) return { kind: "expired", at };
  return left <= TOKEN_EXPIRY_WARNING_DAYS * DAY_MS ? { kind: "soon", at } : { kind: "valid", at };
}

/* ── The publishing account ─────────────────────────────────────────────────────────────── */

/**
 * Platforms where the client has several accounts and none it publishes through: nothing goes out
 * live there until an admin chooses one.
 */
export function unchosenPlatforms(accounts: readonly SocialAccountDto[]): Platform[] {
  const platforms = [...new Set(accounts.map((account) => account.platform))];
  return platforms.filter(
    (platform) =>
      !accounts.some((account) => account.platform === platform && account.isPrimary) &&
      accounts.filter((account) => account.platform === platform).length > 1,
  );
}

/** Whether "Publish through this" applies: an active account its platform doesn't publish through. */
export function canBecomePrimary(account: SocialAccountDto): boolean {
  return !account.isPrimary && account.status === "ACTIVE";
}

/* ── A Meta sign-in's pick list ────────────────────────────────────────────────────────────── */

/** "Qahwa Co" (a Page), "@qahwa.co" (an Instagram account). */
export function selectionName(account: OAuthSelectionAccount): string {
  if (account.platform === "FACEBOOK") return account.meta.pageName ?? account.handle;
  return `@${account.meta.username ?? account.handle}`;
}

/** "Facebook Page · 1000…1", "Instagram · via Qahwa Co". */
export function selectionDetail(account: OAuthSelectionAccount): string {
  if (account.platform === "FACEBOOK") return `Facebook Page · ${account.externalId}`;
  const via = account.meta.pageName ? `via ${account.meta.pageName}` : account.externalId;
  return `${PLATFORM_LABEL[account.platform]} · ${via}`;
}

/** Why an account can't be picked, or null when it can. */
export function selectionBlock(account: OAuthSelectionAccount): string | null {
  if (account.status !== "taken") return null;
  const owner = account.takenBy?.clientName ?? "another client";
  return `Already connected to ${owner}. Disconnect it there first.`;
}

/**
 * What starts ticked: the accounts already this client's (picking them again refreshes their
 * tokens) and, when Meta listed a single Page anyone could take, that Page and its Instagram
 * account. Several free Pages start unticked: the admin says which are this client's.
 */
export function initialPicks(accounts: readonly OAuthSelectionAccount[]): string[] {
  const connected = accounts.filter((account) => account.status === "connected");
  const available = accounts.filter((account) => account.status === "available");
  const pages = available.filter((account) => account.platform === "FACEBOOK");
  if (connected.length > 0 || pages.length !== 1) return connected.map((account) => account.key);
  const pageId = pages[0]!.externalId;
  return available
    .filter((account) => account.externalId === pageId || account.meta.pageId === pageId)
    .map((account) => account.key);
}

/* ── The OAuth callback's result ───────────────────────────────────────────────────────────── */

/** The query keys the callback's redirect adds (next to `tab=accounts`). */
export const OAUTH_RESULT_KEYS = ["oauth", "outcome", "connected", "pick", "message"] as const;

const MESSAGE_MAX = 500;

/** The result a redirect landed with, or null when there is none (or it doesn't parse). */
export function oauthResultFrom(params: {
  get(name: string): string | null;
}): OAuthResultQuery | null {
  if (!params.get("oauth")) return null;
  const parsed = OAuthResultQuery.safeParse({
    oauth: params.get("oauth"),
    outcome: params.get("outcome"),
    connected: params.get("connected") ?? undefined,
    pick: params.get("pick") ?? undefined,
    message: params.get("message")?.slice(0, MESSAGE_MAX) ?? undefined,
  });
  return parsed.success ? parsed.data : null;
}

/** The pick list a sign-in came back with, when the admin still has to choose. */
export function pendingSelection(result: OAuthResultQuery | null): string | null {
  return result?.outcome === "choose" && result.pick ? result.pick : null;
}

/** The same address without the result, so a reload doesn't announce it again. */
export function withoutOAuthResult(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of OAUTH_RESULT_KEYS) params.delete(key);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

const PROVIDER_LABEL: Readonly<Record<OAuthProviderName, string>> = {
  meta: "Meta",
  tiktok: "TikTok",
};

const CONNECTED_DETAIL: Readonly<Record<OAuthProviderName, string>> = {
  meta: "Each account you picked is connected with an encrypted long-lived token. Where several share a platform, choose the one the Publisher posts through.",
  tiktok: "The account can publish now. Its tokens are encrypted at rest.",
};

export interface OAuthNotice {
  tone: "success" | "error";
  title: string;
  description: string;
}

export function oauthNotice(result: OAuthResultQuery): OAuthNotice {
  const provider = PROVIDER_LABEL[result.oauth];
  if (result.outcome === "choose") {
    return {
      tone: "success",
      title: `Choose the ${provider} accounts to connect`,
      description: "Pick this client's Pages and Instagram accounts from what Meta returned.",
    };
  }
  if (result.outcome === "error") {
    return {
      tone: "error",
      title: `Couldn't connect ${provider}`,
      description: result.message ?? "Start the connection again from the client's accounts.",
    };
  }
  const count = result.connected;
  return {
    tone: "success",
    title:
      count === undefined
        ? `${provider} connected`
        : `${count} ${provider} account${count === 1 ? "" : "s"} connected`,
    description: CONNECTED_DETAIL[result.oauth],
  };
}
