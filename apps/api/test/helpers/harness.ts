import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import type { LlmClient } from "@enmo/agents";
import type { Client, User } from "@enmo/db";
import {
  canonicalGraph,
  estimatePlan,
  type Brief,
  type ManagerPlanOutput,
  type PostType,
} from "@enmo/shared";
import { buildApp } from "../../src/app";
import type { EnvSource } from "../../src/config";
import { createDeps, type Deps } from "../../src/deps";
import { JOB_QUEUE, QUEUE_NAMES, type TickJobName } from "../../src/jobs/queues";
import { processorFor, processors } from "../../src/jobs/registry";
import { startWorkers, type WorkerRuntime } from "../../src/jobs/runtime";
import { DAY_MS, FakeClock } from "../../src/lib/clock";
import type { ApiApp, RouteModule } from "../../src/types";
import { testConfig } from "./app";
import { testDb } from "./db";
import { createClient, createUser } from "./factories";

/*
 * The pipeline e2e harness (DESIGN §H "Pipeline e2e", test/e2e/phaseN.*): the real app listening
 * on a free port, in-process queue workers on a unique BULLMQ_PREFIX, the MockLlm (fault
 * injection through env MOCK_LLM_FAULTS) and a FakeClock. Scheduler ticks never fire on their own
 * (SCHEDULERS_ENABLED=false); tests call runTick(). Runs in the vitest "integration" project, whose
 * setup truncates every table before each test.
 */

export interface HarnessOptions {
  /**
   * Env overrides on top of testEnv() (test/helpers/app.ts), e.g.
   * { MOCK_LLM_FAULTS: "COPYWRITER.write:invalid*2" } or { DAILY_TOKEN_CAP: "1" }.
   */
  env?: EnvSource;
  /** Defaults to a FakeClock at the real current time. */
  clock?: FakeClock;
  /** Replaces the LlmClient createLlm() builds from the env (MockLlm). */
  llm?: LlmClient;
  /** Start the in-process queue workers (default true). */
  workers?: boolean;
  /** Extra routes mounted under /v1 before the app starts listening. */
  routes?: RouteModule;
}

/** Truthy results of a waitFor predicate. */
export type Truthy<T> = Exclude<T, false | 0 | "" | null | undefined>;

export interface Harness {
  /** Ready and listening on `url`; `app.inject` works too. */
  app: ApiApp;
  deps: Deps;
  clock: FakeClock;
  /** deps.llm. */
  llm: LlmClient;
  /** http://127.0.0.1:<port>, for SSE clients and fetch. */
  url: string;
  /**
   * Polls `predicate` (typically a database query) until it returns something truthy and resolves
   * to that value; rejects after `timeoutMs` (default DEFAULT_WAIT_FOR_TIMEOUT_MS) with the last
   * value or error in the message.
   */
  waitFor<T>(predicate: () => T | Promise<T>, timeoutMs?: number): Promise<Truthy<T>>;
  /** Runs one scheduler tick's processor now, exactly as its repeatable job would. */
  runTick(name: TickJobName): Promise<void>;
  /** Opens GET /v1/events over the real port as `cookie`'s user (see EventStream). */
  events(options: EventStreamOptions): Promise<EventStream>;
  /** Closes the workers, the app and the deps, and removes this harness's queue keys. */
  stop(): Promise<void>;
}

