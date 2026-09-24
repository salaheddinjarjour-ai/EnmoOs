import type { z } from "zod";
import {
  CopywriterInput,
  DEFAULT_LLM_MODEL,
  ManagerIntakeInput,
  ManagerPlanInput,
  ManagerQaInput,
  type Brief,
  type PostContext,
} from "@enmo/shared";
import type { LlmClient, LlmRefusal, LlmRequest, LlmResponse, LlmStopReason } from "../types";
import { mockCopy, mockCopyWithBannedWord } from "./copywriter";
import { faultAt, parseMockFaults, type MockFault, type MockFaultKind } from "./faults";
import { mockIntake } from "./intake";
import { mockPlan } from "./plan";
import { mockQa, mockWeakQa } from "./qa";
import { hashOf } from "./seed";

export {
  MOCK_FAULT_KINDS,
  faultAt,
  parseMockFaults,
  type MockFault,
  type MockFaultKind,
} from "./faults";
export { REVISION_PREFIX } from "./copywriter";

/** Synthetic usage: one token per four characters. */
export const MOCK_CHARS_PER_TOKEN = 4;
/** An image block's synthetic input tokens (≈ a 1568px render). */
export const MOCK_IMAGE_TOKENS = 1_600;
/** Served-by model on mock replies (`mock:<requested model>`), so AgentRun rows never pass for real calls. */
export const MOCK_MODEL_PREFIX = "mock:";

export interface MockLlmOptions {
  /** Default request model (ANTHROPIC_MODEL); defaults to DEFAULT_LLM_MODEL. */
  model?: string;
  /** MOCK_LLM_FAULTS syntax or parsed faults. */
  faults?: string | readonly MockFault[] | null;
  /** Artificial latency per call, so a local demo shows progress arriving over time. */
  delayMs?: number;
}

/** A fixture bound to one call's input. */
interface BoundFixture {
  /** The piece of work this call is about; fault counts are kept per subject. */
  subject: string;
  build(): object;
  /** The output with a banned word in it; null when the fixture can't express that fault. */
  withBannedWord(): object | null;
  /** A valid but negative verdict; null when the fixture has none. */
  weak(): object | null;
}

function fixture<I>(
  schema: z.ZodType<I>,
  spec: {
    subject(input: I): unknown;
    build(input: I): object;
    banned?(input: I): object | null;
    weak?(input: I): object | null;
  },
): (rawInput: unknown) => BoundFixture {
  return (rawInput) => {
    const input = schema.parse(rawInput);
    return {
      subject: String(hashOf(spec.subject(input))),
      build: () => spec.build(input),
      withBannedWord: () => spec.banned?.(input) ?? null,
      weak: () => spec.weak?.(input) ?? null,
    };
  };
}

/** One post's work, stable across its revisions (so a retried post doesn't fault again). */
function postSubject(input: { brief: Brief; post: PostContext }): unknown {
  const { brief, post } = input;
  return {
    clientId: brief.clientId,
    title: brief.title,
    window: brief.window,
    post: [post.ref, post.type, post.targetDate],
  };
}

const FIXTURES: Readonly<Record<string, (rawInput: unknown) => BoundFixture>> = {
  "MANAGER.intake": fixture(ManagerIntakeInput, { subject: (input) => input, build: mockIntake }),
  "MANAGER.plan": fixture(ManagerPlanInput, { subject: (input) => input, build: mockPlan }),
  "MANAGER.qa": fixture(ManagerQaInput, { subject: postSubject, build: mockQa, weak: mockWeakQa }),
  "COPYWRITER.write": fixture(CopywriterInput, {
    subject: postSubject,
    build: mockCopy,
    banned: mockCopyWithBannedWord,
  }),
};

/** Keys MockLlm can answer. */
export const MOCK_FIXTURE_KEYS = Object.keys(FIXTURES);

/** Drops the first field, so the reply fails the contract with a precise zod issue. */
function breakContract(output: object): object {
  const [first, ...rest] = Object.entries(output);
  return first ? Object.fromEntries(rest) : { unexpected: true };
}

