import type { Client } from "@enmo/db";
import { AUDIT_ACTIONS, type CreateSocialAccountInput, type SocialAccountDto } from "@enmo/shared";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_TOKEN_ENC_KEY } from "../../src/config";
import { createTokenCipher } from "../../src/lib/crypto";
import { DAY_MS } from "../../src/lib/clock";
import { browserHeaders, buildTestApp, type TestApp } from "../helpers/app";
import { sessionCookieFor, type CookieHeader } from "../helpers/auth";
import { testDb } from "../helpers/db";
import { createClient, createUser, type TestUser } from "../helpers/factories";
import { seedPublishPost } from "../helpers/publish-fixtures";

const ACCESS_TOKEN = "EAAG-access-token-that-must-never-leak";
const REFRESH_TOKEN = "refresh-token-that-must-never-leak";
const cipher = createTokenCipher(Buffer.from(TEST_TOKEN_ENC_KEY, "base64"));

let t: TestApp;
let admin: TestUser;
let client: Client;
let cookies: Record<"admin" | "manager" | "editor", CookieHeader>;

beforeAll(async () => {
  t = await buildTestApp();
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  // Tests move the clock forward; sessions below are issued against real time.
  t.clock.set(Date.now());
  admin = await createUser({ role: "ADMIN" });
  const manager = await createUser({ role: "MANAGER" });
  const editor = await createUser({ role: "EDITOR" });
  cookies = {
    admin: await sessionCookieFor(admin),
    manager: await sessionCookieFor(manager),
    editor: await sessionCookieFor(editor),
  };
  client = await createClient({ name: "Qahwa Co" });
});

type Method = NonNullable<InjectOptions["method"]>;

function send(method: Method, url: string, cookie?: CookieHeader, payload?: object) {
  return t.app.inject({ method, url, headers: browserHeaders(cookie), payload });
}

function accountInput(overrides: Partial<CreateSocialAccountInput> = {}): CreateSocialAccountInput {
  return {
    platform: "INSTAGRAM",
    externalId: "17841400000000001",
    handle: "qahwa.co",
    displayName: "Qahwa Co",
    accessToken: ACCESS_TOKEN,
    scopes: ["instagram_basic", "instagram_content_publish"],
    meta: { igUserId: "17841400000000001", pageId: "1000001", username: "qahwa.co" },
    ...overrides,
  };
}

async function connect(
  overrides: Partial<CreateSocialAccountInput> = {},
  clientId = client.id,
): Promise<SocialAccountDto> {
  const response = await send(
    "POST",
    `/v1/clients/${clientId}/social-accounts`,
    cookies.admin,
    accountInput(overrides),
  );
  expect(response.statusCode, response.body).toBe(201);
  return response.json<SocialAccountDto>();
}

