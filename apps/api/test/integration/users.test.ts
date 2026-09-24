import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  AUDIT_ACTIONS,
  type AuditListResponse,
  type TeamDirectoryResponse,
  type UserDto,
  type UserListResponse,
} from "@enmo/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MINUTE_MS } from "../../src/lib/clock";
import { bootstrapSeedAdmin } from "../../src/services/bootstrap";
import { browserHeaders, buildTestApp, testConfig, type TestApp } from "../helpers/app";
import { loginAs, sessionCookieFor } from "../helpers/auth";
import { integrationDatabaseUrl, testDb } from "../helpers/db";
import { createClient, createUser, type TestUser } from "../helpers/factories";

/*
 * ADMIN user management (GET /users, PATCH /users/:id), GET /audit, and the two ways an ADMIN is
 * created without an invite: SEED_ADMIN_* on boot and the create-admin CLI (DESIGN §E).
 */

let t: TestApp;
let admin: TestUser;
let adminCookie: string;

beforeAll(async () => {
  t = await buildTestApp();
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  admin = await createUser({ role: "ADMIN" });
  adminCookie = await sessionCookieFor(admin, { now: t.clock.now() });
});

function patchUser(id: string, payload: object, cookie = adminCookie) {
  return t.app.inject({
    method: "PATCH",
    url: `/v1/users/${id}`,
    headers: browserHeaders(cookie),
    payload,
  });
}

const me = (cookie: string) =>
  t.app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie } });

describe("GET /v1/users", () => {
  it("lists every account, oldest first, without secrets", async () => {
    const editor = await createUser({ role: "EDITOR" });
    const inactive = await createUser({ role: "MANAGER", isActive: false });

    const response = await t.app.inject({
      method: "GET",
      url: "/v1/users",
      headers: browserHeaders(adminCookie),
    });
    expect(response.statusCode).toBe(200);
    const { items } = response.json<UserListResponse>();
    expect(items.map(({ id, role, isActive }) => ({ id, role, isActive }))).toEqual([
      { id: admin.id, role: "ADMIN", isActive: true },
      { id: editor.id, role: "EDITOR", isActive: true },
      { id: inactive.id, role: "MANAGER", isActive: false },
    ]);
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(
      ["createdAt", "email", "id", "isActive", "lastLoginAt", "name", "role"].sort(),
    );
    expect(response.body).not.toContain("argon2");
  });
});

describe("GET /v1/users/directory", () => {
  it("shows every role the whole team, by name, role and status only", async () => {
    const manager = await createUser({ role: "MANAGER", name: "Maha Manager" });
    const editor = await createUser({ role: "EDITOR", name: "Eli Editor" });
    const former = await createUser({ role: "MANAGER", name: "Faris Former", isActive: false });

    for (const viewer of [admin, manager, editor]) {
      const cookie = viewer === admin ? adminCookie : await sessionCookieFor(viewer);
      const response = await t.app.inject({
        method: "GET",
        url: "/v1/users/directory",
        headers: browserHeaders(cookie),
      });
      expect(response.statusCode, response.body).toBe(200);
      const { items } = response.json<TeamDirectoryResponse>();
      // By name: "Eli Editor", "Faris Former", "Maha Manager", "Test Admin …".
      expect(items).toEqual(
        [editor, former, manager, admin].map(({ id, name, role, isActive }) => ({
          id,
          name,
          role,
          isActive,
        })),
      );
      expect(response.body).not.toContain("@enmo.test");
      expect(response.body).not.toContain("argon2");
    }
  });

  it("requires a session", async () => {
    const response = await t.app.inject({ method: "GET", url: "/v1/users/directory" });
    expect(response.statusCode).toBe(401);
  });
});

