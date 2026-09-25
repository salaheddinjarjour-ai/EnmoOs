import { describe, expect, it } from "vitest";
import { canTransition } from "./post-status";
import { postStatusForJobs } from "./publishing";

/* How a post's publish jobs move it (orchestrator/publishing.ts syncPostPublishStatus). */

describe("postStatusForJobs", () => {
  it("is SCHEDULED while every job waits for its slot or its run", () => {
    expect(postStatusForJobs(["SCHEDULED"])).toBe("SCHEDULED");
    expect(postStatusForJobs(["SCHEDULED", "QUEUED"])).toBe("SCHEDULED");
  });

  it("is PUBLISHING once a variant is going out, or out while another still waits", () => {
    expect(postStatusForJobs(["PUBLISHING", "SCHEDULED"])).toBe("PUBLISHING");
    expect(postStatusForJobs(["PUBLISHED", "QUEUED"])).toBe("PUBLISHING");
  });

  it("is LIVE when every job that counts is PUBLISHED", () => {
    expect(postStatusForJobs(["PUBLISHED", "PUBLISHED"])).toBe("LIVE");
    expect(postStatusForJobs(["PUBLISHED", "CANCELLED"])).toBe("LIVE");
  });

  it("is FAILED while any job is, and APPROVED when none is left", () => {
    expect(postStatusForJobs(["FAILED", "PUBLISHED"])).toBe("FAILED");
    expect(postStatusForJobs(["FAILED", "PUBLISHING"])).toBe("FAILED");
    expect(postStatusForJobs(["CANCELLED", "CANCELLED"])).toBe("APPROVED");
    expect(postStatusForJobs([])).toBe("APPROVED");
  });

  it("only ever asks for moves POST_TRANSITIONS allows", () => {
    const moves: [Parameters<typeof canTransition>[0], ReturnType<typeof postStatusForJobs>][] = [
      ["APPROVED", "SCHEDULED"],
      ["SCHEDULED", "PUBLISHING"],
      ["PUBLISHING", "LIVE"],
      ["PUBLISHING", "SCHEDULED"], // a retryable error puts the only job back in the queue
      ["PUBLISHING", "FAILED"],
      ["SCHEDULED", "FAILED"], // the guard refused a token before anything went out
      ["FAILED", "SCHEDULED"], // a retry with nothing else out
      ["FAILED", "PUBLISHING"], // a retry while another variant is out
      ["SCHEDULED", "APPROVED"], // every job called off
    ];
    for (const [from, to] of moves) expect(canTransition(from, to), `${from} → ${to}`).toBe(true);
    expect(canTransition("LIVE", "SCHEDULED")).toBe(false);
    expect(canTransition("APPROVED", "LIVE")).toBe(false);
  });
});