function expectNoTokens(body: string): void {
  expect(body).not.toContain(ACCESS_TOKEN);
  expect(body).not.toContain(REFRESH_TOKEN);
  expect(body).not.toMatch(/tokenEnc|accessToken|refreshToken|"v1:/);
}

describe("access control", () => {
  it("lets every role list accounts but only admins manage them", async () => {
    const account = await connect();

    for (const cookie of Object.values(cookies)) {
      const list = await send("GET", `/v1/clients/${client.id}/social-accounts`, cookie);
      expect(list.statusCode).toBe(200);
    }

    for (const cookie of [cookies.manager, cookies.editor]) {
      const writes = await Promise.all([
        send(
          "POST",
          `/v1/clients/${client.id}/social-accounts`,
          cookie,
          accountInput({ externalId: "x" }),
        ),
        send("DELETE", `/v1/social-accounts/${account.id}`, cookie),
        send("POST", `/v1/social-accounts/${account.id}/check`, cookie),
      ]);
      expect(writes.map((response) => response.statusCode)).toEqual([403, 403, 403]);
    }
    expect(await testDb().socialAccount.count()).toBe(1);
  });

  it("requires a session", async () => {
    const response = await send("GET", `/v1/clients/${client.id}/social-accounts`);
    expect(response.statusCode).toBe(401);
  });
});

describe("POST /v1/clients/:id/social-accounts", () => {
  it("stores tokens encrypted and never returns them", async () => {
    const tokenExpiresAt = new Date(t.clock.now().getTime() + 60 * DAY_MS).toISOString();
    const response = await send(
      "POST",
      `/v1/clients/${client.id}/social-accounts`,
      cookies.admin,
      accountInput({ refreshToken: REFRESH_TOKEN, tokenExpiresAt }),
    );
    expect(response.statusCode).toBe(201);
    expectNoTokens(response.body);

    const account = response.json<SocialAccountDto>();
    const { id, createdAt, updatedAt, ...fields } = account;
    expect(fields).toEqual({
      clientId: client.id,
      platform: "INSTAGRAM",
      externalId: "17841400000000001",
      handle: "qahwa.co",
      displayName: "Qahwa Co",
      status: "ACTIVE",
      // The client's only Instagram account: the one it publishes through.
      isPrimary: true,
      scopes: ["instagram_basic", "instagram_content_publish"],
      meta: { igUserId: "17841400000000001", pageId: "1000001", username: "qahwa.co" },
      tokenExpiresAt,
      refreshExpiresAt: null,
      lastCheckedAt: null,
      connectedById: admin.id,
    });
    expect(id).toMatch(/\S/);
    expect(new Date(createdAt).toISOString()).toBe(createdAt);
    expect(new Date(updatedAt).toISOString()).toBe(updatedAt);

    const row = await testDb().socialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(row.accessTokenEnc).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(row.accessTokenEnc).not.toContain(ACCESS_TOKEN);
    expect(cipher.decrypt(row.accessTokenEnc)).toBe(ACCESS_TOKEN);
    expect(cipher.decrypt(row.refreshTokenEnc ?? "")).toBe(REFRESH_TOKEN);

    const [audit] = await testDb().auditLog.findMany({
      where: { action: AUDIT_ACTIONS.socialAccountConnect },
    });
    expect(audit).toMatchObject({
      actorId: admin.id,
      entityType: "SocialAccount",
      entityId: account.id,
      data: { clientId: client.id, platform: "INSTAGRAM", externalId: "17841400000000001" },
    });
    expectNoTokens(JSON.stringify(audit));
  });

  it("marks an already-expired, unrefreshable token as EXPIRED", async () => {
    const account = await connect({
      tokenExpiresAt: new Date(t.clock.now().getTime() - 1000).toISOString(),
    });
    expect(account.status).toBe("EXPIRED");
  });

  it("refuses a second connection of the same platform account", async () => {
    const first = await connect();
    const otherClient = await createClient({ name: "Other Co" });

    for (const clientId of [client.id, otherClient.id]) {
      const response = await send(
        "POST",
        `/v1/clients/${clientId}/social-accounts`,
        cookies.admin,
        accountInput({ handle: "someone-else" }),
      );
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: "CONFLICT", details: { socialAccountId: first.id, clientId: client.id } },
      });
    }

    // The same external id on another platform is a different account.
    await connect({ platform: "FACEBOOK" });
    expect(await testDb().socialAccount.count()).toBe(2);
  });

  it("returns 409 when two connects race", async () => {
    const responses = await Promise.all(
      [1, 2, 3].map(() =>
        send("POST", `/v1/clients/${client.id}/social-accounts`, cookies.admin, accountInput()),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409, 409]);
  });

  it("rejects unknown and archived clients", async () => {
    const unknown = await send(
      "POST",
      "/v1/clients/nope/social-accounts",
      cookies.admin,
      accountInput(),
    );
    expect(unknown.statusCode).toBe(404);

    const archived = await createClient({ name: "Old Co", archivedAt: new Date() });
    const response = await send(
      "POST",
      `/v1/clients/${archived.id}/social-accounts`,
      cookies.admin,
      accountInput(),
    );
    expect(response.statusCode).toBe(409);
    expect(await testDb().socialAccount.count()).toBe(0);
  });

  it.each([
    ["no access token", { accessToken: "" }],
    ["an unknown platform", { platform: "MYSPACE" }],
    ["a blank handle", { handle: "  " }],
    ["a malformed expiry", { tokenExpiresAt: "tomorrow" }],
  ])("rejects %s", async (_label, overrides) => {
    const response = await send("POST", `/v1/clients/${client.id}/social-accounts`, cookies.admin, {
      ...accountInput(),
      ...overrides,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  });
});

