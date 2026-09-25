import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  CopywriterOutput,
  ManagerIntakeNoClarifyOutput,
  ManagerIntakeOutput,
  ManagerPlanOutput,
  ManagerQaOutput,
  VisualDirectOutput,
  VisualReviewOutput,
  type ManagerIntakeOutput as ManagerIntakeOutputT,
} from "@enmo/shared";
import { AgentEscalation, BudgetExceeded, agentKey, defaultEffort } from "../src";

describe("contracts through the SDK's zodOutputFormat", () => {
  it.each([
    ["ManagerIntakeOutput", ManagerIntakeOutput],
    ["ManagerIntakeNoClarifyOutput", ManagerIntakeNoClarifyOutput],
    ["ManagerPlanOutput", ManagerPlanOutput],
    ["ManagerQaOutput", ManagerQaOutput],
    ["CopywriterOutput", CopywriterOutput],
    ["VisualDirectOutput", VisualDirectOutput],
    ["VisualReviewOutput", VisualReviewOutput],
  ] as const)("%s builds a strict object schema", (_name, schema) => {
    const format = zodOutputFormat(schema);
    expect(format.type).toBe("json_schema");
    expect(format.schema).toMatchObject({ type: "object", additionalProperties: false });
  });

  // Why the Anthropic client must send {type, schema} without `parse`: with a parseable format,
  // messages.stream() parses at message_stop and finalMessage() rejects on invalid output, losing
  // the text and usage the runner needs to record the attempt and ask for a correction.
  it("zodOutputFormat's parse throws on output the runner must see", () => {
    const format = zodOutputFormat(ManagerQaOutput);
    expect(() => format.parse("{not json")).toThrow();
    expect(() => format.parse(JSON.stringify({ verdict: "maybe" }))).toThrow();
  });

  it("the no-clarify contract can stand in for the intake contract (outputFor)", () => {
    const narrowed: z.ZodType<ManagerIntakeOutputT> = ManagerIntakeNoClarifyOutput;
    expect(narrowed).toBe(ManagerIntakeNoClarifyOutput);
  });
});

describe("errors", () => {
  it("AgentEscalation carries agent, action, issues and reason", () => {
    const error = new AgentEscalation({
      agent: "COPYWRITER",
      action: "write",
      issues: [{ path: "caption", message: 'Uses banned word "cheap"' }],
      reason: "INVALID_OUTPUT",
    });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "AgentEscalation",
      agent: "COPYWRITER",
      action: "write",
      reason: "INVALID_OUTPUT",
    });
    expect(error.issues).toHaveLength(1);
    expect(error.message).toBe("COPYWRITER.write escalated (INVALID_OUTPUT, 1 issue)");
  });

  it("BudgetExceeded carries the day's numbers", () => {
    const error = new BudgetExceeded({ day: "2026-09-24", used: 5, cap: 1 });
    expect(error).toMatchObject({ name: "BudgetExceeded", day: "2026-09-24", used: 5, cap: 1 });
  });
});

describe("definitions", () => {
  it("keys agents as AGENT.action", () => {
    expect(agentKey({ agent: "COPYWRITER", action: "write" })).toBe("COPYWRITER.write");
  });

  it("uses the design's effort defaults", () => {
    expect(defaultEffort("MANAGER", "plan")).toBe("high");
    expect(defaultEffort("STRATEGIST", "strategy")).toBe("high");
    expect(defaultEffort("ANALYST", "analyze")).toBe("high");
    expect(defaultEffort("MANAGER", "intake")).toBe("medium");
    expect(defaultEffort("COPYWRITER", "write")).toBe("medium");
    expect(defaultEffort("VISUAL_DIRECTOR", "direct")).toBe("medium");
    expect(defaultEffort("MANAGER", "qa")).toBe("low");
    expect(defaultEffort("VISUAL_DIRECTOR", "review")).toBe("low");
    expect(defaultEffort("PUBLISHER", "schedule")).toBe("low");
  });
});
