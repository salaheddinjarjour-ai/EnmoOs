import { ApiErrorBody, type ErrorCode } from "@enmo/shared";
import { z } from "zod";

/*
 * Typed fetch against the ENMO API (DESIGN §G "Data layer"). TanStack Query hooks in src/hooks
 * build on it.
 *
 * - cookies travel with every call (`credentials: "include"`); the API owns the session
 * - mutations always send `Content-Type: application/json` (the API's CSRF rule), even bodiless
 * - success bodies are parsed with the shared zod DTOs, so a drifting API fails loudly here
 * - a 401 on an authenticated call runs the handler the AuthGate registers (session → /login)
 */

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(
  /\/+$/,
  "",
);

export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    readonly status: number,
    readonly code: ErrorCode | "NETWORK",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

let onUnauthenticated: (() => void) | undefined;

/** Registered by the AuthGate; returns an unregister function. */
export function setUnauthenticatedHandler(handler: () => void): () => void {
  onUnauthenticated = handler;
  return () => {
    if (onUnauthenticated === handler) onUnauthenticated = undefined;
  };
}

export interface ApiRequest<T> {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Parses the success body; omit for 204 responses. */
  schema?: z.ZodType<T>;
  signal?: AbortSignal;
  /** Don't run the 401 handler (the login form, the session probe, public invite routes). */
  allowUnauthenticated?: boolean;
}

/** Joins path segments, URL-encoding each one: apiPath("clients", id, "archive"). */
export function apiPath(...segments: readonly string[]): string {
  return `/${segments.map(encodeURIComponent).join("/")}`;
}

function buildUrl(path: string, query: ApiRequest<unknown>["query"]): string {
  const url = new URL(`${API_URL}/v1${path.startsWith("/") ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function toApiError(response: Response): Promise<ApiError> {
  const parsed = ApiErrorBody.safeParse(await response.json().catch(() => null));
  return parsed.success
    ? new ApiError(
        response.status,
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.details,
      )
    : new ApiError(
        response.status,
        response.status >= 500 ? "INTERNAL" : "BAD_REQUEST",
        response.statusText || `Request failed (${response.status})`,
      );
}

export async function api<T = void>(path: string, request: ApiRequest<T> = {}): Promise<T> {
  const method = request.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(buildUrl(path, request.query), {
      method,
      credentials: "include",
      headers:
        method === "GET" ? { accept: "application/json" } : { "content-type": "application/json" },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: request.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "NETWORK", "Can't reach the ENMO API. Check your connection.");
  }

  if (!response.ok) {
    const error = await toApiError(response);
    if (error.status === 401 && !request.allowUnauthenticated) onUnauthenticated?.();
    throw error;
  }

  if (!request.schema || response.status === 204) return undefined as T;
  return request.schema.parse(await response.json());
}

/* ── Error presentation ─────────────────────────────────────────────────── */

/** A sentence to show the user for any thrown value. */
export function errorMessage(
  error: unknown,
  fallback = "Something went wrong. Try again.",
): string {
  if (error instanceof ApiError) {
    if (error.code === "VALIDATION_FAILED") {
      const [first] = Object.values(fieldErrors(error));
      return first ? `${error.message}: ${first}` : error.message;
    }
    if (error.code === "INTERNAL") return fallback;
    return error.message;
  }
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? fallback;
  return fallback;
}

const IssueList = z.object({
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
});
const FieldDetail = z.object({ field: z.string() });

/**
 * Field-level messages keyed by dotted path ("name", "steps.0.approverRoles"), from a client-side
 * ZodError or an API VALIDATION_FAILED / CONFLICT response. The first message per path wins.
 */
export function fieldErrors(error: unknown): Record<string, string> {
  const entries: Array<[string, string]> = [];
  if (error instanceof z.ZodError) {
    for (const issue of error.issues)
      entries.push([issue.path.map(String).join("."), issue.message]);
  } else if (error instanceof ApiError) {
    const issues = IssueList.safeParse(error.details);
    if (issues.success)
      for (const issue of issues.data.issues) entries.push([issue.path, issue.message]);
    const field = FieldDetail.safeParse(error.details);
    if (field.success) entries.push([field.data.field, error.message]);
  }

  const result: Record<string, string> = {};
  for (const [path, message] of entries) result[path] ??= message;
  return result;
}