interface Reply {
  text: string;
  stopReason: LlmStopReason;
  refusal: LlmRefusal | null;
}

function reply(bound: BoundFixture, fault: MockFaultKind | null): Reply {
  const ok = (value: object): Reply => ({
    text: JSON.stringify(value),
    stopReason: "end_turn",
    refusal: null,
  });
  switch (fault) {
    case null:
      return ok(bound.build());
    case "invalid":
      return ok(breakContract(bound.build()));
    case "banned":
      // Without a banned word to use (or a fixture that checks them) the fault still bites.
      return ok(bound.withBannedWord() ?? breakContract(bound.build()));
    case "weak":
      return ok(bound.weak() ?? bound.build());
    case "truncated": {
      const full = JSON.stringify(bound.build());
      return {
        text: full.slice(0, Math.ceil(full.length / 2)),
        stopReason: "max_tokens",
        refusal: null,
      };
    }
    case "refusal":
      return {
        text: "",
        stopReason: "refusal",
        refusal: { category: null, explanation: "MockLlm refusal fault (MOCK_LLM_FAULTS)." },
      };
  }
}

function inputChars(request: LlmRequest): number {
  let chars = 0;
  for (const block of request.system) chars += block.text.length;
  for (const message of request.messages) {
    if (typeof message.content === "string") {
      chars += message.content.length;
      continue;
    }
    for (const block of message.content) {
      chars += block.type === "text" ? block.text.length : MOCK_IMAGE_TOKENS * MOCK_CHARS_PER_TOKEN;
    }
  }
  return chars;
}

/**
 * The deterministic LlmClient (DESIGN §C): fixtures keyed by `agent.action` and seeded from the
 * input, fault injection per subject, synthetic usage of chars/4. It goes through the same runner
 * path as the Anthropic client, max_tokens truncation included.
 */
export class MockLlm implements LlmClient {
  readonly provider = "mock" as const;
  readonly model: string;
  readonly faults: readonly MockFault[];
  private readonly faultsError: Error | null;
  private readonly delayMs: number;
  private readonly calls = new Map<string, number>();

  constructor(options: MockLlmOptions = {}) {
    this.model = options.model ?? DEFAULT_LLM_MODEL;
    this.delayMs = Math.max(0, options.delayMs ?? 0);
    let faults: readonly MockFault[] = [];
    let faultsError: Error | null = null;
    if (typeof options.faults === "string") {
      try {
        faults = parseMockFaults(options.faults);
      } catch (error) {
        // Reported on the first call instead: every process builds its client at boot and must not crash.
        faultsError = error instanceof Error ? error : new Error(String(error));
      }
    } else if (options.faults) {
      faults = [...options.faults];
    }
    this.faults = faults;
    this.faultsError = faultsError;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (this.faultsError) throw this.faultsError;
    const started = performance.now();
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));

    const key = `${request.meta.agent}.${request.meta.action}`;
    const bind = FIXTURES[key];
    if (!bind) throw new Error(`MockLlm has no fixture for ${key}`);
    const bound = bind(request.meta.input);
    const counterKey = `${key}#${bound.subject}`;
    const callIndex = this.calls.get(counterKey) ?? 0;
    this.calls.set(counterKey, callIndex + 1);

    const { refusal, ...generated } = reply(bound, faultAt(this.faults, key, callIndex));
    let { text, stopReason } = generated;
    const budgetChars = request.maxTokens * MOCK_CHARS_PER_TOKEN;
    if (stopReason !== "refusal" && text.length > budgetChars) {
      text = text.slice(0, budgetChars);
      stopReason = "max_tokens";
    }

    return {
      text,
      stopReason,
      refusal,
      usage: {
        inputTokens: Math.ceil(inputChars(request) / MOCK_CHARS_PER_TOKEN),
        outputTokens: Math.ceil(text.length / MOCK_CHARS_PER_TOKEN),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      model: `${MOCK_MODEL_PREFIX}${request.model}`,
      latencyMs: Math.round(performance.now() - started),
    };
  }

  /** Forgets how many faults each subject has already received. */
  resetFaults(): void {
    this.calls.clear();
  }
}
