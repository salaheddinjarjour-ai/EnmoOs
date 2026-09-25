import { createHmac } from "node:crypto";
import { z } from "zod";

/*
 * The one HTTP path to Meta (Graph and rupload) for the publisher and OAuth: an injected fetch
 * with a per-request timeout, JSON bodies, and Graph's error envelope parsed into GraphApiError.
 * Page and user tokens travel in the Authorization header with an appsecret_proof beside them
 * (Meta's "Require App Secret" setting), so no token lands in a URL, a log line or an error message.
 * Callers turn these errors into their own (PublishError, OAuthError).
 */

export const META_DEFAULT_TIMEOUT_MS = 30_000;

/** A Graph object id: digits, or `<page>_<post>` for Page posts. */
export const GraphId = z
  .union([z.string(), z.number().int().nonnegative()])
  .transform(String)
  .pipe(z.string().regex(/^[A-Za-z0-9_.-]+$/, "Expected a Graph object id"));

/** Graph's error object, as Meta documents it; every field is optional in practice. */
const GraphErrorObject = z.looseObject({
  message: z.string().optional(),
  type: z.string().optional(),
  code: z.number().optional(),
  error_subcode: z.number().optional(),
  is_transient: z.boolean().optional(),
  error_user_title: z.string().optional(),
  error_user_msg: z.string().optional(),
  fbtrace_id: z.string().optional(),
});

/** rupload answers failures with `{debug_info: {retriable, type, message}}` instead. */
const RuploadErrorObject = z.looseObject({
  retriable: z.boolean().optional(),
  type: z.string().optional(),
  message: z.string().optional(),
});

const ErrorEnvelope = z.union([
  z.object({ error: GraphErrorObject }),
  z.object({ debug_info: RuploadErrorObject }),
]);

/** Meta answered with an error: Graph's `{"error": {...}}` or rupload's `{"debug_info": {...}}`. */
export class GraphApiError extends Error {
  override readonly name = "GraphApiError";
  /** The HTTP status. */
  readonly status: number;
  /** Graph's error code (190 invalid token, 4 app rate limit, 100 invalid parameter, …). */
  readonly code: number | null;
  readonly subcode: number | null;
  /** OAuthException, GraphMethodException, … */
  readonly type: string | null;
  /** Meta says the same call may succeed later (is_transient, rupload's retriable). */
  readonly transient: boolean;
  /** Meta's own wording for a person, when it gave one. */
  readonly userMessage: string | null;
  readonly fbtraceId: string | null;

  constructor(
    message: string,
    detail: {
      status: number;
      code?: number | null;
      subcode?: number | null;
      type?: string | null;
      transient?: boolean;
      userMessage?: string | null;
      fbtraceId?: string | null;
    },
  ) {
    super(message);
    this.status = detail.status;
    this.code = detail.code ?? null;
    this.subcode = detail.subcode ?? null;
    this.type = detail.type ?? null;
    this.transient = detail.transient ?? false;
    this.userMessage = detail.userMessage ?? null;
    this.fbtraceId = detail.fbtraceId ?? null;
  }
}

/** Meta couldn't be reached or answered unreadably: DNS, reset, timeout, a non-JSON body. */
export class GraphTransportError extends Error {
  override readonly name = "GraphTransportError";
  readonly status: number | null;
  readonly timedOut: boolean;

  constructor(
    message: string,
    options: { status?: number | null; timedOut?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.status = options.status ?? null;
    this.timedOut = options.timedOut ?? false;
  }
}

/**
 * Meta answered 2xx with a body the caller can't use (e.g. no id). Not retried: the call may well
 * have taken effect, and repeating a publish could post twice.
 */
export class GraphResponseError extends Error {
  override readonly name = "GraphResponseError";
}

export type GraphError = GraphApiError | GraphTransportError | GraphResponseError;

export function isGraphError(error: unknown): error is GraphError {
  return (
    error instanceof GraphApiError ||
    error instanceof GraphTransportError ||
    error instanceof GraphResponseError
  );
}

/** HMAC-SHA256 of the token keyed with the app secret, hex (Meta's appsecret_proof). */
export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(accessToken).digest("hex");
}

