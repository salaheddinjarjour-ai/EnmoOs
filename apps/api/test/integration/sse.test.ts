import { randomUUID } from "node:crypto";
import http, { type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import {
  GLOBAL_CHANNEL,
  realtimeRedisChannel,
  SESSION_COOKIE_NAME,
  SSE_REPLAY_LIMIT,
  SSE_RETRY_MS,
  threadChannel,
  type AlertPayload,
  type PlanProposedPayload,
  type RealtimeEnvelope,
  type ResyncPayload,
} from "@enmo/shared";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MINUTE_MS } from "../../src/lib/clock";
import { createLogger } from "../../src/lib/logger";
import { createRealtimeHub, type RealtimeHub, type RealtimeListener } from "../../src/realtime/hub";
import { createEventsRoutes } from "../../src/routes/events";
import { buildTestApp, TEST_ORIGIN, testConfig, type TestApp } from "../helpers/app";
import { sessionCookieFor, type CookieHeader } from "../helpers/auth";
import { testDb } from "../helpers/db";
import { createUser } from "../helpers/factories";
import { waitFor } from "../helpers/harness";
import { seedCampaign } from "../helpers/route-fixtures";

/*
 * GET /v1/events over a real port (DESIGN §D "Realtime"): headers and CORS, live fan-out by
 * channel, Last-Event-ID replay, the resync cut-off, heartbeats, and that nothing is left
 * subscribed once a client or the app goes away. A second copy of the route with a 40ms heartbeat
 * and a hub the test owns is mounted at /v1/test/events.
 *
 * The Redis channel is shared by everything using this Redis (another suite may be publishing
 * right now), so assertions only count events this run produced: alerts tagged with RUN and
 * plans of RUN's campaign.
 */

const RUN = randomUUID().slice(0, 8);
/** This file's BULLMQ_PREFIX, so its app and its own hubs share one realtime channel. */
const PREFIX = `test-sse-${RUN}`;
const REDIS_CHANNEL = realtimeRedisChannel(PREFIX);

const HEARTBEAT_MS = 40;
const SESSION_CHECK_MS = 50;
const silent = createLogger({ level: "silent", name: "sse-test" });
const redisUrl = testConfig().REDIS_URL;

let t: TestApp;
let baseUrl: string;
let testHub: RealtimeHub;
let cookie: CookieHeader;
const clients: SseClient[] = [];

beforeAll(async () => {
  testHub = createRealtimeHub({ redisUrl, redisChannel: REDIS_CHANNEL, logger: silent });
  const fastEvents = createEventsRoutes({
    heartbeatMs: HEARTBEAT_MS,
    sessionCheckMs: SESSION_CHECK_MS,
    hub: testHub,
  });
  t = await buildTestApp({
    env: { BULLMQ_PREFIX: PREFIX },
    routes: async (scope) => {
      await scope.register(
        async (inner) => {
          await fastEvents(inner);
        },
        { prefix: "/test" },
      );
    },
  });
  await t.app.listen({ host: "127.0.0.1", port: 0 });
  baseUrl = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await t.close();
  await testHub.close();
});

