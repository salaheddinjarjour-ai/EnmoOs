import type { DbClient } from "@enmo/db";
import {
  AUDIT_ACTIONS,
  type ChangePasswordRequest,
  type LoginRequest,
  type SessionResponse,
} from "@enmo/shared";
import type { Config } from "../config";
import type { Clock } from "../lib/clock";
import { AppError, unauthenticated } from "../lib/errors";
import { AUDIT_ENTITY, recordAudit } from "./audit";
import {
  createSession,
  deleteSessionByToken,
  deleteUserSessions,
  type RequestMeta,
} from "./sessions";
import {
  USER_DTO_SELECT,
  hashPassword,
  toSessionResponse,
  verifyAgainstDummy,
  verifyPassword,
} from "./users";

/*
 * Sign-in, sign-out and password change (DESIGN §E). Every failed login gets the same generic 401
 * and an `auth.login_failed` audit row whose `reason` stays server-side.
 */

export interface AuthDeps {
  prisma: DbClient;
  clock: Clock;
  config: Pick<Config, "SESSION_TTL_DAYS">;
}

export const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password";

export type LoginFailureReason = "unknown_email" | "bad_password" | "inactive";

export interface LoginResult {
  session: SessionResponse;
  /** Raw cookie value for Set-Cookie. */
  token: string;
}

export async function login(
  deps: AuthDeps,
  input: LoginRequest,
  meta: RequestMeta,
  /** The session cookie the browser already held, if any; it is replaced, not kept alive. */
  previousToken?: string,
): Promise<LoginResult> {
  const { prisma, clock, config } = deps;
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true, passwordHash: true, isActive: true },
  });

  const passwordOk = user
    ? await verifyPassword(user.passwordHash, input.password)
    : await verifyAgainstDummy(input.password);
  if (!user || !passwordOk || !user.isActive) {
    const reason: LoginFailureReason = !user
      ? "unknown_email"
      : !passwordOk
        ? "bad_password"
        : "inactive";
    await recordAudit(prisma, {
      actorId: null,
      action: AUDIT_ACTIONS.authLoginFailed,
      entityType: AUDIT_ENTITY.user,
      entityId: user?.id ?? null,
      data: { email: input.email, reason },
      ip: meta.ip,
    });
    throw unauthenticated(INVALID_CREDENTIALS_MESSAGE);
  }

  const now = clock.now();
  return prisma.$transaction(async (tx) => {
    if (previousToken) await deleteSessionByToken(tx, previousToken);
    // Lapsed sessions are otherwise only removed when their token comes back, which may be never.
    await tx.session.deleteMany({ where: { userId: user.id, expiresAt: { lte: now } } });
    const session = await createSession(tx, user.id, meta, {
      now,
      ttlDays: config.SESSION_TTL_DAYS,
    });
    const updated = await tx.user.update({
      where: { id: user.id },
      data: { lastLoginAt: now },
      select: USER_DTO_SELECT,
    });
    await recordAudit(tx, {
      actorId: user.id,
      action: AUDIT_ACTIONS.authLogin,
      entityType: AUDIT_ENTITY.user,
      entityId: user.id,
      data: { sessionId: session.id },
      ip: meta.ip,
    });
    return { session: toSessionResponse(updated), token: session.token };
  });
}

/** Deletes the cookie's session row. Idempotent: an unknown or already-deleted token is a no-op. */
export async function logout(prisma: DbClient, token: string, meta: RequestMeta): Promise<void> {
  const session = await deleteSessionByToken(prisma, token);
  if (!session) return;
  await recordAudit(prisma, {
    actorId: session.userId,
    action: AUDIT_ACTIONS.authLogout,
    entityType: AUDIT_ENTITY.user,
    entityId: session.userId,
    data: { sessionId: session.id },
    ip: meta.ip,
  });
}

export async function currentSession(prisma: DbClient, userId: string): Promise<SessionResponse> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: USER_DTO_SELECT,
  });
  return toSessionResponse(user);
}

/**
 * Requires the current password. Signs the user out of every other session; the one making the
 * change stays signed in. A wrong current password is a field error (400), not a 401, because a
 * 401 tells the web client the session itself is gone.
 */
export async function changePassword(
  prisma: DbClient,
  actor: { id: string; sessionId: string },
  input: ChangePasswordRequest,
  meta: RequestMeta,
): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: actor.id },
    select: { passwordHash: true },
  });
  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    const message = "Current password is incorrect";
    throw new AppError("VALIDATION_FAILED", message, {
      details: { issues: [{ path: "currentPassword", message }] },
    });
  }

  const passwordHash = await hashPassword(input.newPassword);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: actor.id }, data: { passwordHash } });
    const otherSessionsRevoked = await deleteUserSessions(tx, actor.id, {
      exceptSessionId: actor.sessionId,
    });
    await recordAudit(tx, {
      actorId: actor.id,
      action: AUDIT_ACTIONS.authPasswordChange,
      entityType: AUDIT_ENTITY.user,
      entityId: actor.id,
      data: { otherSessionsRevoked },
      ip: meta.ip,
    });
  });
}
