import { PublishError, type PublishErrorCode } from "./errors";
import {
  GraphApiError,
  GraphTransportError,
  isGraphError,
  type GraphResponseError,
} from "./graph-client";

/*
 * Graph failures as PublishErrors, so the publish service knows what to do next (errors.ts):
 * token and permission problems are AUTH (the account is marked, an alert raised), rate limits and
 * outages are retried, media Meta couldn't process is MEDIA_FAILED, anything else is a permanent
 * REJECTED. Codes as Meta documents them for the Graph API, Instagram content publishing and
 * Facebook video uploads.
 */

/** 190 invalid or expired token, 102 session, 10 and 200–299 missing permission, 104/2500 no token. */
const AUTH_CODES: ReadonlySet<number> = new Set([190, 102, 104, 10, 2500]);
/** 4 app, 17 user, 32 Page, 613 per-hour; 9 is Instagram's content publishing cap. */
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([4, 9, 17, 32, 613]);
/** Instagram: "reached the maximum number of posts" for the 24-hour window. */
const RATE_LIMIT_SUBCODES: ReadonlySet<number> = new Set([2207042]);
/** 1 unknown, 2 service unavailable. */
const TRANSIENT_CODES: ReadonlySet<number> = new Set([1, 2]);
/** Instagram: server error, media download timed out. */
const TRANSIENT_SUBCODES: ReadonlySet<number> = new Set([2207001, 2207003]);
/** Media Meta couldn't fetch or process: download failures, image and video format errors. */
const MEDIA_CODES: ReadonlySet<number> = new Set([
  324, 352, 390, 6000, 9004, 36000, 36001, 36003, 36004,
]);
const MEDIA_SUBCODES: ReadonlySet<number> = new Set([
  2207004, 2207005, 2207009, 2207020, 2207023, 2207026, 2207052, 2207053,
]);

function inRange(code: number | null, from: number, to: number): boolean {
  return code !== null && code >= from && code <= to;
}

function apiErrorCode(error: GraphApiError): PublishErrorCode {
  const { code, subcode } = error;
  if (code !== null && (AUTH_CODES.has(code) || inRange(code, 200, 299))) return "AUTH";
  if (
    (code !== null && (RATE_LIMIT_CODES.has(code) || inRange(code, 80001, 80014))) ||
    (subcode !== null && RATE_LIMIT_SUBCODES.has(subcode)) ||
    error.status === 429
  ) {
    return "RATE_LIMITED";
  }
  if (
    error.transient ||
    error.status >= 500 ||
    (code !== null && TRANSIENT_CODES.has(code)) ||
    (subcode !== null && TRANSIENT_SUBCODES.has(subcode))
  ) {
    return "UNAVAILABLE";
  }
  if (
    (code !== null && MEDIA_CODES.has(code)) ||
    (subcode !== null && (MEDIA_SUBCODES.has(subcode) || inRange(subcode, 1363000, 1363999)))
  ) {
    return "MEDIA_FAILED";
  }
  return "REJECTED";
}

function transportErrorCode(error: GraphTransportError): PublishErrorCode {
  const { status } = error;
  if (status === 429) return "RATE_LIMITED";
  if (status === null || status === 408 || status >= 500) return "UNAVAILABLE";
  return "REJECTED";
}

/** Any error from a Meta call as a PublishError; PublishErrors pass through unchanged. */
export function toPublishError(error: unknown): PublishError {
  if (error instanceof PublishError) return error;
  if (!isGraphError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    return new PublishError("UNAVAILABLE", `Publishing to Meta failed: ${message}`, {
      cause: error,
    });
  }
  if (error instanceof GraphApiError) {
    return new PublishError(apiErrorCode(error), error.message, {
      status: error.status,
      cause: error,
    });
  }
  if (error instanceof GraphTransportError) {
    return new PublishError(transportErrorCode(error), error.message, {
      status: error.status,
      cause: error,
    });
  }
  const unexpected: GraphResponseError = error;
  return new PublishError("REJECTED", unexpected.message, { cause: unexpected });
}
