import { describe, expect, it } from "vitest";
import {
  PostType,
  estimatePlan,
  validateTaskGraph,
  type CopywriterInput,
  type ManagerIntakeInput,
  type ManagerPlanInput,
  type ManagerQaInput,
} from "@enmo/shared";
import {
  AgentEscalation,
  MOCK_CHARS_PER_TOKEN,
  MockLlm,
  REVISION_PREFIX,
  copywriterWrite,
  createLlm,
  faultAt,
  managerIntake,
  managerPlan,
  managerQa,
  parseMockFaults,
  runAgent,
  validateCopy,
  validateIntake,
  validateQa,
  type LlmRequest,
} from "../src";
import {
  QAHWA,
  RAMADAN_ANSWER,
  TODAY,
  brand,
  brief,
  copyInput,
  intakeInput,
  post,
  recordingHooks,
} from "./fixtures";

function request(input: CopywriterInput, overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: "claude-sonnet-5",
    maxTokens: 16_000,
    effort: "medium",
    system: [{ text: "system prompt", cache: true }],
    messages: [{ role: "user", content: "write it" }],
    outputSchema: copywriterWrite.output,
    meta: { agent: "COPYWRITER", action: "write", attempt: 1, input },
    ...overrides,
  };
}

function planInput(overrides: Partial<ManagerPlanInput> = {}): ManagerPlanInput {
  return {
    brief: brief(),
    brand: brand(),
    today: TODAY,
    enabledActions: ["write", "qa"],
    busyDates: [],
    changeRequest: null,
    previousGraph: null,
    ...overrides,
  };
}

function qaInput(overrides: Partial<ManagerQaInput> = {}): ManagerQaInput {
  const input = copyInput("REEL");
  return {
    brief: input.brief,
    brand: input.brand,
    post: input.post,
    copy: JSON.parse(JSON.stringify({ caption: "x" })) as ManagerQaInput["copy"],
    visuals: null,
    variants: null,
    automatedChecks: [],
    ...overrides,
  };
}

async function mockCopyFor(input: CopywriterInput) {
  const result = await runAgent(copywriterWrite, input, {
    llm: new MockLlm(),
    ...recordingHooks(),
  });
  return result.output;
}