async function signedIn(): Promise<CookieHeader> {
  cookie = await sessionCookieFor(await createUser({ role: "EDITOR" }));
  return cookie;
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

/* ─── a minimal SSE client over node:http (full access to status, headers and raw text) ─────── */

interface ReceivedEvent {
  id: string | null;
  type: string;
  payload: unknown;
}

class SseClient {
  status = 0;
  headers: IncomingHttpHeaders = {};
  text = "";
  readonly events: ReceivedEvent[] = [];
  retryMs: number | null = null;
  ended = false;
  #buffer = "";
  #request: http.ClientRequest | null = null;

  static open(url: string, headers: Record<string, string> = {}): Promise<SseClient> {
    const client = new SseClient();
    clients.push(client);
    return new Promise((resolve, reject) => {
      const request = http.get(url, { headers }, (response) => {
        client.status = response.statusCode ?? 0;
        client.headers = response.headers;
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => client.#receive(chunk));
        response.on("close", () => (client.ended = true));
        resolve(client);
      });
      request.on("error", (error) => {
        client.ended = true;
        if (client.status === 0) reject(error);
      });
      client.#request = request;
    });
  }

  #receive(chunk: string): void {
    this.text += chunk;
    this.#buffer += chunk;
    let boundary = this.#buffer.indexOf("\n\n");
    while (boundary !== -1) {
      this.#frame(this.#buffer.slice(0, boundary));
      this.#buffer = this.#buffer.slice(boundary + 2);
      boundary = this.#buffer.indexOf("\n\n");
    }
  }

  #frame(raw: string): void {
    let id: string | null = null;
    let type = "message";
    const data: string[] = [];
    for (const line of raw.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "id") id = value;
      else if (field === "event") type = value;
      else if (field === "data") data.push(value);
      else if (field === "retry") this.retryMs = Number(value);
    }
    if (data.length > 0) this.events.push({ id, type, payload: JSON.parse(data.join("\n")) });
  }

  /** The events this run produced (see RUN), in arrival order. */
  own(): ReceivedEvent[] {
    return this.events.filter(isOwn);
  }

  /** Ready for live events: the server subscribed before it wrote `retry:`. */
  ready(): Promise<unknown> {
    return waitFor(() => this.retryMs !== null, 5_000);
  }

  waitForEvent(predicate: (event: ReceivedEvent) => boolean): Promise<ReceivedEvent> {
    return waitFor(() => this.events.find(predicate), 5_000);
  }

  /** Resolves once the body ended, with the text the server sent. */
  async body(): Promise<string> {
    await waitFor(() => this.ended, 5_000);
    return this.text;
  }

  close(): void {
    this.#request?.destroy();
  }
}

function stream(path: string, options: { cookie?: string; headers?: Record<string, string> } = {}) {
  return SseClient.open(`${baseUrl}${path}`, {
    accept: "text/event-stream",
    origin: TEST_ORIGIN,
    ...(options.cookie ? { cookie: options.cookie } : {}),
    ...options.headers,
  });
}

async function openReady(path: string, headers: Record<string, string> = {}) {
  const client = await stream(path, { cookie, headers });
  expect(client.status, client.text).toBe(200);
  await client.ready();
  return client;
}

/* ─── events ─────────────────────────────────────────────────────────────────────────────────── */

const OWN_CAMPAIGN = `campaign-${RUN}`;

function alert(message: string): AlertPayload {
  return {
    kind: "failed",
    entityType: "AgentTask",
    entityId: null,
    message: `${RUN} ${message}`,
    clientId: null,
    campaignId: null,
  };
}

function planProposed(threadId: string, version: number): PlanProposedPayload {
  return { campaignId: OWN_CAMPAIGN, threadId, graphId: `graph-${version}`, version };
}

function isOwn(event: { type: string; payload: unknown }): boolean {
  // The stream writes its own resync (never published); anything else by that name is foreign.
  if (event.type === "resync") return (event.payload as ResyncPayload).reason.startsWith("Missed");
  if (event.type === "alert") return (event.payload as AlertPayload).message.startsWith(`${RUN} `);
  if (event.type === "plan.proposed") {
    return (event.payload as PlanProposedPayload).campaignId === OWN_CAMPAIGN;
  }
  return false;
}

/** An own alert whose message (without the RUN tag) is `message`. */
const alertIs = (message: string) => (event: ReceivedEvent) =>
  event.type === "alert" && (event.payload as AlertPayload).message === `${RUN} ${message}`;

async function publishAlert(message: string): Promise<string> {
  await t.deps.realtime.publish(GLOBAL_CHANNEL, "alert", alert(message));
  const row = await testDb().realtimeEvent.findFirstOrThrow({
    where: { type: "alert", payload: { path: ["message"], equals: `${RUN} ${message}` } },
    orderBy: { id: "desc" },
  });
  return row.id.toString();
}

