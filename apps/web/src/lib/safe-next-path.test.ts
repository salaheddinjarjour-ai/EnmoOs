import { describe, expect, it } from "vitest";
import { DEFAULT_LANDING, safeNextPath } from "./safe-next-path";

const ORIGIN = "https://app.enmo.marketing";

describe("safeNextPath", () => {
  it.each([
    ["/clients", "/clients"],
    ["/clients/c1?tab=voice#chain", "/clients/c1?tab=voice#chain"],
    ["/brief?clientId=c1", "/brief?clientId=c1"],
    ["/%2F%2Fevil.com", "/%2F%2Fevil.com"],
    ["/./clients", "/clients"],
  ])("keeps the same-origin path %j", (next, expected) => {
    expect(safeNextPath(next, ORIGIN)).toBe(expected);
  });

  it.each([
    // The URL parser strips tab/CR/LF, leaving a protocol-relative "//evil.com".
    ["tab", "/\t/evil.com"],
    ["newline", "/\n/evil.com"],
    ["carriage return", "/\r/evil.com"],
    ["leading tab", "\t//evil.com"],
    ["protocol-relative", "//evil.com"],
    ["backslash", "/\\evil.com"],
    ["backslash later on", "/clients\\..\\\\evil.com"],
    ["absolute URL", "https://evil.com/phish"],
    ["same-origin absolute URL", `${ORIGIN}/clients`],
    ["javascript: URL", "javascript:alert(document.domain)"],
    ["data: URL", "data:text/html,<script>alert(1)</script>"],
    ["relative path", "clients"],
    ["space", "/ /evil.com"],
    ["NUL", "/clients\u0000"],
    ["DEL", "/clients\u007f"],
    ["non-breaking space", "/clients "],
    ["empty", ""],
  ])("falls back to the dashboard for %s", (_name, next) => {
    expect(safeNextPath(next, ORIGIN)).toBe(DEFAULT_LANDING);
  });

  it("falls back when there is no next or no usable origin", () => {
    expect(safeNextPath(null, ORIGIN)).toBe(DEFAULT_LANDING);
    expect(safeNextPath(undefined, ORIGIN)).toBe(DEFAULT_LANDING);
    expect(safeNextPath("/clients", "null")).toBe(DEFAULT_LANDING);
  });

  it("never returns anything that resolves off the origin", () => {
    const hostile = ["/\t/evil.com", "/\n\n/evil.com", "/\\/evil.com", "/%09/evil.com"];
    for (const next of hostile) {
      expect(new URL(safeNextPath(next, ORIGIN), ORIGIN).origin).toBe(ORIGIN);
    }
  });
});
