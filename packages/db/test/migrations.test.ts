import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

/*
 * schema.prisma and the committed migrations must describe the same database. Phase 1 ships the
 * whole schema, but its tests only touch a few tables, so drift in a later phase's tables would
 * otherwise surface only when that phase queries a `migrate deploy`ed database. The global setup
 * has already deployed every migration into this suite's database.
 */

const run = promisify(execFile);
const dbUrl = inject("dbTestUrl");
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const PRISMA = path.join(PACKAGE_ROOT, "node_modules/.bin/prisma");
const SCHEMA = path.join(PACKAGE_ROOT, "prisma/schema.prisma");

/** `prisma migrate diff` from the migrated database to `schema`: 0 = same, 2 = drift. */
async function diffExitCode(schema: string): Promise<{ code: number; output: string }> {
  try {
    const { stdout } = await run(
      PRISMA,
      ["migrate", "diff", "--from-config-datasource", "--to-schema", schema, "--exit-code"],
      { cwd: PACKAGE_ROOT, env: { ...process.env, DATABASE_URL: dbUrl } },
    );
    return { code: 0, output: stdout };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}

describe("migrations", () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "enmo-schema-"));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("build exactly the database schema.prisma describes", async () => {
    const { code, output } = await diffExitCode(SCHEMA);
    expect(code, output).toBe(0);
  }, 60_000);

  it("would catch a schema change that has no migration", async () => {
    const drifted = path.join(scratch, "schema.prisma");
    const schema = await readFile(SCHEMA, "utf8");
    await writeFile(drifted, `${schema}\nmodel MigrationDriftProbe {\n  id String @id\n}\n`);
    const { code, output } = await diffExitCode(drifted);
    expect(code, output).toBe(2);
    expect(output).toContain("MigrationDriftProbe");
  }, 60_000);
});
