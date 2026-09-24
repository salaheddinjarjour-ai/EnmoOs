import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hash } from "@node-rs/argon2";
import { CreateClientRequest, Email, NewPassword, PersonName, slugify } from "@enmo/shared";
import { createPrisma, type DbClient } from "./index";

/*
 * Idempotent bootstrap:
 *  - the first ADMIN, from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD, only while no user exists;
 *  - with SEED_DEMO=true, the demo client "Qahwa Co" (never overwritten once present).
 * Run with `pnpm db:seed`. The API's SEED_ADMIN_* boot hook has its own audited equivalent
 * (apps/api services/users.ts createFirstAdmin) with the same only-while-empty rule.
 */

export interface SeedAdminInput {
  email: string;
  password: string;
  name?: string;
}

export type SeedAdminResult = "created" | "skipped:users-exist";
export type SeedDemoResult = "created" | "exists";

/** argon2id with the library defaults (m=19456 KiB, t=2, p=1 — the OWASP baseline). */
export type PasswordHasher = (password: string) => Promise<string>;
const argon2id: PasswordHasher = (password) => hash(password);

export async function seedAdmin(
  prisma: DbClient,
  input: SeedAdminInput,
  hashPassword: PasswordHasher = argon2id,
): Promise<SeedAdminResult> {
  const email = Email.parse(input.email);
  const password = NewPassword.parse(input.password);
  const name = PersonName.parse(input.name?.trim() || "Admin");

  if ((await prisma.user.count()) > 0) return "skipped:users-exist";

  const passwordHash = await hashPassword(password);
  try {
    await prisma.user.create({ data: { email, name, passwordHash, role: "ADMIN" } });
  } catch (error) {
    // A concurrent boot created the same admin between our count and insert.
    if (isUniqueViolation(error)) return "skipped:users-exist";
    throw error;
  }
  return "created";
}

const DEMO_CLIENT = CreateClientRequest.parse({
  name: "Qahwa Co",
  timezone: "Asia/Riyadh",
  brandVoice:
    "Warm, confident and a little playful. Specialty coffee for people who care about the ritual. " +
    "Short sentences, sensory detail, no hype.",
  bannedWords: ["cheap", "instant", "guaranteed"],
  visualStyle: {
    palette: {
      primary: "#C8A27A",
      secondary: "#3B2A20",
      accent: "#E3B23C",
      background: "#0F0B08",
      text: "#F5F5F4",
    },
    keywords: ["warm", "cinematic", "close-up", "steam"],
    lighting: "Low golden-hour light with soft shadows",
    imagery: "Hands, cups and beans; shallow depth of field; no faces in close-up.",
    avoid: ["plastic cups", "cluttered backgrounds"],
  },
  enabledPlatforms: ["INSTAGRAM", "FACEBOOK", "TIKTOK"],
});

export async function seedDemoClient(prisma: DbClient): Promise<SeedDemoResult> {
  const slug = DEMO_CLIENT.slug ?? slugify(DEMO_CLIENT.name);
  if (await prisma.client.findUnique({ where: { slug }, select: { id: true } })) return "exists";
  try {
    await prisma.client.create({ data: { ...DEMO_CLIENT, slug } });
  } catch (error) {
    if (isUniqueViolation(error)) return "exists";
    throw error;
  }
  return "created";
}

export interface SeedEnvResult {
  admin: SeedAdminResult | "skipped:not-configured";
  demoClient: SeedDemoResult | "skipped:not-requested";
}

export async function seedFromEnv(
  prisma: DbClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SeedEnvResult> {
  const email = env.SEED_ADMIN_EMAIL?.trim();
  const password = env.SEED_ADMIN_PASSWORD;
  if (Boolean(email) !== Boolean(password)) {
    throw new Error("Set both SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD, or neither");
  }

  const admin =
    email && password
      ? await seedAdmin(prisma, { email, password, name: env.SEED_ADMIN_NAME })
      : "skipped:not-configured";
  const demoClient =
    env.SEED_DEMO === "true" ? await seedDemoClient(prisma) : "skipped:not-requested";
  return { admin, demoClient };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (see packages/db/.env.example)");
  const prisma = createPrisma(url);
  try {
    const result = await seedFromEnv(prisma);
    console.log(`[seed] admin: ${result.admin}; demo client: ${result.demoClient}`);
  } finally {
    await prisma.$disconnect();
  }
}

// Env comes from the caller (`tsx --env-file-if-exists=.env`, or `prisma db seed`, which has
// already loaded .env), so importing "@enmo/db/seed" has no side effects. The basename check
// matters once a bundler inlines this module: inside apps/api/dist/server.js, import.meta.url
// and argv[1] both name the bundle, and the seed CLI must not run on API boot.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  /^seed\.[cm]?[jt]s$/.test(path.basename(fileURLToPath(import.meta.url)));
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error("[seed] failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
