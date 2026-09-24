import { createPrisma, type DbClient } from "@enmo/db";
import { truncateAllTables } from "@enmo/db/testing";

/*
 * The test file's own Prisma client, used by factories and assertions. The integration project
 * sets DATABASE_URL to the migrated test database (vitest.config.ts), and test/setup.ts truncates
 * every table before each test.
 */

let client: DbClient | undefined;

export function integrationDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is unset: run DB-backed tests through the vitest 'integration' project",
    );
  }
  return url;
}

export function testDb(): DbClient {
  return (client ??= createPrisma(integrationDatabaseUrl()));
}

/** TRUNCATE … RESTART IDENTITY CASCADE over every model table (migration history is kept). */
export async function truncateAll(): Promise<void> {
  await truncateAllTables(testDb());
}

export async function disconnectTestDb(): Promise<void> {
  const current = client;
  client = undefined;
  await current?.$disconnect();
}
