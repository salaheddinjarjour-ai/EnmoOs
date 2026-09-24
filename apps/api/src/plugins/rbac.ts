import { can, type Capability } from "@enmo/shared";
import type { FastifyInstance, FastifyRequest, RouteOptions } from "fastify";
import fp from "fastify-plugin";
import { AppError } from "../lib/errors";
import { authenticate, authenticateWithoutRefresh, currentUser } from "./auth";

/*
 * RBAC (DESIGN §E, matrix in @enmo/shared rbac.ts).
 *
 * Every route states who may call it, one of:
 *   onRequest: requireCap("clients.write")    capability check (implies a session)
 *   onRequest: authenticate                   any signed-in user
 *     (or authenticateWithoutRefresh, for a hijacked reply that can't re-issue the cookie)
 *   config: { public: true }                  no session (login, invite preview, health)
 * Guards are onRequest hooks so they decide before the body is parsed and validated: a caller
 * without a session gets 401 (and a role without the capability 403) whatever it sends, never a
 * 400 that describes the route's schema. The plugin refuses to boot if a route declares none of
 * these, or puts a guard in a later hook, so a forgotten guard can never ship as an open endpoint;
 * it records each declaration in `app.routeAccess` so the RBAC matrix test can compare it with the
 * expected table. `approvals.decide` is held by everyone: chain eligibility is checked per step by
 * the approvals service.
 */

/** What a route requires: nothing, any session, or a capability. */
export type RouteAccess = "public" | "session" | Capability;

export interface RouteAccessEntry {
  method: string;
  url: string;
  access: RouteAccess;
}

declare module "fastify" {
  interface FastifyContextConfig {
    /** Marks a route as reachable without a session. */
    public?: boolean;
  }
  interface FastifyInstance {
    /** Every route's declared access rule, in registration order (HEAD/OPTIONS omitted). */
    readonly routeAccess: readonly RouteAccessEntry[];
  }
}

type Guard = (request: FastifyRequest) => Promise<void>;

const guardAccess = new WeakMap<Guard, RouteAccess>([
  [authenticate, "session"],
  [authenticateWithoutRefresh, "session"],
]);

/** onRequest guard factory: 401 without a session, 403 when the role lacks `capability`. */
export function requireCap(capability: Capability): Guard {
  const guard: Guard = async (request) => {
    await authenticate(request);
    if (!can(currentUser(request).role, capability)) {
      throw new AppError("FORBIDDEN", "You don't have permission to do that", {
        details: { capability },
      });
    }
  };
  guardAccess.set(guard, capability);
  return guard;
}

/** The access rules of the guards among a route option's hook (or hooks). */
function guardsIn(hooks: unknown): RouteAccess[] {
  return [hooks]
    .flat()
    .map((hook) => (typeof hook === "function" ? guardAccess.get(hook as Guard) : undefined))
    .filter((access): access is RouteAccess => access !== undefined);
}

/** Guards in hooks that run after the body is parsed (they could answer 400 instead of 401). */
function misplacedGuards(route: RouteOptions): RouteAccess[] {
  return [route.preParsing, route.preValidation, route.preHandler].flatMap(guardsIn);
}

/** The strictest guard wins; `public` only counts when the route has no guard at all. */
function declaredAccess(route: RouteOptions): RouteAccess | null {
  const declared = guardsIn(route.onRequest);
  const capability = declared.find((access) => access !== "session");
  if (capability) return capability;
  if (declared.length > 0) return "session";
  return route.config?.public === true ? "public" : null;
}

export const rbacPlugin = fp(
  (app: FastifyInstance, _options, done) => {
    const entries: RouteAccessEntry[] = [];
    app.decorate("routeAccess", entries);

    app.addHook("onRoute", (route) => {
      // CORS preflights are answered by @fastify/cors before any guard could run.
      const methods = [route.method].flat().filter((method) => method !== "OPTIONS");
      if (methods.length === 0) return;

      if (misplacedGuards(route).length > 0) {
        throw new Error(
          `${methods.join(",")} ${route.url} runs an access guard after the request is parsed: ` +
            "declare it as onRequest: requireCap(…) or onRequest: authenticate",
        );
      }
      const access = declaredAccess(route);
      if (access === null) {
        throw new Error(
          `${methods.join(",")} ${route.url} declares no access rule: add onRequest: requireCap(…) ` +
            "or authenticate, or config: { public: true }",
        );
      }
      // Fastify's automatic HEAD twin of each GET carries the same guards; list the GET only.
      for (const method of methods) {
        if (method !== "HEAD") entries.push({ method, url: route.url, access });
      }
    });
    done();
  },
  { name: "enmo-rbac", fastify: "5.x", dependencies: ["enmo-auth"] },
);
