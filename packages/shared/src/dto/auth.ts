import { z } from "zod";
import { Capability } from "../rbac";
import { Email } from "./common";
import { UserDto } from "./user";

export const SESSION_COOKIE_NAME = "enmo_session";
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/** A password being set (invite accept, password change). */
export const NewPassword = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH);

/** A password being checked; no length policy so old or wrong passwords still get a generic 401. */
const SubmittedPassword = z.string().min(1).max(PASSWORD_MAX_LENGTH);

/** POST /v1/auth/login */
export const LoginRequest = z.object({
  email: Email,
  password: SubmittedPassword,
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/** Returned by POST /auth/login, GET /auth/me and POST /invites/:token/accept. */
export const SessionResponse = z.object({
  user: UserDto,
  capabilities: z.array(Capability),
});
export type SessionResponse = z.infer<typeof SessionResponse>;

/** POST /v1/auth/password → 204 */
export const ChangePasswordRequest = z
  .object({
    currentPassword: SubmittedPassword,
    newPassword: NewPassword,
  })
  .refine((body) => body.newPassword !== body.currentPassword, {
    message: "The new password must differ from the current one",
    path: ["newPassword"],
  });
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;
