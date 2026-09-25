import { describe, expect, it } from "vitest";
import {
  ManagerIntakeNoClarifyOutput,
  ManagerIntakeOutput,
  type CopywriterInput,
  type CopywriterOutput,
} from "@enmo/shared";
import {
  AgentEscalation,
  BudgetExceeded,
  DEFAULT_MAX_RETRIES,
  InvalidAgentInput,
  LlmRequestRejected,
  MAX_TOKENS_CAP,
  RESPONSE_TEXT_CAP,
  copywriterWrite,
  managerIntake,
  runAgent,
  type AgentDefinition,
} from "../src";
import { mockCopy } from "../src/llm/mock/copywriter";
import { mockIntake } from "../src/llm/mock/intake";
import {
  RAMADAN_ANSWER,
  STEP_USAGE,
  copyInput,
  intakeInput,
  recordingHooks,
  scriptedLlm,
} from "./fixtures";

const input = copyInput("REEL");
const good: CopywriterOutput = mockCopy(input);
const goodText = JSON.stringify(good);
const missingCta = JSON.stringify({ ...good, cta: undefined });
const withBanned = JSON.stringify({ ...good, caption: `${good.caption} Never cheap.` });

class TransportError extends Error {
  override readonly name = "RateLimitError";
  readonly status = 429;
}

describe("runAgent: contract retries", () => {
  it("feeds zod and business-rule issues back and succeeds on attempt 3", async () => {
    const llm = scriptedLlm([missingCta, withBanned, goodText]);
    const hooks = recordingHooks();

    const result = await runAgent(copywriterWrite, input, { llm, ...hooks });

    expect(result.output).toEqual(good);
    expect(result.attempts).toBe(3);
    expect(result.model).toBe("claude-sonnet-5");
    expect(result.usage).toEqual({
      inputTokens: STEP_USAGE.inputTokens * 3,
      outputTokens: STEP_USAGE.outputTokens * 3,
      cacheReadTokens: STEP_USAGE.cacheReadTokens * 3,
      cacheWriteTokens: STEP_USAGE.cacheWriteTokens * 3,
    });

    // Attempt 2 sees attempt 1's reply and a correction naming the failing path.
    const second = llm.requests[1]!;
    expect(second.meta.attempt).toBe(2);
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]).toEqual({ role: "assistant", content: missingCta });
    expect(second.messages[2]!.role).toBe("user");
    expect(second.messages[2]!.content).toMatch(/^- cta: /m);
    expect(second.messages[2]!.content).toContain("complete corrected JSON");

    const third = llm.requests[2]!;
    expect(third.messages).toHaveLength(5);
    expect(third.messages[4]!.content).toContain('- caption: Uses the banned word "cheap"');

    expect(hooks.runs.map((run) => [run.attempt, run.outcome])).toEqual([
      [1, "INVALID_OUTPUT"],
      [2, "INVALID_OUTPUT"],
      [3, "OK"],
    ]);
    expect(hooks.runs[0]!.validationErrors?.[0]?.path).toBe("cta");
    expect(hooks.runs[2]!.validationErrors).toBeNull();
    expect(hooks.runs[2]!).toMatchObject({
      agent: "COPYWRITER",
      action: "write",
      promptVersion: copywriterWrite.promptVersion,
      stopReason: "end_turn",
      responseText: goodText,
      inputSnapshot: input,
      latencyMs: 7,
    });
    expect(hooks.usage).toHaveLength(3);
    expect(hooks.checks).toBe(3);
  });

  it("escalates with the last issues after 2 failed retries", async () => {
    const llm = scriptedLlm([missingCta, missingCta, withBanned, goodText]);
    const hooks = recordingHooks();

    const error = await runAgent(copywriterWrite, input, { llm, ...hooks }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(AgentEscalation);
    const escalation = error as AgentEscalation;
    expect(escalation.reason).toBe("INVALID_OUTPUT");
    expect(escalation).toMatchObject({ agent: "COPYWRITER", action: "write" });
    expect(escalation.issues).toEqual([
      { path: "caption", message: 'Uses the banned word "cheap". Rewrite without it.' },
    ]);
    expect(llm.requests).toHaveLength(DEFAULT_MAX_RETRIES + 1);
    expect(hooks.runs.every((run) => run.outcome === "INVALID_OUTPUT")).toBe(true);
  });

  it("honours a custom maxRetries", async () => {
    const llm = scriptedLlm([missingCta, goodText]);
    const error = await runAgent(copywriterWrite, input, {
      llm,
      ...recordingHooks(),
      maxRetries: 0,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentEscalation);
    expect(llm.requests).toHaveLength(1);
  });

  it("rejects replies that aren't JSON with a parse issue", async () => {
    const llm = scriptedLlm(["Sure! Here is the copy:", goodText]);
    const hooks = recordingHooks();
    const result = await runAgent(copywriterWrite, input, { llm, ...hooks });
    expect(result.attempts).toBe(2);
    expect(hooks.runs[0]!.validationErrors?.[0]).toMatchObject({ path: "" });
    expect(hooks.runs[0]!.validationErrors?.[0]?.message).toMatch(/not valid JSON/);
  });

  it("doesn't echo an empty reply as an assistant turn", async () => {
    const llm = scriptedLlm(["", goodText]);
    await runAgent(copywriterWrite, input, { llm, ...recordingHooks() });
    expect(llm.requests[1]!.messages.map((m) => m.role)).toEqual(["user", "user"]);
  });
});

