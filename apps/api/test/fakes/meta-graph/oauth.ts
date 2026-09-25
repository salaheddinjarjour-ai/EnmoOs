import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { META_OAUTH_SCOPES } from "@enmo/shared";
import {
  FAKE_META_APP,
  authenticate,
  checkVersion,
  invalidParameter,
  lookupToken,
  newId,
  nowSeconds,
  paramsOf,
  pkceChallenge,
  sendGraphError,
  text,
  type FakeCode,
  type FakeGraphState,
  type FakeToken,
} from "./world";

/*
 * Facebook Login as the fake plays it:
 *   GET /{v}/dialog/oauth           the consent dialog: redirects straight back to redirect_uri
 *                                   with a code (or error=access_denied when state.consent is deny)
 *   GET /{v}/oauth/access_token     code → short-lived user token; grant_type=fb_exchange_token →
 *                                   long-lived (60 days)
 *   GET /{v}/me/accounts            the user's Pages with their Page tokens and linked Instagram
 *                                   accounts, paged by limit/after
 *   GET /{v}/debug_token            what a token is, for the app token APP_ID|APP_SECRET
 */

const SHORT_LIVED_SECONDS = 2 * 3_600;
const LONG_LIVED_SECONDS = 60 * 86_400;
const DATA_ACCESS_SECONDS = 90 * 86_400;

function grantedScopes(state: FakeGraphState, requested: readonly string[]): string[] {
  return requested.filter((scope) => !state.declinedScopes.includes(scope));
}

function mintUserToken(state: FakeGraphState, scopes: string[], lifetime: number, kind: string) {
  const accessToken = `fake-user-token-${kind}-${newId(state, "")}`;
  const token: FakeToken = {
    type: "USER",
    subjectId: state.user.id,
    userId: state.user.id,
    scopes,
    expiresAt: nowSeconds() + lifetime,
  };
  state.tokens.set(accessToken, token);
  return { access_token: accessToken, token_type: "bearer", expires_in: lifetime };
}

function badCode(reply: FastifyReply, message: string, subcode: number) {
  return sendGraphError(reply, 400, {
    message,
    type: "OAuthException",
    code: 100,
    error_subcode: subcode,
  });
}

function checkApp(params: Record<string, unknown>, reply: FastifyReply): boolean {
  if (text(params, "client_id") !== FAKE_META_APP.appId) {
    void sendGraphError(reply, 400, {
      message: "Error validating application. Invalid application ID.",
      type: "OAuthException",
      code: 101,
    });
    return false;
  }
  if (text(params, "client_secret") !== FAKE_META_APP.appSecret) {
    void sendGraphError(reply, 400, {
      message: "Error validating client secret.",
      type: "OAuthException",
      code: 1,
    });
    return false;
  }
  return true;
}

