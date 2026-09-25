import { describe, expect, it } from "vitest";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { PublisherOutput, type PublisherInput } from "@enmo/shared";
import {
  AgentEscalation,
  MockLlm,
  getAgentDefinition,
  publisherSchedule,
  runAgent,
  validatePublisher,
} from "../src";
import { recordingHooks } from "./fixtures";

function input(): PublisherInput {
  return {
    campaign: { name: "Ramadan iced line", window: { start: "2027-03-01", end: "2027-03-30" } },
    briefSummary: "Push the iced line after iftar, for young professionals in Riyadh.",
    timezone: "Asia/Riyadh",
    items: [
      {
        variantId: "var_ig",
        platform: "INSTAGRAM",
        postType: "REEL",
        targetDate: "2027-03-02",
        candidates: [
          {
            slotStart: "2027-03-02T09:00:00.000Z",
            score: 1.25,
            reasons: ["Instagram weekday lunch peak"],
          },
          { slotStart: "2027-03-02T17:00:00.000Z", score: 1.3, reasons: ["Evening peak"] },
          { slotStart: "2027-03-03T09:00:00.000Z", score: 1.3, reasons: [] },
        ],
      },
      {
        variantId: "var_fb",
        platform: "FACEBOOK",
        postType: "REEL",
        targetDate: null,
        candidates: [{ slotStart: "2027-03-02T07:00:00.000Z", score: 1.25, reasons: [] }],
      },
    ],
  };
}

describe("PUBLISHER.schedule", () => {
  it("is registered with a strict structured-output schema and low effort", () => {
    expect(getAgentDefinition("PUBLISHER.schedule")).toBe(publisherSchedule);
    expect(publisherSchedule.effort).toBe("low");
    expect(publisherSchedule.brandBlock(input())).toBeNull();
    expect(zodOutputFormat(PublisherOutput).schema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
  });

  it("lists every candidate with its exact slotStart and client-local time", () => {
    const message = publisherSchedule.userMessage(input()) as string;
    expect(message).toContain("Client time zone: Asia/Riyadh.");
    expect(message).toContain(
      '1. slotStart "2027-03-02T09:00:00.000Z" = Tue 2027-03-02 12:00 local, score 1.25 (Instagram weekday lunch peak)',
    );
    expect(message).toContain("## Variant var_fb: Facebook REEL, target date none");
  });

  it("MockLlm picks each variant's top candidate through the runner", async () => {
    const { output, attempts } = await runAgent(publisherSchedule, input(), {
      llm: new MockLlm(),
      ...recordingHooks(),
    });
    expect(attempts).toBe(1);
    expect(output.assignments).toEqual([
      {
        variantId: "var_ig",
        slotStart: "2027-03-02T17:00:00.000Z",
        reason: "Top-scored slot: Evening peak.",
      },
      {
        variantId: "var_fb",
        slotStart: "2027-03-02T07:00:00.000Z",
        reason: "Top-scored slot: the best expected engagement of the candidates.",
      },
    ]);
  });

  it("escalates after its retries so the orchestrator can fall back to the top candidate", async () => {
    const error = await runAgent(publisherSchedule, input(), {
      llm: new MockLlm({ faults: "PUBLISHER.schedule:invalid*3" }),
      ...recordingHooks(),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentEscalation);
  });

  it("validates one assignment per variant, at one of its own candidates", () => {
    const reason = "Lunch peak.";
    expect(
      validatePublisher(
        {
          assignments: [
            { variantId: "var_ig", slotStart: "2027-03-02T09:00Z", reason },
            { variantId: "var_ig", slotStart: "2027-03-02T17:00:00.000Z", reason },
            { variantId: "var_x", slotStart: "2027-03-02T07:00:00.000Z", reason },
          ],
        },
        input(),
      ),
    ).toEqual([
      {
        path: "assignments[1].variantId",
        message: "Variant var_ig is assigned twice; give each variant exactly one slot.",
      },
      { path: "assignments[2].variantId", message: 'There is no variant "var_x" in the request.' },
      { path: "assignments", message: "Variant var_fb has no slot; add an assignment for it." },
    ]);
    expect(
      validatePublisher(
        {
          assignments: [
            { variantId: "var_ig", slotStart: "2027-03-02T07:00:00.000Z", reason },
            { variantId: "var_fb", slotStart: "tomorrow", reason },
          ],
        },
        input(),
      ).map((issue) => issue.path),
    ).toEqual(["assignments[0].slotStart", "assignments[1].slotStart"]);
  });
});
