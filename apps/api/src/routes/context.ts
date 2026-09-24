import type { FastifyRequest } from "fastify";
import { currentUser } from "../plugins/auth";
import { toServiceUser, type ServiceUser } from "../services/actor";

/** The signed-in user behind a guarded request, as services take it. */
export function serviceUserOf(request: FastifyRequest): ServiceUser {
  return toServiceUser(currentUser(request), request.clientIp || null);
}
