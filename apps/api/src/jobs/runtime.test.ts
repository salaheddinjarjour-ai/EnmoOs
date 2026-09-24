import { InvalidAgentInput } from "@enmo/agents";
import { UnrecoverableError } from "bullmq";
import { describe, expect, it } from "vitest";
import { JOB, parseJobData } from "./queues";
import { asUnrecoverable } from "./runtime";

describe("failures no retry can fix", () => {
  it("fails a job with malformed data for good", () => {
    expect(() => parseJobData(JOB.taskRun, { taskId: "", revision: -1 })).toThrow(
      UnrecoverableError,
    );
    expect(() => parseJobData(JOB.taskRun, { taskId: "", revision: -1 })).toThrow(
      /Invalid task\.run job data/,
    );
  });

  it("does not retry an agent input its contract rejects", () => {
    const invalid = new InvalidAgentInput({
      agent: "COPYWRITER",
      action: "write",
      issues: [{ path: "post.ref", message: "Invalid string" }],
    });
    const converted = asUnrecoverable(invalid);
    expect(converted).toBeInstanceOf(UnrecoverableError);
    expect((converted as Error).message).toBe(invalid.message);
  });

  it("leaves transport and infrastructure errors to BullMQ's retries", () => {
    const transient = new Error("ECONNRESET");
    expect(asUnrecoverable(transient)).toBe(transient);
  });
});
