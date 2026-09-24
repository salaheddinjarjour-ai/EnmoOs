import { ROLE_CAPABILITIES, defaultApprovalChain, type Role } from "@enmo/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RouteAccess } from "../../src/plugins/rbac";
import { browserHeaders, buildTestApp, type TestApp } from "../helpers/app";
import { sessionCookieFor } from "../helpers/auth";
import { createUser, type TestUser } from "../helpers/factories";

/*
 * The RBAC matrix (DESIGN §E) against every Phase 1 route: auth, users, audit, invites, clients,
 * social accounts, capabilities and health.
 *
 * 1. Statically: the access rule each route declares (recorded by plugins/rbac.ts) must equal the
 *    table below, and every registered route under a Phase 1 prefix must appear in it. A new route
 *    under these prefixes (e.g. Phase 6's POST /clients/:id/analyze) has to be added here.
 * 2. Behaviourally: for each route, no session → 401; each role → 403 exactly when
 *    ROLE_CAPABILITIES (the shared matrix) lacks the route's capability, otherwise the request gets
 *    past the guard. Requests carry valid bodies and point at missing ids, so an allowed call ends
 *    in 2xx/400/404 without side effects that matter, and a 403 can only come from the guard.
 * 3. Guards decide before validation: the same 401/403 answers come back when the query and body
 *    are invalid, so an unprivileged caller never sees a route's schema in a 400.
 */

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface Fixture {
  /** An active account with a known password, for the public login route. */
  loginUser: TestUser;
}

interface RouteCase {
  method: Method;
  /** The route pattern as registered. */
  route: string;
  access: RouteAccess;
  /** Concrete URL to call; defaults to `route`. */
  url?: string;
  payload?: (fixture: Fixture) => object;
}

const MISSING = "matrix-missing-id";

const ROUTES: readonly RouteCase[] = [
  // ── health (unversioned probes and their /v1 twins) ──
  { method: "GET", route: "/healthz", access: "public" },
  { method: "GET", route: "/readyz", access: "public" },
  { method: "GET", route: "/v1/healthz", access: "public" },
  { method: "GET", route: "/v1/readyz", access: "public" },

  // ── auth ──
  {
    method: "POST",
    route: "/v1/auth/login",
    access: "public",
    payload: ({ loginUser }) => ({ email: loginUser.email, password: loginUser.password }),
  },
  { method: "POST", route: "/v1/auth/logout", access: "public" },
  { method: "GET", route: "/v1/auth/me", access: "session" },
  {
    method: "POST",
    route: "/v1/auth/password",
    access: "session",
    payload: () => ({
      currentPassword: "not-the-current-password",
      newPassword: "a-different-passphrase",
    }),
  },

  // ── users and audit ──
  { method: "GET", route: "/v1/users", access: "users.manage" },
  // Read-only team directory for approval-chain editors (names and roles, no emails).
  { method: "GET", route: "/v1/users/directory", access: "clients.read" },
  {
    method: "PATCH",
    route: "/v1/users/:id",
    access: "users.manage",
    url: `/v1/users/${MISSING}`,
    payload: () => ({ role: "EDITOR" }),
  },
  { method: "GET", route: "/v1/audit", access: "audit.read" },

  // ── invites ──
  {
    method: "POST",
    route: "/v1/invites",
    access: "invites.manage",
    payload: () => ({ email: "matrix-invitee@enmo.test", role: "EDITOR" }),
  },
  { method: "GET", route: "/v1/invites", access: "invites.manage" },
  {
    method: "DELETE",
    route: "/v1/invites/:id",
    access: "invites.manage",
    url: `/v1/invites/${MISSING}`,
  },
  {
    method: "GET",
    route: "/v1/invites/:token",
    access: "public",
    url: `/v1/invites/${MISSING}`,
  },
  {
    method: "POST",
    route: "/v1/invites/:token/accept",
    access: "public",
    url: `/v1/invites/${MISSING}/accept`,
    payload: () => ({ name: "Matrix Person", password: "a-long-enough-passphrase" }),
  },

  // ── clients ──
  { method: "GET", route: "/v1/clients", access: "clients.read" },
  {
    method: "GET",
    route: "/v1/clients/:id",
    access: "clients.read",
    url: `/v1/clients/${MISSING}`,
  },
  {
    method: "POST",
    route: "/v1/clients",
    access: "clients.write",
    payload: () => ({ name: "Matrix Co" }),
  },
  {
    method: "PATCH",
    route: "/v1/clients/:id",
    access: "clients.write",
    url: `/v1/clients/${MISSING}`,
    payload: () => ({ brandVoice: "Calm and precise." }),
  },
  {
    method: "PUT",
    route: "/v1/clients/:id/approval-chain",
    access: "clients.write",
    url: `/v1/clients/${MISSING}/approval-chain`,
    payload: () => defaultApprovalChain(),
  },
  {
    method: "POST",
    route: "/v1/clients/:id/archive",
    access: "clients.archive",
    url: `/v1/clients/${MISSING}/archive`,
  },

  // ── social accounts ──
  {
    method: "GET",
    route: "/v1/clients/:id/social-accounts",
    access: "clients.read",
    url: `/v1/clients/${MISSING}/social-accounts`,
  },
  {
    method: "POST",
    route: "/v1/clients/:id/social-accounts",
    access: "socialAccounts.manage",
    url: `/v1/clients/${MISSING}/social-accounts`,
    payload: () => ({
      platform: "INSTAGRAM",
      externalId: "17841400000000000",
      handle: "matrix.co",
      accessToken: "matrix-access-token",
    }),
  },
  {
    method: "DELETE",
    route: "/v1/social-accounts/:id",
    access: "socialAccounts.manage",
    url: `/v1/social-accounts/${MISSING}`,
  },
  {
    method: "POST",
    route: "/v1/social-accounts/:id/check",
    access: "socialAccounts.manage",
    url: `/v1/social-accounts/${MISSING}/check`,
  },

  // ── system ──
  { method: "GET", route: "/v1/capabilities", access: "session" },
];

