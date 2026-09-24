import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagerQaOutput } from "@enmo/shared";
import {
  AnthropicLlm,
  LlmRequestRejected,
  MockLlm,
  createLlm,
  toMessageParams,
  type LlmRequest,
} from "../src";

const BASE_URL = "https://llm.example.test";

const qaReply = { verdict: "pass", issues: [], summaryForReviewer: "Ship it." };

function llmRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: "claude-sonnet-5",
    maxTokens: 16_000,
    effort: "low",
    system: [
      { text: "FROZEN SYSTEM PROMPT", cache: false },
      { text: "BRAND BLOCK", cache: true },
    ],
    messages: [
      { role: "user", content: "Review this post." },
      { role: "assistant", content: '{"verdict":"maybe"}' },
      {
        role: "user",
        content: [
          { type: "text", text: "Fix these issues." },
          { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" },
        ],
      },
    ],
    outputSchema: ManagerQaOutput,
    meta: { agent: "MANAGER", action: "qa", attempt: 2, input: {} },
    ...overrides,
  };
}

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function sse(events: readonly Record<string, unknown>[]): Response {
  const text = events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function messageEvents(options: {
  text: string;
  stopReason?: string;
  stopDetails?: Record<string, unknown> | null;
}): Record<string, unknown>[] {
  const half = Math.floor(options.text.length / 2);
  return [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        container: null,
        usage: {
          input_tokens: 120,
          output_tokens: 1,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 2000,
        },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: options.text.slice(0, half) },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: options.text.slice(half) },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: {
        stop_reason: options.stopReason ?? "end_turn",
        stop_sequence: null,
        stop_details: options.stopDetails ?? null,
      },
      usage: { output_tokens: 42 },
    },
    { type: "message_stop" },
  ];
}

function errorResponse(
  status: number,
  type: string,
  message: string,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A fetch that answers with `responses` in order and records each request. */
function fakeFetch(responses: readonly (() => Response)[]) {
  const calls: Captured[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >,
    });
    const next = responses[calls.length - 1];
    return next ? Promise.resolve(next()) : Promise.reject(new Error("unexpected request"));
  };
  return { fetch, calls };
}

