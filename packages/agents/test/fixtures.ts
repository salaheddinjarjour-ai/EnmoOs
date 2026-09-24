import {
  BrandContext,
  type Brief,
  type CopywriterInput,
  type IntakeClient,
  type ManagerIntakeInput,
  type PostContext,
  type PostType,
} from "@enmo/shared";
import {
  BudgetExceeded,
  type AgentRunRecord,
  type LlmClient,
  type LlmRefusal,
  type LlmRequest,
  type LlmResponse,
  type LlmStopReason,
  type LlmUsage,
  type RunnerHooks,
} from "../src";

export const TODAY = "2026-09-24";

export const QAHWA: IntakeClient = {
  id: "client_qahwa",
  name: "Qahwa Co",
  enabledPlatforms: ["INSTAGRAM", "FACEBOOK", "TIKTOK"],
};

export const RAMADAN_BRIEF =
  "Ramadan campaign for the coffee client — 12 posts, push the iced line";
export const RAMADAN_ANSWER = "Instagram and Facebook, March 1–30";

export function brand(overrides: Partial<BrandContext> = {}): BrandContext {
  return BrandContext.parse({
    clientId: QAHWA.id,
    name: QAHWA.name,
    timezone: "Asia/Dubai",
    brandVoice: "Warm, unhurried and precise. We talk about coffee like craft, never like a deal.",
    bannedWords: ["cheap", "discount"],
    visualStyle: {},
    platforms: QAHWA.enabledPlatforms,
    ...overrides,
  });
}

export function brief(overrides: Partial<Brief> = {}): Brief {
  return {
    clientId: QAHWA.id,
    title: "Ramadan — Iced Line",
    objective: "Drive awareness and trial of the iced line during Ramadan.",
    productFocus: "iced line",
    audience: null,
    keyMessages: ["The iced line is made for Ramadan.", "Crafted with Qahwa Co's signature care."],
    platforms: ["INSTAGRAM", "FACEBOOK"],
    postCount: 12,
    postMix: [
      { type: "REEL", count: 4 },
      { type: "CAROUSEL", count: 4 },
      { type: "STATIC", count: 4 },
    ],
    window: { start: "2027-03-01", end: "2027-03-30" },
    cadenceNotes: null,
    constraints: [],
    assumptions: [],
    ...overrides,
  };
}

export function post(type: PostType, overrides: Partial<PostContext> = {}): PostContext {
  return {
    ref: "p3",
    type,
    platforms: type === "TIKTOK" ? ["TIKTOK"] : ["INSTAGRAM", "FACEBOOK"],
    targetDate: "2027-03-07",
    angle: "Ritual moment: where the iced line fits into Ramadan evenings",
    hook: null,
    pillar: null,
    targetHookSec: null,
    instructions: null,
    ...overrides,
  };
}

export function copyInput(
  type: PostType,
  overrides: Partial<CopywriterInput> = {},
): CopywriterInput {
  const platforms: BrandContext["platforms"] = ["INSTAGRAM", "FACEBOOK", "TIKTOK"];
  return {
    brief: brief({ platforms, postMix: [{ type, count: 12 }] }),
    brand: brand(),
    post: post(type),
    revision: null,
    ...overrides,
  };
}

export function intakeInput(overrides: Partial<ManagerIntakeInput> = {}): ManagerIntakeInput {
  return {
    thread: [{ role: "USER", kind: "TEXT", agent: null, content: RAMADAN_BRIEF }],
    clients: [QAHWA],
    selectedClientId: null,
    today: TODAY,
    allowClarify: true,
    brand: null,
    ...overrides,
  };
}

/** Runner hooks that remember every AgentRun and usage row; `budgetAfter` calls pass the check. */
export function recordingHooks(budgetAfter = Infinity): RunnerHooks & {
  runs: AgentRunRecord[];
  usage: LlmUsage[];
  checks: number;
} {
  const state = {
    runs: [] as AgentRunRecord[],
    usage: [] as LlmUsage[],
    checks: 0,
  };
  return Object.assign(state, {
    budget: {
      check: () => {
        state.checks += 1;
        if (state.checks > budgetAfter) {
          return Promise.reject(new BudgetExceeded({ day: TODAY, used: 10, cap: 1 }));
        }
        return Promise.resolve();
      },
      record: (usage: LlmUsage) => {
        state.usage.push(usage);
        return Promise.resolve();
      },
    },
    recorder: {
      recordRun: (run: AgentRunRecord) => {
        state.runs.push(run);
        return Promise.resolve();
      },
    },
  });
}

export type ScriptedReply =
  | string
  | Error
  | { text?: string; stopReason?: LlmStopReason; usage?: Partial<LlmUsage>; refusal?: LlmRefusal };

export const STEP_USAGE: LlmUsage = {
  inputTokens: 100,
  outputTokens: 40,
  cacheReadTokens: 10,
  cacheWriteTokens: 5,
};

/** An LlmClient that plays back `replies` in order and keeps every request it received. */
export function scriptedLlm(
  replies: readonly ScriptedReply[],
): LlmClient & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    provider: "mock",
    model: "claude-sonnet-5",
    requests,
    complete(request) {
      requests.push(request);
      const next = replies[requests.length - 1];
      if (next === undefined)
        return Promise.reject(new Error(`No scripted reply #${requests.length}`));
      if (next instanceof Error) return Promise.reject(next);
      const reply = typeof next === "string" ? { text: next } : next;
      const response: LlmResponse = {
        text: reply.text ?? "",
        stopReason: reply.stopReason ?? "end_turn",
        usage: { ...STEP_USAGE, ...reply.usage },
        model: "claude-sonnet-5",
        latencyMs: 7,
        refusal: reply.refusal ?? null,
      };
      return Promise.resolve(response);
    },
  };
}
