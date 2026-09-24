import { parseArgs } from "node:util";
import { createPrisma } from "@enmo/db";
import { z } from "zod";
import { loadConfig } from "../config";
import { isAppError } from "../lib/errors";
import { createAdminUser, NewAdminInput } from "../services/users";

/*
 * `pnpm --filter @enmo/api create-admin --email <email> --password <password> [--name <name>]`
 * or, on a deployed box, `node apps/api/dist/create-admin.js …` (DESIGN §E "Bootstrap").
 * Creates an ADMIN even when other users exist, with a `user.create` audit row; refuses an email
 * that already has an account. Reads the same environment as the server (DATABASE_URL etc.).
 */

const USAGE =
  "Usage: pnpm --filter @enmo/api create-admin --email <email> --password <password> [--name <name>]";

class UsageError extends Error {}

function readFlags(args: string[]) {
  try {
    return parseArgs({
      args,
      options: {
        email: { type: "string" },
        password: { type: "string" },
        name: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function parseCommandLine(argv: string[]): NewAdminInput | "help" {
  // `pnpm create-admin -- --email …` forwards the separator; drop it.
  const values = readFlags(argv[0] === "--" ? argv.slice(1) : argv);
  if (values.help) return "help";

  const parsed = NewAdminInput.safeParse(values);
  if (!parsed.success) throw new UsageError(z.prettifyError(parsed.error));
  return { email: parsed.data.email, password: parsed.data.password, name: parsed.data.name };
}

async function main(): Promise<void> {
  const input = parseCommandLine(process.argv.slice(2));
  if (input === "help") {
    console.log(USAGE);
    return;
  }

  const config = loadConfig();
  const prisma = createPrisma(config.DATABASE_URL);
  try {
    const admin = await createAdminUser(prisma, input);
    console.log(`Created ADMIN ${admin.email} (${admin.id}).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n\n${USAGE}`);
  } else if (isAppError(error)) {
    console.error(error.message);
  } else {
    console.error("create-admin failed:", error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
