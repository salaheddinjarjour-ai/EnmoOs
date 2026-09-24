import { describe, expect, it } from "vitest";
import { randomToken, sha256 } from "./tokens";

describe("randomToken", () => {
  it("is 32 bytes of base64url by default", () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("never repeats", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => randomToken()));
    expect(tokens.size).toBe(100);
  });

  it("refuses weak sizes", () => {
    expect(() => randomToken(8)).toThrow(RangeError);
  });
});

describe("sha256", () => {
  it("returns lowercase hex", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256(new TextEncoder().encode("abc"))).toBe(sha256("abc"));
  });
});
