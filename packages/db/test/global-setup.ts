import { execFileSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { withDatabase } from "../src/testing";

/*
 * DB-backed suites get their own database (not enmo_test) so they can truncate freely while the
 * API's integration tests run in parallel under turbo. Like the API suites, they use the local
 * services.sh Postgres when TEST_DATABASE_URL is unset: never skipped, so a missing database fails.
 */
const DATABASE = "enmo_test_dbpkg";
const LOCAL_TEST_DATABASE_URL = "postgresql://postgres@127.0.0.1:54329/enmo_test";
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");

declare module "vitest" {
  export interface ProvidedContext {
    dbTestUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<void> {
  const baseUrl = process.env.TEST_DATABASE_URL?.trim() || LOCAL_TEST_DATABASE_URL;

  const admin = new pg.Client({ connectionString: withDatabase(baseUrl, "postgres") });
  await admin.connect();
  try {
    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [DATABASE]);
    if (existing.rowCount === 0) await admin.query(`CREATE DATABASE "${DATABASE}"`);
  } finally {
    await admin.end();
  }

  const url = withDatabase(baseUrl, DATABASE);
  execFileSync(path.join(PACKAGE_ROOT, "node_modules/.bin/prisma"), ["migrate", "deploy"], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  project.provide("dbTestUrl", url);
}