describe("runAgent: stop reasons", () => {
  it("escalates a refusal immediately with REFUSED", async () => {
    const llm = scriptedLlm([
      { stopReason: "refusal", refusal: { category: "cyber", explanation: "Declined." } },
      goodText,
    ]);
    const hooks = recordingHooks();

    const error = await runAgent(copywriterWrite, input, { llm, ...hooks }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(AgentEscalation);
    expect(error).toMatchObject({ reason: "REFUSED", issues: [] });
    expect((error as Error).message).toContain("cyber");
    expect(llm.requests).toHaveLength(1);
    expect(hooks.runs[0]).toMatchObject({
      outcome: "REFUSED",
      stopReason: "refusal",
      validationErrors: null,
    });
    expect(hooks.usage).toHaveLength(1);
  });

  it("retries a truncation with max_tokens × 1.5 and the same conversation", async () => {
    const llm = scriptedLlm([{ text: goodText.slice(0, 50), stopReason: "max_tokens" }, goodText]);
    const hooks = recordingHooks();

    const result = await runAgent(copywriterWrite, input, { llm, ...hooks });

    expect(result.attempts).toBe(2);
    expect(llm.requests.map((request) => request.maxTokens)).toEqual([16_000, 24_000]);
    expect(llm.requests[1]!.messages).toHaveLength(1);
    expect(hooks.runs[0]).toMatchObject({ outcome: "TRUNCATED", stopReason: "max_tokens" });
  });

  it("caps max_tokens growth at 32k and escalates TRUNCATED when it keeps running out", async () => {
    const def: AgentDefinition<CopywriterInput, CopywriterOutput> = {
      ...copywriterWrite,
      maxTokens: 30_000,
    };
    const cut = { text: "{", stopReason: "max_tokens" as const };
    const llm = scriptedLlm([cut, cut, cut]);

    const error = await runAgent(def, input, { llm, ...recordingHooks() }).catch((e: unknown) => e);

    expect(llm.requests.map((request) => request.maxTokens)).toEqual([
      30_000,
      MAX_TOKENS_CAP,
      MAX_TOKENS_CAP,
    ]);
    expect(error).toBeInstanceOf(AgentEscalation);
    expect(error).toMatchObject({ reason: "TRUNCATED" });
    expect((error as AgentEscalation).issues[0]?.message).toMatch(/max_tokens/);
  });

  it("escalates at once when the context window is exhausted", async () => {
    const llm = scriptedLlm([{ text: "{", stopReason: "model_context_window_exceeded" }, goodText]);
    const error = await runAgent(copywriterWrite, input, { llm, ...recordingHooks() }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ reason: "TRUNCATED" });
    expect(llm.requests).toHaveLength(1);
  });
});

