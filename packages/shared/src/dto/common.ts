import { z } from "zod";

/*
 * Response schemas are serialised with zod's encode direction (fastify-type-provider-zod), which
 * throws on `.transform()`. Every schema in this package therefore sticks to checks, defaults,
 * pipes and `.overwrite()` so it can be used for requests and responses alike.
 */

/** Database ids (Prisma cuid). Kept loose so tests and fixtures can use readable ids. */
export const Id = z.string().min(1).max(64);
export type Id = z.infer<typeof Id>;

/** Timestamps cross the wire as ISO-8601 strings (`Date#toISOString()`). */
export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** Emails are compared and stored lowercased. */
export const Email = z.string().trim().toLowerCase().max(254).pipe(z.email());
export type Email = z.infer<typeof Email>;

export const IdParams = z.object({ id: Id });
export type IdParams = z.infer<typeof IdParams>;

/** Minimal user reference embedded in other resources. */
export const UserRef = z.object({
  id: Id,
  name: z.string(),
  email: z.string(),
});
export type UserRef = z.infer<typeof UserRef>;

/** List endpoints return `{ items }`; single-resource endpoints return the DTO itself. */
export function listResponse<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item) });
}

export const ErrorCode = z.enum([
  "BAD_REQUEST",
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "UNPROCESSABLE",
  "RATE_LIMITED",
  "INTERNAL",
  "UNAVAILABLE",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UNAVAILABLE: 503,
};

/** Body of every non-2xx API response. */
export const ApiErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;
