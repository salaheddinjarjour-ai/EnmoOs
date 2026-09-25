import { createHash, createHmac } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { META_OAUTH_SCOPES } from "@enmo/shared";

/*
 * The fake Graph server's world: the Meta app, user, Pages and tokens it knows, what it has been
 * asked to create, the knobs tests turn (container polls, outcomes, quota, consent), and the
 * request helpers every endpoint shares. Tests read and script it through FakeGraph.state.
 */

/** Graph's error object (`{"error": {...}}`), as Meta documents it. */
export interface GraphErrorBody {
  message: string;
  type: string;
  code: number;
  error_subcode?: number;
  is_transient?: boolean;
  error_user_msg?: string;
  fbtrace_id?: string;
}

/** A scripted failure: the next `times` calls matching `match` answer with this error. */
export interface GraphFailure {
  /** Tested against `"<METHOD> <path>"`, e.g. /^POST \/v26\.0\/\d+\/media_publish$/. */
  match: RegExp;
  status: number;
  error: GraphErrorBody;
  /** Defaults to 1. */
  times?: number;
}

/** Credentials the fake accepts as the Meta app's. */
export const FAKE_META_APP = {
  appId: "fake-meta-app-id",
  appSecret: "fake-meta-app-secret",
} as const;

/** The Meta user who signs in through the fake consent dialog. */
export const FAKE_META_USER = { id: "10000000000000001", name: "Enmo Admin" } as const;

export interface FakeInstagramAccount {
  id: string;
  username: string;
}

export interface FakePage {
  id: string;
  name: string;
  accessToken: string;
  /** The Instagram professional account linked to the Page. */
  instagram: FakeInstagramAccount | null;
}

/**
 * The Pages /me/accounts lists by default: one with a linked Instagram account, one without, so a
 * connect stores three SocialAccounts (two Facebook, one Instagram).
 */
export const FAKE_META_PAGES: readonly Readonly<FakePage>[] = [
  {
    id: "100000000000001",
    name: "Qahwa Co",
    accessToken: "fake-page-token-100000000000001",
    instagram: { id: "17841400000000001", username: "qahwa.co" },
  },
  {
    id: "100000000000002",
    name: "Qahwa Co Events",
    accessToken: "fake-page-token-100000000000002",
    instagram: null,
  },
];

/** Graph's errors as the fake (and Meta) sends them; handy for GraphFailure scripts. */
export const GRAPH_ERRORS = {
  invalidToken: {
    message:
      "Error validating access token: The session has been invalidated because the user changed their password or Facebook has changed the session for security reasons.",
    type: "OAuthException",
    code: 190,
    error_subcode: 460,
  },
  expiredToken: {
    message: "Error validating access token: Session has expired.",
    type: "OAuthException",
    code: 190,
    error_subcode: 463,
  },
  appRateLimited: {
    message: "(#4) Application request limit reached",
    type: "OAuthException",
    code: 4,
    is_transient: true,
  },
  pageRateLimited: {
    message: "(#32) Page request limit reached",
    type: "OAuthException",
    code: 32,
  },
  unavailable: {
    message: "An unexpected error has occurred. Please retry your request later.",
    type: "OAuthException",
    code: 2,
    is_transient: true,
  },
  publishLimitReached: {
    message: "Application request limit reached",
    type: "OAuthException",
    code: 9,
    error_subcode: 2207042,
    error_user_msg:
      "You reached maximum number of posts that is allowed to be published by Content Publishing API.",
  },
  notReady: {
    message: "Media ID is not available",
    type: "OAuthException",
    code: 9007,
    error_subcode: 2207027,
    error_user_msg: "The media is not ready for publishing, please wait for a moment",
  },
} as const satisfies Record<string, GraphErrorBody>;

export interface FakeToken {
  type: "USER" | "PAGE";
  /** The user, or the Page a Page token acts as. */
  subjectId: string;
  /** The user who granted it. */
  userId: string;
  scopes: string[];
  /** Unix seconds; 0 never expires. */
  expiresAt: number;
}

export interface FakeCode {
  /** The redirect_uri the dialog issued it for; null for a code a test made up. */
  redirectUri: string | null;
  scopes: string[];
  codeChallenge: string | null;
  used: boolean;
}

export type ContainerStatusCode = "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED";
export type ContainerOutcome = "FINISHED" | "ERROR" | "EXPIRED";

export interface FakeContainer {
  id: string;
  igUserId: string;
  mediaType: "IMAGE" | "VIDEO" | "REELS" | "STORIES" | "CAROUSEL";
  isCarouselItem: boolean;
  children: string[];
  /** The body it was created with. */
  params: Record<string, unknown>;
  status: ContainerStatusCode;
  /** Status reads left that answer IN_PROGRESS. */
  pollsLeft: number;
  outcome: ContainerOutcome;
  mediaId: string | null;
}

