import { PrismaPg } from "@prisma/adapter-pg";
import type { PoolConfig } from "pg";
import { PrismaClient, type Prisma } from "./generated/client";

export * from "./generated/client";

export type DbClient = PrismaClient;
/** The client handed to `$transaction(async (tx) => …)` callbacks. */
export type DbTransaction = Prisma.TransactionClient;

export type PoolOptions = Omit<PoolConfig, "connectionString">;

export function createPrisma(url: string, pool: PoolOptions = {}): DbClient {
  return new PrismaClient({ adapter: new PrismaPg({ ...pool, connectionString: url }) });
}
