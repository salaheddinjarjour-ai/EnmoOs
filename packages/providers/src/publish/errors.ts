import type { Issue } from "@enmo/shared";

/**
 * Why a publish failed, which decides what the publish service does next:
 * - INVALID_PAYLOAD: the variant breaks the platform's rules; fix the content, retrying won't help
 * - AUTH: the token is invalid, expired or lacks a scope; the account is marked and an alert raised
 * - RATE_LIMITED: a quota or rate limit; retry after it resets
 * - MEDIA_FAILED: the platform couldn't process the media (e.g. a container in ERROR)
 * - UNAVAILABLE: transport errors and 5xx; retry
 * - REJECTED: any other refusal by the platform
 * - NOT_CONFIGURED: a live publisher without app credentials or an account
 * - UNCONFIRMED: an earlier attempt sent the call that makes the post public and never recorded
 *   the answer (a crash, a failed save), so the post may be live already; a person checks first
 */
export type PublishErrorCode =
  | "INVALID_PAYLOAD"
  | "AUTH"
  | "RATE_LIMITED"
  | "MEDIA_FAILED"
  | "UNAVAILABLE"
  | "REJECTED"
  | "NOT_CONFIGURED"
  | "UNCONFIRMED";

const RETRYABLE: ReadonlySet<PublishErrorCode> = new Set(["RATE_LIMITED", "UNAVAILABLE"]);

export class PublishError extends Error {
  override readonly name = "PublishError";
  readonly code: PublishErrorCode;
  /** Whether the same call may succeed later without anyone changing anything. */
  readonly retryable: boolean;
  /** The platform's HTTP status, when it answered at all. */
  readonly status: number | null;
  /** INVALID_PAYLOAD: each broken rule, at its payload path. */
  readonly issues: readonly Issue[];

  constructor(
    code: PublishErrorCode,
    message: string,
    options: {
      status?: number | null;
      issues?: readonly Issue[];
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.status = options.status ?? null;
    this.issues = options.issues ?? [];
  }
}
