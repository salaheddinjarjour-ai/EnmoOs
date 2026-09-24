import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApiErrorBody,
  AuditListResponse,
  CapabilitiesResponse,
  ClientDto,
  ClientListQuery,
  CreateClientRequest,
  CreateInviteResponse,
  CreateSocialAccountRequest,
  DEFAULT_APPROVAL_CHAIN,
  DEFAULT_VISUAL_STYLE,
  Email,
  InviteListResponse,
  LoginRequest,
  SessionResponse,
  SocialAccountListResponse,
  TeamDirectoryResponse,
  TimeZone,
  UpdateClientRequest,
  UpdateUserRequest,
  UserListResponse,
  VisualStyleTokens,
  AcceptInviteRequest,
  capabilitiesFor,
  defaultVisualStyle,
  inviteAcceptPath,
  inviteStatus,
  isValidTimeZone,
  slugify,
} from "../src";

const now = "2026-09-23T10:00:00.000Z";
const user = {
  id: "u1",
  email: "admin@enmo.marketing",
  name: "Admin",
  role: "ADMIN" as const,
  isActive: true,
  lastLoginAt: null,
  createdAt: now,
};
const client = {
  id: "c1",
  name: "Qahwa Co",
  slug: "qahwa-co",
  timezone: "Asia/Riyadh",
  brandVoice: "Warm, confident.",
  visualStyle: defaultVisualStyle(),
  bannedWords: ["cheap"],
  approvalChain: DEFAULT_APPROVAL_CHAIN,
  enabledPlatforms: ["INSTAGRAM" as const, "TIKTOK" as const],
  archivedAt: null,
  createdAt: now,
  updatedAt: now,
};

describe("client request schemas", () => {
  it("fills defaults for a minimal create", () => {
    const parsed = CreateClientRequest.parse({ name: "  Qahwa Co " });
    expect(parsed).toEqual({
      name: "Qahwa Co",
      timezone: "UTC",
      brandVoice: "",
      visualStyle: DEFAULT_VISUAL_STYLE,
      bannedWords: [],
      approvalChain: DEFAULT_APPROVAL_CHAIN,
      enabledPlatforms: ["INSTAGRAM", "FACEBOOK", "TIKTOK"],
    });
    expect(Object.isFrozen(parsed.approvalChain)).toBe(false);
    expect(Object.isFrozen(parsed.visualStyle.palette)).toBe(false);
  });

  it("de-duplicates banned words case-insensitively, keeping the first spelling", () => {
    const parsed = CreateClientRequest.parse({
      name: "X",
      bannedWords: [" Cheap ", "cheap", "CHEAP", "رخيص"],
    });
    expect(parsed.bannedWords).toEqual(["Cheap", "رخيص"]);
  });

  it.each([
    ["an empty name", { name: " " }],
    ["a bad slug", { name: "X", slug: "Bad Slug" }],
    ["an unknown time zone", { name: "X", timezone: "Mars/Olympus" }],
    ["a raw offset time zone", { name: "X", timezone: "+03:00" }],
    ["no platforms", { name: "X", enabledPlatforms: [] }],
    ["duplicate platforms", { name: "X", enabledPlatforms: ["TIKTOK", "TIKTOK"] }],
    ["a bad colour", { name: "X", visualStyle: { palette: { accent: "green" } } }],
  ])("rejects %s", (_label, input) => {
    expect(CreateClientRequest.safeParse(input).success).toBe(false);
  });

  it("requires at least one field on update", () => {
    expect(UpdateClientRequest.safeParse({}).success).toBe(false);
    expect(UpdateClientRequest.parse({ brandVoice: "Bold" })).toEqual({ brandVoice: "Bold" });
  });

  it("parses includeArchived from the query string", () => {
    expect(ClientListQuery.parse({})).toEqual({ includeArchived: false });
    expect(ClientListQuery.parse({ includeArchived: "true" })).toEqual({ includeArchived: true });
  });
});

describe("visual style tokens", () => {
  it("completes partial and legacy JSON with defaults", () => {
    const parsed = VisualStyleTokens.parse({ palette: { accent: "#22c55e" }, keywords: ["warm"] });
    expect(parsed.palette).toEqual({ ...DEFAULT_VISUAL_STYLE.palette, accent: "#22C55E" });
    expect(parsed.keywords).toEqual(["warm"]);
    expect(parsed.typography).toEqual({ display: "SPACE_GROTESK", body: "INTER" });
    expect(parsed.overlay).toEqual({ position: "BOTTOM", scrim: true });
  });

  it("defaults to a brand-neutral palette, never ENMO's action green", () => {
    expect(Object.values(DEFAULT_VISUAL_STYLE.palette)).not.toContain("#4ADE80");
  });
});

