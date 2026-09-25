import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { EnvSource } from "../../src/config";
import { registerFacebook } from "./meta-graph/facebook";
import { registerInstagram } from "./meta-graph/instagram";
import { registerNodes } from "./meta-graph/nodes";
import { registerOAuth } from "./meta-graph/oauth";
import {
  FAKE_META_APP,
  initialState,
  sendGraphError,
  type FakeGraphState,
  type GraphFailure,
} from "./meta-graph/world";

/*
 * A fake Meta Graph API (DESIGN §H "Contract fakes"): a small Fastify server that the real
 * MetaPublisher and MetaOAuthProvider talk to once META_GRAPH_BASE_URL, META_RUPLOAD_BASE_URL and
 * META_OAUTH_DIALOG_URL all point at its `url` (fakeGraphEnv). It records every call, so a test can
 * assert the exact sequence, and `state` scripts what the platform answers:
 *   - OAuth (meta-graph/oauth.ts): the consent dialog, code and fb_exchange_token exchanges,
 *     /me/accounts, debug_token; `consent`, `declinedScopes`, `invalidTokens`
 *   - Instagram (meta-graph/instagram.ts): containers, media_publish, content_publishing_limit;
 *     `containerPolls`, `containerOutcome`, `quotaUsage`/`quotaTotal`
 *   - Facebook (meta-graph/facebook.ts): photos, feed, photo_stories, video_reels and
 *     video_stories with the rupload upload; `videoPolls`, `videoOutcome`
 *   - GET /{id} (meta-graph/nodes.ts): container status, permalinks, video status
 *   - `failNext`: any call answers a Graph error (rate limits, outages, a token revoked mid-flow)
 * Tokens it never issued are accepted as Page tokens with every scope (acceptUnknownTokens), so
 * tests can seed SocialAccounts with any token; user and Page token calls need appsecret_proof.
 */

export {
  FAKE_META_APP,
  FAKE_META_PAGES,
  FAKE_META_USER,
  GRAPH_ERRORS,
  sendGraphError,
  type ContainerOutcome,
  type ContainerStatusCode,
  type FakeCode,
  type FakeContainer,
  type FakeGraphState,
  type FakeInstagramAccount,
  type FakeInstagramMedia,
  type FakePage,
  type FakePhoto,
  type FakePost,
  type FakeToken,
  type FakeVideo,
  type GraphErrorBody,
  type GraphFailure,
  type VideoOutcome,
} from "./meta-graph/world";

/** One request as the fake received it. */
export interface GraphCall {
  method: string;
  /** Without the query string, e.g. "/v26.0/17841400000000000/media". */
  path: string;
  query: Record<string, string>;
  /** A JSON or form body as an object, another body as text; null when there was none. */
  body: unknown;
  headers: Record<string, string>;
}

export interface FakeGraph {
  /** http://127.0.0.1:<port>: the one base URL for Graph, rupload and the OAuth dialog. */
  readonly url: string;
  /** Every call so far, in arrival order. */
  readonly calls: GraphCall[];
  readonly state: FakeGraphState;
  /** `"<METHOD> <path>"` of every call so far. */
  sequence(): string[];
  /** Adds a scripted failure. */
  failNext(failure: GraphFailure): void;
  /** Forgets the calls and restores the initial state. */
  reset(): void;
  close(): Promise<void>;
}

/**
 * The env that aims every Meta host at the fake and configures the Meta app, e.g.
 * `startHarness({ env: { PUBLISH_MODE: "live", ...fakeGraphEnv(graph.url) } })`.
 */
export function fakeGraphEnv(url: string): EnvSource {
  return {
    META_APP_ID: FAKE_META_APP.appId,
    META_APP_SECRET: FAKE_META_APP.appSecret,
    META_GRAPH_BASE_URL: url,
    META_RUPLOAD_BASE_URL: url,
    META_OAUTH_DIALOG_URL: url,
  };
}

function headersOf(request: FastifyRequest): Record<string, string> {
  return Object.fromEntries(
    Object.entries(request.headers).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]],
    ),
  );
}

function callOf(request: FastifyRequest): GraphCall {
  const url = new URL(request.url, "http://fake-graph");
  return {
    method: request.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    body: request.body ?? null,
    headers: headersOf(request),
  };
}

/** Removes and returns the scripted failure the call hits, if any. */
function takeFailure(state: FakeGraphState, call: GraphCall): GraphFailure | null {
  const key = `${call.method} ${call.path}`;
  const index = state.failures.findIndex((failure) => failure.match.test(key));
  if (index === -1) return null;
  const failure = state.failures[index]!;
  const left = (failure.times ?? 1) - 1;
  if (left > 0) state.failures[index] = { ...failure, times: left };
  else state.failures.splice(index, 1);
  return failure;
}

/** The Graph endpoints the fake serves. */
function registerEndpoints(app: FastifyInstance, state: FakeGraphState): void {
  registerOAuth(app, state);
  registerInstagram(app, state);
  registerFacebook(app, state);
  registerNodes(app, state);
}

export async function startFakeGraph(): Promise<FakeGraph> {
  const calls: GraphCall[] = [];
  const state = initialState();
  const app = Fastify({ logger: false });

  // Graph takes form posts as well as JSON; rupload's file_url uploads carry no body at all.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  app.addContentTypeParser("*", { parseAs: "string" }, (_request, body, done) => done(null, body));

  app.addHook("preHandler", async (request, reply) => {
    const call = callOf(request);
    calls.push(call);
    const failure = takeFailure(state, call);
    if (failure) await sendGraphError(reply, failure.status, failure.error);
  });

  registerEndpoints(app, state);

  app.setNotFoundHandler((request, reply) =>
    sendGraphError(reply, 400, {
      message: `Unsupported ${request.method} request: the fake Graph server has no ${new URL(request.url, "http://fake-graph").pathname}`,
      type: "GraphMethodException",
      code: 100,
    }),
  );

  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    state,
    sequence: () => calls.map((call) => `${call.method} ${call.path}`),
    failNext: (failure) => {
      state.failures.push(failure);
    },
    reset: () => {
      calls.length = 0;
      Object.assign(state, initialState());
    },
    close: () => app.close(),
  };
}
