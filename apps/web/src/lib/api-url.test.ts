import { afterEach, describe, expect, it, vi } from "vitest";
import { apiUrl, resolveApiUrl, SAME_ORIGIN_API } from "./api";

describe("resolveApiUrl", () => {
  it("defaults to the local API and trims trailing slashes", () => {
    expect(resolveApiUrl(undefined)).toBe("http://localhost:4000");
    expect(resolveApiUrl("https://api.enmo.marketing/")).toBe("https://api.enmo.marketing");
  });

  it("turns same-origin into relative calls", () => {
    expect(resolveApiUrl(SAME_ORIGIN_API)).toBe("");
    expect(resolveApiUrl(` ${SAME_ORIGIN_API} `)).toBe("");
  });
});

describe("apiUrl", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps an absolute API base", () => {
    expect(apiUrl("/v1/events", "https://api.enmo.marketing").toString()).toBe(
      "https://api.enmo.marketing/v1/events",
    );
  });

  it("resolves same-origin calls against the page's origin", () => {
    vi.stubGlobal("window", { location: { origin: "https://enmoos.example.workers.dev" } });
    expect(apiUrl("/v1/auth/me", "").toString()).toBe(
      "https://enmoos.example.workers.dev/v1/auth/me",
    );
  });
});