function client(fetch: typeof globalThis.fetch, maxRetries?: number) {
  return new AnthropicLlm({
    apiKey: "sk-test-key",
    model: "claude-sonnet-5",
    baseUrl: BASE_URL,
    fetch,
    ...(maxRetries === undefined ? {} : { maxRetries }),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("toMessageParams", () => {
  it("maps an LlmRequest onto the Messages API shape", () => {
    const params = toMessageParams(llmRequest());
    expect(params).toMatchObject({
      model: "claude-sonnet-5",
      max_tokens: 16_000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low", format: { type: "json_schema" } },
      system: [
        { type: "text", text: "FROZEN SYSTEM PROMPT" },
        { type: "text", text: "BRAND BLOCK", cache_control: { type: "ephemeral" } },
      ],
      messages: [
        { role: "user", content: "Review this post." },
        { role: "assistant", content: '{"verdict":"maybe"}' },
        {
          role: "user",
          content: [
            { type: "text", text: "Fix these issues." },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
            },
          ],
        },
      ],
    });
    expect(params.system).toHaveLength(2);
    expect((params.system as { cache_control?: unknown }[])[0]!.cache_control).toBeUndefined();
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("top_p");
    expect(params).not.toHaveProperty("top_k");
    // No `parse`: the SDK would otherwise throw at message_stop on output the runner must see.
    const format = params.output_config?.format;
    expect(format && "parse" in format).toBe(false);
    expect(format?.schema).toMatchObject({ type: "object", additionalProperties: false });
  });

  it("builds each schema's JSON schema once", () => {
    const a = toMessageParams(llmRequest()).output_config?.format;
    const b = toMessageParams(llmRequest()).output_config?.format;
    expect(a).toBe(b);
  });
});

describe("AnthropicLlm", () => {
  it("streams to the configured base URL with the API key only, and maps the reply", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://wrong.example.test");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "leaked-token");
    vi.stubEnv("ANTHROPIC_API_KEY", "leaked-key");
    const text = JSON.stringify(qaReply);
    const { fetch, calls } = fakeFetch([() => sse(messageEvents({ text }))]);

    const response = await client(fetch).complete(llmRequest());

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe(`${BASE_URL}/v1/messages`);
    expect(call!.method).toBe("POST");
    expect(call!.headers.get("x-api-key")).toBe("sk-test-key");
    expect(call!.headers.get("authorization")).toBeNull();
    expect(call!.headers.get("anthropic-version")).toBeTruthy();
    expect(call!.body).toMatchObject({
      model: "claude-sonnet-5",
      max_tokens: 16_000,
      stream: true,
      thinking: { type: "adaptive" },
      output_config: { effort: "low", format: { type: "json_schema" } },
    });
    expect(call!.body).not.toHaveProperty("temperature");
    const messages = call!.body.messages as { role: string }[];
    expect(messages[messages.length - 1]!.role).toBe("user");

    expect(response).toMatchObject({
      text,
      stopReason: "end_turn",
      model: "claude-sonnet-5",
      refusal: null,
      usage: { inputTokens: 120, outputTokens: 42, cacheReadTokens: 2000, cacheWriteTokens: 30 },
    });
    expect(response.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns a refusal with its stop details instead of throwing", async () => {
    const { fetch } = fakeFetch([
      () =>
        sse(
          messageEvents({
            text: "",
            stopReason: "refusal",
            stopDetails: { type: "refusal", category: "cyber", explanation: "Declined." },
          }),
        ),
    ]);
    const response = await client(fetch).complete(llmRequest());
    expect(response).toMatchObject({
      text: "",
      stopReason: "refusal",
      refusal: { category: "cyber", explanation: "Declined." },
    });
  });

  it("returns truncated output as max_tokens rather than failing to parse it", async () => {
    const { fetch } = fakeFetch([
      () => sse(messageEvents({ text: '{"verdict":"pa', stopReason: "max_tokens" })),
    ]);
    const response = await client(fetch).complete(llmRequest());
    expect(response).toMatchObject({ text: '{"verdict":"pa', stopReason: "max_tokens" });
  });

  it("turns a 400 into LlmRequestRejected, without retrying", async () => {
    const { fetch, calls } = fakeFetch([
      () => errorResponse(400, "invalid_request_error", "prompt is too long"),
    ]);
    const error = await client(fetch)
      .complete(llmRequest())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmRequestRejected);
    expect(error).toMatchObject({ status: 400 });
    expect((error as Error).message).toContain("prompt is too long");
    expect(calls).toHaveLength(1);
  });

  it("retries 429s in the SDK, then lets the error propagate for the queue", async () => {
    const limited = () =>
      errorResponse(429, "rate_limit_error", "slow down", { "retry-after-ms": "1" });
    const { fetch, calls } = fakeFetch([limited, limited, limited]);
    const error = await client(fetch)
      .complete(llmRequest())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Anthropic.RateLimitError);
    expect(error).not.toBeInstanceOf(LlmRequestRejected);
    expect(calls).toHaveLength(3);
  });

  it("recovers when a retry succeeds", async () => {
    const { fetch, calls } = fakeFetch([
      () => errorResponse(529, "overloaded_error", "overloaded", { "retry-after-ms": "1" }),
      () => sse(messageEvents({ text: JSON.stringify(qaReply) })),
    ]);
    const response = await client(fetch).complete(llmRequest());
    expect(calls).toHaveLength(2);
    expect(response.stopReason).toBe("end_turn");
  });

  it("propagates 5xx errors as SDK errors when retries are off", async () => {
    const { fetch } = fakeFetch([() => errorResponse(500, "api_error", "boom")]);
    const error = await client(fetch, 0)
      .complete(llmRequest())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Anthropic.InternalServerError);
  });
});

describe("createLlm", () => {
  const base = { model: "claude-sonnet-5", baseUrl: BASE_URL, faults: null };

  it("builds the Anthropic client only with a key, without any I/O", () => {
    const { fetch, calls } = fakeFetch([]);
    const llm = createLlm({ ...base, provider: "anthropic", apiKey: "sk-test-key", fetch });
    expect(llm).toBeInstanceOf(AnthropicLlm);
    expect(llm).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(calls).toHaveLength(0);
  });

  it("falls back to the MockLlm without a key", () => {
    for (const apiKey of [null, "", "   "]) {
      const llm = createLlm({ ...base, provider: "anthropic", apiKey });
      expect(llm).toBeInstanceOf(MockLlm);
      expect(llm.provider).toBe("mock");
    }
    expect(createLlm({ ...base, provider: "mock", apiKey: "sk-test-key" })).toBeInstanceOf(MockLlm);
  });
});
