import { UnrecoverableError } from "bullmq";
import { describe, expect, it } from "vitest";
import {
  JOB,
  JOB_QUEUE,
  RENDER_POLL_MAX_DELAY_MS,
  TICK_JOB_NAMES,
  jobIds,
  parseJobData,
  publishPollDelayMs,
  publishPollMaxPolls,
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

describe("the publishing jobs", () => {
  it("schedule on the agents queue (the Publisher is an LLM call) and publish on ops", () => {
    expect(JOB_QUEUE[JOB.publisherSchedule]).toBe("agents");
    expect(JOB_QUEUE[JOB.publishRun]).toBe("ops");
    expect(JOB_QUEUE[JOB.publishPoll]).toBe("ops");
    expect(JOB_QUEUE[JOB.tickPublish]).toBe("ops");
    expect(JOB_QUEUE[JOB.tickTokens]).toBe("ops");
    expect(TICK_JOB_NAMES).toEqual(["tick.sweeper", "tick.prune", "tick.publish", "tick.tokens"]);
  });

  it("have one id per approval round, publish attempt and poll", () => {
    expect(jobIds.publisherSchedule({ postId: "p1", round: 2 })).toBe("schedule-p1-r2");
    expect(jobIds.publisherSchedule({ postId: "p1", round: 2 }, "sweep1")).toBe(
      "schedule-p1-r2-sweep1",
    );
    expect(jobIds.publishRun({ publishJobId: "j1", attempt: 1 })).toBe("publish-j1-run1");
    expect(jobIds.publishRun({ publishJobId: "j1", attempt: 2 })).toBe("publish-j1-run2");
    expect(jobIds.publishPoll({ publishJobId: "j1", attempt: 2, poll: 3 })).toBe(
      "publish-j1-run2-poll3",
    );
  });

  it("refuse malformed data for good", () => {
    expect(parseJobData(JOB.publishPoll, { publishJobId: "j1", attempt: 1, poll: 1 })).toEqual({
      publishJobId: "j1",
      attempt: 1,
      poll: 1,
    });
    for (const [name, data] of [
      [JOB.publisherSchedule, { postId: "p1" }],
      [JOB.publishRun, { publishJobId: "j1", attempt: 0 }],
      [JOB.publishPoll, { publishJobId: "j1", attempt: 1 }],
    ] as const) {
      expect(() => parseJobData(name, data), name).toThrow(UnrecoverableError);
    }
  });

  it("poll every PUBLISH_POLL_INTERVAL_SEC for at most PUBLISH_POLL_MAX_MIN", () => {
    const config = { PUBLISH_POLL_INTERVAL_SEC: 10, PUBLISH_POLL_MAX_MIN: 10 };
    expect(publishPollDelayMs(config)).toBe(10_000);
    expect(publishPollMaxPolls(config)).toBe(60);
    expect(publishPollMaxPolls({ PUBLISH_POLL_INTERVAL_SEC: 300, PUBLISH_POLL_MAX_MIN: 1 })).toBe(
      1,
    );
  });
});
