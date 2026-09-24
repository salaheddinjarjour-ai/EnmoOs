import type { DbClient, Prisma } from "@enmo/db";
import {
  AUDIT_ACTIONS,
  can,
  INVITE_TTL_DAYS,
  inviteAcceptPath,
  inviteStatus,
  type AcceptInviteRequest,
  type CreateInviteRequest,
  type CreateInviteResponse,
  type InviteDto,
  type InvitePreviewResponse,
} from "@enmo/shared";
import type { Config } from "../config";
import { DAY_MS, type Clock } from "../lib/clock";
import { AppError, conflict, notFound } from "../lib/errors";
import { randomToken, sha256 } from "../lib/tokens";
import { AUDIT_ENTITY, recordAudit } from "./audit";
import type { LoginResult } from "./auth";
import { createSession, deleteSessionByToken, type RequestMeta } from "./sessions";
import { USER_DTO_SELECT, hashPassword, isUniqueViolation, toSessionResponse } from "./users";

/*
 * Invites (DESIGN §E "Bootstrap"). No email is sent: the ADMIN copies the one-time link
 * /invite/<token>, valid for INVITE_TTL_DAYS. Only sha256(token) is stored, so the link cannot be
 * recovered later; issuing a new invite for the same email revokes the older pending ones.
 */

export interface InviteDeps {
  prisma: DbClient;
  clock: Clock;
  config: Pick<Config, "SESSION_TTL_DAYS">;
}

export interface InviteActorContext {
  actorId: string;
  ip: string | null;
}

const INVITE_SELECT = {
  id: true,
  email: true,
  role: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
  createdAt: true,
  invitedBy: { select: { id: true, name: true, email: true } },
} as const satisfies Prisma.InviteSelect;

type InviteRow = Prisma.InviteGetPayload<{ select: typeof INVITE_SELECT }>;

export function toInviteDto(row: InviteRow, now: Date): InviteDto {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: inviteStatus(row, now),
    invitedBy: row.invitedBy,
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** One answer for unknown, expired, revoked and used links, so a token's history never leaks. */
const invalidInvite = () => new AppError("NOT_FOUND", "This invite link is invalid or has expired");

const accountExists = () => conflict("An account with this email already exists");

function pendingWhere(now: Date) {
  return {
    acceptedAt: null,
    revokedAt: null,
    expiresAt: { gt: now },
  } satisfies Prisma.InviteWhereInput;
}

export async function createInvite(
  deps: InviteDeps,
  input: CreateInviteRequest,
  context: InviteActorContext,
): Promise<CreateInviteResponse> {
  const { prisma, clock } = deps;
  const now = clock.now();
  const token = randomToken();

  return prisma.$transaction(async (tx) => {
    if (await tx.user.findUnique({ where: { email: input.email }, select: { id: true } })) {
      throw accountExists();
    }

    const superseded = await tx.invite.findMany({
      where: { email: input.email, ...pendingWhere(now) },
      select: { id: true },
    });
    const supersededInviteIds = superseded.map(({ id }) => id);
    if (supersededInviteIds.length > 0) {
      await tx.invite.updateMany({
        where: { id: { in: supersededInviteIds } },
        data: { revokedAt: now },
      });
    }

    const invite = await tx.invite.create({
      data: {
        email: input.email,
        role: input.role,
        tokenHash: sha256(token),
        invitedById: context.actorId,
        // From the injected clock, so createdAt and expiresAt are exactly INVITE_TTL_DAYS apart.
        createdAt: now,
        expiresAt: new Date(now.getTime() + INVITE_TTL_DAYS * DAY_MS),
      },
      select: INVITE_SELECT,
    });
    await recordAudit(tx, {
      actorId: context.actorId,
      action: AUDIT_ACTIONS.userInvite,
      entityType: AUDIT_ENTITY.invite,
      entityId: invite.id,
      data: { email: invite.email, role: invite.role, supersededInviteIds },
      ip: context.ip,
    });
    return { invite: toInviteDto(invite, now), token, acceptPath: inviteAcceptPath(token) };
  });
}

/** Every invite, newest first, with its status computed at `now`. */
export async function listInvites(deps: Omit<InviteDeps, "config">): Promise<InviteDto[]> {
  const now = deps.clock.now();
  const rows = await deps.prisma.invite.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: INVITE_SELECT,
  });
  return rows.map((row) => toInviteDto(row, now));
}

