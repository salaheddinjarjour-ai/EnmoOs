import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toErrorResponse } from "../plugins/errors";
import { parseStored, StoredDataError } from "./stored";

describe("parseStored", () => {
  const Shape = z.object({ steps: z.array(z.object({ name: z.string() })).min(1) });

  it("returns the parsed value", () => {
    expect(parseStored(Shape, { steps: [{ name: "Review" }] }, "Client c1.approvalChain")).toEqual({
      steps: [{ name: "Review" }],
    });
  });

  it("throws a StoredDataError naming the row, which the API reports as a 500", () => {
    let thrown: unknown;
    try {
      parseStored(Shape, { steps: [] }, "Client c1.approvalChain");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StoredDataError);
    expect((thrown as Error).message).toContain("Client c1.approvalChain");
    expect(toErrorResponse(thrown)).toEqual({
      status: 500,
      body: { error: { code: "INTERNAL", message: "Something went wrong" } },
    });
  });
});