describe("GET /v1/clients/:id/social-accounts", () => {
  it("lists the client's accounts without any token fields", async () => {
    await connect({
      platform: "TIKTOK",
      externalId: "tt-1",
      handle: "qahwa",
      refreshToken: REFRESH_TOKEN,
    });
    await connect({ platform: "INSTAGRAM", externalId: "ig-1", handle: "qahwa.co" });
    const otherClient = await createClient({ name: "Other Co" });
    await connect({ externalId: "ig-other" }, otherClient.id);

    const response = await send("GET", `/v1/clients/${client.id}/social-accounts`, cookies.editor);
    expect(response.statusCode).toBe(200);
    expectNoTokens(response.body);
    const { items } = response.json<{ items: SocialAccountDto[] }>();
    expect(items.map((item) => [item.platform, item.externalId])).toEqual([
      ["INSTAGRAM", "ig-1"],
      ["TIKTOK", "tt-1"],
    ]);
  });

  it("returns 404 for an unknown client", async () => {
    const response = await send("GET", "/v1/clients/nope/social-accounts", cookies.editor);
    expect(response.statusCode).toBe(404);
  });
});

describe("DELETE /v1/social-accounts/:id", () => {
  it("disconnects the account and records who did it", async () => {
    const account = await connect();

    const response = await send("DELETE", `/v1/social-accounts/${account.id}`, cookies.admin);
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(await testDb().socialAccount.count()).toBe(0);

    const [audit] = await testDb().auditLog.findMany({
      where: { action: AUDIT_ACTIONS.socialAccountDisconnect },
    });
    expect(audit).toMatchObject({
      actorId: admin.id,
      entityId: account.id,
      data: { clientId: client.id, platform: "INSTAGRAM", handle: "qahwa.co" },
    });

    const again = await send("DELETE", `/v1/social-accounts/${account.id}`, cookies.admin);
    expect(again.statusCode).toBe(404);
  });

  it("accepts the empty JSON body the web client sends", async () => {
    const account = await connect();
    const response = await t.app.inject({
      method: "DELETE",
      url: `/v1/social-accounts/${account.id}`,
      headers: { ...browserHeaders(cookies.admin), "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(204);
  });
});

describe("the account a client publishes through", () => {
  const primaryOf = async (platform: "INSTAGRAM" | "FACEBOOK" = "INSTAGRAM") =>
    (
      await testDb().socialAccount.findMany({
        where: { clientId: client.id, platform, isPrimary: true },
        select: { id: true },
      })
    ).map((row) => row.id);

  it("is a client's only account on the platform; with a second, it stays until an admin chooses", async () => {
    const first = await connect();
    expect(first.isPrimary).toBe(true);
    const second = await connect({ externalId: "17841400000000002", handle: "qahwa.events" });
    expect(second.isPrimary).toBe(false);
    // Another platform is chosen for on its own.
    expect((await connect({ platform: "FACEBOOK", externalId: "1000001" })).isPrimary).toBe(true);
    expect(await primaryOf()).toEqual([first.id]);
  });

  it("switches to the account an admin picks, moving the posts waiting to go out; audited", async () => {
    const first = await connect();
    const second = await connect({ externalId: "17841400000000002", handle: "qahwa.events" });
    const { jobs } = await seedPublishPost({
      createdBy: admin,
      client,
      platforms: ["INSTAGRAM"],
      jobs: [
        {
          platform: "INSTAGRAM",
          scheduledFor: new Date(t.clock.now().getTime() + DAY_MS),
          dryRun: false,
          socialAccountId: first.id,
        },
      ],
    });
    const out = await seedPublishPost({
      createdBy: admin,
      client,
      ref: "p2",
      platforms: ["INSTAGRAM"],
      status: "LIVE",
      jobs: [
        {
          platform: "INSTAGRAM",
          status: "PUBLISHED",
          scheduledFor: t.clock.now(),
          dryRun: false,
          socialAccountId: first.id,
        },
      ],
    });

    for (const cookie of [cookies.manager, cookies.editor]) {
      const refused = await send("POST", `/v1/social-accounts/${second.id}/primary`, cookie);
      expect(refused.statusCode).toBe(403);
    }
    const response = await send("POST", `/v1/social-accounts/${second.id}/primary`, cookies.admin);
    expect(response.statusCode, response.body).toBe(200);
    expectNoTokens(response.body);
    expect(response.json<SocialAccountDto>()).toMatchObject({ id: second.id, isPrimary: true });
    expect(await primaryOf()).toEqual([second.id]);

    const waiting = await testDb().publishJob.findUniqueOrThrow({
      where: { id: jobs.INSTAGRAM!.id },
    });
    expect(waiting.socialAccountId).toBe(second.id);
    // What already went out stays with the account it went out through.
    const published = await testDb().publishJob.findUniqueOrThrow({
      where: { id: out.jobs.INSTAGRAM!.id },
    });
    expect(published.socialAccountId).toBe(first.id);
    const [audit] = await testDb().auditLog.findMany({
      where: { action: AUDIT_ACTIONS.socialAccountPrimary },
    });
    expect(audit).toMatchObject({
      actorId: admin.id,
      entityId: second.id,
      data: { clientId: client.id, platform: "INSTAGRAM", previousId: first.id, movedJobs: 1 },
    });

    // Again: nothing changes.
    const again = await send("POST", `/v1/social-accounts/${second.id}/primary`, cookies.admin);
    expect(again.json<SocialAccountDto>().isPrimary).toBe(true);
    expect(await testDb().auditLog.count({ where: { action: AUDIT_ACTIONS.socialAccountPrimary } })).toBe(1);
  });

  it("refuses an account that can't publish", async () => {
    await connect();
    const expired = await connect({
      externalId: "17841400000000002",
      tokenExpiresAt: new Date(t.clock.now().getTime() - 1000).toISOString(),
    });
    const response = await send("POST", `/v1/social-accounts/${expired.id}/primary`, cookies.admin);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "CONFLICT", details: { status: "EXPIRED" } },
    });
    expect((await send("POST", "/v1/social-accounts/nope/primary", cookies.admin)).statusCode).toBe(
      404,
    );
  });

  it("passes to the only account left once the publishing one is disconnected, never to one of several", async () => {
    const first = await connect();
    const second = await connect({ externalId: "17841400000000002", handle: "b" });
    const third = await connect({ externalId: "17841400000000003", handle: "c" });

    await send("DELETE", `/v1/social-accounts/${first.id}`, cookies.admin);
    expect(await primaryOf()).toEqual([]);
    await send("DELETE", `/v1/social-accounts/${second.id}`, cookies.admin);
    expect(await primaryOf()).toEqual([third.id]);
    const [audit] = await testDb().auditLog.findMany({
      where: { action: AUDIT_ACTIONS.socialAccountPrimary },
    });
    expect(audit).toMatchObject({ entityId: third.id, data: { disconnectedId: second.id } });
  });
});

