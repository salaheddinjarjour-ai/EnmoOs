"use client";

import {
  parseRealtimeEvent,
  RealtimeEventType,
  type AlertPayload,
  type ChatMessageDto,
  type PostDto,
  type PostListResponse,
} from "@enmo/shared";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { queryKeys } from "../hooks/query-keys";
import { API_URL } from "./api";
import {
  effectsOf,
  patchPost,
  queryKeyId,
  upsertMessage,
  type CacheEffect,
} from "./realtime-events";
import { SESSION_QUERY_KEY } from "./session";

/*
 * Live updates (DESIGN §D "Realtime", §G). ONE EventSource per signed-in tab on
 * `${API}/v1/events`: the global channel always, plus `?threadId=` while a campaign thread is on
 * screen, so opening another thread swaps the stream rather than adding one. Each event becomes
 * cache effects (lib/realtime-events): patches land at once, invalidations are batched.
 *
 * Gaps: the newest event id seen is carried into every new stream as `?lastEventId=`, so the API
 * replays whatever was published while no stream was open (and the browser's own reconnects send
 * Last-Event-ID). A stream that opens without any cursor can't know what it missed, so it refetches
 * the live queries instead, and a thread coming back on screen is read afresh (its events from
 * while it was unsubscribed predate the cursor); `resync` refetches everything.
 */

export type RealtimeStatus = "connecting" | "open" | "reconnecting";

export interface LiveAlert extends AlertPayload {
  /** Event id, or a local sequence for alerts without one. */
  id: string;
  receivedAt: string;
}

const MAX_ALERTS = 20;
const INVALIDATE_BATCH_MS = 120;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

/** Query roots whose data the stream keeps current. */
const LIVE_ROOTS: readonly QueryKey[] = [
  queryKeys.campaigns.all,
  queryKeys.threads.all,
  queryKeys.taskGraphs.all,
  queryKeys.posts.all,
  queryKeys.assets.all,
  queryKeys.approvals.all,
  queryKeys.budget,
];

export interface StreamCallbacks {
  onStatus(status: RealtimeStatus): void;
  onAlert(alert: LiveAlert): void;
}

/** The connection itself, outside React: one EventSource at a time, reconnecting with backoff. */
export class LiveStream {
  private source: EventSource | null = null;
  private threadId: string | null = null;
  private lastEventId: string | null = null;
  private running = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<string, QueryKey>();
  private alertSequence = 0;

  constructor(
    private readonly queryClient: QueryClient,
    private readonly callbacks: StreamCallbacks,
  ) {}

  start(): void {
    this.running = true;
    this.callbacks.onStatus("connecting");
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.close();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pending.clear();
  }

  setThread(threadId: string | null): void {
    if (threadId === this.threadId) return;
    this.threadId = threadId;
    if (this.running) this.connect();
  }

  private close(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.source?.close();
    this.source = null;
  }

  private connect(): void {
    this.close();
    const url = new URL(`${API_URL}/v1/events`);
    if (this.threadId) url.searchParams.set("threadId", this.threadId);
    const cursor = this.lastEventId;
    if (cursor) url.searchParams.set("lastEventId", cursor);

    // Swapping threads keeps the current status: the indicator only moves on open or error.
    const source = new EventSource(url, { withCredentials: true });
    const threadId = this.threadId;
    this.source = source;
    let sawEventId = false;
    let opened = false;

    source.onopen = () => {
      this.attempt = 0;
      this.callbacks.onStatus("open");
      if (!cursor && !sawEventId) {
        // Without a cursor the API had nothing to replay from: refetch what may have changed.
        this.refetchLive();
      } else if (!opened && threadId) {
        // The cursor only covers what this tab was subscribed to; the thread's own events from
        // while it was off screen are older than it, so the thread is read afresh.
        this.scheduleInvalidate(queryKeys.threads.messages(threadId));
        this.scheduleInvalidate(queryKeys.campaigns.all);
        this.scheduleInvalidate(queryKeys.taskGraphs.all);
      }
      opened = true;
    };
    source.onerror = () => {
      if (source.readyState === EventSource.CONNECTING) {
        // The browser retries on its own (after the stream's `retry:`), sending Last-Event-ID.
        this.callbacks.onStatus("reconnecting");
        return;
      }
      // Closed for good (an HTTP error such as 401 or 503): back off and open a new stream. The
      // session may be what ended, which the session probe turns into a trip to /login.
      source.close();
      if (this.source !== source || !this.running) return;
      this.source = null;
      this.callbacks.onStatus("reconnecting");
      void this.queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempt);
      this.attempt += 1;
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };

