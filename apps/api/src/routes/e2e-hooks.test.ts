import { describe, expect, it } from "vitest";
import { e2eHooksEnabled } from "./e2e-hooks";

describe("e2eHooksEnabled", () => {
  it("opens the hooks only for a browser-test server", () => {
    expect(e2eHooksEnabled({ ENMO_E2E: "1" }, { NODE_ENV: "development" })).toBe(true);
    expect(e2eHooksEnabled({ ENMO_E2E: "1" }, { NODE_ENV: "test" })).toBe(true);
  });

  it("keeps them shut everywhere else, production above all", () => {
    expect(e2eHooksEnabled({}, { NODE_ENV: "development" })).toBe(false);
    expect(e2eHooksEnabled({ ENMO_E2E: "true" }, { NODE_ENV: "development" })).toBe(false);
    expect(e2eHooksEnabled({ ENMO_E2E: "1" }, { NODE_ENV: "production" })).toBe(false);
  });
});
