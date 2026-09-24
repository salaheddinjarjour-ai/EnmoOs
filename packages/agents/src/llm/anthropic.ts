import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type {
  ContentBlockParam,
  JSONOutputFormat,
  Message,
  MessageParam,
  MessageStreamParams,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { z } from "zod";
import { LlmRequestRejected } from "../errors";
import type { LlmClient, LlmMessage, LlmRequest, LlmResponse } from "./types";

/** SDK-level retries of 408/409/429/5xx/connection errors before BullMQ's own attempts. */
export const ANTHROPIC_MAX_RETRIES = 2;

export interface AnthropicLlmOptions {
  apiKey: string;
  /** Default model (ANTHROPIC_MODEL). */
  model: string;
  /** ENMO_ANTHROPIC_BASE_URL, e.g. "https://api.anthropic.com". */
  baseUrl: string;
  /** Defaults to ANTHROPIC_MAX_RETRIES; tests lower it. */
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
}

/** HTTP statuses where the identical request can never succeed (see LlmRequestRejected). */
const REJECTED_STATUSES = new Set([400, 413]);

const formatCache = new WeakMap<z.ZodType, JSONOutputFormat>();

/**
 * The contract as `output_config.format`, without zodOutputFormat's `parse`: with a parseable
 * format the SDK parses at message_stop and finalMessage() rejects on invalid output, losing the
 * text and usage the runner must record before asking for a correction.
 */
export function outputFormatFor(schema: z.ZodType): JSONOutputFormat {
  let format = formatCache.get(schema);
  if (!format) {
    format = { type: "json_schema", schema: zodOutputFormat(schema).schema };
    formatCache.set(schema, format);
  }
  return format;
}

/** LlmRequest → Messages API params (snake_case wire names; no temperature, top_p or prefill). */
export function toMessageParams(request: LlmRequest): MessageStreamParams {
  const system: TextBlockParam[] = request.system.map((block) =>
    block.cache
      ? { type: "text", text: block.text, cache_control: { type: "ephemeral" } }
      : { type: "text", text: block.text },
  );
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    thinking: { type: "adaptive" },
    output_config: { effort: request.effort, format: outputFormatFor(request.outputSchema) },
    system,
    messages: request.messages.map(toMessageParam),
  };
}

function toMessageParam(message: LlmMessage): MessageParam {
  if (typeof message.content === "string") return { role: message.role, content: message.content };
  const content: ContentBlockParam[] = message.content.map((block) =>
    block.type === "text"
      ? { type: "text", text: block.text }
      : {
          type: "image",
          source: { type: "base64", media_type: block.mediaType, data: block.data },
        },
  );
  return { role: message.role, content };
}

/** Message → LlmResponse: text blocks joined (thinking skipped), usage split as billed. */
export function toLlmResponse(message: Message, latencyMs: number): LlmResponse {
  let text = "";
  for (const block of message.content) if (block.type === "text") text += block.text;
  const details = message.stop_details;
  return {
    text,
    // Always set on a finished stream; end_turn keeps the type total if a proxy drops it.
    stopReason: message.stop_reason ?? "end_turn",
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    },
    model: message.model,
    latencyMs,
    refusal:
      details?.type === "refusal"
        ? { category: details.category ?? null, explanation: details.explanation ?? null }
        : null,
  };
}

/**
 * The Anthropic Messages API behind LlmClient. Credentials and base URL are always passed
 * explicitly (authToken: null) so a shell's ANTHROPIC_* variables are never picked up. The SDK
 * client is built on first use, which keeps construction free of I/O and exceptions.
 */
export class AnthropicLlm implements LlmClient {
  readonly provider = "anthropic" as const;
  readonly model: string;
  private readonly options: AnthropicLlmOptions;
  private client: Anthropic | null = null;

  constructor(options: AnthropicLlmOptions) {
    this.options = options;
    this.model = options.model;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const client = (this.client ??= new Anthropic({
      apiKey: this.options.apiKey,
      authToken: null,
      baseURL: this.options.baseUrl,
      webhookKey: null,
      maxRetries: this.options.maxRetries ?? ANTHROPIC_MAX_RETRIES,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    }));
    const params = toMessageParams(request);
    const started = performance.now();
    try {
      const message = await client.messages.stream(params).finalMessage();
      return toLlmResponse(message, Math.round(performance.now() - started));
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        const status: unknown = error.status;
        if (typeof status === "number" && REJECTED_STATUSES.has(status)) {
          throw new LlmRequestRejected({ status, message: error.message, cause: error });
        }
      }
      throw error;
    }
  }
}