describe("MockLlm", () => {
  it("is deterministic: equal requests give equal replies, different posts differ", async () => {
    const input = copyInput("REEL");
    const [a, b] = await Promise.all([
      new MockLlm().complete(request(input)),
      new MockLlm().complete(request(input)),
    ]);
    expect(a.text).toBe(b.text);
    expect(a.usage).toEqual(b.usage);

    const other = await new MockLlm().complete(
      request(
        copyInput("REEL", {
          post: post("REEL", { ref: "p9", angle: "Golden hour: the iced line at dusk" }),
        }),
      ),
    );
    expect(other.text).not.toBe(a.text);
  });

  it("reports synthetic usage of chars / 4 and a mock model", async () => {
    const input = copyInput("STATIC");
    const req = request(input);
    const response = await new MockLlm().complete(req);
    const inputChars = "system prompt".length + "write it".length;
    expect(response.usage).toEqual({
      inputTokens: Math.ceil(inputChars / MOCK_CHARS_PER_TOKEN),
      outputTokens: Math.ceil(response.text.length / MOCK_CHARS_PER_TOKEN),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(response.model).toBe("mock:claude-sonnet-5");
    expect(response.stopReason).toBe("end_turn");
  });

  it("stops at max_tokens like the real API when the reply doesn't fit", async () => {
    const response = await new MockLlm().complete(request(copyInput("REEL"), { maxTokens: 10 }));
    expect(response.stopReason).toBe("max_tokens");
    expect(response.text).toHaveLength(10 * MOCK_CHARS_PER_TOKEN);
  });

  it("rejects agents it has no fixture for", async () => {
    const req = request(copyInput("REEL"));
    await expect(
      new MockLlm().complete({
        ...req,
        meta: { ...req.meta, agent: "ANALYST", action: "analyze" },
      }),
    ).rejects.toThrow(/no fixture for ANALYST\.analyze/);
  });
});

describe("MockLlm intake: the Ramadan brief", () => {
  it("asks exactly one consolidated question, then returns the 12-post brief", async () => {
    const llm = new MockLlm();
    const first = intakeInput();
    const clarify = await runAgent(managerIntake, first, { llm, ...recordingHooks() });

    expect(clarify.attempts).toBe(1);
    const result = clarify.output.result;
    if (result.kind !== "clarify") throw new Error("expected a clarify");
    expect(result.missing).toEqual(["platforms", "window"]);
    expect(result.question.match(/\?/g)).toHaveLength(1);
    expect(result.question).toMatch(/platforms/);
    expect(result.question).toMatch(/dates/);
    expect(result.draft).toMatchObject({
      clientId: QAHWA.id,
      postCount: 12,
      productFocus: "iced line",
    });

    const answered: ManagerIntakeInput = {
      ...first,
      allowClarify: false,
      thread: [
        ...first.thread,
        { role: "AGENT", kind: "CLARIFY", agent: "MANAGER", content: result.question },
        { role: "USER", kind: "TEXT", agent: null, content: RAMADAN_ANSWER },
      ],
    };
    const final = await runAgent(managerIntake, answered, { llm, ...recordingHooks() });
    const briefResult = final.output.result;
    if (briefResult.kind !== "brief") throw new Error("expected a brief");
    const { brief: resolved } = briefResult;

    expect(resolved).toMatchObject({
      clientId: QAHWA.id,
      postCount: 12,
      platforms: ["INSTAGRAM", "FACEBOOK"],
      window: { start: "2027-03-01", end: "2027-03-30" },
      productFocus: "iced line",
    });
    expect(resolved.postMix.reduce((sum, item) => sum + item.count, 0)).toBe(12);
    expect(resolved.title).toBe("Ramadan — Iced Line");
    expect(resolved.assumptions.some((line) => line.startsWith("Post mix assumed"))).toBe(true);
    expect(briefResult.confirmation).toContain("12 posts");
    expect(validateIntake(final.output, answered)).toEqual([]);
  });

  it("never clarifies once the question has been asked: gaps become assumptions", async () => {
    const input = intakeInput({ allowClarify: false });
    const { output } = await runAgent(managerIntake, input, {
      llm: new MockLlm(),
      ...recordingHooks(),
    });
    if (output.result.kind !== "brief") throw new Error("expected a brief");
    expect(output.result.brief.assumptions.join(" ")).toMatch(/Platforms assumed.*Dates assumed/);
    expect(output.result.brief.window.start > TODAY).toBe(true);
  });

  it("asks for the client too when several are on the roster and none is named", async () => {
    const input = intakeInput({
      clients: [QAHWA, { id: "client_b", name: "Bloom Florals", enabledPlatforms: ["INSTAGRAM"] }],
    });
    const { output } = await runAgent(managerIntake, input, {
      llm: new MockLlm(),
      ...recordingHooks(),
    });
    if (output.result.kind !== "clarify") throw new Error("expected a clarify");
    expect(output.result.missing).toEqual(["client", "platforms", "window"]);
    expect(output.result.question.match(/\?/g)).toHaveLength(1);
  });

  it("reads client names, platform aliases, typed counts and relative dates", async () => {
    const input = intakeInput({
      clients: [
        QAHWA,
        { id: "client_b", name: "Bloom Florals", enabledPlatforms: ["INSTAGRAM", "FACEBOOK"] },
      ],
      thread: [
        {
          role: "USER",
          kind: "TEXT",
          agent: null,
          content:
            "Bloom needs 3 reels and 2 carousels on IG, FB and TikTok over the next 2 weeks, avoid discount talk",
        },
      ],
    });
    const { output } = await runAgent(managerIntake, input, {
      llm: new MockLlm(),
      ...recordingHooks(),
    });
    if (output.result.kind !== "brief") throw new Error("expected a brief");
    const { brief: resolved } = output.result;
    expect(resolved.clientId).toBe("client_b");
    expect(resolved.platforms).toEqual(["INSTAGRAM", "FACEBOOK"]);
    expect(resolved.assumptions[0]).toMatch(/TikTok isn't enabled for Bloom Florals/);
    expect(resolved.postCount).toBe(5);
    expect(resolved.postMix).toEqual([
      { type: "REEL", count: 3 },
      { type: "CAROUSEL", count: 2 },
    ]);
    expect(resolved.window).toEqual({ start: "2026-09-25", end: "2026-10-08" });
    expect(resolved.constraints).toEqual(["Avoid discount talk."]);
    expect(validateIntake(output, input)).toEqual([]);
  });

  it("uses the client the campaign was started for", async () => {
    const input = intakeInput({
      clients: [QAHWA, { id: "client_b", name: "Bloom Florals", enabledPlatforms: ["INSTAGRAM"] }],
      selectedClientId: "client_b",
      thread: [
        { role: "USER", kind: "TEXT", agent: null, content: "8 posts on Instagram in March" },
      ],
    });
    const { output } = await runAgent(managerIntake, input, {
      llm: new MockLlm(),
      ...recordingHooks(),
    });
    if (output.result.kind !== "brief") throw new Error("expected a brief");
    expect(output.result.brief).toMatchObject({
      clientId: "client_b",
      postCount: 8,
      window: { start: "2027-03-01", end: "2027-03-31" },
    });
  });
});

describe("MockLlm plan", () => {
  it("builds the canonical 12-post write → qa graph inside the window", async () => {
    const input = planInput();
    const { output } = await runAgent(managerPlan, input, {
      llm: new MockLlm(),
      ...recordingHooks(),
    });
    expect(output.posts).toHaveLength(12);
    expect(output.nodes).toHaveLength(24);
    expect(output.nodes.slice(0, 2)).toEqual([
      {
        id: "n1",
        agent: "COPYWRITER",
        action: "write",
        postRef: "p1",
        deps: [],
        instructions: null,
      },
      { id: "n2", agent: "MANAGER", action: "qa", postRef: "p1", deps: ["n1"], instructions: null },
    ]);
    expect(validateTaskGraph(output, input.brief, input.enabledActions)).toEqual([]);
    expect(new Set(output.posts.map((p) => p.angle)).size).toBe(10);
    expect(output.posts[0]!.targetDate).toBe("2027-03-01");
    expect(output.summary).toMatch(/12 posts for Qahwa Co on Instagram and Facebook/);
    expect(estimatePlan(output).calls).toBe(24);
  });

  it("dodges busy dates, quotes a change request verbatim and plans strategy when enabled", async () => {
    const changeRequest = "Move the reels   earlier —\nand keep Fridays free.";
    const input = planInput({
      enabledActions: ["qa", "write", "strategy"],
      busyDates: ["2027-03-01"],
      changeRequest,
    });
    const { output } = await runAgent(managerPlan, input, {
      llm: new MockLlm(),
      ...recordingHooks(),
    });
    expect(output.posts[0]!.targetDate).toBe("2027-03-02");
    expect(output.summary).toContain(changeRequest);
    expect(output.nodes[0]).toMatchObject({ id: "n1", action: "strategy", postRef: null });
    expect(validateTaskGraph(output, input.brief, input.enabledActions)).toEqual([]);
  });
});

describe("MockLlm copywriter", () => {
  it.each(PostType.options)("writes valid %s copy in the right shape", async (type) => {
    const input = copyInput(type);
    const copy = await mockCopyFor(input);
    expect(validateCopy(copy, input)).toEqual([]);
    expect(copy.platformCaptions.map((pc) => pc.platform)).toEqual(input.post.platforms);
    expect(copy.hashtags).toContain("#QahwaCo");
    if (type === "REEL" || type === "TIKTOK") expect(copy.script).not.toBeNull();
    if (type === "CAROUSEL") expect(copy.slides?.length).toBeGreaterThanOrEqual(3);
    if (type === "STATIC" || type === "STORY") expect(copy.onScreenText).toBeTruthy();
  });

  it("honours targetHookSec and keeps the hook inside the first scene", async () => {
    const input = copyInput("REEL", { post: post("REEL", { targetHookSec: 1.2 }) });
    const copy = await mockCopyFor(input);
    expect(copy.script!.hookTimestampSec).toBe(1.2);
    expect(copy.script!.scenes[0]!.durationSec).toBeGreaterThan(1.2);
    expect(validateCopy(copy, input)).toEqual([]);
  });

  it("never uses the brand's banned words, even ones its templates would", async () => {
    const input = copyInput("CAROUSEL", {
      brand: brand({ bannedWords: ["iced line", "order", "store", "Ramadan", "#MadeWithIntent"] }),
    });
    const copy = await mockCopyFor(input);
    expect(validateCopy(copy, input)).toEqual([]);
    expect(JSON.stringify(copy)).not.toMatch(/MadeWithIntent/);
  });

  it("revises with the [rev] prefix and the feedback it applied", async () => {
    const base = copyInput("REEL");
    const previous = await mockCopyFor(base);
    const verbatim = "  Make the hook about the FIRST sip —\nless about the evening.  ";
    const input: CopywriterInput = {
      ...base,
      revision: { feedback: { verbatim, source: "HUMAN", decisionId: "dec_1" }, previous },
    };
    const hooks = recordingHooks();
    const { output } = await runAgent(copywriterWrite, input, { llm: new MockLlm(), ...hooks });

    expect(output.caption.startsWith(REVISION_PREFIX)).toBe(true);
    expect(output.platformCaptions.every((pc) => pc.caption.startsWith(REVISION_PREFIX))).toBe(
      true,
    );
    expect(output.caption).toContain("Make the hook about the FIRST sip");
    expect(validateCopy(output, input)).toEqual([]);
    const snapshot = hooks.runs[0]!.inputSnapshot as CopywriterInput;
    expect(snapshot.revision?.feedback.verbatim).toBe(verbatim);
  });
});

describe("MockLlm QA", () => {
  it("passes clean copy and sends failed checks back to the Copywriter", async () => {
    const copy = await mockCopyFor(copyInput("REEL"));
    const clean = qaInput({
      copy,
      automatedChecks: [{ name: "banned_words", passed: true, detail: null }],
    });
    const pass = await runAgent(managerQa, clean, { llm: new MockLlm(), ...recordingHooks() });
    expect(pass.output).toMatchObject({ verdict: "pass", issues: [] });

    const failing = qaInput({
      copy,
      automatedChecks: [{ name: "hashtags", passed: false, detail: "31 hashtags" }],
    });
    const revise = await runAgent(managerQa, failing, { llm: new MockLlm(), ...recordingHooks() });
    expect(revise.output.verdict).toBe("revise");
    expect(revise.output.issues).toEqual([
      expect.objectContaining({ target: "COPYWRITER", field: "hashtags" }),
    ]);
    expect(validateQa(revise.output, failing)).toEqual([]);
  });
});

describe("MockLlm faults", () => {
  it("parses MOCK_LLM_FAULTS and rejects malformed entries", () => {
    expect(
      parseMockFaults(
        " COPYWRITER.write:invalid*2 , MANAGER.qa:weak,VISUAL_DIRECTOR.review:weak*3",
      ),
    ).toEqual([
      { key: "COPYWRITER.write", kind: "invalid", count: 2 },
      { key: "MANAGER.qa", kind: "weak", count: 1 },
      { key: "VISUAL_DIRECTOR.review", kind: "weak", count: 3 },
    ]);
    expect(() => parseMockFaults("COPYWRITER.write:explode")).toThrow(/kind must be one of/);
    expect(() => parseMockFaults("NOBODY.write:invalid")).toThrow(/unknown agent/);
    expect(() => parseMockFaults("COPYWRITER.write:invalid*0")).toThrow(/at least 1/);
    expect(() => parseMockFaults("copywriter")).toThrow(/AGENT\.action:kind/);
  });

  it("fires entries for a key in order, per call index", () => {
    const faults = parseMockFaults(
      "COPYWRITER.write:invalid,COPYWRITER.write:banned*2,MANAGER.qa:weak",
    );
    expect([0, 1, 2, 3].map((i) => faultAt(faults, "COPYWRITER.write", i))).toEqual([
      "invalid",
      "banned",
      "banned",
      null,
    ]);
  });

  it("invalid*2 succeeds on attempt 3, for every post independently", async () => {
    const llm = new MockLlm({ faults: "COPYWRITER.write:invalid*2" });
    const results = await Promise.all(
      ["p1", "p2", "p3"].map((ref) =>
        runAgent(copywriterWrite, copyInput("REEL", { post: post("REEL", { ref }) }), {
          llm,
          ...recordingHooks(),
        }),
      ),
    );
    expect(results.map((r) => r.attempts)).toEqual([3, 3, 3]);
  });

  it("invalid*3 escalates, and a later retry of the same post runs clean", async () => {
    const llm = new MockLlm({ faults: "COPYWRITER.write:invalid*3" });
    const input = copyInput("CAROUSEL");
    const error = await runAgent(copywriterWrite, input, { llm, ...recordingHooks() }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AgentEscalation);
    expect(error).toMatchObject({ reason: "INVALID_OUTPUT" });
    expect((error as AgentEscalation).issues[0]?.path).toBe("caption");

    const retry = await runAgent(copywriterWrite, input, { llm, ...recordingHooks() });
    expect(retry.attempts).toBe(1);
  });

  it("banned slips a banned word into the copy, which the validator catches", async () => {
    const hooks = recordingHooks();
    const llm = new MockLlm({ faults: "COPYWRITER.write:banned" });
    const result = await runAgent(copywriterWrite, copyInput("STATIC"), { llm, ...hooks });
    expect(result.attempts).toBe(2);
    expect(hooks.runs[0]!.validationErrors).toEqual([
      { path: "caption", message: 'Uses the banned word "cheap". Rewrite without it.' },
    ]);
  });

  it("refusal escalates REFUSED; truncated retries with more room", async () => {
    const refused = await runAgent(copywriterWrite, copyInput("REEL"), {
      llm: new MockLlm({ faults: "COPYWRITER.write:refusal" }),
      ...recordingHooks(),
    }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ reason: "REFUSED" });

    const hooks = recordingHooks();
    const truncated = await runAgent(copywriterWrite, copyInput("REEL"), {
      llm: new MockLlm({ faults: "COPYWRITER.write:truncated" }),
      ...hooks,
    });
    expect(truncated.attempts).toBe(2);
    expect(hooks.runs[0]).toMatchObject({ outcome: "TRUNCATED", stopReason: "max_tokens" });
  });

  it("weak makes QA send a post back once", async () => {
    const llm = new MockLlm({ faults: "MANAGER.qa:weak" });
    const copy = await mockCopyFor(copyInput("REEL"));
    const input = qaInput({ copy });
    const first = await runAgent(managerQa, input, { llm, ...recordingHooks() });
    expect(first.output.verdict).toBe("revise");
    expect(validateQa(first.output, input)).toEqual([]);
    const second = await runAgent(managerQa, input, { llm, ...recordingHooks() });
    expect(second.output.verdict).toBe("pass");
  });

  it("createLlm never throws on bad faults; the first call reports them", async () => {
    const llm = createLlm({
      provider: "mock",
      apiKey: null,
      model: "claude-sonnet-5",
      baseUrl: "https://api.anthropic.com",
      faults: "COPYWRITER.write:nope",
    });
    await expect(llm.complete(request(copyInput("REEL")))).rejects.toThrow(/MOCK_LLM_FAULTS/);
  });
});
