import type { DbClient } from "@enmo/db";
import {
  formatSseFrame,
  GLOBAL_CHANNEL,
  SSE_HEARTBEAT_MS,
  SSE_REPLAY_LIMIT,
  SSE_RETRY_MS,
  threadChannel,
  type RealtimeChannel,
  type RealtimeEnvelope,
  type ResyncPayload,
} from "@enmo/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { badRequest, notFound } from "../lib/errors";
import type { RealtimeHub } from "./hub";

/*
 * One SSE connection (DESIGN §D "Endpoint", GET /v1/events). `reply.hijack()`, then the headers
 * (text/event-stream, Cache-Control: no-cache, no-transform, Connection: keep-alive,
 * X-Accel-Buffering: no, plus the CORS headers written by hand because a hijacked reply skips the
 * normal send path), `retry: SSE_RETRY_MS`, the replay of RealtimeEvent rows after `lastEventId`
 * on `channels` (more than SSE_REPLAY_LIMIT sends one `resync` instead), then live frames from the
 * hub and a `: ping` comment every heartbeat until the client goes away.
 *
 * The hub subscription starts before the replay query, so nothing published in between is lost;
 * live events are held back until the replay is written, and ones the replay already carried are
 * dropped. The session is checked again every `session.everyMs`: logging out or being deactivated
 * deletes it, and the stream must not outlive it.
 */

/** The largest RealtimeEvent.id (Postgres BIGINT). */
const MAX_EVENT_ID = 2n ** 63n - 1n;

/** A Last-Event-ID as the stream wrote it: the decimal row id. */
export const EventId = z
  .string()
  .refine(
    (value) => /^\d{1,19}$/.test(value) && BigInt(value) <= MAX_EVENT_ID,
    "Expected an event id",
  );

/**
 * A stream whose socket buffers more than this is not keeping up; it is cut off, and the browser's
 * reconnect replays what it missed from the table instead of this process holding it in memory.
 */
export const SSE_MAX_BUFFERED_BYTES = 1 << 20;

/** How often an open stream re-checks its session. */
export const SSE_SESSION_CHECK_MS = 60_000;

export interface SessionCheck {
  everyMs: number;
  /** False once the session behind the stream is gone. */
  isValid(): Promise<boolean>;
}

export interface EventStreamOptions {
  /** GLOBAL_CHANNEL, plus the thread's channel when the page names one. */
  channels: readonly RealtimeChannel[];
  /** From the Last-Event-ID header or ?lastEventId=; null for a fresh stream. */
  lastEventId: bigint | null;
  /** Exact origins allowed to read the stream with credentials (APP_ORIGINS). */
  allowedOrigins: ReadonlySet<string>;
  /** Defaults to SSE_HEARTBEAT_MS. */
  heartbeatMs?: number;
  /** Ends the stream when aborted (the app is shutting down). */
  signal?: AbortSignal;
  /** Ends the stream once the session it was opened with is no longer valid. */
  session?: SessionCheck;
}

/**
 * The cursor to replay from. The header wins: EventSource puts the newest id it saw there on every
 * reconnect, while the query only holds what the page knew when it first opened the stream.
 */
export function resolveLastEventId(
  header: string | string[] | undefined,
  query: string | undefined,
): bigint | null {
  const fromHeader = Array.isArray(header) ? header.at(-1) : header;
  const value = fromHeader?.trim() || query;
  if (value === undefined || value === "") return null;
  const parsed = EventId.safeParse(value);
  if (!parsed.success) throw badRequest("Last-Event-ID must be an event id this stream sent");
  return BigInt(parsed.data);
}

/** The channels a stream listens on; NOT_FOUND when the named thread doesn't exist. */
export async function resolveChannels(
  prisma: DbClient,
  threadId: string | undefined,
): Promise<RealtimeChannel[]> {
  if (threadId === undefined) return [GLOBAL_CHANNEL];
  const thread = await prisma.chatThread.findUnique({
    where: { id: threadId },
    select: { id: true },
  });
  if (!thread) throw notFound("Thread");
  return [GLOBAL_CHANNEL, threadChannel(thread.id)];
}

type HeaderValue = number | string | string[];

function withVary(existing: HeaderValue | undefined, field: string): string {
  const values = [existing ?? []]
    .flat()
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.some((value) => value.toLowerCase() === field.toLowerCase())) values.push(field);
  return values.join(", ");
}

/**
 * The response headers: whatever the app's hooks already set (security headers), the exact-origin
 * CORS pair for an allowed Origin (and nothing CORS-related for any other), and the SSE headers.
 */
