import {
  AUDIT_ACTIONS,
  BANNED_WORDS_MAX,
  DEFAULT_APPROVAL_CHAIN,
  DEFAULT_VISUAL_STYLE,
  type ApprovalChain,
  type ClientDto,
  type ClientListItem,
} from "@enmo/shared";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { browserHeaders, buildTestApp, type TestApp } from "../helpers/app";
import { sessionCookieFor, type CookieHeader } from "../helpers/auth";
import { testDb } from "../helpers/db";
import { createClient, createUser, type TestUser } from "../helpers/factories";

let t: TestApp;
let admin: TestUser;
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
});

type Method = NonNullable<InjectOptions["method"]>;

function send(method: Method, url: string, cookie?: CookieHeader, payload?: object) {
  return t.app.inject({ method, url, headers: browserHeaders(cookie), payload });
}

async function createViaApi(payload: object, cookie = cookies.admin): Promise<ClientDto> {
  const response = await send("POST", "/v1/clients", cookie, payload);
  expect(response.statusCode, response.body).toBe(201);
  return response.json<ClientDto>();
}

function auditRows(action: string) {
  return testDb().auditLog.findMany({ where: { action }, orderBy: { createdAt: "asc" } });
}

describe("access control", () => {
  it("requires a session", async () => {
    const response = await send("GET", "/v1/clients");
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });

  it("requires an allowed Origin on mutations", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/v1/clients",
      headers: { cookie: cookies.admin },
      payload: { name: "Qahwa Co" },
    });
    expect(response.statusCode).toBe(403);
    expect(await testDb().client.count()).toBe(0);
  });

  it("lets editors read but not write", async () => {
    const client = await createClient();
    const editor = cookies.editor;

    expect((await send("GET", "/v1/clients", editor)).statusCode).toBe(200);
    expect((await send("GET", `/v1/clients/${client.id}`, editor)).statusCode).toBe(200);

    const writes = await Promise.all([
      send("POST", "/v1/clients", editor, { name: "Nope" }),
      send("PATCH", `/v1/clients/${client.id}`, editor, { brandVoice: "Loud" }),
      send("PUT", `/v1/clients/${client.id}/approval-chain`, editor, DEFAULT_APPROVAL_CHAIN),
      send("POST", `/v1/clients/${client.id}/archive`, editor),
    ]);
    for (const response of writes) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    }
  });

  it("lets managers write but only admins archive", async () => {
    const created = await createViaApi({ name: "Qahwa Co" }, cookies.manager);
    const patched = await send("PATCH", `/v1/clients/${created.id}`, cookies.manager, {
      brandVoice: "Warm",
    });
    expect(patched.statusCode).toBe(200);
    const chain = await send(
      "PUT",
      `/v1/clients/${created.id}/approval-chain`,
      cookies.manager,
      DEFAULT_APPROVAL_CHAIN,
    );
    expect(chain.statusCode).toBe(200);

    const archivedByManager = await send(
      "POST",
      `/v1/clients/${created.id}/archive`,
      cookies.manager,
    );
    expect(archivedByManager.statusCode).toBe(403);
    const archivedByAdmin = await send("POST", `/v1/clients/${created.id}/archive`, cookies.admin);
    expect(archivedByAdmin.statusCode).toBe(200);
  });
});

