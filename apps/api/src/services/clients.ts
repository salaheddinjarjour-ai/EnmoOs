import { Prisma, type Client, type DbClient, type DbTransaction } from "@enmo/db";
import {
  ApprovalChain,
  AUDIT_ACTIONS,
  chainShortfalls,
  CLIENT_SLUG_MAX_LENGTH,
  describeShortfall,
  type ClientDto,
  slugify,
  VisualStyleTokens,
  type ClientListItem,
  type ClientListQuery,
  type CreateClientRequest,
  type KnownAuditAction,
  type UpdateApprovalChainRequest,
  type UpdateClientRequest,
} from "@enmo/shared";
import { conflict, notFound, unprocessable } from "../lib/errors";
import { parseStored } from "../lib/stored";
import { recordAudit } from "./audit";

/*
 * Clients (DESIGN §B "Clients", §E routes). Request bodies arrive already validated by the shared
 * schemas; this module adds what needs the database (unique slugs, an approval chain the current
 * team can complete, archive state) and writes an AuditLog row in the same transaction as each
 * change.
 */

/** Who is making a change, for AuditLog rows. */
export interface Actor {
  id: string;
  ip: string | null;
}

type Db = DbClient | DbTransaction;

/** AuditLog.entityType values, named after the Prisma models like services/audit.ts does. */
export const AUDITED_ENTITY = { client: "Client", socialAccount: "SocialAccount" } as const;
type AuditedEntity = (typeof AUDITED_ENTITY)[keyof typeof AUDITED_ENTITY];

export function auditChange(
  db: Db,
  actor: Actor,
  action: KnownAuditAction,
  entity: { type: AuditedEntity; id: string },
  data?: Prisma.InputJsonObject,
) {
  return recordAudit(db, {
    actorId: actor.id,
    ip: actor.ip,
    action,
    entityType: entity.type,
    entityId: entity.id,
    data,
  });
}

export function isPrismaError(error: unknown, code: "P2002" | "P2025"): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

// ── DTOs ────────────────────────────────────────────────────────────────────

export function toClientDto(row: Client): ClientDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    timezone: row.timezone,
    brandVoice: row.brandVoice,
    visualStyle: parseStored(VisualStyleTokens, row.visualStyle, `Client ${row.id}.visualStyle`),
    bannedWords: row.bannedWords,
    approvalChain: parseStored(ApprovalChain, row.approvalChain, `Client ${row.id}.approvalChain`),
    enabledPlatforms: row.enabledPlatforms,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Canonical banned-word list: NFKC (so full-width and ligature spellings match what the
 * banned-word matcher sees), trimmed, inner whitespace collapsed, empties dropped, and
 * de-duplicated case-insensitively keeping the first spelling.
 */
export function normalizeBannedWords(words: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of words) {
    const word = raw.normalize("NFKC").replace(/\s+/gu, " ").trim();
    const key = word.toLocaleLowerCase();
    if (word === "" || seen.has(key)) continue;
    seen.add(key);
    result.push(word);
  }
  return result;
}

/** Suffixes up to "-99999" keep every candidate within the prefix firstFreeSlug() queries. */
const MAX_SLUG_SUFFIX_LENGTH = 6;
const MAX_SLUG_ATTEMPTS = 5;

/** `base` for n = 1, otherwise `base-n`, truncated so the result stays a valid Slug. */
export function slugCandidate(base: string, n: number): string {
  if (n <= 1) return base;
  const suffix = `-${n}`;
  const stem = base.slice(0, CLIENT_SLUG_MAX_LENGTH - suffix.length).replace(/-+$/, "");
  return `${stem}${suffix}`;
}

// ── Queries ─────────────────────────────────────────────────────────────────

export async function listClients(db: DbClient, query: ClientListQuery): Promise<ClientListItem[]> {
  const rows = await db.client.findMany({
    where: query.includeArchived ? {} : { archivedAt: null },
    orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { name: "asc" }, { id: "asc" }],
    include: { _count: { select: { socialAccounts: true, campaigns: true, posts: true } } },
  });
  return rows.map(({ _count, ...row }) => ({ ...toClientDto(row), counts: _count }));
}

export async function getClient(db: DbClient, id: string): Promise<ClientDto> {
  const row = await db.client.findUnique({ where: { id } });
  if (!row) throw notFound("Client");
  return toClientDto(row);
}

/** 404 for an unknown client, 409 for an archived one (archived clients are read-only). */
export async function requireEditableClient(db: Db, id: string): Promise<void> {
  const row = await db.client.findUnique({ where: { id }, select: { archivedAt: true } });
  if (!row) throw notFound("Client");
  if (row.archivedAt) throw clientArchived();
}

// ── Mutations ───────────────────────────────────────────────────────────────

export async function createClient(
  db: DbClient,
  input: CreateClientRequest,
  actor: Actor,
): Promise<ClientDto> {
  await assertChainCompletable(db, input.approvalChain);
  const { slug: requestedSlug, bannedWords, ...fields } = input;

  // A concurrent create can take the slug between the lookup and the insert; look again.
  for (let attempt = 1; ; attempt++) {
    const slug = requestedSlug ?? (await firstFreeSlug(db, slugify(input.name)));
    try {
      return await db.$transaction(async (tx) => {
        const row = await tx.client.create({
          data: { ...fields, slug, bannedWords: normalizeBannedWords(bannedWords) },
        });
        await auditChange(tx, actor, AUDIT_ACTIONS.clientCreate, clientEntity(row.id), {
          name: row.name,
          slug: row.slug,
        });
        return toClientDto(row);
      });
    } catch (error) {
      if (!isPrismaError(error, "P2002")) throw error;
      if (requestedSlug !== undefined) throw slugTaken(requestedSlug);
      if (attempt >= MAX_SLUG_ATTEMPTS) throw conflict("Could not reserve a unique slug; retry");
    }
  }
}