/** Idempotent for an already-revoked invite; an accepted one can no longer be revoked. */
export async function revokeInvite(
  deps: Omit<InviteDeps, "config">,
  inviteId: string,
  context: InviteActorContext,
): Promise<void> {
  const { prisma, clock } = deps;
  const now = clock.now();

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.invite.updateMany({
      where: { id: inviteId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    if (count === 0) {
      const invite = await tx.invite.findUnique({
        where: { id: inviteId },
        select: { acceptedAt: true },
      });
      if (!invite) throw notFound("Invite");
      if (invite.acceptedAt) throw conflict("This invite has already been accepted");
      return;
    }
    await recordAudit(tx, {
      actorId: context.actorId,
      action: AUDIT_ACTIONS.inviteRevoke,
      entityType: AUDIT_ENTITY.invite,
      entityId: inviteId,
      ip: context.ip,
    });
  });
}

/**
 * A redeemable invite: pending, and its issuer can still invite. Losing that right already revokes
 * the issuer's pending invites (services/users.ts); this backs it up at redemption time.
 */
async function findPendingInvite(prisma: DbClient, token: string, now: Date) {
  const invite = await prisma.invite.findUnique({
    where: { tokenHash: sha256(token) },
    select: {
      id: true,
      email: true,
      role: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      invitedBy: { select: { role: true, isActive: true } },
    },
  });
  if (!invite || inviteStatus(invite, now) !== "PENDING") throw invalidInvite();
  if (!invite.invitedBy.isActive || !can(invite.invitedBy.role, "invites.manage")) {
    throw invalidInvite();
  }
  return invite;
}

/** Public: what the accept page shows before the invitee picks a name and password. */
export async function previewInvite(
  deps: Omit<InviteDeps, "config">,
  token: string,
): Promise<InvitePreviewResponse> {
  const invite = await findPendingInvite(deps.prisma, token, deps.clock.now());
  return { email: invite.email, role: invite.role, expiresAt: invite.expiresAt.toISOString() };
}

/**
 * Public: consumes the invite, creates the account with the invited role and signs it in. The
 * conditional update on the invite row makes a link usable exactly once, even under concurrent
 * submissions. Like login, it ends the session the browser already held: its cookie is about to be
 * overwritten, after which nobody could sign that session out.
 */
export async function acceptInvite(
  deps: InviteDeps,
  token: string,
  input: AcceptInviteRequest,
  meta: RequestMeta,
  previousToken?: string,
): Promise<LoginResult> {
  const { prisma, clock, config } = deps;
  const now = clock.now();
  const invite = await findPendingInvite(prisma, token, now);
  const passwordHash = await hashPassword(input.password);

  try {
    return await prisma.$transaction(async (tx) => {
      const claimed = await tx.invite.updateMany({
        where: { id: invite.id, ...pendingWhere(now) },
        data: { acceptedAt: now },
      });
      if (claimed.count !== 1) throw invalidInvite();
      if (await tx.user.findUnique({ where: { email: invite.email }, select: { id: true } })) {
        throw accountExists();
      }

      const user = await tx.user.create({
        data: {
          email: invite.email,
          name: input.name,
          role: invite.role,
          passwordHash,
          lastLoginAt: now,
        },
        select: USER_DTO_SELECT,
      });
      if (previousToken) await deleteSessionByToken(tx, previousToken);
      const session = await createSession(tx, user.id, meta, {
        now,
        ttlDays: config.SESSION_TTL_DAYS,
      });
      await recordAudit(tx, {
        actorId: user.id,
        action: AUDIT_ACTIONS.inviteAccept,
        entityType: AUDIT_ENTITY.invite,
        entityId: invite.id,
        data: { userId: user.id, email: user.email, role: user.role, sessionId: session.id },
        ip: meta.ip,
      });
      return { session: toSessionResponse(user), token: session.token };
    });
  } catch (error) {
    // Another account with this email was created between our check and insert.
    if (isUniqueViolation(error)) throw accountExists();
    throw error;
  }
}