export interface FakeInstagramMedia {
  id: string;
  igUserId: string;
  containerId: string;
  mediaType: FakeContainer["mediaType"];
  caption: string | null;
  permalink: string;
}

export interface FakePhoto {
  id: string;
  pageId: string;
  url: string;
  published: boolean;
  /** The post it went out in (published, attached to a feed post, or a story). */
  postId: string | null;
}

export interface FakePost {
  id: string;
  pageId: string;
  kind: "photo" | "feed" | "photo_story" | "video_story";
  message: string | null;
  photoIds: string[];
  permalink: string;
}

export type VideoOutcome = "ready" | "error";

export interface FakeVideo {
  id: string;
  pageId: string;
  kind: "reel" | "story";
  /** The file rupload pulled; null until uploaded. */
  fileUrl: string | null;
  phase: "created" | "uploaded" | "processing" | "ready" | "error";
  description: string | null;
  /** Status reads left that answer `processing` once finished. */
  pollsLeft: number;
  outcome: VideoOutcome;
  postId: string | null;
}

export interface FakeGraphState {
  /** Pending scripted failures, checked in order before any endpoint runs. */
  failures: GraphFailure[];
  user: { id: string; name: string };
  /** What /me/accounts lists. */
  pages: FakePage[];
  /** Tokens the fake issued (or a test registered). */
  tokens: Map<string, FakeToken>;
  /** Revoked tokens: every call with one fails with OAuthException 190, debug_token says invalid. */
  invalidTokens: Set<string>;
  /**
   * Accept tokens the fake never issued as never-expiring Page tokens with every scope, so tests
   * can seed accounts with any token. Default true.
   */
  acceptUnknownTokens: boolean;
  /** Refuse user and Page token calls without a valid appsecret_proof. Default true. */
  requireAppSecretProof: boolean;
  /** What the admin does on the consent dialog. */
  consent: "grant" | "deny";
  /** Scopes the admin unticks on the consent dialog. */
  declinedScopes: string[];
  codes: Map<string, FakeCode>;
  /** Exchange codes the dialog never issued (once each). Default true. */
  acceptUnknownCodes: boolean;
  /** Instagram: status reads a new container answers IN_PROGRESS before its outcome. Default 0. */
  containerPolls: number;
  containerOutcome: ContainerOutcome;
  /** content_publishing_limit; media_publish is refused once usage reaches the total. */
  quotaUsage: number;
  quotaTotal: number;
  /** Facebook: status reads a finished video answers `processing` before its outcome. Default 0. */
  videoPolls: number;
  videoOutcome: VideoOutcome;
  containers: Map<string, FakeContainer>;
  media: Map<string, FakeInstagramMedia>;
  photos: Map<string, FakePhoto>;
  posts: Map<string, FakePost>;
  videos: Map<string, FakeVideo>;
  nextId: number;
}

const PAGE_SCOPES = [...META_OAUTH_SCOPES];

export function initialState(): FakeGraphState {
  const pages = FAKE_META_PAGES.map((page) => ({
    ...page,
    instagram: page.instagram ? { ...page.instagram } : null,
  }));
  const tokens = new Map<string, FakeToken>(
    pages.map((page) => [
      page.accessToken,
      {
        type: "PAGE",
        subjectId: page.id,
        userId: FAKE_META_USER.id,
        scopes: [...PAGE_SCOPES],
        expiresAt: 0,
      },
    ]),
  );
  return {
    failures: [],
    user: { ...FAKE_META_USER },
    pages,
    tokens,
    invalidTokens: new Set(),
    acceptUnknownTokens: true,
    requireAppSecretProof: true,
    consent: "grant",
    declinedScopes: [],
    codes: new Map(),
    acceptUnknownCodes: true,
    containerPolls: 0,
    containerOutcome: "FINISHED",
    quotaUsage: 0,
    quotaTotal: 100,
    videoPolls: 0,
    videoOutcome: "ready",
    containers: new Map(),
    media: new Map(),
    photos: new Map(),
    posts: new Map(),
    videos: new Map(),
    nextId: 1,
  };
}

