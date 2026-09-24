import type { DbClient, DbTransaction, Prisma } from "@enmo/db";
import {
  ApprovalChain,
  AUDIT_ACTIONS,
  chainShortfalls,
  Email,
  NewPassword,
  PersonName,
  can,
  capabilitiesFor,
  type Role,
  type SessionResponse,
  type TeamMember,
  type UpdateUserRequest,
  type UserDto,
} from "@enmo/shared";
import { hash, verify } from "@node-rs/argon2";
import { z } from "zod";
import { conflict, forbidden, notFound } from "../lib/errors";
import { randomToken } from "../lib/tokens";
import { AUDIT_ENTITY, recordAudit } from "./audit";
import { deleteUserSessions } from "./sessions";

/*
 * User accounts: DTO mapping, password hashing, ADMIN user management (DESIGN §E) and the two ways
 * an ADMIN is created without an invite (create-admin CLI, SEED_ADMIN_* on boot).
 */

type Db = DbClient | DbTransaction;

// ── Passwords ────────────────────────────────────────────────────────────────

/** argon2id (the @node-rs/argon2 default) with the library's OWASP-baseline cost parameters. */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/** False for a wrong password and for a malformed stored hash (never throws). */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same argon2 work as a real check, so a login for an unknown email takes as long as one
 * with a wrong password and response timing does not reveal which emails have accounts.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomToken());
  await verifyPassword(await dummyHash, password);
  return false;
}

// ── DTOs ─────────────────────────────────────────────────────────────────────

export const USER_DTO_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
} as const satisfies Prisma.UserSelect;

export type UserDtoRow = Prisma.UserGetPayload<{ select: typeof USER_DTO_SELECT }>;

export function toUserDto(user: UserDtoRow): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toSessionResponse(user: UserDtoRow): SessionResponse {
  return { user: toUserDto(user), capabilities: capabilitiesFor(user.role) };
}

// ── ADMIN user management ───────────────────────────────────────────────────

/** Every account, active or not, oldest first (the admin users screen). */
export async function listUsers(db: Db): Promise<UserDto[]> {
  const users = await db.user.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: USER_DTO_SELECT,
  });
  return users.map(toUserDto);
}

/** Every account by name, with only what teammates need to pick approvers (no emails). */
export function listTeamDirectory(db: Db): Promise<TeamMember[]> {
  return db.user.findMany({
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true, role: true, isActive: true },
  });
}

interface UserState {
  id: string;
  role: Role;
  isActive: boolean;
}

export interface UserChanges {
  role?: { from: Role; to: Role };
  isActive?: { from: boolean; to: boolean };
}

/**
 * The guard rails on PATCH /users/:id, as a pure function: nobody may demote or deactivate
 * themself, and the last active ADMIN can never be demoted or deactivated. Returns only the fields
 * that actually change (empty for a no-op request).
 */
export function planUserUpdate(input: {
  actorId: string;
  target: UserState;
  request: UpdateUserRequest;
  activeAdminCount: number;
}): UserChanges {
  const { actorId, target, request, activeAdminCount } = input;
  const role = request.role ?? target.role;
  const isActive = request.isActive ?? target.isActive;

  const changes: UserChanges = {};
  if (role !== target.role) changes.role = { from: target.role, to: role };
  if (isActive !== target.isActive) changes.isActive = { from: target.isActive, to: isActive };
  if (!changes.role && !changes.isActive) return changes;

  if (target.id === actorId) {
    throw conflict("You can't change your own role or deactivate yourself");
  }
  const losesAdmin = target.role === "ADMIN" && target.isActive && (role !== "ADMIN" || !isActive);
  if (losesAdmin && activeAdminCount <= 1) {
    throw conflict("There must always be at least one active admin");
  }
  return changes;
}

export interface UpdateUserContext {
  actorId: string;
  ip: string | null;
  now: Date;
}

/** Whether the account, in this state, may issue invites. */
const canInvite = (state: { role: Role; isActive: boolean }) =>
  state.isActive && can(state.role, "invites.manage");

/**
 * Applies a role/active change. A changed role or a deactivation signs the user out everywhere, so
 * their next request re-reads permissions (or fails), and an account that can no longer invite
 * loses its pending invites: otherwise an admin being offboarded could invite an address they
 * control and redeem it after deactivation. Runs under a lock on the active-admin rows so two
 * admins demoting each other at the same moment cannot leave the workspace without one.
 */
