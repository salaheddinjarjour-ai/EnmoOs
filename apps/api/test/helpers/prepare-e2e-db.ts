import { createPrisma } from "@enmo/db";
import { truncateAllTables } from "@enmo/db/testing";
import { databaseName, prepareDatabase } from "./databases";

/*
 * Run by apps/web/playwright.config.ts before it starts the API: creates, migrates and empties the
 * browser-test database (DATABASE_URL, e.g. enmo_e2e) so every Playwright run starts clean and the
 * seed admin is recreated on boot.
 */

const url = process.env.DATABASE_URL;
if (!url) throw new Error("prepare-e2e-db: DATABASE_URL is not set");

await prepareDatabase(url);
const prisma = createPrisma(url);
try {
  await truncateAllTables(prisma);
} finally {
  await prisma.$disconnect();
}
console.log(`[e2e] database ${databaseName(url)} migrated and emptied`);
