import { UnrecoverableError } from "bullmq";
import { describe, expect, it } from "vitest";
import {
  JOB,
  JOB_QUEUE,
  RENDER_POLL_MAX_DELAY_MS,
  jobIds,
  parseJobData,
  renderPollDelayMs,
} from "./queues";

describe("the visual loop's jobs", () => {
  it("render on the media queue and review on the agents queue (LLM work)", () => {
    expect(JOB_QUEUE[JOB.renderSubmit]).toBe("media");
    expect(JOB_QUEUE[JOB.renderPoll]).toBe("media");
    expect(JOB_QUEUE[JOB.visualReview]).toBe("agents");
    expect(JOB_QUEUE[JOB.visualRegenerate]).toBe("agents");
  });

  it("have deterministic ids without the ':' BullMQ rejects", () => {
    const asset = { assetId: "cmasset1" };
    expect(jobIds.renderSubmit(asset)).toBe("render-cmasset1-submit");
    expect(jobIds.renderSubmit(asset, "stall-1")).toBe("render-cmasset1-submit-stall-1");
    expect(jobIds.renderPoll({ ...asset, attempt: 3 })).toBe("render-cmasset1-poll3");
    expect(jobIds.visualReview(asset)).toBe("review-cmasset1");
    expect(jobIds.visualReview(asset, null)).toBe("review-cmasset1");
    expect(jobIds.visualRegenerate(asset)).toBe("regenerate-cmasset1");
    expect(() => jobIds.visualReview(asset, "bad:token")).toThrow();
  });

  it("refuse malformed data for good", () => {
    expect(parseJobData(JOB.renderPoll, { assetId: "a1", attempt: 1 })).toEqual({
      assetId: "a1",
      attempt: 1,
    });
    for (const [name, data] of [
      [JOB.renderSubmit, {}],
      [JOB.renderPoll, { assetId: "a1", attempt: 0 }],
      [JOB.visualReview, { assetId: "" }],
      [JOB.visualRegenerate, { asset: "a1" }],
    ] as const) {
      expect(() => parseJobData(name, data), name).toThrow(UnrecoverableError);
    }
  });
});

describe("renderPollDelayMs", () => {
  it("starts at RENDER_POLL_DELAY_MS and backs off to at most 10 seconds", () => {
    const config = { RENDER_POLL_DELAY_MS: 3_000 };
    expect([1, 2, 3, 4, 5].map((attempt) => renderPollDelayMs(config, attempt))).toEqual([
      3_000, 4_500, 6_750, 10_000, 10_000,
    ]);
    expect(renderPollDelayMs(config, 50)).toBe(RENDER_POLL_MAX_DELAY_MS);
  });

  it("keeps a short test delay short for the first polls", () => {
    expect(renderPollDelayMs({ RENDER_POLL_DELAY_MS: 20 }, 1)).toBe(20);
    expect(renderPollDelayMs({ RENDER_POLL_DELAY_MS: 20 }, 2)).toBe(30);
  });
});
