import type { DbClient } from "./index";

/*
 * Test-only helpers, exported as "@enmo/db/testing" so production bundles never pull them in.
 */

/** Empties every table except Prisma's migration history and resets identity sequences. */
export async function truncateAllTables(prisma: DbClient): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map(({ tablename }) => `"${tablename.replaceAll('"', '""')}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/** `postgresql://…/enmo_test` → `postgresql://…/<database>`, keeping credentials and params. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
