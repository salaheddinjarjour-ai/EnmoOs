import {
  AUDIT_ACTIONS,
  INVITE_TTL_DAYS,
  SESSION_COOKIE_NAME,
  capabilitiesFor,
  type CreateInviteResponse,
  type InviteDto,
  type InviteListResponse,
  type SessionResponse,
} from "@enmo/shared";
import { Writable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DAY_MS, MINUTE_MS } from "../../src/lib/clock";
import { createLogger } from "../../src/lib/logger";
import { sha256 } from "../../src/lib/tokens";
import { browserHeaders, buildTestApp, type TestApp } from "../helpers/app";
import { sessionCookieFor } from "../helpers/auth";
import { testDb } from "../helpers/db";
import { createUser, type TestUser } from "../helpers/factories";

/*
 * POST /invites · GET /invites · DELETE /invites/:id · GET /invites/:token (public)
 * · POST /invites/:token/accept (public) — DESIGN §E "Bootstrap".
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
  t.clock.set(Date.now());
  admin = await createUser({ role: "ADMIN", name: "Ada Admin" });
  adminCookie = await sessionCookieFor(admin, { now: t.clock.now(), ttlDays: 365 });
});

async function invite(email: string, role: "ADMIN" | "MANAGER" | "EDITOR" = "EDITOR") {
  const response = await t.app.inject({
    method: "POST",
    url: "/v1/invites",
    headers: browserHeaders(adminCookie),
    payload: { email, role },
  });
  if (response.statusCode !== 201) {
    throw new Error(`invite(${email}) failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<CreateInviteResponse>();
}

const preview = (token: string) =>
  t.app.inject({ method: "GET", url: `/v1/invites/${encodeURIComponent(token)}` });

const accept = (
  token: string,
  payload: object = { name: "Nour Editor", password: "a-long-enough-passphrase" },
) =>
  t.app.inject({
    method: "POST",
    url: `/v1/invites/${encodeURIComponent(token)}/accept`,
    headers: browserHeaders(),
    payload,
  });

const revoke = (id: string) =>
  t.app.inject({
    method: "DELETE",
    url: `/v1/invites/${id}`,
    headers: browserHeaders(adminCookie),
  });

async function listInvites(): Promise<InviteDto[]> {
  const response = await t.app.inject({
    method: "GET",
    url: "/v1/invites",
    headers: browserHeaders(adminCookie),
  });
  expect(response.statusCode).toBe(200);
  return response.json<InviteListResponse>().items;
}

describe("POST /v1/invites", () => {
  it("returns a one-time /invite/<token> link valid for 7 days and stores only its hash", async () => {
    const now = t.clock.now();
    const created = await invite("  New.Editor@Enmo.Test ", "MANAGER");

    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.acceptPath).toBe(`/invite/${created.token}`);
    expect(created.invite).toEqual({
      id: expect.any(String) as string,
      email: "new.editor@enmo.test",
      role: "MANAGER",
      status: "PENDING",
      invitedBy: { id: admin.id, name: "Ada Admin", email: admin.email },
      expiresAt: new Date(now.getTime() + INVITE_TTL_DAYS * DAY_MS).toISOString(),
      acceptedAt: null,
      revokedAt: null,
      createdAt: expect.any(String) as string,
    });

    const row = await testDb().invite.findUniqueOrThrow({ where: { id: created.invite.id } });
    expect(row.tokenHash).toBe(sha256(created.token));
    expect(JSON.stringify(row)).not.toContain(created.token);

    const [audit] = await testDb().auditLog.findMany({
      where: { action: AUDIT_ACTIONS.userInvite },
    });
    expect(audit).toMatchObject({
      actorId: admin.id,
      entityType: "Invite",
      entityId: created.invite.id,
      data: { email: "new.editor@enmo.test", role: "MANAGER", supersededInviteIds: [] },
    });
  });

  it("refuses an email that already has an account", async () => {
    const existing = await createUser();
    const response = await t.app.inject({
      method: "POST",
      url: "/v1/invites",
      headers: browserHeaders(adminCookie),
      payload: { email: existing.email.toUpperCase(), role: "EDITOR" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("revokes older pending invites for the same email", async () => {
    const first = await invite("twice@enmo.test", "EDITOR");
    const second = await invite("twice@enmo.test", "MANAGER");

    expect((await preview(first.token)).statusCode).toBe(404);
    expect((await preview(second.token)).statusCode).toBe(200);
    const statuses = Object.fromEntries((await listInvites()).map((i) => [i.id, i.status]));
    expect(statuses).toEqual({ [first.invite.id]: "REVOKED", [second.invite.id]: "PENDING" });

    const audits = await testDb().auditLog.findMany({
      where: { action: AUDIT_ACTIONS.userInvite, entityId: second.invite.id },
    });
    expect(audits[0]?.data).toMatchObject({ supersededInviteIds: [first.invite.id] });
  });

  it("validates the body", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/v1/invites",
      headers: browserHeaders(adminCookie),
      payload: { email: "nope", role: "OWNER" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /v1/invites", () => {
  it("lists every invite newest first with its current status", async () => {
    const accepted = await invite("accepted@enmo.test");
    expect((await accept(accepted.token)).statusCode).toBe(200);
    t.clock.advance(MINUTE_MS);
    const revoked = await invite("revoked@enmo.test");
    expect((await revoke(revoked.invite.id)).statusCode).toBe(204);
    t.clock.advance(MINUTE_MS);
    const expiring = await invite("expiring@enmo.test");
    t.clock.advance(MINUTE_MS);
    const pending = await invite("pending@enmo.test");

    // Past the "expiring" invite's deadline, but not yet past the "pending" one's.
    t.clock.advance(INVITE_TTL_DAYS * DAY_MS - MINUTE_MS / 2);
    const items = await listInvites();
    expect(items.map(({ email, status }) => ({ email, status }))).toEqual([
      { email: "pending@enmo.test", status: "PENDING" },
      { email: "expiring@enmo.test", status: "EXPIRED" },
      { email: "revoked@enmo.test", status: "REVOKED" },
      { email: "accepted@enmo.test", status: "ACCEPTED" },
    ]);
    expect(items.map(({ id }) => id)).toEqual([
      pending.invite.id,
      expiring.invite.id,
      revoked.invite.id,
      accepted.invite.id,
    ]);
  });
});

describe("GET /v1/invites/:token", () => {
  it("previews a pending invite without a session", async () => {
    const created = await invite("preview@enmo.test", "MANAGER");
    const response = await preview(created.token);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      email: "preview@enmo.test",
      role: "MANAGER",
      expiresAt: created.invite.expiresAt,
    });
  });

  it("answers the same 404 for unknown, expired, revoked and used links", async () => {
    const used = await invite("used@enmo.test");
    await accept(used.token);
    const revoked = await invite("revoked@enmo.test");
    await revoke(revoked.invite.id);
    const expired = await invite("expired@enmo.test");

    t.clock.advance(INVITE_TTL_DAYS * DAY_MS);
    for (const token of ["unknown-token", used.token, revoked.token, expired.token]) {
      const response = await preview(token);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: { code: "NOT_FOUND", message: "This invite link is invalid or has expired" },
      });
    }
  });
});

describe("POST /v1/invites/:token/accept", () => {
  it("creates the account with the invited role and signs it in", async () => {
    const created = await invite("joiner@enmo.test", "MANAGER");
    const now = t.clock.now();

    const response = await accept(created.token, {
      name: "  Joiner Person ",
      password: "a-long-enough-passphrase",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<SessionResponse>();
    expect(body).toEqual({
      user: {
        id: expect.any(String) as string,
        email: "joiner@enmo.test",
        name: "Joiner Person",
        role: "MANAGER",
        isActive: true,
        lastLoginAt: now.toISOString(),
        createdAt: expect.any(String) as string,
      },
      capabilities: capabilitiesFor("MANAGER"),
    });

    const cookie = response.cookies.find(({ name }) => name === SESSION_COOKIE_NAME);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
    const meResponse = await t.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie?.value ?? ""}` },
    });
    expect(meResponse.json<SessionResponse>().user.id).toBe(body.user.id);

    const stored = await testDb().invite.findUniqueOrThrow({ where: { id: created.invite.id } });
    expect(stored.acceptedAt).toEqual(now);

    const [audit] = await testDb().auditLog.findMany({
      where: { action: AUDIT_ACTIONS.inviteAccept },
    });
    expect(audit).toMatchObject({
      actorId: body.user.id,
      entityType: "Invite",
      entityId: created.invite.id,
      data: { userId: body.user.id, email: "joiner@enmo.test", role: "MANAGER" },
    });

    // The new password works for a normal sign-in.
    const login = await t.app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: browserHeaders(),
      payload: { email: "joiner@enmo.test", password: "a-long-enough-passphrase" },
    });
    expect(login.statusCode).toBe(200);
  });

  it("ends the session the browser already held, like a sign-in does", async () => {
    const created = await invite("second-account@enmo.test");
    const response = await t.app.inject({
      method: "POST",
      url: `/v1/invites/${encodeURIComponent(created.token)}/accept`,
      headers: browserHeaders(adminCookie),
      payload: { name: "Second Account", password: "a-long-enough-passphrase" },
    });
    expect(response.statusCode).toBe(200);

    // The admin's session row is gone rather than orphaned behind an overwritten cookie.
    expect(await testDb().session.count({ where: { userId: admin.id } })).toBe(0);
    const adminMe = await t.app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: adminCookie },
    });
    expect(adminMe.statusCode).toBe(401);
  });

  it("works exactly once, even for concurrent submissions", async () => {
    const created = await invite("once@enmo.test");
    const responses = await Promise.all([accept(created.token), accept(created.token)]);
    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 404]);
    expect(await testDb().user.count({ where: { email: "once@enmo.test" } })).toBe(1);

    expect((await accept(created.token)).statusCode).toBe(404);
  });

  it("enforces the password policy and a name", async () => {
    const created = await invite("policy@enmo.test");
    const short = await accept(created.token, { name: "Short", password: "elevenchars" });
    expect(short.statusCode).toBe(400);
    expect(short.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED", details: { issues: [{ path: "password" }] } },
    });
    expect(
      (await accept(created.token, { name: " ", password: "a-long-enough-passphrase" })).statusCode,
    ).toBe(400);

    // A rejected attempt does not consume the invite.
    expect((await preview(created.token)).statusCode).toBe(200);
  });

  it("refuses expired and revoked invites", async () => {
    const revoked = await invite("revoked@enmo.test");
    await revoke(revoked.invite.id);
    expect((await accept(revoked.token)).statusCode).toBe(404);

    const expiring = await invite("late@enmo.test");
    t.clock.advance(INVITE_TTL_DAYS * DAY_MS);
    expect((await accept(expiring.token)).statusCode).toBe(404);
    expect(
      await testDb().user.count({
        where: { email: { in: ["revoked@enmo.test", "late@enmo.test"] } },
      }),
    ).toBe(0);
  });

  it("refuses when an account was created for the email after the invite", async () => {
    const created = await invite("raced@enmo.test");
    await createUser({ email: "raced@enmo.test" });
    const response = await accept(created.token);
    expect(response.statusCode).toBe(409);
    // The whole acceptance rolled back, so the invite is still pending.
    const stored = await testDb().invite.findUniqueOrThrow({ where: { id: created.invite.id } });
    expect(stored.acceptedAt).toBeNull();
  });
});

describe("DELETE /v1/invites/:id", () => {
  it("revokes a pending invite and audits it", async () => {
    const created = await invite("bye@enmo.test");
    const response = await revoke(created.invite.id);
    expect(response.statusCode).toBe(204);
    expect((await preview(created.token)).statusCode).toBe(404);

    const [audit] = await testDb().auditLog.findMany({
      where: { action: AUDIT_ACTIONS.inviteRevoke },
    });
    expect(audit).toMatchObject({
      actorId: admin.id,
      entityType: "Invite",
      entityId: created.invite.id,
    });

    // Revoking again is a no-op.
    expect((await revoke(created.invite.id)).statusCode).toBe(204);
    expect(await testDb().auditLog.count({ where: { action: AUDIT_ACTIONS.inviteRevoke } })).toBe(
      1,
    );
  });

  it("cannot revoke an accepted invite, and 404s for unknown ids", async () => {
    const created = await invite("kept@enmo.test");
    await accept(created.token);
    const accepted = await revoke(created.invite.id);
    expect(accepted.statusCode).toBe(409);
    expect((await revoke("does-not-exist")).statusCode).toBe(404);
  });
});

describe("an issuer who can no longer invite", () => {
  it.each([
    ["deactivated", { isActive: false }],
    ["demoted", { role: "MANAGER" }],
  ])("loses their pending invites when %s", async (_label, change) => {
    const pending = await invite("pending-link@enmo.test", "ADMIN");
    const used = await invite("used-link@enmo.test");
    expect((await accept(used.token)).statusCode).toBe(200);
    const otherAdmin = await createUser({ role: "ADMIN" });
    const otherCookie = await sessionCookieFor(otherAdmin, { now: t.clock.now() });

    const response = await t.app.inject({
      method: "PATCH",
      url: `/v1/users/${admin.id}`,
      headers: browserHeaders(otherCookie),
      payload: change,
    });
    expect(response.statusCode).toBe(200);

    expect((await preview(pending.token)).statusCode).toBe(404);
    expect((await accept(pending.token)).statusCode).toBe(404);
    expect(await testDb().user.count({ where: { email: "pending-link@enmo.test" } })).toBe(0);
    const rows = await testDb().invite.findMany({
      where: { invitedById: admin.id },
      orderBy: { email: "asc" },
      select: { email: true, acceptedAt: true, revokedAt: true },
    });
    expect(rows).toEqual([
      { email: "pending-link@enmo.test", acceptedAt: null, revokedAt: t.clock.now() },
      { email: "used-link@enmo.test", acceptedAt: expect.any(Date) as Date, revokedAt: null },
    ]);
    const [audit] = await testDb().auditLog.findMany({
      where: { action: AUDIT_ACTIONS.userUpdate, entityId: admin.id },
    });
    expect(audit?.data).toMatchObject({ invitesRevoked: [pending.invite.id] });
  });

  it("refuses a link whose issuer lost the right outside PATCH /users", async () => {
    const created = await invite("stale-link@enmo.test");
    await testDb().user.update({ where: { id: admin.id }, data: { isActive: false } });

    expect((await preview(created.token)).statusCode).toBe(404);
    expect((await accept(created.token)).statusCode).toBe(404);
    expect(await testDb().user.count({ where: { email: "stale-link@enmo.test" } })).toBe(0);
  });
});

describe("request logs", () => {
  it("never contain the invite token, whatever the outcome", async () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString("utf8"));
        done();
      },
    });
    // Production logs at info (render.yaml), where Fastify records every incoming request URL.
    const logged = await buildTestApp({
      clock: t.clock,
      logger: createLogger({ level: "info", name: "enmo-api", destination }),
    });
    try {
      const created = await invite("logged@enmo.test");
      const token = encodeURIComponent(created.token);
      const requests = [
        { method: "GET", url: `/v1/invites/${token}` },
        { method: "POST", url: `/v1/invites/${token}/accept`, payload: { name: "" } },
        {
          method: "POST",
          url: `/v1/invites/${token}/accept`,
          payload: { name: "Logged Editor", password: "a-long-enough-passphrase" },
        },
        { method: "GET", url: `/v1/invites/${token}?again=${token}` },
      ] as const;
      const statuses = [];
      for (const request of requests) {
        const response = await logged.app.inject({ ...request, headers: browserHeaders() });
        statuses.push(response.statusCode);
      }
      expect(statuses).toEqual([200, 400, 200, 404]);

      const output = lines.join("");
      expect(output).toContain('"msg":"incoming request"');
      expect(output).toContain("/v1/invites/[redacted]/accept");
      expect(output).not.toContain(created.token);
      expect(output).not.toContain(token);
    } finally {
      await logged.close();
    }
  });
});
