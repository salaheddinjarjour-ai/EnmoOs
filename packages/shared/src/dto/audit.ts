import { z } from "zod";
import { Id, IsoDateTime, UserRef } from "./common";

/** Well-known AuditLog.action values; the column is free text so later phases can add more. */
export const AUDIT_ACTIONS = {
  authLogin: "auth.login",
  authLoginFailed: "auth.login_failed",
  authLogout: "auth.logout",
  authPasswordChange: "auth.password_change",
  /** An account created outside the invite flow: the create-admin CLI or the SEED_ADMIN_* boot. */
  userCreate: "user.create",
  userInvite: "user.invite",
  userUpdate: "user.update",
  inviteRevoke: "invite.revoke",
  inviteAccept: "invite.accept",
  clientCreate: "client.create",
  clientUpdate: "client.update",
  clientApprovalChain: "client.approval_chain",
  clientArchive: "client.archive",
  socialAccountConnect: "social_account.connect",
  socialAccountDisconnect: "social_account.disconnect",
  socialAccountCheck: "social_account.check",
  planApprove: "plan.approve",
  approvalApproveAll: "approval.approve_all",
  publishReschedule: "publish.reschedule",
  publishCancel: "publish.cancel",
  publishRetry: "publish.retry",
} as const;
export type KnownAuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export const AuditLogDto = z.object({
  id: Id,
  actor: UserRef.nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  data: z.unknown().nullable(),
  ip: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type AuditLogDto = z.infer<typeof AuditLogDto>;

/** GET /v1/audit — newest first, keyset-paginated by id. */
export const AuditListQuery = z.object({
  action: z.string().max(100).optional(),
  entityType: z.string().max(100).optional(),
  entityId: z.string().max(100).optional(),
  actorId: Id.optional(),
  cursor: Id.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditListQuery = z.infer<typeof AuditListQuery>;

export const AuditListResponse = z.object({
  items: z.array(AuditLogDto),
  nextCursor: Id.nullable(),
});
export type AuditListResponse = z.infer<typeof AuditListResponse>;
