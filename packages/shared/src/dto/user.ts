import { z } from "zod";
import { Role } from "../enums";
import { Email, Id, IsoDateTime, listResponse } from "./common";

export const PersonName = z.string().trim().min(1).max(120);

export const UserDto = z.object({
  id: Id,
  email: Email,
  name: z.string(),
  role: Role,
  isActive: z.boolean(),
  lastLoginAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type UserDto = z.infer<typeof UserDto>;

/** GET /v1/users */
export const UserListResponse = listResponse(UserDto);
export type UserListResponse = z.infer<typeof UserListResponse>;

/** A teammate as the rest of the team sees them: no email, no sign-in history. */
export const TeamMember = z.object({
  id: Id,
  name: z.string(),
  role: Role,
  isActive: z.boolean(),
});
export type TeamMember = z.infer<typeof TeamMember>;

/**
 * GET /v1/users/directory (clients.read): every account, deactivated ones included so approval
 * chains that still name them show a name rather than an id. Approval chains are edited by
 * clients.write holders, not only by admins, so they need the team without users.manage.
 */
export const TeamDirectoryResponse = listResponse(TeamMember);
export type TeamDirectoryResponse = z.infer<typeof TeamDirectoryResponse>;

/**
 * PATCH /v1/users/:id → UserDto. The API refuses to demote or deactivate the last active ADMIN,
 * or the caller themself.
 */
export const UpdateUserRequest = z
  .object({
    role: Role.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => body.role !== undefined || body.isActive !== undefined, {
    message: "Provide role and/or isActive",
  });
export type UpdateUserRequest = z.infer<typeof UpdateUserRequest>;
