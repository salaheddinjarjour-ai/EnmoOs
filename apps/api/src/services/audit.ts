import type { DbClient, DbTransaction, Prisma } from "@enmo/db";
import type { AuditListQuery, AuditListResponse, AuditLogDto } from "@enmo/shared";

/*
 * AuditLog writes and the GET /v1/audit listing (DESIGN §B "System", §E). Writers pass the
 * transaction client when the audited change is transactional, so the row commits (or rolls back)
 * together with the change it describes.
 */

export const AUDIT_ENTITY = {
  user: "User",
  invite: "Invite",
} as const;

export interface AuditEntry {
  /** Null when nobody is signed in (e.g. a failed login, a boot-time seed). */
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  data?: Prisma.InputJsonObject;
  ip?: string | null;
}

export async function recordAudit(
  db: DbClient | DbTransaction,
  entry: AuditEntry,
): Promise<{ id: string }> {
  return db.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      ip: entry.ip ?? null,
      ...(entry.data === undefined ? {} : { data: entry.data }),
    },
    select: { id: true },
  });
}

const AUDIT_LOG_SELECT = {
  id: true,
  action: true,
  entityType: true,
  entityId: true,
  data: true,
  ip: true,
  createdAt: true,
  actor: { select: { id: true, name: true, email: true } },
} as const satisfies Prisma.AuditLogSelect;

type AuditLogRow = Prisma.AuditLogGetPayload<{ select: typeof AUDIT_LOG_SELECT }>;

function toAuditLogDto(row: AuditLogRow): AuditLogDto {
  return {
    id: row.id,
    actor: row.actor,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    data: row.data,
    ip: row.ip,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Newest first. `cursor` is the last id of the previous page; ids break createdAt ties. */
export async function listAuditLogs(
  db: DbClient,
  query: AuditListQuery,
): Promise<AuditListResponse> {
  const rows = await db.auditLog.findMany({
    where: {
      action: query.action,
      entityType: query.entityType,
      entityId: query.entityId,
      actorId: query.actorId,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    // One extra row tells us whether another page exists.
    take: query.limit + 1,
    select: AUDIT_LOG_SELECT,
  });
  const page = rows.slice(0, query.limit);
  return {
    items: page.map(toAuditLogDto),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}