describe("POST /v1/clients", () => {
  it("creates a client with the documented defaults", async () => {
    const client = await createViaApi({ name: "  Qahwa Co  " });

    expect(client).toMatchObject({
      name: "Qahwa Co",
      slug: "qahwa-co",
      timezone: "UTC",
      brandVoice: "",
      bannedWords: [],
      enabledPlatforms: ["INSTAGRAM", "FACEBOOK", "TIKTOK"],
      archivedAt: null,
    });
    expect(client.visualStyle).toEqual(DEFAULT_VISUAL_STYLE);
    expect(client.approvalChain).toEqual(DEFAULT_APPROVAL_CHAIN);
    expect(new Date(client.createdAt).toISOString()).toBe(client.createdAt);

    const [audit] = await auditRows(AUDIT_ACTIONS.clientCreate);
    expect(audit).toMatchObject({
      actorId: admin.id,
      entityType: "Client",
      entityId: client.id,
      data: { name: "Qahwa Co", slug: "qahwa-co" },
    });
  });

  it("stores every field it is given", async () => {
    const client = await createViaApi({
      name: "Qahwa Co",
      slug: "qahwa",
      timezone: "Asia/Riyadh",
      brandVoice: "Warm, confident, a little playful.",
      bannedWords: ["cheap", "instant"],
      visualStyle: { palette: { accent: "#c8a27a" }, keywords: ["steam"] },
      enabledPlatforms: ["INSTAGRAM", "TIKTOK"],
    });

    expect(client).toMatchObject({
      slug: "qahwa",
      timezone: "Asia/Riyadh",
      brandVoice: "Warm, confident, a little playful.",
      bannedWords: ["cheap", "instant"],
      enabledPlatforms: ["INSTAGRAM", "TIKTOK"],
    });
    expect(client.visualStyle.palette).toEqual({
      ...DEFAULT_VISUAL_STYLE.palette,
      accent: "#C8A27A",
    });
    expect(client.visualStyle.keywords).toEqual(["steam"]);

    const fetched = await send("GET", `/v1/clients/${client.id}`, cookies.editor);
    expect(fetched.json()).toEqual(client);
  });

  it("de-duplicates derived slugs with a numeric suffix", async () => {
    const first = await createViaApi({ name: "Qahwa Co" });
    const second = await createViaApi({ name: "Qahwa  Co!" });
    const third = await createViaApi({ name: "QAHWA CO" });
    expect([first.slug, second.slug, third.slug]).toEqual(["qahwa-co", "qahwa-co-2", "qahwa-co-3"]);

    // Non-Latin names fall back to "client".
    const arabic = await createViaApi({ name: "قهوة" });
    const arabicAgain = await createViaApi({ name: "شاي" });
    expect([arabic.slug, arabicAgain.slug]).toEqual(["client", "client-2"]);
  });

  it("keeps suffixed slugs within the length limit", async () => {
    const name = "The Extraordinarily Long Specialty Coffee Roasting Company of Jeddah";
    const first = await createViaApi({ name });
    const second = await createViaApi({ name });
    expect(first.slug).toHaveLength(48);
    expect(second.slug.length).toBeLessThanOrEqual(48);
    expect(second.slug).toMatch(/^the-extraordinarily-long-.*-2$/);
  });

  it("handles concurrent creates of the same name", async () => {
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        send("POST", "/v1/clients", cookies.admin, { name: "Qahwa Co" }),
      ),
    );
    expect(responses.map((response) => response.statusCode)).toEqual([201, 201, 201, 201]);
    const slugs = responses.map((response) => response.json<ClientDto>().slug).sort();
    expect(slugs).toEqual(["qahwa-co", "qahwa-co-2", "qahwa-co-3", "qahwa-co-4"]);
  });

  it("rejects an explicit slug that is taken", async () => {
    await createViaApi({ name: "Qahwa Co" });
    const response = await send("POST", "/v1/clients", cookies.admin, {
      name: "Other",
      slug: "qahwa-co",
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "CONFLICT", details: { field: "slug" } },
    });
  });

  it.each([
    ["an unknown time zone", { timezone: "Mars/Olympus_Mons" }, "timezone"],
    ["a raw UTC offset", { timezone: "+03:00" }, "timezone"],
    [
      "a malformed colour",
      { visualStyle: { palette: { primary: "red" } } },
      "visualStyle.palette.primary",
    ],
    [
      "an unknown font",
      { visualStyle: { typography: { display: "COMIC_SANS" } } },
      "visualStyle.typography.display",
    ],
    ["no platforms", { enabledPlatforms: [] }, "enabledPlatforms"],
    ["duplicate platforms", { enabledPlatforms: ["TIKTOK", "TIKTOK"] }, "enabledPlatforms"],
    ["an unknown platform", { enabledPlatforms: ["MYSPACE"] }, "enabledPlatforms.0"],
    ["a blank name", { name: "   " }, "name"],
    ["an invalid slug", { slug: "Qahwa Co" }, "slug"],
    [
      "too many banned words",
      { bannedWords: Array.from({ length: BANNED_WORDS_MAX + 1 }, (_, i) => `w${i}`) },
      "bannedWords",
    ],
    ["an empty approval chain", { approvalChain: { steps: [] } }, "approvalChain.steps"],
  ])("rejects %s", async (_label, overrides, path) => {
    const response = await send("POST", "/v1/clients", cookies.admin, {
      name: "Qahwa Co",
      ...overrides,
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{
      error: { code: string; details: { issues: { path: string }[] } };
    }>();
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.details.issues.map((issue) => issue.path)).toContain(path);
    expect(await testDb().client.count()).toBe(0);
  });

  it("accepts any IANA zone the runtime knows", async () => {
    for (const timezone of ["America/Argentina/Buenos_Aires", "Etc/GMT+3", "Asia/Kolkata"]) {
      const client = await createViaApi({ name: `Zone ${timezone}`, timezone });
      expect(client.timezone).toBe(timezone);
    }
  });

  it("stores a zone typed in the wrong case under its proper name", async () => {
    const client = await createViaApi({ name: "Qahwa Co", timezone: "asia/riyadh" });
    expect(client.timezone).toBe("Asia/Riyadh");
    const stored = await testDb().client.findUniqueOrThrow({ where: { id: client.id } });
    expect(stored.timezone).toBe("Asia/Riyadh");

    const patched = await send("PATCH", `/v1/clients/${client.id}`, cookies.admin, {
      timezone: "EUROPE/LONDON",
    });
    expect(patched.json<ClientDto>().timezone).toBe("Europe/London");
  });
});