describe("PATCH /v1/users/:id", () => {
  it("changes a role, signs the user out everywhere and audits the change", async () => {
    const editor = await createUser({ role: "EDITOR" });
    const cookie = await sessionCookieFor(editor, { now: t.clock.now() });
    await sessionCookieFor(editor, { now: t.clock.now() });

    const response = await patchUser(editor.id, { role: "MANAGER" });
    expect(response.statusCode).toBe(200);
    expect(response.json<UserDto>()).toMatchObject({
      id: editor.id,
      role: "MANAGER",
      isActive: true,
    });

    expect(await testDb().session.count({ where: { userId: editor.id } })).toBe(0);
    expect((await me(cookie)).statusCode).toBe(401);

    const [audit] = await testDb().auditLog.findMany({
      where: { action: AUDIT_ACTIONS.userUpdate },
    });
    expect(audit).toMatchObject({
      actorId: admin.id,
      entityType: "User",
      entityId: editor.id,
      ip: "127.0.0.1",
      data: { role: { from: "EDITOR", to: "MANAGER" }, sessionsRevoked: 2 },
    });

    // The new role applies at the next sign-in.
    const session = await loginAs(t.app, editor);
    expect((await me(session)).json()).toMatchObject({ user: { role: "MANAGER" } });
  });

  it("deactivates (ending sessions and blocking sign-in) and reactivates", async () => {
    const manager = await createUser({ role: "MANAGER" });
    const cookie = await loginAs(t.app, manager);

    const deactivated = await patchUser(manager.id, { isActive: false });
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json<UserDto>().isActive).toBe(false);
    expect((await me(cookie)).statusCode).toBe(401);
    expect(await testDb().session.count({ where: { userId: manager.id } })).toBe(0);

    const login = await t.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: browserHeaders(),
      payload: { email: manager.email, password: manager.password },
    });
    expect(login.statusCode).toBe(401);

    const [audit] = await testDb().auditLog.findMany({
      where: { action: AUDIT_ACTIONS.userUpdate },
    });
    expect(audit?.data).toEqual({ isActive: { from: true, to: false }, sessionsRevoked: 1 });

    expect((await patchUser(manager.id, { isActive: true })).statusCode).toBe(200);
    expect(await loginAs(t.app, manager)).toMatch(/^enmo_session=/);
  });

  it("still deactivates a chain's only eligible approver, recording the chains it stalls", async () => {
    const manager = await createUser({ role: "MANAGER" });
    const named = await createUser({ role: "EDITOR" });
    const managersOnly = await createClient({
      name: "Managers Only",
      approvalChain: {
        steps: [
          { name: "Admins", approverRoles: ["ADMIN"], approverUserIds: [], minApprovals: 1 },
          { name: "Managers", approverRoles: ["MANAGER"], approverUserIds: [], minApprovals: 1 },
        ],
      },
    });
    // Already stuck before the change, so not blamed on it; archived clients never count.
    await createClient({
      name: "Already Stuck",
      approvalChain: {
        steps: [
          { name: "Editors", approverRoles: ["EDITOR"], approverUserIds: [], minApprovals: 3 },
        ],
      },
    });
    await createClient({
      name: "Archived",
      archivedAt: new Date(),
      approvalChain: {
        steps: [{ name: "Named", approverRoles: [], approverUserIds: [named.id], minApprovals: 1 }],
      },
    });

    const response = await patchUser(manager.id, { isActive: false });
    expect(response.statusCode).toBe(200);
    const [audit] = await testDb().auditLog.findMany({
      where: { action: AUDIT_ACTIONS.userUpdate, entityId: manager.id },
    });
    expect(audit?.data).toMatchObject({
      approvalChainsStalled: [{ clientId: managersOnly.id, steps: [1] }],
    });

    // A change that stalls nothing records nothing extra.
    expect((await patchUser(named.id, { role: "MANAGER" })).statusCode).toBe(200);
    const [promoted] = await testDb().auditLog.findMany({
      where: { action: AUDIT_ACTIONS.userUpdate, entityId: named.id },
    });
    expect(promoted?.data).not.toHaveProperty("approvalChainsStalled");
  });

  it("treats an unchanged request as a no-op", async () => {
    const editor = await createUser({ role: "EDITOR" });
    const cookie = await sessionCookieFor(editor, { now: t.clock.now() });

    const response = await patchUser(editor.id, { role: "EDITOR", isActive: true });
    expect(response.statusCode).toBe(200);
    expect((await me(cookie)).statusCode).toBe(200);
    expect(await testDb().auditLog.count()).toBe(0);
  });

  it("never lets admins demote or deactivate themselves", async () => {
    for (const payload of [{ role: "MANAGER" }, { role: "EDITOR" }, { isActive: false }]) {
      const response = await patchUser(admin.id, payload);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: "CONFLICT" } });
    }
    expect((await patchUser(admin.id, { role: "ADMIN" })).statusCode).toBe(200);
    expect((await me(adminCookie)).statusCode).toBe(200);
  });

  it("keeps at least one active admin when two admins demote each other at once", async () => {
    const other = await createUser({ role: "ADMIN" });
    const otherCookie = await sessionCookieFor(other, { now: t.clock.now() });

    const responses = await Promise.all([
      patchUser(other.id, { role: "EDITOR" }, adminCookie),
      patchUser(admin.id, { isActive: false }, otherCookie),
    ]);
    // Exactly one wins. The other is refused either under the lock (403: its caller is no longer an
    // active admin) or, if the winner committed before it authenticated, because the winner's
    // role or status change deleted its caller's sessions (401). Which one depends on timing.
    const statuses = responses.map(({ statusCode }) => statusCode).sort();
    expect([
      [200, 401],
      [200, 403],
    ]).toContainEqual(statuses);
    expect(await testDb().user.count({ where: { role: "ADMIN", isActive: true } })).toBe(1);
  });

  it("allows demoting another admin while one remains", async () => {
    const other = await createUser({ role: "ADMIN" });
    expect((await patchUser(other.id, { role: "MANAGER" })).statusCode).toBe(200);
    // Now `admin` is the last one; nobody else holds users.manage to try, and they can't self-demote.
    expect((await patchUser(admin.id, { role: "MANAGER" })).statusCode).toBe(409);
  });

  it("404s for unknown users and 400s for an empty change", async () => {
    expect((await patchUser("no-such-user", { role: "EDITOR" })).statusCode).toBe(404);
    const empty = await patchUser(admin.id, {});
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  });
});

