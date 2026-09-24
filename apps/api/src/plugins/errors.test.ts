import { Prisma } from "@enmo/db";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError, notFound } from "../lib/errors";
import { toErrorResponse } from "./errors";

describe("toErrorResponse", () => {
  it("renders AppErrors with their status, code, message and details", () => {
    expect(toErrorResponse(notFound("Client"))).toEqual({
      status: 404,
      body: { error: { code: "NOT_FOUND", message: "Client not found" } },
    });
    expect(
      toErrorResponse(new AppError("BAD_REQUEST", "Use JSON", { status: 415, details: { a: 1 } })),
    ).toEqual({
      status: 415,
      body: { error: { code: "BAD_REQUEST", message: "Use JSON", details: { a: 1 } } },
    });
  });

  it("maps ZodError to 400 VALIDATION_FAILED with dotted paths", () => {
    const result = z.object({ steps: z.array(z.object({ name: z.string() })) }).safeParse({
      steps: [{ name: 1 }],
    });
    if (result.success) throw new Error("expected failure");
    const { status, body } = toErrorResponse(result.error);
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.details).toEqual({
      issues: [{ path: "steps.0.name", message: expect.any(String) as string }],
    });
  });

  it("maps unique and not-found Prisma errors", () => {
    const known = (code: string) =>
      new Prisma.PrismaClientKnownRequestError("db error", { code, clientVersion: "7.10.0" });
    expect(toErrorResponse(known("P2002")).status).toBe(409);
    expect(toErrorResponse(known("P2025")).status).toBe(404);
    expect(toErrorResponse(known("P2003")).status).toBe(500);
  });

  it("maps a transaction Postgres aborted for another one (deadlock, serialization) to 409", () => {
    const conflict = { code: "CONFLICT", message: expect.any(String) as string };
    const deadlock = new Prisma.PrismaClientKnownRequestError("deadlock detected", {
      code: "P2034",
      clientVersion: "7.10.0",
      meta: {
        driverAdapterError: {
          name: "DriverAdapterError",
          cause: { originalCode: "40P01", kind: "TransactionWriteConflict" },
        },
      },
    });
    expect(toErrorResponse(deadlock)).toEqual({ status: 409, body: { error: conflict } });
    // A raw query (a row lock) reports the driver's error under its own code.
    const raw = (originalCode: string) =>
      new Prisma.PrismaClientKnownRequestError("raw query failed", {
        code: "P2010",
        clientVersion: "7.10.0",
        meta: { driverAdapterError: { name: "DriverAdapterError", cause: { originalCode } } },
      });
    expect(toErrorResponse(raw("40001")).status).toBe(409);
    expect(toErrorResponse(raw("40P01")).status).toBe(409);
    expect(toErrorResponse(raw("23503")).status).toBe(500);
  });

  it("keeps 4xx framework errors (including rate-limit objects) and hides 5xx details", () => {
    expect(toErrorResponse({ statusCode: 429, message: "Rate limit exceeded" })).toEqual({
      status: 429,
      body: { error: { code: "RATE_LIMITED", message: "Rate limit exceeded" } },
    });
    expect(
      toErrorResponse(Object.assign(new Error("Unsupported Media Type"), { statusCode: 415 })),
    ).toEqual({
      status: 415,
      body: { error: { code: "BAD_REQUEST", message: "Unsupported Media Type" } },
    });
    expect(toErrorResponse(new Error("connection string leaked"))).toEqual({
      status: 500,
      body: { error: { code: "INTERNAL", message: "Something went wrong" } },
    });
    expect(
      toErrorResponse(Object.assign(new Error("upstream"), { statusCode: 503 })).body.error,
    ).toEqual({
      code: "UNAVAILABLE",
      message: "Something went wrong",
    });
  });
});