export async function updateUser(
  prisma: DbClient,
  userId: string,
  request: UpdateUserRequest,
  context: UpdateUserContext,
): Promise<UserDto> {
  return prisma.$transaction(async (tx) => {
    const activeAdmins = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "User" WHERE role = 'ADMIN' AND "isActive" = true FOR UPDATE`;

    // The actor was authorised before this transaction; make sure that still holds under the lock.
    const actor = await tx.user.findUnique({
      where: { id: context.actorId },
      select: { role: true, isActive: true },
    });
    if (!actor?.isActive || !can(actor.role, "users.manage")) throw forbidden();

    const target = await tx.user.findUnique({ where: { id: userId }, select: USER_DTO_SELECT });
    if (!target) throw notFound("User");

    const changes = planUserUpdate({
      actorId: context.actorId,
      target,
      request,
      activeAdminCount: activeAdmins.length,
    });
    if (!changes.role && !changes.isActive) return toUserDto(target);

    const updated = await tx.user.update({
      where: { id: userId },
      data: {
        ...(changes.role ? { role: changes.role.to } : {}),
        ...(changes.isActive ? { isActive: changes.isActive.to } : {}),
      },
      select: USER_DTO_SELECT,
    });
    const sessionsRevoked = await deleteUserSessions(tx, userId);
    const invitesRevoked =
      canInvite(target) && !canInvite(updated)
        ? { invitesRevoked: await revokePendingInvitesFrom(tx, userId, context.now) }
        : {};
    const stalled = await chainsStalledBy(tx, target);
    await recordAudit(tx, {
      actorId: context.actorId,
      action: AUDIT_ACTIONS.userUpdate,
      entityType: AUDIT_ENTITY.user,
      entityId: userId,
      data: {
        ...changes,
        sessionsRevoked,
        ...invitesRevoked,
        ...(stalled.length > 0 ? { approvalChainsStalled: stalled } : {}),
      },
      ip: context.ip,
    });
    return toUserDto(updated);
  });
}

/**
 * Active clients whose approval chain the change to `before` (a user as they were) left with steps
 * nobody can complete, and which steps. The change goes ahead (offboarding someone must never
 * wait on a chain); the audit row records the damage and the web Team screen shows it.
 */
async function chainsStalledBy(
  tx: DbTransaction,
  before: UserState,
): Promise<{ clientId: string; steps: number[] }[]> {
  const [clients, teamAfter] = await Promise.all([
    tx.client.findMany({ where: { archivedAt: null }, select: { id: true, approvalChain: true } }),
    tx.user.findMany({ select: { id: true, role: true, isActive: true } }),
  ]);
  const teamBefore = teamAfter.map((member) =>
    member.id === before.id ? { ...member, role: before.role, isActive: before.isActive } : member,
  );
  return clients.flatMap(({ id, approvalChain }) => {
    const chain = ApprovalChain.safeParse(approvalChain);
    if (!chain.success) return [];
    const already = new Set(chainShortfalls(chain.data, teamBefore).map(({ step }) => step));
    const steps = chainShortfalls(chain.data, teamAfter)
      .map(({ step }) => step)
      .filter((step) => !already.has(step));
    return steps.length > 0 ? [{ clientId: id, steps }] : [];
  });
}

/** Revokes the still-redeemable invites `userId` issued; returns their ids. */
async function revokePendingInvitesFrom(
  tx: DbTransaction,
  userId: string,
  now: Date,
): Promise<string[]> {
  const revoked = await tx.invite.updateManyAndReturn({
    where: { invitedById: userId, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
    data: { revokedAt: now },
    select: { id: true },
  });
  return revoked.map(({ id }) => id);
}

// ── Accounts created without an invite ──────────────────────────────────────

export const NewAdminInput = z.object({
  email: Email,
  password: NewPassword,
  name: PersonName.default("Admin"),
});
export type NewAdminInput = z.input<typeof NewAdminInput>;

type AdminSource = "cli" | "bootstrap";

async function insertAdmin(
  tx: DbTransaction,
  admin: { email: string; name: string; passwordHash: string },
  source: AdminSource,
): Promise<UserDto> {
  const user = await tx.user.create({
    data: { ...admin, role: "ADMIN" },
    select: USER_DTO_SELECT,
  });
  await recordAudit(tx, {
    actorId: null,
    action: AUDIT_ACTIONS.userCreate,
    entityType: AUDIT_ENTITY.user,
    entityId: user.id,
    data: { email: user.email, role: user.role, source },
  });
  return toUserDto(user);
}

/** Prisma P2002: a unique index rejected the write (typically a racing insert of the same email). */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

/** `create-admin`: adds an ADMIN even when other users exist; refuses an email already in use. */
export async function createAdminUser(prisma: DbClient, input: NewAdminInput): Promise<UserDto> {
  const { email, password, name } = NewAdminInput.parse(input);
  const passwordHash = await hashPassword(password);
  try {
    return await prisma.$transaction(async (tx) => {
      if (await tx.user.findUnique({ where: { email }, select: { id: true } })) {
        throw conflict(`A user with the email ${email} already exists`);
      }
      return insertAdmin(tx, { email, name, passwordHash }, "cli");
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict(`A user with the email ${email} already exists`);
    throw error;
  }
}

/**
 * Boot-time seed: creates the ADMIN only while the users table is empty. Safe to run on every boot
 * and from concurrent processes (a racing insert of the same email loses on the unique index).
 */
export async function createFirstAdmin(
  prisma: DbClient,
  input: NewAdminInput,
): Promise<UserDto | null> {
  if ((await prisma.user.count()) > 0) return null;

  const { email, password, name } = NewAdminInput.parse(input);
  const passwordHash = await hashPassword(password);
  try {
    return await prisma.$transaction(async (tx) => {
      if ((await tx.user.count()) > 0) return null;
      return insertAdmin(tx, { email, name, passwordHash }, "bootstrap");
    });
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}