describe("GET /v1/clients", () => {
  it("lists active clients by name with related counts", async () => {
    const zeta = await createClient({ name: "Zeta Tea" });
    const alpha = await createClient({ name: "Alpha Beans" });
    await createClient({ name: "Old Client", archivedAt: new Date() });
    await testDb().socialAccount.create({
      data: {
        clientId: alpha.id,
        platform: "INSTAGRAM",
        externalId: "ig-1",
        handle: "alpha",
        accessTokenEnc: "v1:x:y:z",
      },
    });
    await testDb().campaign.create({
      data: { clientId: alpha.id, name: "Ramadan", createdById: admin.id },
    });

    const response = await send("GET", "/v1/clients", cookies.editor);
    expect(response.statusCode).toBe(200);
    const { items } = response.json<{ items: ClientListItem[] }>();
    expect(items.map((item) => item.name)).toEqual(["Alpha Beans", "Zeta Tea"]);
    expect(items[0]?.counts).toEqual({ socialAccounts: 1, campaigns: 1, posts: 0 });
    expect(items[1]).toMatchObject({
      id: zeta.id,
      counts: { socialAccounts: 0, campaigns: 0, posts: 0 },
    });
    expect(items[0]?.visualStyle).toEqual(DEFAULT_VISUAL_STYLE);
  });

  it("includes archived clients last when asked", async () => {
    await createClient({ name: "Archived Co", archivedAt: new Date() });
    await createClient({ name: "Zeta Tea" });

    const response = await send("GET", "/v1/clients?includeArchived=true", cookies.editor);
    const { items } = response.json<{ items: ClientListItem[] }>();
    expect(items.map((item) => [item.name, item.archivedAt !== null])).toEqual([
      ["Zeta Tea", false],
      ["Archived Co", true],
    ]);

    const invalid = await send("GET", "/v1/clients?includeArchived=maybe", cookies.editor);
    expect(invalid.statusCode).toBe(400);
  });
});

describe("GET /v1/clients/:id", () => {
  it("reports a stored row that no longer fits its schema as a server fault, not a bad request", async () => {
    const client = await createViaApi({ name: "Qahwa Co" });
    await testDb().client.update({
      where: { id: client.id },
      data: { approvalChain: { steps: [] } },
    });

    const response = await send("GET", `/v1/clients/${client.id}`, cookies.editor);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "INTERNAL", message: "Something went wrong" },
    });
  });

  it("returns 404 for an unknown client", async () => {
    const response = await send("GET", "/v1/clients/nope", cookies.editor);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: "Client not found" },
    });
  });
});