export const DEFAULT_WAIT_FOR_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  timeoutMs = DEFAULT_WAIT_FOR_TIMEOUT_MS,
): Promise<Truthy<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: { value: unknown } | { error: unknown } = { value: undefined };
  for (;;) {
    try {
      const value = await predicate();
      if (value) return value as Truthy<T>;
      last = { value };
    } catch (error) {
      last = { error };
    }
    if (Date.now() >= deadline) {
      const detail =
        "error" in last
          ? `last error: ${last.error instanceof Error ? last.error.message : inspect(last.error)}`
          : `last value: ${inspect(last.value, { depth: 4 })}`;
      throw new Error(`waitFor timed out after ${timeoutMs}ms (${detail})`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = options.clock ?? new FakeClock();
  const config = testConfig({ ...options.env, SCHEDULERS_ENABLED: "false" });
  const deps = createDeps(config, { clock, ...(options.llm ? { llm: options.llm } : {}) });

  let app: ApiApp | undefined;
  let workers: WorkerRuntime | undefined;
  const streams = new Set<EventStream>();
  let tick = 0;

  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      try {
        for (const stream of streams) stream.close();
        await workers?.close();
        // Hijacked SSE responses would otherwise hold the server open until their client goes.
        app?.server.closeAllConnections();
        await app?.close();
        for (const name of QUEUE_NAMES) {
          await deps.queues.queue(name).obliterate({ force: true });
        }
      } finally {
        await deps.close();
      }
    })());

  try {
    app = await buildApp(deps);
    const { routes } = options;
    if (routes) {
      await app.register(
        async (scope) => {
          await routes(scope);
        },
        { prefix: "/v1" },
      );
    }
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    if (options.workers !== false) workers = await startWorkers(deps, { schedulers: false });

    return {
      app,
      deps,
      clock,
      llm: deps.llm,
      url,
      waitFor,
      async runTick(name) {
        const processor = processorFor(processors, JOB_QUEUE[name], name);
        if (!processor) throw new Error(`No processor registered for ${name}`);
        tick += 1;
        await processor(
          { id: `${name}-manual-${tick}`, name, data: {}, attemptsMade: 0, opts: { attempts: 1 } },
          deps,
        );
      },
      async events(streamOptions) {
        const stream = await EventStream.open(url, streamOptions);
        streams.add(stream);
        return stream;
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

/* ─── fixtures ──────────────────────────────────────────────────────────────────────────────── */

export interface SeededPlan {
  admin: User;
  client: Client;
  campaignId: string;
  threadId: string;
  graphId: string;
  brief: Brief;
  plan: ManagerPlanOutput;
}

export interface SeedPlanOptions {
  postCount: number;
  /** Defaults to a new client "Qahwa Co" on Instagram. */
  client?: Client;
  admin?: User;
  /** Defaults to STATIC. */
  type?: PostType;
}

/**
 * A campaign whose brief is locked and whose plan v1 (write → qa per post, PROPOSED) waits for
 * approval, written straight to the database so a test's MockLlm calls start at the Copywriter.
 */
export async function seedProposedPlan(h: Harness, options: SeedPlanOptions): Promise<SeededPlan> {
  const db = testDb();
  const admin = options.admin ?? (await createUser({ role: "ADMIN" }));
  const client =
    options.client ?? (await createClient({ name: "Qahwa Co", enabledPlatforms: ["INSTAGRAM"] }));
  const type = options.type ?? "STATIC";
  const day = (offset: number) =>
    new Date(h.clock.now().getTime() + offset * DAY_MS).toISOString().slice(0, 10);
  const brief: Brief = {
    clientId: client.id,
    title: "Iced Line",
    objective: "Drive trial of the iced line.",
    productFocus: "iced line",
    audience: null,
    keyMessages: ["Cold brew, done properly."],
    platforms: ["INSTAGRAM"],
    postCount: options.postCount,
    postMix: [{ type, count: options.postCount }],
    window: { start: day(1), end: day(options.postCount + 14) },
    cadenceNotes: null,
    constraints: [],
    assumptions: [],
  };
  const posts = Array.from({ length: options.postCount }, (_, i) => ({
    ref: `p${i + 1}`,
    type,
    platforms: ["INSTAGRAM" as const],
    targetDate: day(i + 1),
    angle: `Golden hour ${i + 1}: the iced line as the day winds down`,
    pillarHint: null,
  }));
  const plan: ManagerPlanOutput = {
    summary: `${options.postCount} ${type.toLowerCase()} posts for Instagram, each drafted then checked.`,
    posts,
    nodes: canonicalGraph(posts, ["write", "qa"]),
  };

  const campaign = await db.campaign.create({
    data: {
      clientId: client.id,
      name: brief.title,
      status: "PLANNING",
      brief,
      briefLockedAt: h.clock.now(),
      createdById: admin.id,
      thread: { create: {} },
    },
    include: { thread: true },
  });
  if (!campaign.thread) throw new Error("The campaign thread was not created");
  const graph = await db.taskGraph.create({
    data: {
      campaignId: campaign.id,
      version: 1,
      summary: plan.summary,
      graph: plan,
      estimate: estimatePlan(plan),
    },
  });
  return {
    admin,
    client,
    campaignId: campaign.id,
    threadId: campaign.thread.id,
    graphId: graph.id,
    brief,
    plan,
  };
}

/* ─── SSE client ─────────────────────────────────────────────────────────────────────────────── */

export interface EventStreamOptions {
  /** Session cookie ("enmo_session=…"). */
  cookie: string;
  threadId?: string;
  lastEventId?: string;
}

export interface ReceivedEvent {
  id: string | null;
  type: string;
  payload: unknown;
}

/** A minimal EventSource over fetch: collects every frame of GET /v1/events. */
export class EventStream {
  readonly received: ReceivedEvent[] = [];
  /** The `retry:` value the server sent, if any. */
  retryMs: number | null = null;
  readonly #abort = new AbortController();
  #error: unknown = null;

  private constructor() {}

  static async open(baseUrl: string, options: EventStreamOptions): Promise<EventStream> {
    const stream = new EventStream();
    const query = new URLSearchParams();
    if (options.threadId) query.set("threadId", options.threadId);
    const headers: Record<string, string> = {
      cookie: options.cookie,
      accept: "text/event-stream",
    };
    if (options.lastEventId) headers["last-event-id"] = options.lastEventId;
    const response = await fetch(`${baseUrl}/v1/events?${query.toString()}`, {
      headers,
      signal: stream.#abort.signal,
    });
    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => "");
      throw new Error(`GET /v1/events answered ${response.status}: ${body}`);
    }
    void stream.#read(response.body);
    return stream;
  }

  async #read(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          this.#frame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!this.#abort.signal.aborted) this.#error = error;
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
    if (data.length === 0) return;
    this.received.push({ id, type, payload: JSON.parse(data.join("\n")) as unknown });
  }

  /** Resolves with the first received event matching `predicate` (already received ones count). */
  async waitFor(
    predicate: (event: ReceivedEvent) => boolean,
    timeoutMs = DEFAULT_WAIT_FOR_TIMEOUT_MS,
  ): Promise<ReceivedEvent> {
    return waitFor(() => {
      if (this.#error) throw new Error("The event stream failed", { cause: this.#error });
      return this.received.find(predicate);
    }, timeoutMs);
  }

  ofType(type: string): ReceivedEvent[] {
    return this.received.filter((event) => event.type === type);
  }

  close(): void {
    this.#abort.abort();
  }
}
