import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Deps } from "./deps";

/** The Fastify instance every plugin and route module receives (zod type provider). */
export type ApiApp = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

/**
 * A routes/<resource>.ts module. Register routes synchronously on `app`; routes/index.ts gives each
 * module its own encapsulated scope under /v1. Every route must declare its access rule (see
 * plugins/rbac.ts), e.g.
 *
 *   app.get("/clients", { onRequest: requireCap("clients.read"), schema: {…} }, handler)
 */
export type RouteModule = (app: ApiApp) => void | Promise<void>;

declare module "fastify" {
  interface FastifyInstance {
    deps: Deps;
  }
  interface FastifyRequest {
    /**
     * The client's address (lib/trusted-proxies.ts). Rate limits, sessions, audit rows and logs use
     * this, never `request.ip`, which in production is the Cloudflare edge that reached Render.
     */
    readonly clientIp: string;
  }
}
