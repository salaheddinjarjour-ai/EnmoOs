import { z } from "zod";
import { META_OAUTH_SCOPES, type SocialAccountMeta } from "@enmo/shared";
import { metaConfigured, metaUrl, type MetaConfig } from "../meta/config";
import {
  GraphApiError,
  GraphClient,
  GraphId,
  META_DEFAULT_TIMEOUT_MS,
  isGraphError,
  type GraphRequest,
} from "../publish/graph-client";
import {
  OAuthError,
  type OAuthAccount,
  type OAuthErrorCode,
  type OAuthProvider,
  type OAuthTokens,
  type PkceChallenge,
  type PkceVerifier,
  type TokenInfo,
} from "./types";

/*
 * Meta OAuth (DESIGN §F "Meta"): the consent dialog asks for META_OAUTH_SCOPES; the callback
 * exchanges the code, swaps the short-lived user token for a long-lived one (fb_exchange_token),
 * and asks debug_token which scopes the admin actually granted (the dialog lets them untick some).
 * listAccounts reads /me/accounts?fields=id,name,access_token,instagram_business_account{id,username}
 * and returns one account per Page plus one per linked Instagram account, each with the Page's
 * token (which doesn't expire when it comes from a long-lived user token). debugToken() calls
 * /debug_token with the app token for tick.tokens.
 */

export interface MetaOAuthOptions extends MetaConfig {
  /** The API's callback URL registered with the Meta app (…/v1/oauth/meta/callback). */
  redirectUri: string;
  fetch: typeof globalThis.fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
}

const ACCOUNT_FIELDS = "id,name,access_token,instagram_business_account{id,username}";
/** Pages per /me/accounts page, and how many pages to follow (1,000 Pages is plenty). */
const ACCOUNTS_PAGE_SIZE = 100;
const ACCOUNTS_MAX_PAGES = 10;

const AccessToken = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
});

const PageList = z.object({
  data: z.array(
    z.looseObject({
      id: GraphId,
      name: z.string(),
      access_token: z.string().min(1).optional(),
      instagram_business_account: z
        .looseObject({ id: GraphId, username: z.string().optional() })
        .optional(),
    }),
  ),
  paging: z
    .looseObject({
      cursors: z.looseObject({ after: z.string().optional() }).optional(),
      next: z.string().optional(),
    })
    .optional(),
});
type Page = z.output<typeof PageList>["data"][number];

const DebugToken = z.object({
  data: z.looseObject({
    app_id: z.string().optional(),
    is_valid: z.boolean(),
    /** Unix seconds; 0 when the token never expires. */
    expires_at: z.number().optional(),
    scopes: z.array(z.string()).optional(),
    user_id: z.string().optional(),
    /** A Page token's Page. */
    profile_id: z.string().optional(),
    error: z.looseObject({ message: z.string().optional() }).optional(),
  }),
});

/** Code 100 with these subcodes: the code is invalid, expired, already used or for another URI. */
const BAD_CODE_SUBCODES: ReadonlySet<number> = new Set([36007, 36008, 36009]);

function isPermissionError(error: GraphApiError): boolean {
  const { code } = error;
  return code === 190 || code === 10 || (code !== null && code >= 200 && code <= 299);
}