/*
 * Every registered route must be in ROUTES with its expected rule, unless it belongs to a later
 * phase whose own suite checks it. A new route anywhere else fails "declared access" until it is
 * added to the table (and so to the behavioural checks below).
 */
const LATER_PHASE_PREFIXES: readonly string[] = [];

const ROLES = Object.keys(ROLE_CAPABILITIES) as Role[];

const key = (method: string, route: string) => `${method} ${route}`;

let t: TestApp;

beforeAll(async () => {
  t = await buildTestApp();
});

afterAll(async () => {
  await t.close();
});

async function call(routeCase: RouteCase, fixture: Fixture, cookie?: string) {
  const payload = routeCase.payload?.(fixture);
  return t.app.inject({
    method: routeCase.method,
    url: routeCase.url ?? routeCase.route,
    headers: browserHeaders(cookie),
    ...(payload === undefined ? {} : { payload }),
  });
}

describe("declared access", () => {
  it("lists every registered route with the expected rule", () => {
    const declared = Object.fromEntries(
      t.app.routeAccess
        .filter(({ url }) => !LATER_PHASE_PREFIXES.some((prefix) => url.startsWith(prefix)))
        .map(({ method, url, access }) => [key(method, url), access]),
    );
    const expected = Object.fromEntries(
      ROUTES.map(({ method, route, access }) => [key(method, route), access]),
    );
    expect(declared).toEqual(expected);
  });
});

describe("enforced access", () => {
  it.each(ROUTES.map((routeCase) => [key(routeCase.method, routeCase.route), routeCase] as const))(
    "%s",
    async (_name, routeCase) => {
      const fixture: Fixture = { loginUser: await createUser({ role: "EDITOR" }) };

      const anonymous = await call(routeCase, fixture);
      if (routeCase.access === "public") {
        expect(anonymous.statusCode, anonymous.body).not.toBe(401);
        expect(anonymous.statusCode, anonymous.body).not.toBe(403);
        expect(anonymous.statusCode, anonymous.body).toBeLessThan(500);
        return;
      }
      expect(anonymous.statusCode, anonymous.body).toBe(401);
      expect(anonymous.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });

      for (const role of ROLES) {
        const user = await createUser({ role });
        const response = await call(routeCase, fixture, await sessionCookieFor(user));
        const allowed =
          routeCase.access === "session" || ROLE_CAPABILITIES[role].includes(routeCase.access);
        const label = `${role} → ${response.statusCode} ${response.body}`;

        if (allowed) {
          expect([401, 403], label).not.toContain(response.statusCode);
          expect(response.statusCode, label).toBeLessThan(500);
        } else {
          expect(response.statusCode, label).toBe(403);
          expect(response.json(), label).toEqual({
            error: {
              code: "FORBIDDEN",
              message: expect.any(String) as string,
              details: { capability: routeCase.access },
            },
          });
        }
      }
    },
  );
});

/** Invalid for every Phase 1 query schema that has these keys (audit limit, clients flag). */
const INVALID_QUERY = "limit=0&includeArchived=maybe";
/** Not an object, so no body schema accepts it. */
const INVALID_BODY = ["not", "a", "request", "body"];
const BODY_METHODS: ReadonlySet<Method> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function invalidCall(routeCase: RouteCase, fixture: Fixture, cookie?: string) {
  return call(
    {
      ...routeCase,
      url: `${routeCase.url ?? routeCase.route}?${INVALID_QUERY}`,
      ...(BODY_METHODS.has(routeCase.method) ? { payload: () => INVALID_BODY } : {}),
    },
    fixture,
    cookie,
  );
}

describe("guards run before validation", () => {
  const guarded = ROUTES.filter(({ access }) => access !== "public");

  it.each(guarded.map((routeCase) => [key(routeCase.method, routeCase.route), routeCase] as const))(
    "%s",
    async (_name, routeCase) => {
      const fixture: Fixture = { loginUser: await createUser({ role: "EDITOR" }) };

      const anonymous = await invalidCall(routeCase, fixture);
      expect(anonymous.statusCode, anonymous.body).toBe(401);
      expect(anonymous.json()).toEqual({
        error: { code: "UNAUTHENTICATED", message: expect.any(String) as string },
      });

      const { access } = routeCase;
      if (access === "public" || access === "session") return;
      for (const role of ROLES.filter(
        (candidate) => !ROLE_CAPABILITIES[candidate].includes(access),
      )) {
        const user = await createUser({ role });
        const response = await invalidCall(routeCase, fixture, await sessionCookieFor(user));
        expect(response.statusCode, `${role} → ${response.body}`).toBe(403);
        expect(response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
      }
    },
  );
});