describe("POST /v1/social-accounts/:id/check", () => {
  async function check(id: string) {
    const response = await send("POST", `/v1/social-accounts/${id}/check`, cookies.admin);
    expect(response.statusCode, response.body).toBe(200);
    expectNoTokens(response.body);
    return response.json<SocialAccountDto>();
  }

  it("confirms tokens decrypt and stamps lastCheckedAt", async () => {
    const account = await connect({ refreshToken: REFRESH_TOKEN });
    const now = t.clock.advance(5000);

    const checked = await check(account.id);
    expect(checked).toMatchObject({ status: "ACTIVE", lastCheckedAt: now.toISOString() });

    const [audit] = await testDb().auditLog.findMany({
      where: { action: AUDIT_ACTIONS.socialAccountCheck },
    });
    expect(audit).toMatchObject({
      actorId: admin.id,
      entityId: account.id,
      data: { previousStatus: "ACTIVE", status: "ACTIVE" },
    });
  });

  it("reports EXPIRED once the token lapses, unless it can be refreshed", async () => {
    const expiresAt = new Date(t.clock.now().getTime() + DAY_MS);
    const plain = await connect({ externalId: "plain", tokenExpiresAt: expiresAt.toISOString() });
    const refreshable = await connect({
      externalId: "refreshable",
      tokenExpiresAt: expiresAt.toISOString(),
      refreshToken: REFRESH_TOKEN,
      refreshExpiresAt: new Date(expiresAt.getTime() + 30 * DAY_MS).toISOString(),
    });

    t.clock.advance(2 * DAY_MS);
    expect((await check(plain.id)).status).toBe("EXPIRED");
    expect((await check(refreshable.id)).status).toBe("ACTIVE");

    t.clock.advance(60 * DAY_MS);
    // The admin's session has lapsed too by now.
    cookies.admin = await sessionCookieFor(admin, { now: t.clock.now() });
    expect((await check(refreshable.id)).status).toBe("EXPIRED");
  });

  it("reports ERROR when a stored token no longer decrypts, and recovers once it does", async () => {
    const account = await connect({ refreshToken: REFRESH_TOKEN });
    const row = await testDb().socialAccount.findUniqueOrThrow({ where: { id: account.id } });
    const [version, iv, tag, ciphertext = ""] = row.refreshTokenEnc?.split(":") ?? [];
    const flipped = Buffer.from(ciphertext, "base64");
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    await testDb().socialAccount.update({
      where: { id: account.id },
      data: { refreshTokenEnc: [version, iv, tag, flipped.toString("base64")].join(":") },
    });

    expect((await check(account.id)).status).toBe("ERROR");
    const [audit] = await testDb().auditLog.findMany({
      where: { action: AUDIT_ACTIONS.socialAccountCheck },
    });
    expect(audit?.data).toEqual({
      previousStatus: "ACTIVE",
      status: "ERROR",
      reason: "token_decrypt_failed",
    });

    await testDb().socialAccount.update({
      where: { id: account.id },
      data: { refreshTokenEnc: row.refreshTokenEnc },
    });
    expect((await check(account.id)).status).toBe("ACTIVE");
  });

  it("reports ERROR when TOKEN_ENC_KEY has changed", async () => {
    const account = await connect();
    const rotated = await buildTestApp({
      env: { TOKEN_ENC_KEY: Buffer.alloc(32, 0x11).toString("base64") },
    });
    try {
      const response = await rotated.app.inject({
        method: "POST",
        url: `/v1/social-accounts/${account.id}/check`,
        headers: browserHeaders(cookies.admin),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<SocialAccountDto>().status).toBe("ERROR");
    } finally {
      await rotated.close();
    }
  });

  it("keeps a platform-reported revocation", async () => {
    const account = await connect();
    await testDb().socialAccount.update({ where: { id: account.id }, data: { status: "REVOKED" } });
    expect((await check(account.id)).status).toBe("REVOKED");
  });

  it("returns 404 for an unknown account", async () => {
    const response = await send("POST", "/v1/social-accounts/nope/check", cookies.admin);
    expect(response.statusCode).toBe(404);
  });
});