describe("helpers", () => {
  it("slugifies names", () => {
    expect(slugify("Qahwa Co")).toBe("qahwa-co");
    expect(slugify("  Café Déjà-Vu!! ")).toBe("cafe-deja-vu");
    expect(slugify("قهوة")).toBe("client");
    expect(slugify("x".repeat(80))).toHaveLength(48);
  });

  it("validates IANA time zones", () => {
    for (const tz of ["UTC", "Asia/Riyadh", "America/Argentina/Buenos_Aires", "Etc/GMT+3"]) {
      expect(isValidTimeZone(tz)).toBe(true);
    }
    for (const tz of ["", "Mars/Olympus", "+03:00", "Asia/Riyadh; DROP"]) {
      expect(isValidTimeZone(tz)).toBe(false);
    }
  });

  it("stores a time zone in the runtime's own casing, and keeps aliases as sent", () => {
    expect(TimeZone.parse(" asia/riyadh ")).toBe("Asia/Riyadh");
    expect(TimeZone.parse("utc")).toBe("UTC");
    expect(TimeZone.parse("etc/gmt+3")).toBe("Etc/GMT+3");
    expect(TimeZone.parse("Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(TimeZone.parse("America/Argentina/Buenos_Aires")).toBe("America/Argentina/Buenos_Aires");
    expect(TimeZone.safeParse("Mars/Olympus").success).toBe(false);
    expect(UpdateClientRequest.parse({ timezone: "asia/riyadh" }).timezone).toBe("Asia/Riyadh");
  });

  it("normalises emails", () => {
    expect(Email.parse("  Admin@Enmo.Marketing ")).toBe("admin@enmo.marketing");
    expect(Email.safeParse("not-an-email").success).toBe(false);
  });

  it("derives invite status", () => {
    const at = new Date(now);
    const base = { acceptedAt: null, revokedAt: null, expiresAt: "2026-09-30T00:00:00.000Z" };
    expect(inviteStatus(base, at)).toBe("PENDING");
    expect(inviteStatus({ ...base, expiresAt: "2026-09-01T00:00:00.000Z" }, at)).toBe("EXPIRED");
    expect(inviteStatus({ ...base, acceptedAt: now }, at)).toBe("ACCEPTED");
    expect(inviteStatus({ ...base, acceptedAt: now, revokedAt: now }, at)).toBe("REVOKED");
    expect(inviteAcceptPath("abc_-1")).toBe("/invite/abc_-1");
  });

  it("enforces the password policy only when setting a password", () => {
    expect(LoginRequest.safeParse({ email: "a@b.co", password: "short" }).success).toBe(true);
    expect(AcceptInviteRequest.safeParse({ name: "A", password: "short" }).success).toBe(false);
    expect(AcceptInviteRequest.safeParse({ name: "A", password: "long enough pw" }).success).toBe(
      true,
    );
  });

  it("requires a change on user updates", () => {
    expect(UpdateUserRequest.safeParse({}).success).toBe(false);
    expect(UpdateUserRequest.safeParse({ isActive: false }).success).toBe(true);
  });

  it("defaults social account scopes and meta", () => {
    const parsed = CreateSocialAccountRequest.parse({
      platform: "INSTAGRAM",
      externalId: "1784",
      handle: "qahwa.co",
      accessToken: "tok",
    });
    expect(parsed.scopes).toEqual([]);
    expect(parsed.meta).toEqual({});
  });
});

// The API serialises responses with zod's encode direction, which throws on transforms.
describe("response schemas are encodable", () => {
  const samples: [string, z.ZodType, unknown][] = [
    ["SessionResponse", SessionResponse, { user, capabilities: capabilitiesFor("ADMIN") }],
    ["UserListResponse", UserListResponse, { items: [user] }],
    [
      "TeamDirectoryResponse",
      TeamDirectoryResponse,
      { items: [{ id: user.id, name: user.name, role: user.role, isActive: true }] },
    ],
    ["ClientDto", ClientDto, client],
    [
      "CreateInviteResponse",
      CreateInviteResponse,
      {
        invite: {
          id: "i1",
          email: "new@enmo.marketing",
          role: "EDITOR",
          status: "PENDING",
          invitedBy: { id: user.id, name: user.name, email: user.email },
          expiresAt: now,
          acceptedAt: null,
          revokedAt: null,
          createdAt: now,
        },
        token: "tok",
        acceptPath: "/invite/tok",
      },
    ],
    ["InviteListResponse", InviteListResponse, { items: [] }],
    [
      "SocialAccountListResponse",
      SocialAccountListResponse,
      {
        items: [
          {
            id: "s1",
            clientId: "c1",
            platform: "INSTAGRAM",
            externalId: "1784",
            handle: "qahwa.co",
            displayName: null,
            status: "ACTIVE",
            scopes: ["instagram_basic"],
            meta: { igUserId: "1784", extra: "kept" },
            tokenExpiresAt: null,
            refreshExpiresAt: null,
            lastCheckedAt: null,
            connectedById: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    ],
    [
      "CapabilitiesResponse",
      CapabilitiesResponse,
      {
        llm: { provider: "mock", model: "mock" },
        visual: { provider: "mock" },
        publish: { mode: "dry-run" },
        storage: { driver: "local" },
        pipelineActions: [],
        integrations: {
          anthropic: false,
          meta: false,
          tiktok: false,
          higgsfield: false,
          r2: false,
        },
        dailyTokenCap: 2_000_000,
      },
    ],
    [
      "AuditListResponse",
      AuditListResponse,
      {
        items: [
          {
            id: "a1",
            actor: null,
            action: "auth.login_failed",
            entityType: "user",
            entityId: null,
            data: { email: "x@y.z" },
            ip: "127.0.0.1",
            createdAt: now,
          },
        ],
        nextCursor: null,
      },
    ],
    ["ApiErrorBody", ApiErrorBody, { error: { code: "NOT_FOUND", message: "Client not found" } }],
  ];

  it.each(samples)("%s", (_name, schema, sample) => {
    expect(z.encode(schema, sample)).toEqual(sample);
  });
});
