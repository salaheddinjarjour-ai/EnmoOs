import { PrismaPg } from "@prisma/adapter-pg";
import type { PoolConfig } from "pg";
import { PrismaClient, type Prisma } from "./generated/client";

export * from "./generated/client";

export type DbClient = PrismaClient;
/** The client handed to `$transaction(async (tx) => …)` callbacks. */
export type DbTransaction = Prisma.TransactionClient;

export type PoolOptions = Omit<PoolConfig, "connectionString">;

const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * Turns a DATABASE_URL into what the pg driver needs. Prisma's `?schema=` parameter comes off the
 * URL (the Prisma CLI reads it there itself; the runtime adapter takes it separately), which lets
 * ENMO live in its own schema of a database it shares (`…/db?schema=enmo`).
 */
export function splitSchema(url: string): { connectionString: string; schema: string | null } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { connectionString: url, schema: null };
  }
  // The pg driver reads sslmode=require as verify-full; Postgres (and the Prisma CLI, which runs
  // the migrations on the same URL) mean "encrypted, certificate not checked". Keep one meaning.
  const libpqSsl = parsed.searchParams.has("sslmode") && !parsed.searchParams.has("uselibpqcompat");
  const schema = parsed.searchParams.get("schema");
  if (schema === null && !libpqSsl) return { connectionString: url, schema: null };
  if (schema !== null && !SCHEMA_NAME.test(schema)) {
    throw new Error(`DATABASE_URL ?schema= must be a plain Postgres identifier, got "${schema}"`);
  }
  parsed.searchParams.delete("schema");
  if (libpqSsl) parsed.searchParams.set("uselibpqcompat", "true");
  return {
    connectionString: parsed.toString(),
    schema: schema === null || schema === "public" ? null : schema,
  };
}

export function createPrisma(url: string, pool: PoolOptions = {}): DbClient {
  const { connectionString, schema } = splitSchema(url);
  if (!schema) {
    return new PrismaClient({ adapter: new PrismaPg({ ...pool, connectionString }) });
  }
  // The adapter qualifies Prisma's own queries; search_path covers the raw SQL (locks, probes).
  return new PrismaClient({
    adapter: new PrismaPg(
      { ...pool, connectionString, options: `-c search_path=${schema}` },
      { schema },
    ),
  });
}
