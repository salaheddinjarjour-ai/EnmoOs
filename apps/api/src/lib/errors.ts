import { ERROR_HTTP_STATUS, type ErrorCode } from "@enmo/shared";

export interface AppErrorOptions {
  details?: unknown;
  /** Overrides the status implied by the code (e.g. 415 reported as BAD_REQUEST). */
  status?: number;
  cause?: unknown;
}

/**
 * An expected failure with a client-safe message. The error plugin renders it as
 * `{ error: { code, message, details? } }` (ApiErrorBody) with `status`.
 */
export class AppError extends Error {
  override readonly name = "AppError";
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.status = options.status ?? ERROR_HTTP_STATUS[code];
    this.details = options.details;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError("BAD_REQUEST", message, { details });

export const unauthenticated = (message = "Sign in to continue") =>
  new AppError("UNAUTHENTICATED", message);

export const forbidden = (message = "You don't have permission to do that") =>
  new AppError("FORBIDDEN", message);

export const notFound = (what = "Resource") => new AppError("NOT_FOUND", `${what} not found`);

export const conflict = (message: string, details?: unknown) =>
  new AppError("CONFLICT", message, { details });

export const unprocessable = (message: string, details?: unknown) =>
  new AppError("UNPROCESSABLE", message, { details });