describe("runAgent: transport errors and budget", () => {
  it("lets transport errors propagate without spending contract attempts", async () => {
    const transport = new TransportError("rate limited");
    const hooks = recordingHooks();

    const error = await runAgent(copywriterWrite, input, {
      llm: scriptedLlm([missingCta, transport]),
      ...hooks,
    }).catch((e: unknown) => e);

    expect(error).toBe(transport);
    expect(hooks.runs.map((run) => [run.attempt, run.outcome])).toEqual([
      [1, "INVALID_OUTPUT"],
      [2, "API_ERROR"],
    ]);
    expect(hooks.runs[1]).toMatchObject({
      responseText: null,
      stopReason: null,
      model: "claude-sonnet-5",
    });
    expect(hooks.usage).toHaveLength(1);

    // BullMQ's retry of the job starts a fresh run with all three contract attempts available.
    const retry = scriptedLlm([missingCta, missingCta, goodText]);
    const result = await runAgent(copywriterWrite, input, { llm: retry, ...recordingHooks() });
    expect(result.attempts).toBe(3);
  });

  it("surfaces the provider error even if recording the failed call fails too", async () => {
    const transport = new TransportError("overloaded");
    const hooks = recordingHooks();
    hooks.recorder.recordRun = () => Promise.reject(new Error("db down"));
    const error = await runAgent(copywriterWrite, input, {
      llm: scriptedLlm([transport]),
      ...hooks,
    }).catch((e: unknown) => e);
    expect(error).toBe(transport);
  });

  it("escalates a request the provider rejects as malformed (API_ERROR)", async () => {
    const llm = scriptedLlm([
      new LlmRequestRejected({ status: 400, message: "prompt is too long" }),
    ]);
    const hooks = recordingHooks();
    const error = await runAgent(copywriterWrite, input, { llm, ...hooks }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AgentEscalation);
    expect(error).toMatchObject({ reason: "API_ERROR" });
    expect((error as AgentEscalation).issues[0]?.message).toContain("prompt is too long");
    expect(hooks.runs[0]).toMatchObject({ outcome: "API_ERROR" });
  });

  it("throws BudgetExceeded before calling the model", async () => {
    const llm = scriptedLlm([goodText]);
    const hooks = recordingHooks(0);
    const error = await runAgent(copywriterWrite, input, { llm, ...hooks }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BudgetExceeded);
    expect(llm.requests).toHaveLength(0);
    expect(hooks.runs).toHaveLength(0);
  });

  it("checks the budget before every attempt", async () => {
    const llm = scriptedLlm([missingCta, goodText]);
    const hooks = recordingHooks(1);
    const error = await runAgent(copywriterWrite, input, { llm, ...hooks }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BudgetExceeded);
    expect(llm.requests).toHaveLength(1);
    expect(hooks.usage).toHaveLength(1);
  });

  it("rejects an input its schema refuses, before any spend", async () => {
    const llm = scriptedLlm([goodText]);
    const hooks = recordingHooks();
    const broken = { ...input, post: { ...input.post, ref: "post-3" } };
    const error = await runAgent(copywriterWrite, broken, { llm, ...hooks }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InvalidAgentInput);
    expect((error as InvalidAgentInput).issues[0]?.path).toBe("post.ref");
    expect(hooks.checks).toBe(0);
    expect(llm.requests).toHaveLength(0);
  });
});