function dialog(state: FakeGraphState, request: FastifyRequest, reply: FastifyReply) {
  const params = paramsOf(request);
  if (text(params, "client_id") !== FAKE_META_APP.appId) {
    return invalidParameter(reply, "Invalid App ID");
  }
  const redirectUri = text(params, "redirect_uri");
  if (!redirectUri || !URL.canParse(redirectUri)) {
    return invalidParameter(reply, "The redirect_uri parameter is missing or invalid");
  }
  const target = new URL(redirectUri);
  const returnedState = text(params, "state");
  if (state.consent === "deny") {
    target.searchParams.set("error", "access_denied");
    target.searchParams.set("error_code", "200");
    target.searchParams.set("error_description", "Permissions error");
    target.searchParams.set("error_reason", "user_denied");
  } else {
    const requested = (text(params, "scope") ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
    const code = `fake-code-${newId(state, "")}`;
    const issued: FakeCode = {
      redirectUri,
      scopes: grantedScopes(state, requested),
      codeChallenge: text(params, "code_challenge") ?? null,
      used: false,
    };
    state.codes.set(code, issued);
    target.searchParams.set("code", code);
  }
  if (returnedState !== undefined) target.searchParams.set("state", returnedState);
  return reply.redirect(target.toString(), 302);
}

function exchangeCode(state: FakeGraphState, params: Record<string, unknown>, reply: FastifyReply) {
  const code = text(params, "code");
  const redirectUri = text(params, "redirect_uri");
  if (!code) return invalidParameter(reply, "Missing authorization code");
  if (!redirectUri) return invalidParameter(reply, "Missing redirect_uri parameter.");
  let issued = state.codes.get(code);
  if (!issued) {
    if (!state.acceptUnknownCodes)
      return badCode(reply, "Invalid verification code format.", 36008);
    issued = {
      redirectUri: null,
      scopes: grantedScopes(state, META_OAUTH_SCOPES),
      codeChallenge: null,
      used: false,
    };
    state.codes.set(code, issued);
  }
  if (issued.used) return badCode(reply, "This authorization code has been used.", 36009);
  if (issued.redirectUri !== null && issued.redirectUri !== redirectUri) {
    return badCode(
      reply,
      "Error validating verification code. Please make sure your redirect_uri is identical to the one you used in the OAuth dialog request",
      36008,
    );
  }
  if (issued.codeChallenge !== null) {
    const verifier = text(params, "code_verifier");
    if (!verifier || pkceChallenge(verifier) !== issued.codeChallenge) {
      return badCode(reply, "Invalid code_verifier for this authorization code.", 36008);
    }
  }
  issued.used = true;
  return mintUserToken(state, [...issued.scopes], SHORT_LIVED_SECONDS, "short");
}

function extendToken(state: FakeGraphState, params: Record<string, unknown>, reply: FastifyReply) {
  const short = text(params, "fb_exchange_token");
  if (!short) return invalidParameter(reply, "Missing fb_exchange_token parameter");
  const found = lookupToken(state, short);
  if ("error" in found) return sendGraphError(reply, 400, found.error);
  if (found.token.type !== "USER") {
    return invalidParameter(reply, "fb_exchange_token must be a user access token");
  }
  return mintUserToken(state, [...found.token.scopes], LONG_LIVED_SECONDS, "long");
}

function accessToken(state: FakeGraphState, request: FastifyRequest, reply: FastifyReply) {
  const params = paramsOf(request);
  if (!checkApp(params, reply)) return reply;
  return text(params, "grant_type") === "fb_exchange_token"
    ? extendToken(state, params, reply)
    : exchangeCode(state, params, reply);
}

function cursor(index: number): string {
  return Buffer.from(String(index)).toString("base64url");
}

function fromCursor(value: string | undefined): number {
  if (!value) return 0;
  const index = Number(Buffer.from(value, "base64url").toString());
  return Number.isInteger(index) && index >= 0 ? index : 0;
}

function accounts(state: FakeGraphState, request: FastifyRequest, reply: FastifyReply) {
  const user = authenticate(state, request, reply, { user: true });
  if (!user) return reply;
  // Without pages_show_list Graph lists nothing rather than failing.
  const pages = user.scopes.includes("pages_show_list") ? state.pages : [];
  const params = paramsOf(request);
  const fields = (text(params, "fields") ?? "id,name").split(",");
  const limit = Math.max(1, Math.min(100, Number(text(params, "limit") ?? 25) || 25));
  const start = fromCursor(text(params, "after"));
  const slice = pages.slice(start, start + limit);
  const end = start + slice.length;

  const data = slice.map((page) => {
    // The Page token carries what the user granted and lives as long as a long-lived user token.
    state.tokens.set(page.accessToken, {
      type: "PAGE",
      subjectId: page.id,
      userId: user.userId,
      scopes: [...user.scopes],
      expiresAt: 0,
    });
    return {
      id: page.id,
      name: page.name,
      ...(fields.includes("access_token") ? { access_token: page.accessToken } : {}),
      ...(fields.some((field) => field.startsWith("instagram_business_account")) && page.instagram
        ? { instagram_business_account: { ...page.instagram } }
        : {}),
    };
  });
  const next = new URL(request.url, `http://${request.headers.host ?? "fake-graph"}`);
  next.searchParams.delete("access_token");
  next.searchParams.delete("appsecret_proof");
  next.searchParams.set("after", cursor(end));
  return {
    data,
    paging: {
      cursors: { before: cursor(start), after: cursor(end) },
      ...(end < pages.length ? { next: next.toString() } : {}),
    },
  };
}

function debugToken(state: FakeGraphState, request: FastifyRequest, reply: FastifyReply) {
  const params = paramsOf(request);
  if (text(params, "access_token") !== `${FAKE_META_APP.appId}|${FAKE_META_APP.appSecret}`) {
    return sendGraphError(reply, 400, {
      message: "Invalid OAuth access token signature.",
      type: "OAuthException",
      code: 190,
    });
  }
  const input = text(params, "input_token");
  if (!input) return invalidParameter(reply, "The parameter input_token is required");
  const base = { app_id: FAKE_META_APP.appId, application: "ENMO OS (fake)" };
  const found = lookupToken(state, input);
  if ("error" in found) {
    return {
      data: {
        ...base,
        is_valid: false,
        scopes: [],
        error: {
          code: found.error.code,
          message: found.error.message,
          ...(found.error.error_subcode ? { subcode: found.error.error_subcode } : {}),
        },
      },
    };
  }
  const token = found.token;
  return {
    data: {
      ...base,
      type: token.type,
      is_valid: true,
      expires_at: token.expiresAt,
      data_access_expires_at: nowSeconds() + DATA_ACCESS_SECONDS,
      scopes: token.scopes,
      user_id: token.userId,
      ...(token.type === "PAGE" ? { profile_id: token.subjectId } : {}),
    },
  };
}

export function registerOAuth(app: FastifyInstance, state: FakeGraphState): void {
  app.get("/:version/dialog/oauth", (request, reply) =>
    checkVersion(request, reply) ? dialog(state, request, reply) : reply,
  );
  app.get("/:version/oauth/access_token", (request, reply) =>
    checkVersion(request, reply) ? accessToken(state, request, reply) : reply,
  );
  app.get("/:version/me/accounts", (request, reply) =>
    checkVersion(request, reply) ? accounts(state, request, reply) : reply,
  );
  app.get("/:version/debug_token", (request, reply) =>
    checkVersion(request, reply) ? debugToken(state, request, reply) : reply,
  );
}