/** PATCH semantics: only the fields present change; `visualStyle` replaces the stored tokens. */
export async function updateClient(
  db: DbClient,
  id: string,
  patch: UpdateClientRequest,
  actor: Actor,
): Promise<ClientDto> {
  const { bannedWords, ...fields } = patch;
  const data: Prisma.ClientUpdateInput = {
    ...fields,
    ...(bannedWords && { bannedWords: normalizeBannedWords(bannedWords) }),
  };
  try {
    return await db.$transaction(async (tx) => {
      await requireEditableClient(tx, id);
      const row = await updateUnarchived(tx, id, data);
      await auditChange(tx, actor, AUDIT_ACTIONS.clientUpdate, clientEntity(id), {
        fields: Object.entries(patch)
          .filter(([, value]) => value !== undefined)
          .map(([field]) => field),
      });
      return toClientDto(row);
    });
  } catch (error) {
    if (patch.slug !== undefined && isPrismaError(error, "P2002")) throw slugTaken(patch.slug);
    throw error;
  }
}

export async function replaceApprovalChain(
  db: DbClient,
  id: string,
  chain: UpdateApprovalChainRequest,
  actor: Actor,
): Promise<ClientDto> {
  return db.$transaction(async (tx) => {
    await requireEditableClient(tx, id);
    await assertChainCompletable(tx, chain);
    const row = await updateUnarchived(tx, id, { approvalChain: chain });
    await auditChange(tx, actor, AUDIT_ACTIONS.clientApprovalChain, clientEntity(id), chain);
    return toClientDto(row);
  });
}

/** Idempotent: archiving an archived client returns it unchanged and writes no audit row. */
export async function archiveClient(
  db: DbClient,
  id: string,
  actor: Actor,
  now: Date,
): Promise<ClientDto> {
  return db.$transaction(async (tx) => {
    const { count } = await tx.client.updateMany({
      where: { id, archivedAt: null },
      data: { archivedAt: now },
    });
    const row = await tx.client.findUnique({ where: { id } });
    if (!row) throw notFound("Client");
    if (count > 0) await auditChange(tx, actor, AUDIT_ACTIONS.clientArchive, clientEntity(id));
    return toClientDto(row);
  });
}

// ── Internals ───────────────────────────────────────────────────────────────

const clientEntity = (id: string) => ({ type: AUDITED_ENTITY.client, id });

const clientArchived = () => conflict("This client is archived and can no longer be changed");

const slugTaken = (slug: string) =>
  conflict(`The slug "${slug}" is already used by another client`, { field: "slug" });

/** Guards against an archive landing between requireEditableClient() and the write. */
async function updateUnarchived(
  tx: DbTransaction,
  id: string,
  data: Prisma.ClientUpdateInput,
): Promise<Client> {
  try {
    return await tx.client.update({ where: { id, archivedAt: null }, data });
  } catch (error) {
    if (isPrismaError(error, "P2025")) throw clientArchived();
    throw error;
  }
}

async function firstFreeSlug(db: Db, base: string): Promise<string> {
  // Every candidate up to the longest suffix starts with this prefix, so one query sees them all.
  const sharedPrefix = base.slice(0, CLIENT_SLUG_MAX_LENGTH - MAX_SLUG_SUFFIX_LENGTH);
  const rows = await db.client.findMany({
    where: { slug: { startsWith: sharedPrefix } },
    select: { slug: true },
  });
  const taken = new Set(rows.map((row) => row.slug));
  for (let n = 1; ; n++) {
    const candidate = slugCandidate(base, n);
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The schema has checked the chain's shape; against the current team, named approvers must be
 * real, active users and every step needs at least minApprovals active teammates who may decide
 * it. A step short of that could never complete (nobody decides a step twice), so every post for
 * the client would wait at it with nothing to publish.
 */
async function assertChainCompletable(db: Db, chain: ApprovalChain): Promise<void> {
  const named = [...new Set(chain.steps.flatMap((step) => step.approverUserIds))];
  const roles = [...new Set(chain.steps.flatMap((step) => step.approverRoles))];
  const team = await db.user.findMany({
    where: { isActive: true, OR: [{ id: { in: named } }, { role: { in: roles } }] },
    select: { id: true, role: true, isActive: true },
  });

  const activeIds = new Set(team.map((user) => user.id));
  const invalid = named.filter((id) => !activeIds.has(id));
  if (invalid.length > 0) {
    throw unprocessable("Approval chain names users who don't exist or are deactivated", {
      userIds: invalid,
    });
  }

  const shortfalls = chainShortfalls(chain, team);
  const [first] = shortfalls;
  if (first) {
    throw unprocessable(
      `Approval step ${first.step + 1} ("${first.name}") ${describeShortfall(first)}`,
      { steps: shortfalls },
    );
  }
}
