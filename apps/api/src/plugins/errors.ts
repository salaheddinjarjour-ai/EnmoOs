import { Prisma } from "@enmo/db";
import type { ApiErrorBody, ErrorCode } from "@enmo/shared";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from "fastify-type-provider-zod";
import { z } from "zod";
import { isAppError } from "../lib/errors";

/*
 * One error shape for every non-2xx response: `{ error: { code, message, details? } }`.
 * Only AppError messages and 4xx framework messages reach clients; anything unexpected becomes a
 * logged 500 with a generic message.
 */

interface ErrorResponse {
  status: number;
  body: ApiErrorBody;
}

function response(
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
): ErrorResponse {
  return {
    status,
    body: { error: details === undefined ? { code, message } : { code, message, details } },
  };
}

function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 422:
      return "UNPROCESSABLE";
    case 429:
      return "RATE_LIMITED";
    case 503:
      return "UNAVAILABLE";
    default:
      return status >= 500 ? "INTERNAL" : "BAD_REQUEST";
  }
}

/** Framework and plugin errors (and @fastify/rate-limit's plain objects) carry `statusCode`. */
function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const { statusCode } = error;
  return typeof statusCode === "number" && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : undefined;
}

function messageOf(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : "Request failed";
}

const WRITE_CONFLICT_SQLSTATES = new Set(["40001", "40P01"]);

/** P2034, or a raw query's driver error carrying the same Postgres SQLSTATE. */
function isWriteConflict(error: Prisma.PrismaClientKnownRequestError): boolean {
  if (error.code === "P2034") return true;
  const cause = (error.meta?.driverAdapterError as { cause?: unknown } | undefined)?.cause;
  if (typeof cause !== "object" || cause === null) return false;
  const { kind, originalCode } = cause as { kind?: unknown; originalCode?: unknown };
  return (
    kind === "TransactionWriteConflict" ||
    (typeof originalCode === "string" && WRITE_CONFLICT_SQLSTATES.has(originalCode))
  );
}

const zodIssues = (issues: readonly z.core.$ZodIssue[]) =>
  issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));

export function toErrorResponse(error: unknown): ErrorResponse {
  if (isAppError(error)) return response(error.status, error.code, error.message, error.details);

  if (hasZodFastifySchemaValidationErrors(error)) {
    return response(400, "VALIDATION_FAILED", "Request validation failed", {
      where: error.validationContext,
      issues: error.validation.map((issue) => ({
        path: issue.instancePath.replace(/^\//, "").replaceAll("/", "."),
        message: issue.message ?? "Invalid value",
      })),
    });
  }

  if (isResponseSerializationError(error)) {
    return response(500, "INTERNAL", "Something went wrong");
  }

  if (error instanceof z.core.$ZodError) {
    return response(400, "VALIDATION_FAILED", "Validation failed", {
      issues: zodIssues(error.issues),
    });
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") return response(409, "CONFLICT", "That already exists");
    if (error.code === "P2025") return response(404, "NOT_FOUND", "Resource not found");
    if (isWriteConflict(error)) {
      // Postgres aborted this transaction for another one (40P01 deadlock, 40001 serialization):
      // nothing of it was stored, and the same click again will see what the other one did.
      return response(409, "CONFLICT", "Someone else changed this at the same moment; try again");
    }
  }

  const status = statusCodeOf(error);
  if (status !== undefined && status < 500) {
    return response(status, codeForStatus(status), messageOf(error));
  }
  return response(status ?? 500, codeForStatus(status ?? 500), "Something went wrong");
}

export const errorsPlugin = fp(
  (app: FastifyInstance, _options, done) => {
    app.setErrorHandler((error, request, reply) => {
      const { status, body } = toErrorResponse(error);
      if (status >= 500) request.log.error({ err: error }, "request failed");
      return reply.status(status).send(body);
    });

    app.setNotFoundHandler((request, reply) => {
      const path = request.url.split("?")[0] ?? request.url;
      const { status, body } = response(
        404,
        "NOT_FOUND",
        `Route ${request.method} ${path} not found`,
      );
      return reply.status(status).send(body);
    });
    done();
  },
  { name: "enmo-errors", fastify: "5.x" },
);
