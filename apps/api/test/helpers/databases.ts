import { execFileSync } from "node:child_process";
import path from "node:path";
import { withDatabase } from "@enmo/db/testing";
import pg from "pg";

/*
 * Database preparation shared by the vitest global setup (enmo_test) and the Playwright API server
 * (enmo_e2e): create the database if missing, then `prisma migrate deploy` from packages/db.
 */

export const LOCAL_TEST_DATABASE_URL = "postgresql://postgres@127.0.0.1:54329/enmo_test";
export const LOCAL_REDIS_URL = "redis://127.0.0.1:63799";

const DB_PACKAGE_ROOT = path.resolve(import.meta.dirname, "../../../../packages/db");

/**
 * TEST_DATABASE_URL (CI) or the local services.sh database. DATABASE_URL is deliberately ignored:
 * after `eval "$(scripts/services.sh env)"` it names enmo_dev, which the suites would wipe.
 */
export function testDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.TEST_DATABASE_URL?.trim() || LOCAL_TEST_DATABASE_URL;
}

export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

/** Suites truncate every table, so only databases named for testing are accepted. */
export function assertDisposableDatabase(url: string): void {
  const name = databaseName(url);
  if (!/(test|e2e)/.test(name)) {
    throw new Error(
      `Refusing to use database "${name}" for tests: its name must contain "test" or "e2e". ` +
        "Point TEST_DATABASE_URL at a disposable database.",
    );
  }
}

async function ensureDatabase(url: string): Promise<void> {
  const name = databaseName(url);
  const admin = new pg.Client({ connectionString: withDatabase(url, "postgres") });
  await admin.connect();
  try {
    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (existing.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
    }
  } finally {
    await admin.end();
  }
}

function migrateDeploy(url: string): void {
  try {
    execFileSync(path.join(DB_PACKAGE_ROOT, "node_modules/.bin/prisma"), ["migrate", "deploy"], {
      cwd: DB_PACKAGE_ROOT,
      env: { ...process.env, DATABASE_URL: url },
      stdio: "pipe",
    });
  } catch (error) {
    const output =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr)
        : String(error);
    throw new Error(`prisma migrate deploy failed for ${databaseName(url)}:\n${output}`);
  }
}

export async function prepareDatabase(url: string): Promise<void> {
  assertDisposableDatabase(url);
  await ensureDatabase(url);
  migrateDeploy(url);
}
