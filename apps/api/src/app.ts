import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyBaseLogger, type FastifyReply } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { Deps } from "./deps";
import { clientIpGetter, clientIpPolicy } from "./lib/trusted-proxies";
import { authPlugin } from "./plugins/auth";
import { errorsPlugin, toErrorResponse } from "./plugins/errors";
import { rbacPlugin } from "./plugins/rbac";
import { securityPlugin } from "./plugins/security";
import { registerRoutes } from "./routes/index";
import type { ApiApp } from "./types";

/** Builds the HTTP app without listening; server.ts listens, tests use `app.inject`. */
export async function buildApp(deps: Deps): Promise<ApiApp> {
  const logger: FastifyBaseLogger = deps.logger;
  const clientIp = clientIpPolicy(deps.config.TRUST_PROXY);
  const app: ApiApp = Fastify({
    loggerInstance: logger,
    trustProxy: clientIp.trustProxy,
    genReqId: () => randomUUID(),
    routerOptions: { ignoreTrailingSlash: true },
    // Errors the router raises before any route or hook runs (a malformed percent-encoding such as
    // /files/%zz, an over-long param) answer in the same { error } shape as everything else.
    frameworkErrors: (error, _request, reply) => {
      const { status, body } = toErrorResponse(error);
      // The option is generic over route types; outside any route the reply is a plain one.
      void (reply as unknown as FastifyReply).status(status).send(body);
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate("deps", deps);
  app.decorateRequest("clientIp", { getter: clientIpGetter(clientIp) });

  await app.register(errorsPlugin);
  await app.register(cookie);
  await app.register(securityPlugin);
  await app.register(authPlugin);
  await app.register(rbacPlugin);
  await registerRoutes(app);

  return app;
}