function asOAuthError(
  error: unknown,
  operation: string,
  denied: (error: GraphApiError) => boolean,
): OAuthError {
  if (error instanceof OAuthError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code: OAuthErrorCode =
    error instanceof GraphApiError && denied(error) ? "DENIED" : "API_ERROR";
  const status = error instanceof GraphApiError ? error.status : null;
  return new OAuthError(code, `${operation}: ${message}`, {
    status,
    cause: isGraphError(error) ? error : undefined,
  });
}

function unixToDate(seconds: number | undefined): Date | null {
  return seconds ? new Date(seconds * 1_000) : null;
}

export class MetaOAuthProvider implements OAuthProvider {
  readonly name = "meta" as const;
  readonly options: MetaOAuthOptions;
  readonly #graph: GraphClient;

  constructor(options: MetaOAuthOptions) {
    this.options = options;
    this.#graph = new GraphClient({
      fetch: options.fetch,
      appSecret: options.appSecret,
      timeoutMs: options.timeoutMs ?? META_DEFAULT_TIMEOUT_MS,
    });
  }

  authorizeUrl(state: string, pkce?: PkceChallenge): string {
    const { appId } = this.#app();
    const { dialogBaseUrl, graphVersion, redirectUri } = this.options;
    return metaUrl(dialogBaseUrl, graphVersion, "dialog/oauth", {
      client_id: appId,
      redirect_uri: redirectUri,
      state,
      response_type: "code",
      scope: META_OAUTH_SCOPES.join(","),
      // Asks again for any permission the admin declined the last time they connected.
      auth_type: "rerequest",
      ...(pkce ? { code_challenge: pkce.codeChallenge, code_challenge_method: "S256" } : {}),
    });
  }

  async exchange(code: string, pkce?: PkceVerifier): Promise<OAuthTokens> {
    const { appId, appSecret } = this.#app();
    const short = await this.#call(
      "Meta refused the sign-in code",
      (error) =>
        error.code === 190 || (error.code === 100 && BAD_CODE_SUBCODES.has(error.subcode ?? 0)),
      {
        method: "GET",
        url: this.#url("oauth/access_token", {
          client_id: appId,
          client_secret: appSecret,
          redirect_uri: this.options.redirectUri,
          code,
          ...(pkce ? { code_verifier: pkce.codeVerifier } : {}),
        }),
      },
      AccessToken,
    );
    const long = await this.#call(
      "Meta would not extend the sign-in",
      (error) => error.code === 190,
      {
        method: "GET",
        url: this.#url("oauth/access_token", {
          grant_type: "fb_exchange_token",
          client_id: appId,
          client_secret: appSecret,
          fb_exchange_token: short.access_token,
        }),
      },
      AccessToken,
    );
    const info = await this.debugToken(long.access_token);
    if (!info.valid) {
      throw new OAuthError(
        "API_ERROR",
        `Meta rejected the token it just issued: ${info.error ?? "no reason given"}`,
      );
    }
    return {
      accessToken: long.access_token,
      refreshToken: null,
      expiresAt: info.expiresAt,
      refreshExpiresAt: null,
      scopes: info.scopes,
    };
  }

  async listAccounts(tokens: OAuthTokens): Promise<OAuthAccount[]> {
    this.#app();
    const pages: Page[] = [];
    let after: string | undefined;
    for (let page = 0; page < ACCOUNTS_MAX_PAGES; page += 1) {
      const body = await this.#call(
        "Meta would not list the Pages",
        isPermissionError,
        {
          method: "GET",
          url: this.#url("me/accounts", {
            fields: ACCOUNT_FIELDS,
            limit: String(ACCOUNTS_PAGE_SIZE),
            ...(after ? { after } : {}),
          }),
          token: tokens.accessToken,
        },
        PageList,
      );
      pages.push(...body.data);
      after = body.paging?.cursors?.after;
      if (!body.paging?.next || !after) break;
    }
    return pages.flatMap((page) => accountsOf(page, tokens.scopes));
  }

  async debugToken(accessToken: string): Promise<TokenInfo> {
    const { appId, appSecret } = this.#app();
    const { data } = await this.#call(
      "Meta could not check the token",
      () => false,
      {
        method: "GET",
        url: this.#url("debug_token", {
          input_token: accessToken,
          access_token: `${appId}|${appSecret}`,
        }),
      },
      DebugToken,
    );
    const otherApp = data.app_id !== undefined && data.app_id !== appId;
    const expiresAt = unixToDate(data.expires_at);
    return {
      valid: data.is_valid && !otherApp,
      expiresAt,
      scopes: data.scopes ?? [],
      subjectId: data.profile_id ?? data.user_id ?? null,
      error: otherApp
        ? "The token belongs to another Meta app"
        : data.is_valid
          ? null
          : (data.error?.message ?? "Meta reports the token as invalid"),
    };
  }

  #app(): { appId: string; appSecret: string } {
    const { appId, appSecret } = this.options;
    if (!metaConfigured(this.options) || !appId || !appSecret) {
      throw new OAuthError(
        "NOT_CONFIGURED",
        "Connecting Meta accounts needs META_APP_ID and META_APP_SECRET",
      );
    }
    return { appId, appSecret };
  }

  #url(path: string, query: Record<string, string>): string {
    return metaUrl(this.options.graphBaseUrl, this.options.graphVersion, path, query);
  }

  async #call<T extends z.ZodType>(
    operation: string,
    denied: (error: GraphApiError) => boolean,
    request: GraphRequest,
    schema: T,
  ): Promise<z.output<T>> {
    try {
      return await this.#graph.call(request, schema);
    } catch (error) {
      throw asOAuthError(error, operation, denied);
    }
  }
}

/** A Page as its Facebook account, and its linked Instagram account when it has one. */
function accountsOf(page: Page, scopes: readonly string[]): OAuthAccount[] {
  // Without a Page token (the admin can't manage the Page's content) nothing can publish there.
  if (!page.access_token) return [];
  const tokens: OAuthTokens = {
    accessToken: page.access_token,
    refreshToken: null,
    expiresAt: null,
    refreshExpiresAt: null,
    scopes: [...scopes],
  };
  const pageMeta: SocialAccountMeta = { pageId: page.id, pageName: page.name, source: "oauth" };
  const accounts: OAuthAccount[] = [
    {
      platform: "FACEBOOK",
      externalId: page.id,
      handle: page.name,
      displayName: page.name,
      tokens,
      meta: pageMeta,
    },
  ];
  const instagram = page.instagram_business_account;
  if (instagram) {
    const { username } = instagram;
    accounts.push({
      platform: "INSTAGRAM",
      externalId: instagram.id,
      handle: username ?? instagram.id,
      displayName: null,
      tokens: { ...tokens, scopes: [...scopes] },
      meta: { ...pageMeta, igUserId: instagram.id, ...(username ? { username } : {}) },
    });
  }
  return accounts;
}
