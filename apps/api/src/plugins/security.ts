import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { AppError, forbidden } from "../lib/errors";
import { redactUrl } from "../lib/logger";
import { ipRateLimitKey } from "../lib/trusted-proxies";

/*
 * CORS, CSRF and response-header posture (DESIGN §E).
 *
 * - CORS allows exactly APP_ORIGINS, with credentials.
 * - State-changing requests must come from an APP_ORIGINS Origin; with SameSite=Lax cookies that
 *   closes CSRF. A request body must be JSON: form and text bodies (the "simple" content types a
 *   cross-site form can send) are refused with 415 before they are read, and an empty JSON body is
 *   accepted so the web client can send `Content-Type: application/json` on every mutation.
 * - Every response carries a strict set of security headers; JSON is never cached by default.
 * - @fastify/rate-limit is registered with `global: false`; routes opt in via
 *   `config: { rateLimit: {…} }` or `app.createRateLimit()` (login: 10/min/IP, 5/min/email).
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  // The API serves JSON (and, later, image files): nothing it returns needs to run or be framed.
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "cross-origin-opener-policy": "same-origin",
  // Routes that serve cacheable content (e.g. stored files) override this.
  "cache-control": "no-store",
} as const;

const HSTS = "max-age=31536000; includeSubDomains";

export interface RateLimitRule {
  max: number;
  timeWindowMs: number;
  /** Defaults to the client IP (IPv6 grouped by /64). Runs as a preHandler, after validation. */
  keyGenerator?: (request: FastifyRequest) => string;
}

/** The plugin's own default keys on `request.ip`, which is the Cloudflare edge in production. */
const clientIpKey = (request: FastifyRequest) => ipRateLimitKey(request.clientIp);

/**
 * preHandler that counts the request against every rule and answers 429 (with Retry-After) once any
 * of them is exhausted. Unlike stacking `app.rateLimit()` handlers, every rule is always counted
 * (the plugin marks a request as handled after the first one). Each call gets its own in-memory
 * counters, scoped to this app instance. Call it from a route module (after this plugin loaded).
 */
export function rateLimitGuard(
  app: FastifyInstance,
  rules: readonly RateLimitRule[],
  message: (retryAfterSec: number) => string,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const limiters = rules.map(({ max, timeWindowMs, keyGenerator = clientIpKey }) =>
    app.createRateLimit({ max, timeWindow: timeWindowMs, keyGenerator }),
  );

  return async (request, reply) => {
    const results = await Promise.all(limiters.map((limit) => limit(request)));
    let retryAfterSec = 0;
    for (const result of results) {
      if (!result.isAllowed && result.isExceeded) {
        retryAfterSec = Math.max(retryAfterSec, result.ttlInSeconds, 1);
      }
    }
    if (retryAfterSec === 0) return;

    request.log.warn({ ip: request.clientIp, url: redactUrl(request.url) }, "rate limit exceeded");
    void reply.header("retry-after", String(retryAfterSec));
    throw new AppError("RATE_LIMITED", message(retryAfterSec), { details: { retryAfterSec } });
  };
}

function hasBody(request: FastifyRequest): boolean {
  const { "content-length": length, "transfer-encoding": encoding } = request.headers;
  return encoding !== undefined || (length !== undefined && length !== "0");
}

function isJsonContentType(contentType: string | undefined): boolean {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

export const securityPlugin = fp(
  async (app: FastifyInstance) => {
    const { APP_ORIGINS, NODE_ENV } = app.deps.config;
    const allowedOrigins = new Set(APP_ORIGINS);
    const headers: Record<string, string> =
      NODE_ENV === "production"
        ? { ...SECURITY_HEADERS, "strict-transport-security": HSTS }
        : { ...SECURITY_HEADERS };

    await app.register(cors, {
      origin: [...APP_ORIGINS],
      credentials: true,
      methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
      maxAge: 600,
    });
    await app.register(rateLimit, { global: false });

    app.removeContentTypeParser("text/plain");
    const parseJson = app.getDefaultJsonParser("error", "error");
    app.removeContentTypeParser("application/json");
    app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
      const text = typeof body === "string" ? body : body.toString("utf8");
      if (text === "") {
        done(null, undefined);
        return;
      }
      // The default parser is synchronous and reports through `done`.
      void parseJson(request, text, done);
    });

    app.addHook("onRequest", (request, reply, done) => {
      reply.headers(headers);
      if (SAFE_METHODS.has(request.method)) {
        done();
        return;
      }

      const { origin } = request.headers;
      if (origin === undefined || !allowedOrigins.has(origin)) {
        done(forbidden("Request origin not allowed"));
        return;
      }
      if (hasBody(request) && !isJsonContentType(request.headers["content-type"])) {
        done(
          new AppError("BAD_REQUEST", "Send the request body as JSON (application/json)", {
            status: 415,
          }),
        );
        return;
      }
      done();
    });
  },
  { name: "enmo-security", fastify: "5.x" },
);