describe("GET /v1/audit", () => {
  async function seedAuditRows() {
    const start = t.clock.now().getTime();
    const rows = [
      { action: "auth.login", actorId: admin.id, entityId: admin.id },
      { action: "user.update", actorId: admin.id, entityId: "u1" },
      { action: "auth.login_failed", actorId: null, entityId: null },
      { action: "user.update", actorId: admin.id, entityId: "u2" },
      { action: "auth.login", actorId: admin.id, entityId: admin.id },
    ];
    for (const [index, row] of rows.entries()) {
      await testDb().auditLog.create({
        data: {
          ...row,
          entityType: "User",
          data: { index },
          ip: "10.0.0.1",
          createdAt: new Date(start + index * MINUTE_MS),
        },
      });
    }
  }

  const audit = (query = "") =>
    t.app.inject({ method: "GET", url: `/v1/audit${query}`, headers: browserHeaders(adminCookie) });

  it("lists entries newest first with their actor", async () => {
    await seedAuditRows();
    const response = await audit();
    expect(response.statusCode).toBe(200);
    const body = response.json<AuditListResponse>();
    expect(body.nextCursor).toBeNull();
    expect(body.items.map(({ data }) => data)).toEqual([
      { index: 4 },
      { index: 3 },
      { index: 2 },
      { index: 1 },
      { index: 0 },
    ]);
    expect(body.items[0]).toMatchObject({
      action: "auth.login",
      actor: { id: admin.id, name: admin.name, email: admin.email },
      entityType: "User",
      entityId: admin.id,
      ip: "10.0.0.1",
    });
    expect(body.items[2]?.actor).toBeNull();
  });

  it("filters and pages with a cursor", async () => {
    await seedAuditRows();
    const updates = (await audit("?action=user.update")).json<AuditListResponse>();
    expect(updates.items.map(({ entityId }) => entityId)).toEqual(["u2", "u1"]);
    const byEntity = (await audit("?entityType=User&entityId=u1")).json<AuditListResponse>();
    expect(byEntity.items).toHaveLength(1);
    const byActor = (await audit(`?actorId=${admin.id}`)).json<AuditListResponse>();
    expect(byActor.items).toHaveLength(4);

    const seen: unknown[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: AuditListResponse = (
        await audit(`?limit=2${cursor ? `&cursor=${cursor}` : ""}`)
      ).json<AuditListResponse>();
      seen.push(...page.items.map(({ data }) => data));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([{ index: 4 }, { index: 3 }, { index: 2 }, { index: 1 }, { index: 0 }]);
  });

  it("validates the limit", async () => {
    expect((await audit("?limit=0")).statusCode).toBe(400);
    expect((await audit("?limit=201")).statusCode).toBe(400);
  });
});

describe("bootstrapSeedAdmin", () => {
  const seedEnv = {
    SEED_ADMIN_EMAIL: "Founder@Enmo.Test",
    SEED_ADMIN_PASSWORD: "founder-passphrase-123",
    SEED_ADMIN_NAME: "Founder",
  };
  const bootDeps = (env = seedEnv) => ({
    config: testConfig(env),
    prisma: testDb(),
    logger: t.deps.logger,
  });

  it("creates the ADMIN on an empty database, once, with an audit row", async () => {
    await testDb().user.deleteMany();

    await Promise.all([bootstrapSeedAdmin(bootDeps()), bootstrapSeedAdmin(bootDeps())]);
    await bootstrapSeedAdmin(bootDeps());

    const users = await testDb().user.findMany();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      email: "founder@enmo.test",
      name: "Founder",
      role: "ADMIN",
      isActive: true,
    });
    expect(users[0]?.passwordHash).toMatch(/^\$argon2id\$/);
    const audits = await testDb().auditLog.findMany({
      where: { action: AUDIT_ACTIONS.userCreate },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: null,
      entityId: users[0]?.id,
      data: { email: "founder@enmo.test", role: "ADMIN", source: "bootstrap" },
    });

    const login = await t.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: browserHeaders(),
      payload: { email: "founder@enmo.test", password: "founder-passphrase-123" },
    });
    expect(login.statusCode).toBe(200);
  });

  it("does nothing once any user exists, or when not configured", async () => {
    await bootstrapSeedAdmin(bootDeps());
    await testDb().user.deleteMany();
    await bootstrapSeedAdmin({ config: testConfig(), prisma: testDb(), logger: t.deps.logger });
    expect(await testDb().user.count()).toBe(0);
    expect(await testDb().auditLog.count()).toBe(0);
  });
});