export function eventStreamHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedOrigins: ReadonlySet<string>,
): Record<string, HeaderValue> {
  const headers: Record<string, HeaderValue> = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    // The CORS pair is decided below, from the exact origin list only.
    if (value === undefined || name === "content-length") continue;
    if (name.startsWith("access-control-")) continue;
    headers[name] = value;
  }
  const { origin } = request.headers;
  if (origin !== undefined && allowedOrigins.has(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-credentials"] = "true";
  }
  headers.vary = withVary(headers.vary, "Origin");
  return {
    ...headers,
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
}

interface ReplayResult {
  /** Ids written by the replay, so the same events arriving live are not sent twice. */
  replayed: Set<string>;
}

/** Writes the missed rows, or a single `resync` when there are more than SSE_REPLAY_LIMIT. */
async function replay(
  prisma: DbClient,
  channels: readonly RealtimeChannel[],
  after: bigint,
  write: (chunk: string) => void,
): Promise<ReplayResult> {
  const where = { channel: { in: [...channels] } };
  const rows = await prisma.realtimeEvent.findMany({
    where: { ...where, id: { gt: after } },
    orderBy: { id: "asc" },
    take: SSE_REPLAY_LIMIT + 1,
    select: { id: true, type: true, payload: true },
  });

  if (rows.length > SSE_REPLAY_LIMIT) {
    // The resync carries the newest id, so the next reconnect resumes from here.
    const newest = await prisma.realtimeEvent.findFirst({
      where,
      orderBy: { id: "desc" },
      select: { id: true },
    });
    const payload: ResyncPayload = {
      reason: `Missed more than ${SSE_REPLAY_LIMIT} events; reload everything`,
    };
    const id = (newest?.id ?? after).toString();
    write(formatSseFrame({ id, type: "resync", payload }));
    return { replayed: new Set() };
  }

  const replayed = new Set<string>();
  for (const row of rows) {
    const id = row.id.toString();
    replayed.add(id);
    write(formatSseFrame({ id, type: row.type, payload: row.payload }));
  }
  return { replayed };
}

/** Streams until the connection closes (or `signal` aborts); never rejects. */
export function streamEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  hub: RealtimeHub,
  options: EventStreamOptions,
): Promise<void> {
  const { prisma } = request.server.deps;
  const { channels, lastEventId, signal, session, heartbeatMs = SSE_HEARTBEAT_MS } = options;
  const raw = reply.raw;
  const log = request.log;

  reply.hijack();
  raw.writeHead(200, eventStreamHeaders(request, reply, options.allowedOrigins));

  return new Promise<void>((resolve) => {
    let finished = false;
    /** Live events held back while the replay is written; null once live frames flow. */
    let held: RealtimeEnvelope[] | null = [];
    let replayed = new Set<string>();

    const write = (chunk: string) => {
      if (finished || raw.writableEnded || raw.destroyed) return;
      if (!raw.write(chunk) && raw.writableLength > SSE_MAX_BUFFERED_BYTES) {
        log.warn({ buffered: raw.writableLength }, "SSE client is not keeping up; disconnecting");
        raw.destroy();
      }
    };

    const send = (event: RealtimeEnvelope) => {
      // Each replayed id can come back live at most once (a PUBLISH that lagged its insert).
      if (replayed.delete(event.id)) return;
      write(formatSseFrame(event));
    };

    const end = () => {
      if (!raw.writableEnded && !raw.destroyed) raw.end();
      finish();
    };

    const unsubscribe = hub.subscribe(channels, {
      onEvent: (event) => (held ? held.push(event) : send(event)),
      onInterrupt: end,
    });
    const heartbeat = setInterval(() => write(": ping\n\n"), heartbeatMs);
    heartbeat.unref();
    const sessionCheck = session
      ? setInterval(() => {
          session.isValid().then(
            (valid) => {
              if (!valid) end();
            },
            (error: unknown) => log.warn({ err: error }, "SSE session check failed"),
          );
        }, session.everyMs)
      : undefined;
    sessionCheck?.unref();

    function finish() {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      clearInterval(sessionCheck);
      unsubscribe();
      signal?.removeEventListener("abort", end);
      raw.off("close", finish);
      held = null;
      replayed.clear();
      resolve();
    }

    raw.once("close", finish);
    signal?.addEventListener("abort", end, { once: true });
    // The client may have left while the request was being authenticated.
    if (signal?.aborted || raw.destroyed || request.raw.socket.destroyed) {
      end();
      return;
    }

    write(`retry: ${SSE_RETRY_MS}\n\n`);

    const replayDone =
      lastEventId === null
        ? Promise.resolve({ replayed: new Set<string>() })
        : replay(prisma, channels, lastEventId, write);
    replayDone.then(
      (result) => {
        if (finished) return;
        replayed = result.replayed;
        const pending = held ?? [];
        held = null;
        for (const event of pending) send(event);
      },
      (error: unknown) => {
        log.error({ err: error }, "SSE replay failed; closing the stream so the client retries");
        end();
      },
    );
  });
}
