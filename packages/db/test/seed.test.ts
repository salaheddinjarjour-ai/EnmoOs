import { verify } from "@node-rs/argon2";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { ApprovalChain, VisualStyleTokens } from "@enmo/shared";
import { createPrisma, type DbClient } from "../src";
import { seedAdmin, seedDemoClient, seedFromEnv } from "../src/seed";
import { truncateAllTables } from "../src/testing";

const dbUrl = inject("dbTestUrl");
const PASSWORD = "correct horse battery";

describe("seed", () => {
  let prisma: DbClient;

  beforeAll(() => {
    prisma = createPrisma(dbUrl);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await truncateAllTables(prisma);
  });

  it("does nothing when not configured", async () => {
    await expect(seedFromEnv(prisma, {})).resolves.toEqual({
      admin: "skipped:not-configured",
      demoClient: "skipped:not-requested",
    });
    expect(await prisma.user.count()).toBe(0);
  });

  it("refuses half a configuration", async () => {
    await expect(seedFromEnv(prisma, { SEED_ADMIN_EMAIL: "a@enmo.marketing" })).rejects.toThrow(
      /SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD/,
    );
  });

  it("creates the first ADMIN with an argon2id hash, exactly once", async () => {
    const env = { SEED_ADMIN_EMAIL: " Admin@Enmo.Marketing ", SEED_ADMIN_PASSWORD: PASSWORD };
    await expect(seedFromEnv(prisma, env)).resolves.toMatchObject({ admin: "created" });
    await expect(seedFromEnv(prisma, env)).resolves.toMatchObject({ admin: "skipped:users-exist" });

    const users = await prisma.user.findMany();
    expect(users).toHaveLength(1);
    const [admin] = users;
    expect(admin).toMatchObject({
      email: "admin@enmo.marketing",
      name: "Admin",
      role: "ADMIN",
      isActive: true,
    });
    expect(admin?.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(await verify(admin?.passwordHash ?? "", PASSWORD)).toBe(true);
  });

  it("never adds an admin once any user exists", async () => {
    await prisma.user.create({
      data: { email: "editor@enmo.marketing", name: "Ed", passwordHash: "x", role: "EDITOR" },
    });
    await expect(
      seedAdmin(prisma, { email: "admin@enmo.marketing", password: PASSWORD }),
    ).resolves.toBe("skipped:users-exist");
    expect(await prisma.user.count({ where: { role: "ADMIN" } })).toBe(0);
  });

  it("rejects a weak seed password", async () => {
    await expect(
      seedAdmin(prisma, { email: "admin@enmo.marketing", password: "short" }),
    ).rejects.toThrow();
    expect(await prisma.user.count()).toBe(0);
  });

  it("creates the demo client idempotently with valid style and chain JSON", async () => {
    await expect(seedDemoClient(prisma)).resolves.toBe("created");
    await expect(seedFromEnv(prisma, { SEED_DEMO: "true" })).resolves.toMatchObject({
      demoClient: "exists",
    });

    const client = await prisma.client.findUniqueOrThrow({ where: { slug: "qahwa-co" } });
    expect(client).toMatchObject({ name: "Qahwa Co", timezone: "Asia/Riyadh", archivedAt: null });
    expect(client.enabledPlatforms).toEqual(["INSTAGRAM", "FACEBOOK", "TIKTOK"]);
    expect(VisualStyleTokens.parse(client.visualStyle).palette.primary).toBe("#C8A27A");
    expect(ApprovalChain.parse(client.approvalChain).steps).toHaveLength(1);
    expect(await prisma.client.count()).toBe(1);
  });

  it("truncates every table and restarts identities", async () => {
    await prisma.realtimeEvent.create({ data: { channel: "global", type: "resync", payload: {} } });
    await seedDemoClient(prisma);
    await truncateAllTables(prisma);
    expect(await prisma.client.count()).toBe(0);
    const event = await prisma.realtimeEvent.create({
      data: { channel: "global", type: "resync", payload: {} },
    });
    expect(event.id).toBe(1n);
  });
});