describe("create-admin CLI", () => {
  const API_ROOT = path.resolve(import.meta.dirname, "../..");
  const TSX = path.join(API_ROOT, "node_modules/.bin/tsx");

  async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await promisify(execFile)(
        TSX,
        ["src/scripts/create-admin.ts", ...args],
        {
          cwd: API_ROOT,
          // Only what the script needs: no developer-shell variables leak in.
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            NODE_ENV: "test",
            LOG_LEVEL: "silent",
            DATABASE_URL: integrationDatabaseUrl(),
          },
          timeout: 60_000,
        },
      );
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return {
        code: typeof failure.code === "number" ? failure.code : 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
      };
    }
  }

  it("creates an ADMIN even when other users exist, and refuses a taken email", async () => {
    const created = await run([
      "--",
      "--email",
      "Second.Admin@Enmo.Test",
      "--password",
      "second-admin-passphrase",
      "--name",
      "Second Admin",
    ]);
    expect(created.code).toBe(0);
    expect(created.stdout).toMatch(/Created ADMIN second\.admin@enmo\.test/);
    expect(created.stdout + created.stderr).not.toContain("second-admin-passphrase");

    const user = await testDb().user.findUniqueOrThrow({
      where: { email: "second.admin@enmo.test" },
    });
    expect(user).toMatchObject({ name: "Second Admin", role: "ADMIN", isActive: true });
    const [audit] = await testDb().auditLog.findMany({
      where: { action: AUDIT_ACTIONS.userCreate },
    });
    expect(audit?.data).toMatchObject({ source: "cli", email: "second.admin@enmo.test" });

    const duplicate = await run(["--email", admin.email, "--password", "whatever-long-password"]);
    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr).toMatch(/already exists/);
    expect(await testDb().user.count()).toBe(2);
  });

  it("explains its usage on bad input", async () => {
    const short = await run(["--email", "x@enmo.test", "--password", "short"]);
    expect(short.code).toBe(1);
    expect(short.stderr).toMatch(/12 characters/);
    expect(short.stderr).toMatch(/Usage: /);

    const unknown = await run(["--emial", "x@enmo.test"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/Usage: /);
  });
});
