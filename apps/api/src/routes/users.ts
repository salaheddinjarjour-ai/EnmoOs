import {
  AuditListQuery,
  AuditListResponse,
  IdParams,
  TeamDirectoryResponse,
  UpdateUserRequest,
  UserDto,
  UserListResponse,
} from "@enmo/shared";
import { currentUser } from "../plugins/auth";
import { requireCap } from "../plugins/rbac";
import { listAuditLogs } from "../services/audit";
import { listTeamDirectory, listUsers, updateUser } from "../services/users";
import type { RouteModule } from "../types";

/*
 * ADMIN user management and the audit log (DESIGN §E):
 *   GET /users · PATCH /users/:id {role?, isActive?} · GET /audit
 * plus the read-only team directory approval-chain editors pick named approvers from:
 *   GET /users/directory (clients.read)
 */
export const usersRoutes: RouteModule = (app) => {
  app.get(
    "/users",
    { onRequest: requireCap("users.manage"), schema: { response: { 200: UserListResponse } } },
    async () => ({ items: await listUsers(app.deps.prisma) }),
  );

  app.get(
    "/users/directory",
    { onRequest: requireCap("clients.read"), schema: { response: { 200: TeamDirectoryResponse } } },
    async () => ({ items: await listTeamDirectory(app.deps.prisma) }),
  );

  app.patch(
    "/users/:id",
    {
      onRequest: requireCap("users.manage"),
      schema: { params: IdParams, body: UpdateUserRequest, response: { 200: UserDto } },
    },
    (request) =>
      updateUser(app.deps.prisma, request.params.id, request.body, {
        actorId: currentUser(request).id,
        ip: request.clientIp,
        now: app.deps.clock.now(),
      }),
  );

  app.get(
    "/audit",
    {
      onRequest: requireCap("audit.read"),
      schema: { querystring: AuditListQuery, response: { 200: AuditListResponse } },
    },
    (request) => listAuditLogs(app.deps.prisma, request.query),
  );
};