    for (const type of RealtimeEventType.options) {
      source.addEventListener(type, (event) => {
        if (this.source !== source) return;
        if (event.lastEventId) {
          this.lastEventId = event.lastEventId;
          sawEventId = true;
        }
        this.receive(type, event.data, event.lastEventId);
      });
    }
  }

  private receive(type: string, data: unknown, eventId: string): void {
    // Both failure paths below mean a frame this build can't read: refetching is always safe.
    let payload: unknown;
    try {
      payload = JSON.parse(String(data));
    } catch {
      this.refetchLive();
      return;
    }
    const parsed = parseRealtimeEvent(type, payload);
    if (!parsed.success) {
      this.refetchLive();
      return;
    }
    for (const effect of effectsOf(parsed.data)) this.apply(effect, eventId);
  }

  private apply(effect: CacheEffect, eventId: string): void {
    switch (effect.kind) {
      case "invalidate":
        this.scheduleInvalidate(effect.queryKey);
        return;
      case "upsertMessage":
        this.queryClient.setQueryData<ChatMessageDto[]>(
          queryKeys.threads.messages(effect.threadId),
          (current) => (current ? upsertMessage(current, effect.message) : current),
        );
        return;
      case "patchPost":
        this.queryClient.setQueryData<PostDto>(
          queryKeys.posts.detail(effect.post.postId),
          (post) => (post ? patchPost(post, effect.post) : post),
        );
        this.queryClient.setQueriesData<PostListResponse>(
          { queryKey: queryKeys.posts.lists() },
          (current) =>
            current
              ? { items: current.items.map((post) => patchPost(post, effect.post)) }
              : current,
        );
        return;
      case "setBudget":
        this.queryClient.setQueryData(queryKeys.budget, effect.budget);
        return;
      case "alert":
        this.alertSequence += 1;
        this.callbacks.onAlert({
          ...effect.alert,
          id: eventId || `local-${this.alertSequence}`,
          receivedAt: new Date().toISOString(),
        });
        return;
      case "resync":
        void this.queryClient.invalidateQueries();
        return;
    }
  }

  private refetchLive(): void {
    for (const queryKey of LIVE_ROOTS) this.scheduleInvalidate(queryKey);
  }

  private scheduleInvalidate(queryKey: QueryKey): void {
    this.pending.set(queryKeyId(queryKey), queryKey);
    this.flushTimer ??= setTimeout(() => this.flush(), INVALIDATE_BATCH_MS);
  }

  private flush(): void {
    this.flushTimer = null;
    const keys = [...this.pending.values()];
    this.pending.clear();
    for (const queryKey of keys) void this.queryClient.invalidateQueries({ queryKey });
  }
}

interface RealtimeContextValue {
  status: RealtimeStatus;
  alerts: readonly LiveAlert[];
  dismissAlert: (id: string) => void;
  /** Adds the thread's channel to the stream; call the returned function to release it. */
  watchThread: (threadId: string) => () => void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const [alerts, setAlerts] = useState<LiveAlert[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [stream] = useState(
    () =>
      new LiveStream(queryClient, {
        onStatus: setStatus,
        onAlert: (alert) =>
          setAlerts((current) =>
            [alert, ...current.filter((existing) => existing.id !== alert.id)].slice(0, MAX_ALERTS),
          ),
      }),
  );

  useEffect(() => {
    stream.start();
    return () => stream.stop();
  }, [stream]);

  useEffect(() => stream.setThread(threadId), [stream, threadId]);

  const watchThread = useCallback((id: string) => {
    setThreadId(id);
    return () => setThreadId((current) => (current === id ? null : current));
  }, []);

  const dismissAlert = useCallback(
    (id: string) => setAlerts((current) => current.filter((alert) => alert.id !== id)),
    [],
  );

  const value = useMemo<RealtimeContextValue>(
    () => ({ status, alerts, dismissAlert, watchThread }),
    [status, alerts, dismissAlert, watchThread],
  );

  return <RealtimeContext value={value}>{children}</RealtimeContext>;
}

function useRealtime(): RealtimeContextValue {
  const context = useContext(RealtimeContext);
  if (!context) throw new Error("Realtime hooks must be used inside <RealtimeProvider>");
  return context;
}

/** Streams the thread's events while the calling component is mounted. */
export function useRealtimeThread(threadId: string | undefined): void {
  const { watchThread } = useRealtime();
  useEffect(() => (threadId ? watchThread(threadId) : undefined), [threadId, watchThread]);
}

export function useRealtimeStatus(): RealtimeStatus {
  return useRealtime().status;
}

/** Alerts received live this session (escalations, failures, budget), newest first. */
export function useLiveAlerts(): Pick<RealtimeContextValue, "alerts" | "dismissAlert"> {
  const { alerts, dismissAlert } = useRealtime();
  return { alerts, dismissAlert };
}
