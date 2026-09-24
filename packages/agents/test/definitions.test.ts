import { describe, expect, it } from "vitest";
import {
  AGENT_DEFINITIONS,
  DEFAULT_MAX_TOKENS,
  PLAN_MAX_TOKENS,
  copywriterWrite,
  getAgentDefinition,
  managerIntake,
  managerPlan,
  managerQa,
  renderBrandBlock,
  resolveEffort,
  type AgentKey,
} from "../src";
import { mockCopy } from "../src/llm/mock/copywriter";
import { TODAY, brand, brief, copyInput, intakeInput } from "./fixtures";

const KEYS: AgentKey[] = ["MANAGER.intake", "MANAGER.plan", "MANAGER.qa", "COPYWRITER.write"];

describe("registry", () => {
  it("registers every Phase 2 action under its key", () => {
    for (const key of KEYS) {
      const def = getAgentDefinition(key);
      expect(`${def.agent}.${def.action}`).toBe(key);
      expect(AGENT_DEFINITIONS[key]).toBe(def);
    }
    expect(new Set(KEYS.map((key) => getAgentDefinition(key).promptVersion)).size).toBe(
      KEYS.length,
    );
  });

  it("uses the design's effort and max_tokens defaults", () => {
    expect(
      [managerIntake, managerPlan, managerQa, copywriterWrite].map((def) => [
        def.effort,
        def.maxTokens,
      ]),
    ).toEqual([
      ["medium", DEFAULT_MAX_TOKENS],
      ["high", PLAN_MAX_TOKENS],
      ["low", DEFAULT_MAX_TOKENS],
      ["medium", DEFAULT_MAX_TOKENS],
    ]);
    expect([DEFAULT_MAX_TOKENS, PLAN_MAX_TOKENS]).toEqual([16_000, 32_000]);
  });

  it("applies AGENT_EFFORT_<AGENT> overrides per agent", () => {
    expect(resolveEffort(managerPlan, { MANAGER: "low" })).toBe("low");
    expect(resolveEffort(copywriterWrite, { MANAGER: "low" })).toBe("medium");
  });
});

describe("prompts", () => {
  it("keep system prompts frozen: no client data, and the rules each agent needs", () => {
    for (const key of KEYS) {
      const { systemPrompt } = getAgentDefinition(key);
      expect(systemPrompt).not.toContain("Qahwa");
      expect(systemPrompt).toMatch(/Discover, Strategize, Create, Optimize/);
      expect(systemPrompt).toMatch(/Never use any of them/);
      expect(systemPrompt).toMatch(/complete corrected JSON/);
    }
    expect(managerIntake.systemPrompt).toMatch(/ONE-question rule/);
    expect(managerIntake.systemPrompt).toMatch(/one sentence, one question mark/);
    expect(copywriterWrite.systemPrompt).toMatch(/verbatim between <feedback> tags/);
    expect(copywriterWrite.systemPrompt).toMatch(/≤ 2200 characters/);
    expect(copywriterWrite.systemPrompt).toMatch(/first 1 to 3 seconds/);
    expect(managerPlan.systemPrompt).toMatch(/write → direct → adapt → qa/);
    expect(managerQa.systemPrompt).toMatch(/passed to them verbatim/);
  });

  it("puts the brand, banned words included, in the second system block", () => {
    const block = renderBrandBlock(brand({ bannedWords: ["cheap", " ", "discount"] }));
    expect(block).toContain("# Client brand: Qahwa Co");
    expect(block).toMatch(/## Banned words: never use\n- cheap\n- discount\n/);
    expect(block).toContain("Warm, unhurried and precise.");
    expect(renderBrandBlock(brand())).toBe(renderBrandBlock(brand()));
    expect(renderBrandBlock(brand({ bannedWords: [] }))).toContain("None on file.");
    expect(managerIntake.brandBlock(intakeInput())).toBeNull();
    expect(managerIntake.brandBlock(intakeInput({ brand: brand() }))).toContain("Qahwa Co");
  });

  it("quotes revision feedback byte-for-byte", () => {
    const base = copyInput("REEL");
    const verbatim = "  Lead with the FIRST sip.\n\n\tNo “evening” talk — ever.  \n";
    const message = copywriterWrite.userMessage({
      ...base,
      revision: {
        feedback: { verbatim, source: "HUMAN", decisionId: "dec_1" },
        previous: mockCopy(base),
      },
    });
    expect(typeof message).toBe("string");
    expect(message as string).toContain(`<feedback>\n${verbatim}\n</feedback>`);
    expect(message as string).toContain("<previous_copy>");
    expect(message as string).toMatch(/Revise the copy for post p3 \(feedback source: HUMAN\)/);
  });

  it("tells the Copywriter the shape and platforms it owes", () => {
    const message = copywriterWrite.userMessage(copyInput("CAROUSEL")) as string;
    expect(message).toContain("3–10 slides; script and onScreenText are null");
    expect(message).toContain("Platforms, one caption each: Instagram, Facebook.");
  });

  it("quotes a plan change request verbatim and lists enabled actions in order", () => {
    const changeRequest = "Swap p2 and p5.\nKeep the reels on weekends!";
    const message = managerPlan.userMessage({
      brief: brief(),
      brand: brand(),
      today: TODAY,
      enabledActions: ["qa", "write"],
      busyDates: ["2027-03-05"],
      changeRequest,
      previousGraph: null,
    }) as string;
    expect(message).toContain(`<change_request>\n${changeRequest}\n</change_request>`);
    expect(message).toContain("Enabled actions, in pipeline order: write, qa");
    expect(message).toContain("2027-03-05");
    // Post dates are days in the client's calendar, and the Manager is told which one.
    expect(message).toContain(`Today (Asia/Dubai): ${TODAY}`);
  });

  it("gives intake the roster, today, the question budget and the conversation", () => {
    const message = managerIntake.userMessage(intakeInput({ allowClarify: false })) as string;
    expect(message).toContain(`Today (UTC): ${TODAY}`);
    expect(
      managerIntake.userMessage(intakeInput({ selectedClientId: "client_qahwa", brand: brand() })),
    ).toContain(`Today (Asia/Dubai): ${TODAY}`);
    expect(message).toContain('Qahwa Co: id "client_qahwa"');
    expect(message).toContain("Clarifying question: already asked.");
    expect(message).toContain('<message role="USER" kind="TEXT">');
  });
});