/** A fresh numeric id: `prefix` then a zero-padded counter (Graph ids are digit strings). */
export function newId(state: FakeGraphState, prefix: string): string {
  const id = `${prefix}${String(state.nextId).padStart(10, "0")}`;
  state.nextId += 1;
  return id;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

/** Answers like Graph does when a call fails. */
export function sendGraphError(reply: FastifyReply, status: number, error: GraphErrorBody) {
  return reply.status(status).send({ error });
}

export function invalidParameter(reply: FastifyReply, message: string, subcode?: number) {
  return sendGraphError(reply, 400, {
    message: `(#100) ${message}`,
    type: "OAuthException",
    code: 100,
    ...(subcode === undefined ? {} : { error_subcode: subcode }),
  });
}

export function unknownObject(reply: FastifyReply, id: string) {
  return invalidParameter(
    reply,
    `Unsupported request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`,
    33,
  );
}

/* ─── Request helpers ──────────────────────────────────────────────────────────────────────── */

export interface NodeParams {
  version: string;
  id: string;
}

export function routeParams(request: FastifyRequest): NodeParams {
  return request.params as NodeParams;
}

/** Whether the path's version looks like Graph's ("v26.0"); answers the error if not. */
export function checkVersion(request: FastifyRequest, reply: FastifyReply): boolean {
  const { version } = request.params as { version?: string };
  if (version !== undefined && /^v\d+\.\d+$/.test(version)) return true;
  void invalidParameter(reply, `Unknown Graph API version '${version ?? ""}'`);
  return false;
}

/** Query and body parameters merged, as Graph reads them. */
export function paramsOf(request: FastifyRequest): Record<string, unknown> {
  const query = Object.fromEntries(new URL(request.url, "http://fake-graph").searchParams);
  const body =
    request.body !== null && typeof request.body === "object"
      ? (request.body as Record<string, unknown>)
      : {};
  return { ...query, ...body };
}

export function text(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (typeof value === "string") return value === "" ? undefined : value;
  if (typeof value === "number") return String(value);
  return undefined;
}

export function flag(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return undefined;
}

/** The token a call carries: `Authorization: OAuth|Bearer <token>`, else an access_token param. */
export function tokenOf(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  const match = header ? /^(?:OAuth|Bearer)\s+(\S+)$/i.exec(header) : null;
  if (match?.[1]) return match[1];
  return text(paramsOf(request), "access_token") ?? null;
}

export function appSecretProofFor(token: string): string {
  return createHmac("sha256", FAKE_META_APP.appSecret).update(token).digest("hex");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** What the fake knows about `token`, or the Graph error a call with it gets. */
export function lookupToken(
  state: FakeGraphState,
  token: string,
): { token: FakeToken } | { error: GraphErrorBody } {
  if (state.invalidTokens.has(token)) return { error: GRAPH_ERRORS.invalidToken };
  const known = state.tokens.get(token);
  if (known) {
    if (known.expiresAt > 0 && known.expiresAt <= nowSeconds()) {
      return { error: GRAPH_ERRORS.expiredToken };
    }
    return { token: known };
  }
  if (state.acceptUnknownTokens) {
    return {
      token: {
        type: "PAGE",
        subjectId: "unknown",
        userId: state.user.id,
        scopes: [...PAGE_SCOPES],
        expiresAt: 0,
      },
    };
  }
  return {
    error: {
      message: "Invalid OAuth access token - Cannot parse access token",
      type: "OAuthException",
      code: 190,
    },
  };
}

export interface AuthOptions {
  /** A scope the token must carry. */
  scope?: string;
  /** Only a user token will do (/me/accounts). */
  user?: boolean;
  /** rupload takes no appsecret_proof. */
  skipProof?: boolean;
}

/** The call's token, or null after answering the Graph error Meta would send. */
export function authenticate(
  state: FakeGraphState,
  request: FastifyRequest,
  reply: FastifyReply,
  options: AuthOptions = {},
): FakeToken | null {
  const token = tokenOf(request);
  if (!token) {
    void sendGraphError(reply, 400, {
      message: "An access token is required to request this resource.",
      type: "OAuthException",
      code: 104,
    });
    return null;
  }
  const found = lookupToken(state, token);
  if ("error" in found) {
    void sendGraphError(reply, 400, found.error);
    return null;
  }
  if (!options.skipProof) {
    const proof = text(paramsOf(request), "appsecret_proof");
    if (proof !== undefined && proof !== appSecretProofFor(token)) {
      void invalidParameter(reply, "Invalid appsecret_proof provided in the API argument");
      return null;
    }
    if (proof === undefined && state.requireAppSecretProof) {
      void invalidParameter(reply, "API calls from the server require an appsecret_proof argument");
      return null;
    }
  }
  if (options.user && found.token.type !== "USER") {
    void invalidParameter(reply, "This call needs a user access token");
    return null;
  }
  if (options.scope && !found.token.scopes.includes(options.scope)) {
    void sendGraphError(reply, 403, {
      message: `(#200) Requires ${options.scope} permission to manage the object`,
      type: "OAuthException",
      code: 200,
    });
    return null;
  }
  return found.token;
}