const alertMessages = (client: SseClient) =>
  client
    .own()
    .filter((event) => event.type === "alert")
    .map((event) => (event.payload as AlertPayload).message.slice(RUN.length + 1));

async function threadId(): Promise<string> {
  const owner = await createUser({ role: "MANAGER" });
  return (await seedCampaign({ createdBy: owner })).threadId;
}

/* ─── tests ──────────────────────────────────────────────────────────────────────────────────── */

describe("GET /v1/events access", () => {
  it("answers 401 without a session, with CORS headers for the allowed origin", async () => {
    const client = await stream("/v1/events");
    expect(client.status).toBe(401);
    expect(JSON.parse(await client.body())).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    expect(client.headers["access-control-allow-origin"]).toBe(TEST_ORIGIN);
    expect(client.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("answers 404 for an unknown thread", async () => {
    await signedIn();
    const client = await stream("/v1/events?threadId=no-such-thread", { cookie });
    expect(client.status).toBe(404);
    expect(JSON.parse(await client.body())).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("rejects a malformed cursor in the query or the Last-Event-ID header", async () => {
    await signedIn();
    const fromQuery = await stream("/v1/events?lastEventId=abc", { cookie });
    expect(fromQuery.status).toBe(400);
    const fromHeader = await stream("/v1/events", { cookie, headers: { "last-event-id": "1x" } });
    expect(fromHeader.status).toBe(400);
    const tooLarge = await stream("/v1/events?lastEventId=9999999999999999999", { cookie });
    expect(tooLarge.status).toBe(400);
  });

  it("answers 503 when the realtime subscription can't be opened", async () => {
    const unreachable = createRealtimeHub({
      redisUrl: "redis://127.0.0.1:1",
      redisChannel: REDIS_CHANNEL,
      logger: silent,
      startTimeoutMs: 150,
    });
    const app = await buildTestApp({
      routes: async (scope) => {
        const broken = createEventsRoutes({ hub: unreachable });
        await scope.register(async (inner) => void (await broken(inner)), { prefix: "/broken" });
      },
    });
    try {
      const user = await createUser();
      const response = await app.app.inject({
        method: "GET",
        url: "/v1/broken/events",
        headers: { cookie: await sessionCookieFor(user) },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: "UNAVAILABLE" } });
    } finally {
      await app.close();
      await unreachable.close();
    }
  });
});

describe("GET /v1/events stream", () => {
  it("writes the SSE and CORS headers, then retry first", async () => {
    await signedIn();
    const client = await openReady("/v1/events");
    expect(client.headers["content-type"]).toBe("text/event-stream");
    expect(client.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(client.headers.connection).toBe("keep-alive");
    expect(client.headers["x-accel-buffering"]).toBe("no");
    expect(client.headers["access-control-allow-origin"]).toBe(TEST_ORIGIN);
    expect(client.headers["access-control-allow-credentials"]).toBe("true");
    expect(client.headers.vary).toMatch(/\bOrigin\b/);
    expect(client.headers["x-content-type-options"]).toBe("nosniff");
    expect(client.text.startsWith(`retry: ${SSE_RETRY_MS}\n\n`)).toBe(true);
    expect(client.retryMs).toBe(SSE_RETRY_MS);
  });

  it("passes the CORS preflight a cross-origin reconnect with Last-Event-ID needs", async () => {
    const response = await t.app.inject({
      method: "OPTIONS",
      url: "/v1/events",
      headers: {
        origin: TEST_ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": "last-event-id",
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(TEST_ORIGIN);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(String(response.headers["access-control-allow-headers"])).toMatch(/last-event-id/i);
  });

  it("sends no CORS headers to an origin outside APP_ORIGINS", async () => {
    await signedIn();
    const client = await openReady("/v1/events", { origin: "https://evil.example" });
    expect(client.headers["access-control-allow-origin"]).toBeUndefined();
    expect(client.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("delivers global events and its thread's events, not other threads'", async () => {
    await signedIn();
    const mine = await threadId();
    const other = await threadId();
    const client = await openReady(`/v1/events?threadId=${mine}`);
    const globalOnly = await openReady("/v1/events");

    await t.deps.realtime.publish(threadChannel(other), "plan.proposed", planProposed(other, 9));
    await t.deps.realtime.publish(threadChannel(mine), "plan.proposed", planProposed(mine, 1));
    const alertId = await publishAlert("global news");

    const received = await client.waitForEvent(alertIs("global news"));
    expect(received).toEqual({ id: alertId, type: "alert", payload: alert("global news") });
    const proposals = client.own().filter((event) => event.type === "plan.proposed");
    expect(proposals.map((event) => event.payload)).toEqual([planProposed(mine, 1)]);
    const row = await testDb().realtimeEvent.findFirstOrThrow({
      where: { channel: threadChannel(mine) },
    });
    expect(proposals[0]?.id).toBe(row.id.toString());

    await globalOnly.waitForEvent(alertIs("global news"));
    expect(globalOnly.own().map((event) => event.type)).toEqual(["alert"]);
  });

  it("replays what a client missed after reconnecting with Last-Event-ID", async () => {
    await signedIn();
    const mine = await threadId();
    const other = await threadId();
    const first = await openReady(`/v1/events?threadId=${mine}`);
    const id1 = await publishAlert("one");
    await publishAlert("two");
    await first.waitForEvent(alertIs("two"));
    first.close();

    await t.deps.realtime.publish(threadChannel(mine), "plan.proposed", planProposed(mine, 2));
    await t.deps.realtime.publish(threadChannel(other), "plan.proposed", planProposed(other, 3));
    await publishAlert("three");

    const second = await openReady(`/v1/events?threadId=${mine}`, { "last-event-id": id1 });
    await second.waitForEvent(alertIs("three"));
    const replayed = second.own();
    expect(replayed.map((event) => event.type)).toEqual(["alert", "plan.proposed", "alert"]);
    expect(alertMessages(second)).toEqual(["two", "three"]);
    expect(replayed[1]?.payload).toEqual(planProposed(mine, 2));
    const ids = replayed.map((event) => BigInt(event.id ?? "0"));
    expect([...ids].sort((a, b) => (a < b ? -1 : 1))).toEqual(ids);

    // …and carries on live.
    await publishAlert("four");
    await second.waitForEvent(alertIs("four"));
  });

  it("takes the cursor from ?lastEventId=, with the Last-Event-ID header winning", async () => {
    await signedIn();
    const id1 = await publishAlert("one");
    const id2 = await publishAlert("two");
    await publishAlert("three");

    const fromQuery = await openReady(`/v1/events?lastEventId=${id1}`);
    await fromQuery.waitForEvent(alertIs("three"));
    expect(alertMessages(fromQuery)).toEqual(["two", "three"]);

    const both = await openReady(`/v1/events?lastEventId=${id1}`, { "last-event-id": id2 });
    await both.waitForEvent(alertIs("three"));
    expect(alertMessages(both)).toEqual(["three"]);

    const fresh = await openReady("/v1/events");
    await publishAlert("four");
    await fresh.waitForEvent(alertIs("four"));
    expect(alertMessages(fresh)).toEqual(["four"]);
  });

  it("does not send a replayed event again when its PUBLISH arrives late", async () => {
    await signedIn();
    const row = await testDb().realtimeEvent.create({
      data: { channel: GLOBAL_CHANNEL, type: "alert", payload: alert("stored, not yet published") },
    });
    const client = await openReady("/v1/events?lastEventId=0");
    await client.waitForEvent(alertIs("stored, not yet published"));

    const late: RealtimeEnvelope = {
      id: row.id.toString(),
      channel: GLOBAL_CHANNEL,
      type: "alert",
      payload: alert("stored, not yet published"),
    };
    await t.deps.redis.publish(REDIS_CHANNEL, JSON.stringify(late));
    await publishAlert("after");
    await client.waitForEvent(alertIs("after"));
    expect(alertMessages(client)).toEqual(["stored, not yet published", "after"]);
  });

  it(`replays up to ${SSE_REPLAY_LIMIT} missed events`, async () => {
    await signedIn();
    await testDb().realtimeEvent.createMany({
      data: Array.from({ length: SSE_REPLAY_LIMIT }, (_, index) => ({
        channel: GLOBAL_CHANNEL,
        type: "alert",
        payload: alert(`missed ${index}`),
      })),
    });
    const client = await openReady("/v1/events?lastEventId=0");
    await waitFor(() => client.own().length === SSE_REPLAY_LIMIT, 5_000);
    expect(client.own().every((event) => event.type === "alert")).toBe(true);
    expect(alertMessages(client).at(-1)).toBe(`missed ${SSE_REPLAY_LIMIT - 1}`);
  });

  it(`sends a single resync instead of more than ${SSE_REPLAY_LIMIT} events`, async () => {
    await signedIn();
    await testDb().realtimeEvent.createMany({
      data: Array.from({ length: SSE_REPLAY_LIMIT + 1 }, (_, index) => ({
        channel: GLOBAL_CHANNEL,
        type: "alert",
        payload: alert(`missed ${index}`),
      })),
    });
    const newest = await testDb().realtimeEvent.findFirstOrThrow({ orderBy: { id: "desc" } });

    const client = await openReady("/v1/events?lastEventId=0");
    const resync = await client.waitForEvent((event) => event.type === "resync");
    expect(resync.id).toBe(newest.id.toString());
    expect(resync.payload).toEqual({ reason: expect.any(String) as string });

    await publishAlert("live after resync");
    await client.waitForEvent(alertIs("live after resync"));
    expect(client.own().map((event) => event.type)).toEqual(["resync", "alert"]);

    // The resync's id is the new cursor: reconnecting from it replays nothing old.
    const next = await openReady("/v1/events", { "last-event-id": resync.id ?? "" });
    await next.waitForEvent(alertIs("live after resync"));
    expect(alertMessages(next)).toEqual(["live after resync"]);
  });

  it("serves a Last-Event-ID beyond the table as a fresh live stream", async () => {
    await signedIn();
    const client = await openReady("/v1/events", { "last-event-id": "9223372036854775807" });
    await publishAlert("live");
    await client.waitForEvent(alertIs("live"));
    expect(client.own().map((event) => event.type)).toEqual(["alert"]);
  });
});

describe("heartbeat and cleanup", () => {
  it("sends a ': ping' comment every heartbeat", async () => {
    await signedIn();
    const client = await openReady("/v1/test/events");
    await waitFor(() => client.text.split(": ping\n\n").length > 3, 5_000);
    expect(client.own()).toEqual([]);
  });

  it("ends the stream once its session is gone (logout, deactivation)", async () => {
    const user = await createUser();
    const other = await createUser();
    const mine = await openReady("/v1/test/events", { cookie: await sessionCookieFor(user) });
    const theirs = await openReady("/v1/test/events", { cookie: await sessionCookieFor(other) });

    await testDb().session.deleteMany({ where: { userId: user.id } });
    await waitFor(() => mine.ended, 5_000);
    // Well past a few checks: the other stream, whose session lives, stays open.
    await new Promise((resolve) => setTimeout(resolve, SESSION_CHECK_MS * 4));
    expect(theirs.ended).toBe(false);

    const again = await stream("/v1/test/events", { cookie: await sessionCookieFor(user) });
    expect(again.status).toBe(200);
  });

  it("checks its session without rolling it, leaving that to requests that can set the cookie", async () => {
    const user = await createUser();
    // Last seen 10 minutes ago: any request that rolls sessions would roll this one.
    const staleCookie = await sessionCookieFor(user, {
      now: new Date(t.clock.now().getTime() - 10 * MINUTE_MS),
    });
    const before = await testDb().session.findFirstOrThrow({ where: { userId: user.id } });

    const client = await openReady("/v1/test/events", { cookie: staleCookie });
    expect(client.headers["set-cookie"]).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, SESSION_CHECK_MS * 4));
    expect(client.ended).toBe(false);
    // The hijacked stream can't re-issue the cookie, so it must not move the server's expiry.
    expect(await testDb().session.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({
      lastSeenAt: before.lastSeenAt,
      expiresAt: before.expiresAt,
    });

    // The next ordinary request rolls it, and the browser's cookie moves with it.
    const me = await t.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: staleCookie },
    });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.cookies.map((set) => set.name)).toContain(SESSION_COOKIE_NAME);
    const rolled = await testDb().session.findUniqueOrThrow({ where: { id: before.id } });
    expect(rolled.expiresAt.getTime()).toBeGreaterThan(before.expiresAt.getTime());
  });

  it("unsubscribes a stream as soon as its client goes away", async () => {
    await signedIn();
    await waitFor(() => testHub.listenerCount() === 0, 5_000);
    const streams = await Promise.all([
      openReady("/v1/test/events"),
      openReady("/v1/test/events"),
      openReady(`/v1/test/events?threadId=${await threadId()}`),
    ]);
    expect(testHub.listenerCount()).toBe(3);

    streams[0]?.close();
    await waitFor(() => testHub.listenerCount() === 2, 5_000);
    for (const client of streams) client.close();
    await waitFor(() => testHub.listenerCount() === 0, 5_000);
  });

  it("ends open streams when the app closes", async () => {
    const hub = createRealtimeHub({ redisUrl, redisChannel: REDIS_CHANNEL, logger: silent });
    const own = await buildTestApp({
      routes: async (scope) => {
        const events = createEventsRoutes({ hub });
        await scope.register(async (inner) => void (await events(inner)), { prefix: "/own" });
      },
    });
    let closed = false;
    try {
      await own.app.listen({ host: "127.0.0.1", port: 0 });
      const ownUrl = `http://127.0.0.1:${(own.app.server.address() as AddressInfo).port}/v1`;
      const session = await sessionCookieFor(await createUser());
      const streams = await Promise.all(
        [`${ownUrl}/own/events`, `${ownUrl}/events`].map((url) =>
          SseClient.open(url, { cookie: session }),
        ),
      );
      for (const client of streams) {
        expect(client.status).toBe(200);
        await client.ready();
      }
      expect(hub.listenerCount()).toBe(1);

      // Must not wait for the browsers to hang up.
      await own.close();
      closed = true;
      await waitFor(() => streams.every((client) => client.ended), 5_000);
      expect(hub.listenerCount()).toBe(0);
    } finally {
      if (!closed) await own.close();
      await hub.close();
    }
  });
});

describe("realtime hub", () => {
  /** Keeps this run's events only (see RUN); counts interruptions. */
  function recorder() {
    const events: RealtimeEnvelope[] = [];
    let interrupts = 0;
    const listener: RealtimeListener = {
      onEvent: (event) => {
        if (isOwn(event)) events.push(event);
      },
      onInterrupt: () => (interrupts += 1),
    };
    return { events, listener, interrupts: () => interrupts };
  }

  it("fans envelopes out by channel and skips malformed ones", async () => {
    const hub = createRealtimeHub({ redisUrl, redisChannel: REDIS_CHANNEL, logger: silent });
    try {
      await hub.start();
      await hub.start();
      const global = recorder();
      const thread = recorder();
      const both = recorder();
      const t1 = threadChannel(`t1-${RUN}`);
      hub.subscribe([GLOBAL_CHANNEL], global.listener);
      hub.subscribe([t1], thread.listener);
      hub.subscribe([GLOBAL_CHANNEL, t1, GLOBAL_CHANNEL], both.listener);

      const publish = (message: unknown) =>
        t.deps.redis.publish(
          REDIS_CHANNEL,
          typeof message === "string" ? message : JSON.stringify(message),
        );
      await publish("not json");
      await publish({ id: "1", channel: GLOBAL_CHANNEL, type: "alert", payload: { kind: "?" } });
      await publish({ id: "x", channel: GLOBAL_CHANNEL, type: "alert", payload: alert("bad id") });
      await publish({ id: "2", channel: "elsewhere", type: "alert", payload: alert("bad ch") });
      // Another deployment (or test run) on the same Redis: its envelopes never arrive here.
      await t.deps.redis.publish(
        realtimeRedisChannel(`${PREFIX}-other`),
        JSON.stringify({
          id: "9",
          channel: GLOBAL_CHANNEL,
          type: "alert",
          payload: alert("other"),
        }),
      );
      await publish({ id: "3", channel: GLOBAL_CHANNEL, type: "alert", payload: alert("g") });
      await publish({ id: "4", channel: t1, type: "plan.proposed", payload: planProposed(t1, 1) });

      await waitFor(() => both.events.length === 2, 5_000);
      expect(global.events.map((event) => event.id)).toEqual(["3"]);
      expect(thread.events.map((event) => event.id)).toEqual(["4"]);
      expect(both.events.map((event) => event.id)).toEqual(["3", "4"]);
      expect(hub.listenerCount()).toBe(3);
    } finally {
      await hub.close();
    }
  });

  it("interrupts listeners when the subscription comes back after a drop", async () => {
    let connection: Redis | undefined;
    const hub = createRealtimeHub({
      redisUrl,
      redisChannel: REDIS_CHANNEL,
      logger: silent,
      connect: (url) => {
        connection = new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
        return connection;
      },
    });
    try {
      await hub.start();
      const probe = recorder();
      hub.subscribe([GLOBAL_CHANNEL], probe.listener);
      connection?.disconnect(true);
      await waitFor(() => probe.interrupts() === 1, 5_000);

      // Re-subscribed: live events flow again.
      await waitFor(async () => {
        await t.deps.redis.publish(
          REDIS_CHANNEL,
          JSON.stringify({
            id: "7",
            channel: GLOBAL_CHANNEL,
            type: "alert",
            payload: alert("back"),
          }),
        );
        return probe.events.some((event) => alertIs("back")(event));
      }, 5_000);
    } finally {
      await hub.close();
    }
  });

  it("interrupts everyone on close and refuses to start again", async () => {
    const hub = createRealtimeHub({ redisUrl, redisChannel: REDIS_CHANNEL, logger: silent });
    await hub.start();
    const probe = recorder();
    const unsubscribe = hub.subscribe([GLOBAL_CHANNEL], probe.listener);
    await hub.close();
    expect(probe.interrupts()).toBe(1);
    expect(hub.listenerCount()).toBe(0);
    unsubscribe();
    await expect(hub.start()).rejects.toThrow(/closed/);

    const late = recorder();
    hub.subscribe([GLOBAL_CHANNEL], late.listener);
    expect(late.interrupts()).toBe(0);
    await Promise.resolve();
    expect(late.interrupts()).toBe(1);
    expect(hub.listenerCount()).toBe(0);
  });

  it("times out start() while Redis is unreachable", async () => {
    const hub = createRealtimeHub({
      redisUrl: "redis://127.0.0.1:1",
      redisChannel: REDIS_CHANNEL,
      logger: silent,
      startTimeoutMs: 100,
    });
    try {
      await expect(hub.start()).rejects.toThrow(/not ready/);
    } finally {
      await hub.close();
    }
  });
});
