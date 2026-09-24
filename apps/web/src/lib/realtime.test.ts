import type { ChatMessageDto } from "@enmo/shared";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../hooks/query-keys";
import { API_URL } from "./api";
import { LiveStream, type RealtimeStatus } from "./realtime";

/* The stream outside React, against a scripted EventSource. */

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readonly url: URL;
  readonly withCredentials: boolean;
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(url: string | URL, init?: EventSourceInit) {
    this.url = new URL(String(url));
    this.withCredentials = init?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }

  emit(type: string, payload: unknown, id: string): void {
    const event = { data: JSON.stringify(payload), lastEventId: id } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  fail(readyState: number): void {
    this.readyState = readyState;
    this.onerror?.();
  }
}

const AT = "2027-02-01T10:00:00.000Z";
const message: ChatMessageDto = {
  id: "m2",
  threadId: "t1",
  role: "AGENT",
  agent: "MANAGER",
  author: null,
  content: "Which platforms?",
  createdAt: AT,
  updatedAt: AT,
  kind: "TEXT",
  payload: null,
};

function latest(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error("No stream was opened");
  return source;
}

describe("LiveStream", () => {
  let queryClient: QueryClient;
  let statuses: RealtimeStatus[];
  let stream: LiveStream;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    FakeEventSource.instances = [];
    queryClient = new QueryClient();
    statuses = [];
    stream = new LiveStream(queryClient, {
      onStatus: (status) => statuses.push(status),
      onAlert: () => undefined,
    });
  });

  afterEach(() => {
    stream.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("opens one credentialed stream on the global channel", () => {
    stream.start();
    const source = latest();
    expect(source.url.toString()).toBe(`${API_URL}/v1/events`);
    expect(source.withCredentials).toBe(true);
    source.open();
    expect(statuses).toEqual(["connecting", "open"]);
  });

  it("refetches the live queries when a stream opens with nothing to replay from", () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    stream.start();
    latest().open();
    vi.advanceTimersByTime(200);
    const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    expect(keys).toEqual(
      expect.arrayContaining([
        JSON.stringify(queryKeys.threads.all),
        JSON.stringify(queryKeys.posts.all),
        JSON.stringify(queryKeys.budget),
      ]),
    );
  });

  it("patches the thread and carries the newest event id into the next thread's stream", () => {
    queryClient.setQueryData(queryKeys.threads.messages("t1"), [
      { ...message, id: "m1", content: "Brief" },
    ]);
    stream.setThread("t1");
    stream.start();
    const first = latest();
    expect(first.url.searchParams.get("threadId")).toBe("t1");
    first.open();
    first.emit("message.created", { threadId: "t1", message }, "41");
    expect(
      queryClient
        .getQueryData<ChatMessageDto[]>(queryKeys.threads.messages("t1"))
        ?.map((m) => m.id),
    ).toEqual(["m1", "m2"]);

    stream.setThread("t2");
    const second = latest();
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    expect(second.url.searchParams.get("threadId")).toBe("t2");
    expect(second.url.searchParams.get("lastEventId")).toBe("41");

    // The new thread's history predates the cursor, so it is read afresh on open.
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    second.open();
    vi.advanceTimersByTime(200);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.threads.messages("t2") });
  });

  it("stores budget snapshots as they arrive", () => {
    stream.start();
    latest().open();
    const budget = {
      day: "2027-02-01",
      used: 4200,
      cap: 2_000_000,
      remaining: 1_995_800,
      blockedTasks: 0,
      resetsAt: "2027-02-02T00:00:00.000Z",
    };
    latest().emit("budget.updated", budget, "7");
    expect(queryClient.getQueryData(queryKeys.budget)).toEqual(budget);
  });

  it("backs off and reopens after the stream is refused", () => {
    stream.start();
    latest().open();
    latest().fail(FakeEventSource.CLOSED);
    expect(statuses.at(-1)).toBe("reconnecting");
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    latest().fail(FakeEventSource.CLOSED);
    vi.advanceTimersByTime(2_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(2_000);
    expect(FakeEventSource.instances).toHaveLength(3);
    latest().open();
    expect(statuses.at(-1)).toBe("open");
  });

  it("lets the browser retry a dropped stream by itself", () => {
    stream.start();
    latest().open();
    latest().fail(FakeEventSource.CONNECTING);
    expect(statuses.at(-1)).toBe("reconnecting");
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