describe("PATCH /v1/clients/:id", () => {
  it("updates only the fields sent", async () => {
    const client = await createViaApi({
      name: "Qahwa Co",
      brandVoice: "Warm",
      visualStyle: { palette: { accent: "#C8A27A" }, lighting: "Golden hour" },
    });
    t.clock.advance(1000);

    const response = await send("PATCH", `/v1/clients/${client.id}`, cookies.manager, {
      name: "Qahwa Company",
      brandVoice: "Warm and bold",
      timezone: "Asia/Riyadh",
      enabledPlatforms: ["INSTAGRAM"],
    });
    expect(response.statusCode).toBe(200);
    const updated = response.json<ClientDto>();
    expect(updated).toMatchObject({
      name: "Qahwa Company",
      slug: "qahwa-co",
      brandVoice: "Warm and bold",
      timezone: "Asia/Riyadh",
      enabledPlatforms: ["INSTAGRAM"],
    });
    expect(updated.visualStyle).toEqual(client.visualStyle);

    const [audit] = await auditRows(AUDIT_ACTIONS.clientUpdate);
    const audited = audit?.data as { fields?: string[] } | undefined;
    expect(audited?.fields?.toSorted()).toEqual([
      "brandVoice",
      "enabledPlatforms",
      "name",
      "timezone",
    ]);
  });

  it("replaces the whole visual style, filling defaults", async () => {
    const client = await createViaApi({
      name: "Qahwa Co",
      visualStyle: { palette: { accent: "#C8A27A" }, lighting: "Golden hour", keywords: ["steam"] },
    });
    const response = await send("PATCH", `/v1/clients/${client.id}`, cookies.admin, {
      visualStyle: { palette: { primary: "#112233" } },
    });
    const { visualStyle } = response.json<ClientDto>();
    expect(visualStyle.palette).toEqual({ ...DEFAULT_VISUAL_STYLE.palette, primary: "#112233" });
    expect(visualStyle.lighting).toBe("");
    expect(visualStyle.keywords).toEqual([]);
  });

  it("normalises banned words", async () => {
    const client = await createViaApi({ name: "Qahwa Co" });
    const response = await send("PATCH", `/v1/clients/${client.id}`, cookies.admin, {
      bannedWords: [
        "  cheap ",
        "Cheap",
        "ｃｈｅａｐ", // full-width
        "instant   coffee",
        "Instant Coffee",
        "ﬁnest", // "fi" ligature
        "finest",
        "رخيص",
        "  رخيص  ",
      ],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<ClientDto>().bannedWords).toEqual([
      "cheap",
      "instant coffee",
      "finest",
      "رخيص",
    ]);
    const stored = await testDb().client.findUniqueOrThrow({ where: { id: client.id } });
    expect(stored.bannedWords).toEqual(["cheap", "instant coffee", "finest", "رخيص"]);
  });

  it("normalises banned words on create too", async () => {
    const client = await createViaApi({ name: "Qahwa Co", bannedWords: ["ＣＨＥＡＰ", "cheap"] });
    expect(client.bannedWords).toEqual(["CHEAP"]);
  });

  it("changes the slug only when asked, and never to a taken one", async () => {
    const other = await createViaApi({ name: "Other Co" });
    const client = await createViaApi({ name: "Qahwa Co" });

    const renamed = await send("PATCH", `/v1/clients/${client.id}`, cookies.admin, {
      slug: "qahwa",
    });
    expect(renamed.json<ClientDto>().slug).toBe("qahwa");

    const taken = await send("PATCH", `/v1/clients/${client.id}`, cookies.admin, {
      slug: other.slug,
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ error: { code: "CONFLICT", details: { field: "slug" } } });
  });

  it("rejects empty patches and ignores the approval chain", async () => {
    const client = await createViaApi({ name: "Qahwa Co" });
    const chain: ApprovalChain = {
      steps: [
        { name: "Admin only", approverRoles: ["ADMIN"], approverUserIds: [], minApprovals: 1 },
      ],
    };

    const empty = await send("PATCH", `/v1/clients/${client.id}`, cookies.admin, {});
    expect(empty.statusCode).toBe(400);
    const chainOnly = await send("PATCH", `/v1/clients/${client.id}`, cookies.admin, {
      approvalChain: chain,
    });
    expect(chainOnly.statusCode).toBe(400);

    const mixed = await send("PATCH", `/v1/clients/${client.id}`, cookies.admin, {
      brandVoice: "Bold",
      approvalChain: chain,
    });
    expect(mixed.statusCode).toBe(200);
    expect(mixed.json<ClientDto>().approvalChain).toEqual(DEFAULT_APPROVAL_CHAIN);
  });

  it("returns 404 for an unknown client", async () => {
    const response = await send("PATCH", "/v1/clients/nope", cookies.admin, { brandVoice: "x" });
    expect(response.statusCode).toBe(404);
  });
});

describe("PUT /v1/clients/:id/approval-chain", () => {
  it("replaces the chain when every named approver is active", async () => {
    const client = await createViaApi({ name: "Qahwa Co" });
    const approver = await createUser({ role: "EDITOR" });
    const chain: ApprovalChain = {
      steps: [
        {
          name: "Editor check",
          approverRoles: [],
          approverUserIds: [approver.id],
          minApprovals: 1,
        },
        {
          name: "Manager review",
          approverRoles: ["MANAGER", "ADMIN"],
          approverUserIds: [],
          minApprovals: 2,
        },
      ],
    };

    const response = await send(
      "PUT",
      `/v1/clients/${client.id}/approval-chain`,
      cookies.admin,
      chain,
    );
    expect(response.statusCode).toBe(200);
    expect(response.json<ClientDto>().approvalChain).toEqual(chain);

    const stored = await testDb().client.findUniqueOrThrow({ where: { id: client.id } });
    expect(stored.approvalChain).toEqual(chain);
    const [audit] = await auditRows(AUDIT_ACTIONS.clientApprovalChain);
    expect(audit).toMatchObject({ entityId: client.id, data: chain });
  });

  it("rejects approvers who are unknown or deactivated", async () => {
    const client = await createViaApi({ name: "Qahwa Co" });
    const inactive = await createUser({ isActive: false });
    const active = await createUser();
    const chain: ApprovalChain = {
      steps: [
        {
          name: "Named",
          approverRoles: [],
          approverUserIds: [active.id, inactive.id, "missing-user"],
          minApprovals: 1,
        },
      ],
    };

    const response = await send(
      "PUT",
      `/v1/clients/${client.id}/approval-chain`,
      cookies.admin,
      chain,
    );
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "UNPROCESSABLE", details: { userIds: [inactive.id, "missing-user"] } },
    });
    const stored = await testDb().client.findUniqueOrThrow({ where: { id: client.id } });
    expect(stored.approvalChain).toEqual(DEFAULT_APPROVAL_CHAIN);
  });

  it("applies the same approver check on create", async () => {
    const response = await send("POST", "/v1/clients", cookies.admin, {
      name: "Qahwa Co",
      approvalChain: {
        steps: [
          { name: "Ghost", approverRoles: ["ADMIN"], approverUserIds: ["ghost"], minApprovals: 1 },
        ],
      },
    });
    expect(response.statusCode).toBe(422);
    expect(await testDb().client.count()).toBe(0);
  });

  it("rejects a step the current team can't complete, naming the step", async () => {
    const client = await createViaApi({ name: "Qahwa Co" });
    // The workspace has exactly one active ADMIN, so a step asking two of them can never finish.
    const chain: ApprovalChain = {
      steps: [
        DEFAULT_APPROVAL_CHAIN.steps[0]!,
        {
          name: "Brand lead sign-off",
          approverRoles: ["ADMIN"],
          approverUserIds: [],
          minApprovals: 2,
        },
      ],
    };

    const response = await send(
      "PUT",
      `/v1/clients/${client.id}/approval-chain`,
      cookies.admin,
      chain,
    );
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: {
        code: "UNPROCESSABLE",
        message:
          'Approval step 2 ("Brand lead sign-off") needs 2 approvals, but only 1 active teammate can approve it',
        details: { steps: [{ step: 1, name: "Brand lead sign-off", eligible: 1, required: 2 }] },
      },
    });
    const stored = await testDb().client.findUniqueOrThrow({ where: { id: client.id } });
    expect(stored.approvalChain).toEqual(DEFAULT_APPROVAL_CHAIN);
    expect(await auditRows(AUDIT_ACTIONS.clientApprovalChain)).toHaveLength(0);
  });

  it("counts only active teammates, by role or by name, each once", async () => {
    const client = await createViaApi({ name: "Qahwa Co" });
    await createUser({ role: "MANAGER", isActive: false });
    const managersStep = (minApprovals: number, approverUserIds: string[] = []) => ({
      steps: [
        { name: "Managers", approverRoles: ["MANAGER" as const], approverUserIds, minApprovals },
      ],
    });
    const put = (chain: ApprovalChain) =>
      send("PUT", `/v1/clients/${client.id}/approval-chain`, cookies.admin, chain);

    // One active manager (from beforeEach) plus a deactivated one: two approvals are out of reach.
    const short = await put(managersStep(2));
    expect(short.statusCode).toBe(422);
    expect(short.json()).toMatchObject({
      error: { details: { steps: [{ step: 0, eligible: 1, required: 2 }] } },
    });

    // Naming someone outside the role adds them; naming a manager again does not double-count.
    const [activeManager] = await testDb().user.findMany({
      where: { role: "MANAGER", isActive: true },
    });
    expect((await put(managersStep(2, [activeManager!.id]))).statusCode).toBe(422);
    expect((await put(managersStep(2, [admin.id]))).statusCode).toBe(200);

    // A second active manager makes the role alone enough.
    await createUser({ role: "MANAGER" });
    expect((await put(managersStep(2))).statusCode).toBe(200);
  });

  it("applies the same completability check on create", async () => {
    const response = await send("POST", "/v1/clients", cookies.manager, {
      name: "Qahwa Co",
      approvalChain: {
        steps: [
          { name: "Editors", approverRoles: ["EDITOR"], approverUserIds: [], minApprovals: 3 },
        ],
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "UNPROCESSABLE", details: { steps: [{ step: 0, eligible: 1, required: 3 }] } },
    });
    expect(await testDb().client.count()).toBe(0);
  });

  it.each([
    ["no steps", { steps: [] }],
    ["six steps", { steps: Array.from({ length: 6 }, () => DEFAULT_APPROVAL_CHAIN.steps[0]) }],
    [
      "a step without approvers",
      { steps: [{ name: "Empty", approverRoles: [], approverUserIds: [], minApprovals: 1 }] },
    ],
    [
      "minApprovals above the named approvers",
      { steps: [{ name: "Solo", approverRoles: [], approverUserIds: ["u1"], minApprovals: 2 }] },
    ],
    [
      "minApprovals of 4",
      { steps: [{ name: "Many", approverRoles: ["ADMIN"], approverUserIds: [], minApprovals: 4 }] },
    ],
    [
      "an unknown role",
      { steps: [{ name: "Bad", approverRoles: ["OWNER"], approverUserIds: [], minApprovals: 1 }] },
    ],
  ])("rejects a chain with %s", async (_label, chain) => {
    const client = await createViaApi({ name: "Qahwa Co" });
    const response = await send(
      "PUT",
      `/v1/clients/${client.id}/approval-chain`,
      cookies.admin,
      chain,
    );
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  });

  it("returns 404 for an unknown client", async () => {
    const response = await send(
      "PUT",
      "/v1/clients/nope/approval-chain",
      cookies.admin,
      DEFAULT_APPROVAL_CHAIN,
    );
    expect(response.statusCode).toBe(404);
  });
});