export interface GraphRequest {
  method: "GET" | "POST";
  url: string;
  /** A Page or user token, sent as `Authorization: OAuth <token>`. */
  token?: string;
  /** Adds appsecret_proof for `token` (default true; rupload takes none). */
  proof?: boolean;
  /** A JSON body (POST). */
  json?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface GraphClientOptions {
  fetch: typeof globalThis.fetch;
  /** Signs token calls with appsecret_proof; null leaves the proof out. */
  appSecret: string | null;
  timeoutMs?: number;
}

/** `GET /v26.0/123/media`: what an error message may say about a call (never the query). */
function describe(request: GraphRequest): string {
  const { pathname } = new URL(request.url);
  return `${request.method} ${pathname}`;
}

function errorMessage(call: string, status: number, error: z.output<typeof ErrorEnvelope>) {
  if ("error" in error) {
    const { message, code, error_subcode: subcode, error_user_msg: userMessage } = error.error;
    const codes = code === undefined ? "" : ` (#${code}${subcode ? `/${subcode}` : ""})`;
    const text = userMessage ?? message ?? "no message";
    return `Meta refused ${call}${codes}: ${text}`;
  }
  return `Meta refused ${call} (${status}): ${error.debug_info.message ?? "no message"}`;
}

function toApiError(call: string, status: number, body: unknown): GraphApiError | null {
  const parsed = ErrorEnvelope.safeParse(body);
  if (!parsed.success) return null;
  const envelope = parsed.data;
  if ("error" in envelope) {
    const error = envelope.error;
    return new GraphApiError(errorMessage(call, status, envelope), {
      status,
      code: error.code ?? null,
      subcode: error.error_subcode ?? null,
      type: error.type ?? null,
      transient: error.is_transient ?? false,
      userMessage: error.error_user_msg ?? null,
      fbtraceId: error.fbtrace_id ?? null,
    });
  }
  return new GraphApiError(errorMessage(call, status, envelope), {
    status,
    type: envelope.debug_info.type ?? null,
    transient: envelope.debug_info.retriable ?? false,
  });
}

export class GraphClient {
  readonly #options: GraphClientOptions;

  constructor(options: GraphClientOptions) {
    this.#options = options;
  }

  /** Sends the request and returns its JSON body parsed with `schema`; throws a GraphError. */
  async call<T extends z.ZodType>(request: GraphRequest, schema: T): Promise<z.output<T>> {
    const call = describe(request);
    const body = await this.#send(request, call);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
      throw new GraphResponseError(
        `Meta answered ${call} unexpectedly${where}: ${issue?.message ?? "invalid body"}`,
      );
    }
    return parsed.data;
  }

  async #send(request: GraphRequest, call: string): Promise<unknown> {
    const timeoutMs = this.#options.timeoutMs ?? META_DEFAULT_TIMEOUT_MS;
    const url = new URL(request.url);
    const headers: Record<string, string> = { Accept: "application/json", ...request.headers };
    if (request.token !== undefined) {
      headers.Authorization = `OAuth ${request.token}`;
      if ((request.proof ?? true) && this.#options.appSecret) {
        url.searchParams.set(
          "appsecret_proof",
          appSecretProof(request.token, this.#options.appSecret),
        );
      }
    }
    if (request.json) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.#options.fetch(url, {
        method: request.method,
        headers,
        ...(request.json ? { body: JSON.stringify(request.json) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new GraphTransportError(
        timedOut
          ? `Meta did not answer ${call} within ${timeoutMs} ms`
          : `Meta could not be reached for ${call}: ${error instanceof Error ? error.message : String(error)}`,
        { timedOut, cause: error },
      );
    }

    const text = await response.text().catch(() => "");
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = undefined;
    }
    if (response.ok) {
      if (body === undefined) {
        throw new GraphResponseError(`Meta answered ${call} with a body that isn't JSON`);
      }
      return body;
    }
    const apiError = toApiError(call, response.status, body);
    if (apiError) throw apiError;
    throw new GraphTransportError(`Meta answered ${call} with HTTP ${response.status}`, {
      status: response.status,
    });
  }
}
