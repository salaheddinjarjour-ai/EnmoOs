import { AgentEscalation, InvalidAgentInput } from "@enmo/agents";
import { describe, expect, it } from "vitest";
import { asSentence, handOffFromEscalation, handOffFromInvalidInput } from "./escalation";

describe("hand-off wording", () => {
  it("ends every sentence with one full stop", () => {
    expect(asSentence("failed after every retry: socket hang up")).toBe(
      "failed after every retry: socket hang up.",
    );
    expect(asSentence("was stopped.. ")).toBe("was stopped.");
    expect(asSentence("really?")).toBe("really?");
  });

  it("summarises an escalation with its first issues", () => {
    const handOff = handOffFromEscalation(
      new AgentEscalation({
        agent: "COPYWRITER",
        action: "write",
        reason: "INVALID_OUTPUT",
        issues: [
          { path: "caption", message: "Caption is too long." },
          { path: "hashtags", message: "Too many hashtags" },
        ],
      }),
    );
    expect(handOff).toMatchObject({
      reason: "INVALID_OUTPUT",
      message:
        "kept returning output that breaks its contract: Caption is too long; Too many hashtags.",
    });
    expect(handOff.issues).toHaveLength(2);
  });

  it("explains a refusal without issues", () => {
    const handOff = handOffFromEscalation(
      new AgentEscalation({ agent: "MANAGER", action: "qa", reason: "REFUSED", issues: [] }),
    );
    expect(handOff.message).toBe("refused the request.");
  });

  it("names a request the provider rejected", () => {
    const handOff = handOffFromEscalation(
      new AgentEscalation({
        agent: "COPYWRITER",
        action: "write",
        reason: "API_ERROR",
        issues: [{ path: "", message: "400 prompt is too long" }],
      }),
    );
    expect(handOff.message).toBe(
      "had its request rejected by the model provider: 400 prompt is too long.",
    );
  });

  it("reports an invalid input as a bug, not as the model's failure", () => {
    const handOff = handOffFromInvalidInput(
      new InvalidAgentInput({
        agent: "COPYWRITER",
        action: "write",
        issues: [{ path: "post.targetDate", message: "Invalid date" }],
      }),
    );
    expect(handOff).toMatchObject({
      reason: "INVALID_INPUT",
      message: "was given an input that breaks its contract (a bug to report): Invalid date.",
    });
  });
});