describe("POST /v1/clients/:id/archive", () => {
  it("archives once, hides the client from the default list and freezes it", async () => {
    const client = await createViaApi({ name: "Qahwa Co" });
    const archivedAt = t.clock.advance(60_000);

    const first = await send("POST", `/v1/clients/${client.id}/archive`, cookies.admin);
    expect(first.statusCode).toBe(200);
    expect(first.json<ClientDto>().archivedAt).toBe(archivedAt.toISOString());

    t.clock.advance(60_000);
    const second = await send("POST", `/v1/clients/${client.id}/archive`, cookies.admin);
    expect(second.json<ClientDto>().archivedAt).toBe(archivedAt.toISOString());
    expect(await auditRows(AUDIT_ACTIONS.clientArchive)).toHaveLength(1);

    const list = await send("GET", "/v1/clients", cookies.admin);
    expect(list.json<{ items: unknown[] }>().items).toEqual([]);
    const fetched = await send("GET", `/v1/clients/${client.id}`, cookies.admin);
    expect(fetched.statusCode).toBe(200);

    const patch = await send("PATCH", `/v1/clients/${client.id}`, cookies.admin, {
      brandVoice: "x",
    });
    expect(patch.statusCode).toBe(409);
    const chain = await send(
      "PUT",
      `/v1/clients/${client.id}/approval-chain`,
      cookies.admin,
      DEFAULT_APPROVAL_CHAIN,
    );
    expect(chain.statusCode).toBe(409);
  });

  it("returns 404 for an unknown client", async () => {
    const response = await send("POST", "/v1/clients/nope/archive", cookies.admin);
    expect(response.statusCode).toBe(404);
  });
});