describe("runAgent: request", () => {
  it("sends the frozen prompt, the cached brand block, the model and effort", async () => {
    const llm = scriptedLlm([goodText]);
    await runAgent(copywriterWrite, input, {
      llm,
      ...recordingHooks(),
      effort: "high",
      model: "claude-opus-5",
    });
    const [request] = llm.requests;
    expect(request).toMatchObject({ model: "claude-opus-5", effort: "high", maxTokens: 16_000 });
    expect(request!.system).toHaveLength(2);
    expect(request!.system[0]).toEqual({ text: copywriterWrite.systemPrompt, cache: false });
    expect(request!.system[1]!.cache).toBe(true);
    expect(request!.system[1]!.text).toContain("- cheap");
    expect(request!.meta).toEqual({ agent: "COPYWRITER", action: "write", attempt: 1, input });
    expect(request!.messages).toEqual([
      { role: "user", content: copywriterWrite.userMessage(input) },
    ]);
  });

  it("defaults to the client's model and the definition's effort; no brand block → prompt cached", async () => {
    const llm = scriptedLlm([JSON.stringify(mockIntake(intakeInput()))]);
    await runAgent(managerIntake, intakeInput(), { llm, ...recordingHooks() });
    const [request] = llm.requests;
    expect(request).toMatchObject({ model: llm.model, effort: "medium" });
    expect(request!.system).toEqual([{ text: managerIntake.systemPrompt, cache: true }]);
  });

  it("puts images ahead of the first turn's text and keeps them for corrections", async () => {
    const image = { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" } as const;
    const llm = scriptedLlm([missingCta, goodText]);
    const hooks = recordingHooks();
    await runAgent(copywriterWrite, input, { llm, ...hooks, images: [image] });

    const first = {
      role: "user",
      content: [image, { type: "text", text: copywriterWrite.userMessage(input) }],
    };
    expect(llm.requests[0]!.messages).toEqual([first]);
    expect(llm.requests[1]!.messages[0]).toEqual(first);
    expect(llm.requests[1]!.messages).toHaveLength(3);
    // The snapshot is the JSON input only; the pixels never land in AgentRun rows.
    expect(hooks.runs[0]!.inputSnapshot).toEqual(input);

    const plain = scriptedLlm([goodText]);
    await runAgent(copywriterWrite, input, { llm: plain, ...recordingHooks(), images: [] });
    expect(plain.requests[0]!.messages[0]!.content).toBe(copywriterWrite.userMessage(input));
  });

  it("caps the stored response text", async () => {
    const huge = `{"caption": "${"x".repeat(RESPONSE_TEXT_CAP)}"}`;
    const hooks = recordingHooks();
    await runAgent(copywriterWrite, input, { llm: scriptedLlm([huge, goodText]), ...hooks });
    expect(hooks.runs[0]!.responseText).toHaveLength(RESPONSE_TEXT_CAP);
  });
});

describe("runAgent: intake without the clarify branch", () => {
  it("uses the narrowed schema once the question has been asked and rejects a second clarify", async () => {
    const answered = intakeInput({
      allowClarify: false,
      thread: [
        ...intakeInput().thread,
        { role: "AGENT", kind: "CLARIFY", agent: "MANAGER", content: "Which platforms and dates?" },
        { role: "USER", kind: "TEXT", agent: null, content: RAMADAN_ANSWER },
      ],
    });
    const clarify = JSON.stringify(mockIntake(intakeInput()));
    const briefReply = JSON.stringify(mockIntake(answered));
    const llm = scriptedLlm([clarify, briefReply]);
    const hooks = recordingHooks();

    const result = await runAgent(managerIntake, answered, { llm, ...hooks });

    expect(llm.requests[0]!.outputSchema).toBe(ManagerIntakeNoClarifyOutput);
    expect(hooks.runs[0]!.validationErrors?.some((issue) => issue.path.startsWith("result."))).toBe(
      true,
    );
    expect(result.attempts).toBe(2);
    expect(result.output.result.kind).toBe("brief");
  });

  it("keeps the full schema while the question is available", async () => {
    const llm = scriptedLlm([JSON.stringify(mockIntake(intakeInput()))]);
    const result = await runAgent(managerIntake, intakeInput(), { llm, ...recordingHooks() });
    expect(llm.requests[0]!.outputSchema).toBe(ManagerIntakeOutput);
    expect(result.output.result.kind).toBe("clarify");
  });
});
