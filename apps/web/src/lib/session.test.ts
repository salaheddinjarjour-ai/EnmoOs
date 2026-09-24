import { SessionResponse } from "@enmo/shared";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, setUnauthenticatedHandler } from "./api";
import { endSessionOnUnauthenticated, fetchSession, loginHref, SESSION_QUERY_KEY } from "./session";

/*
 * The mid-session sign-out path (DESIGN §G "A 401 redirects to /login"): the API revokes a session
 * (deactivation, role change, password change elsewhere, expiry), the next authenticated call gets
 * a 401, the cached session becomes null and the AuthGate redirects. The redirect itself is covered
 * by the Playwright spec; this covers everything up to it.
 */

const session = SessionResponse.parse({
  user: {
    id: "u1",
    email: "layla@enmo.test",
    name: "Layla",
    role: "EDITOR",
    isActive: true,
    lastLoginAt: null,
    createdAt: "2026-09-24T10:00:00.000Z",
  },
  capabilities: ["clients.read"],
});

const fetchMock = vi.fn<typeof fetch>();

function respond(status: number, body: unknown = undefined) {
  fetchMock.mockResolvedValueOnce(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

const unauthenticated = { error: { code: "UNAUTHENTICATED", message: "Sign in to continue" } };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api() on a 401", () => {
  it("runs the registered handler for authenticated calls and still rejects", async () => {
    const handler = vi.fn();
    const unregister = setUnauthenticatedHandler(handler);
    try {
      respond(401, unauthenticated);
      const error = await api("/clients").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

  it("leaves the handler alone for calls that expect to be signed out, and for other errors", async () => {
    const handler = vi.fn();
    const unregister = setUnauthenticatedHandler(handler);
    try {
      respond(401, unauthenticated);
      await expect(
        api("/auth/login", { method: "POST", allowUnauthenticated: true }),
      ).rejects.toMatchObject({ status: 401 });
      respond(403, { error: { code: "FORBIDDEN", message: "No" } });
      await expect(api("/users")).rejects.toMatchObject({ status: 403 });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("stops calling a handler once it is unregistered, without dropping a newer one", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = setUnauthenticatedHandler(first);
    const unregisterSecond = setUnauthenticatedHandler(second);
    unregisterFirst();

    respond(401, unauthenticated);
    await api("/clients").catch(() => undefined);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    unregisterSecond();
    respond(401, unauthenticated);
    await api("/clients").catch(() => undefined);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("endSessionOnUnauthenticated", () => {
  it("marks the cached session signed out when an authenticated call gets a 401", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(SESSION_QUERY_KEY, session);
    const unregister = endSessionOnUnauthenticated(queryClient);
    try {
      respond(200, { items: [] });
      await api("/clients");
      expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toEqual(session);

      respond(401, unauthenticated);
      await expect(api("/clients", { query: { includeArchived: true } })).rejects.toBeInstanceOf(
        ApiError,
      );
      expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toBeNull();
    } finally {
      unregister();
      queryClient.clear();
    }
  });

  it("is inert once unregistered (the AuthGate unmounted)", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(SESSION_QUERY_KEY, session);
    endSessionOnUnauthenticated(queryClient)();

    respond(401, unauthenticated);
    await api("/clients").catch(() => undefined);
    expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toEqual(session);
    queryClient.clear();
  });
});

describe("fetchSession", () => {
  it("answers null for a 401 without treating it as a revoked session", async () => {
    const handler = vi.fn();
    const unregister = setUnauthenticatedHandler(handler);
    try {
      respond(401, unauthenticated);
      expect(await fetchSession()).toBeNull();
      respond(200, session);
      expect(await fetchSession()).toEqual(session);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });
});

describe("loginHref", () => {
  it("keeps the way back, except to the default landing", () => {
    expect(loginHref("/clients")).toBe("/login?next=%2Fclients");
    expect(loginHref("/clients/c1")).toBe("/login?next=%2Fclients%2Fc1");
    expect(loginHref("/command")).toBe("/login");
    expect(loginHref("/")).toBe("/login");
  });
});
