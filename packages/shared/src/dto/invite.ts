import { z } from "zod";
import { Role } from "../enums";
import { NewPassword } from "./auth";
import { Email, Id, IsoDateTime, UserRef, listResponse } from "./common";
import { PersonName } from "./user";

export const INVITE_TTL_DAYS = 7;

/** Web route that accepts an invite; the API returns it so the ADMIN can copy the link. */
export function inviteAcceptPath(token: string): string {
  return `/invite/${encodeURIComponent(token)}`;
}

export const InviteStatus = z.enum(["PENDING", "ACCEPTED", "REVOKED", "EXPIRED"]);
export type InviteStatus = z.infer<typeof InviteStatus>;

type DateLike = Date | string;

export function inviteStatus(
  invite: { acceptedAt: DateLike | null; revokedAt: DateLike | null; expiresAt: DateLike },
  now: Date = new Date(),
): InviteStatus {
  if (invite.revokedAt) return "REVOKED";
  if (invite.acceptedAt) return "ACCEPTED";
  return new Date(invite.expiresAt).getTime() <= now.getTime() ? "EXPIRED" : "PENDING";
}

export const InviteDto = z.object({
  id: Id,
  email: Email,
  role: Role,
  status: InviteStatus,
  invitedBy: UserRef,
  expiresAt: IsoDateTime,
  acceptedAt: IsoDateTime.nullable(),
  revokedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type InviteDto = z.infer<typeof InviteDto>;

/** POST /v1/invites */
export const CreateInviteRequest = z.object({
  email: Email,
  role: Role,
});
export type CreateInviteRequest = z.infer<typeof CreateInviteRequest>;

/** The raw token is only ever returned here; the database keeps its sha256. */
export const CreateInviteResponse = z.object({
  invite: InviteDto,
  token: z.string().min(1),
  acceptPath: z.string().startsWith("/invite/"),
});
export type CreateInviteResponse = z.infer<typeof CreateInviteResponse>;

/** GET /v1/invites */
export const InviteListResponse = listResponse(InviteDto);
export type InviteListResponse = z.infer<typeof InviteListResponse>;

export const InviteTokenParams = z.object({ token: z.string().min(1).max(256) });
export type InviteTokenParams = z.infer<typeof InviteTokenParams>;

/** GET /v1/invites/:token (public) — only valid, pending invites resolve. */
export const InvitePreviewResponse = z.object({
  email: Email,
  role: Role,
  expiresAt: IsoDateTime,
});
export type InvitePreviewResponse = z.infer<typeof InvitePreviewResponse>;

/** POST /v1/invites/:token/accept (public) → SessionResponse, and sets the session cookie. */
export const AcceptInviteRequest = z.object({
  name: PersonName,
  password: NewPassword,
});
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequest>;
