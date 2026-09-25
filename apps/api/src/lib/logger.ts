import { pino, type DestinationStream, type Logger } from "pino";

export type { Logger };

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const REDACTED = "[redacted]";

/** Never let credentials reach the logs, whatever a caller decides to log. */
const REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  'req.headers["x-enmo-edge-auth"]',
  'res.headers["set-cookie"]',
  "*.password",
  "*.passwordHash",
  "*.accessToken",
  "*.refreshToken",
  "*.token",
];

/*
 * Path segments that follow one of these are bearer secrets: the invite token is the whole
 * credential for GET /invites/:token and POST /invites/:token/accept (only its sha256 is stored).
 * DELETE /invites/:id is caught too, which costs nothing: the audit log has the id.
 */
const SECRET_PATH_PARENTS = new Set(["invites"]);

function redactQuery(query: string): string {
  return query
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const separator = pair.indexOf("=");
      return separator === -1 ? pair : `${pair.slice(0, separator)}=${REDACTED}`;
    })
    .join("&");
}

/**
 * A request URL that is safe to log: secret path segments are replaced, every query value is
 * dropped (OAuth `code`/`state` and anything like them) while parameter names stay for debugging,
 * and a fragment is removed.
 */
export function redactUrl(url: string): string {
  const withoutFragment = url.split("#", 1)[0] ?? "";
  const queryStart = withoutFragment.indexOf("?");
  const path = queryStart === -1 ? withoutFragment : withoutFragment.slice(0, queryStart);
  const segments = path.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const parent = segments[index - 1]?.toLowerCase() ?? "";
    if (SECRET_PATH_PARENTS.has(parent) && segments[index] !== "") segments[index] = REDACTED;
  }
  const redactedPath = segments.join("/");
  if (queryStart === -1) return redactedPath;
  const query = redactQuery(withoutFragment.slice(queryStart + 1));
  return query ? `${redactedPath}?${query}` : redactedPath;
}

interface LoggableRequest {
  method?: string;
  url?: string;
  host?: string;
  /** Fastify requests carry request.clientIp (app.ts); a plain object may only have `ip`. */
  clientIp?: string;
  ip?: string;
  socket?: { remotePort?: number } | null;
}

/**
 * Fastify logs `{ req: request }` for every incoming request and merges the logger's own `req`
 * serializer over its default one, whose raw `url` would put invite tokens in the logs.
 */
function serializeRequest(request: LoggableRequest) {
  return {
    method: request.method,
    url: typeof request.url === "string" ? redactUrl(request.url) : undefined,
    host: request.host,
    // eslint-disable-next-line no-restricted-properties -- a plain object may only have `ip`.
    remoteAddress: request.clientIp ?? request.ip,
    remotePort: request.socket?.remotePort,
  };
}

export interface LoggerOptions {
  level: LogLevel;
  name: string;
  /** Defaults to stdout; tests pass a stream to inspect what would be written. */
  destination?: DestinationStream;
}

export function createLogger({ level, name, destination }: LoggerOptions): Logger {
  const options = {
    name,
    level,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    serializers: { req: serializeRequest },
  };
  return destination ? pino(options, destination) : pino(options);
}
