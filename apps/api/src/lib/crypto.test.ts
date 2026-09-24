import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTokenCipher, TOKEN_KEY_BYTES, TokenCryptoError } from "./crypto";

const key = randomBytes(TOKEN_KEY_BYTES);
const cipher = createTokenCipher(key);

/** Replaces one `:`-separated part of an encrypted payload. */
function withPart(payload: string, index: number, edit: (part: string) => string): string {
  const parts = payload.split(":");
  parts[index] = edit(parts[index] ?? "");
  return parts.join(":");
}

/** Flips the lowest bit of the first byte of a base64 part. */
function flipFirstByte(part: string): string {
  const bytes = Buffer.from(part, "base64");
  bytes[0] = (bytes[0] ?? 0) ^ 0x01;
  return bytes.toString("base64");
}

describe("token cipher", () => {
  it.each([
    ["an ASCII token", "EAAGm0PX4ZCpsBAKZCZ-long.token_value"],
    ["unicode", "توكن سري — 🔐"],
    ["an empty string", ""],
    ["a long token", "x".repeat(8192)],
  ])("round-trips %s", (_label, plaintext) => {
    expect(cipher.decrypt(cipher.encrypt(plaintext))).toBe(plaintext);
  });

  it("writes v1:<iv>:<tag>:<ciphertext> with a 12-byte IV and a 16-byte tag", () => {
    const payload = cipher.encrypt("secret-token");
    expect(payload).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    const [, iv = "", tag = "", ciphertext = ""] = payload.split(":");
    expect(Buffer.from(iv, "base64")).toHaveLength(12);
    expect(Buffer.from(tag, "base64")).toHaveLength(16);
    expect(Buffer.from(ciphertext, "base64")).toHaveLength("secret-token".length);
    expect(payload).not.toContain("secret-token");
  });

  it("uses a fresh IV for every message", () => {
    const first = cipher.encrypt("same");
    const second = cipher.encrypt("same");
    expect(first).not.toBe(second);
    expect(first.split(":")[1]).not.toBe(second.split(":")[1]);
  });

  it.each([
    ["the IV", 1],
    ["the auth tag", 2],
    ["the ciphertext", 3],
  ])("detects tampering with %s", (_label, index) => {
    const payload = cipher.encrypt("secret-token");
    const tampered = withPart(payload, index, flipFirstByte);
    expect(() => cipher.decrypt(tampered)).toThrow(TokenCryptoError);
  });

  it("detects a truncated ciphertext", () => {
    const payload = cipher.encrypt("secret-token");
    const truncated = withPart(payload, 3, (part) =>
      Buffer.from(part, "base64").subarray(1).toString("base64"),
    );
    expect(() => cipher.decrypt(truncated)).toThrow(TokenCryptoError);
  });

  it("refuses payloads written with another key", () => {
    const other = createTokenCipher(randomBytes(TOKEN_KEY_BYTES));
    expect(() => other.decrypt(cipher.encrypt("secret-token"))).toThrow(
      /wrong key or tampered data/,
    );
  });

  it("keeps working when the caller later mutates its key buffer", () => {
    const mutable = Buffer.from(key);
    const local = createTokenCipher(mutable);
    const payload = local.encrypt("secret-token");
    mutable.fill(0);
    expect(local.decrypt(payload)).toBe("secret-token");
  });

  it.each([
    ["plaintext", "not-encrypted"],
    ["too few parts", "v1:AAAA:BBBB"],
    ["too many parts", "v1:a:b:c:d"],
    ["an unknown version", "v2:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA"],
    ["a short IV", "v1:AAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA"],
    ["a short tag", "v1:AAAAAAAAAAAAAAAA:AAAA:AAAA"],
    ["non-base64 ciphertext", "v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:@@@@"],
  ])("rejects %s", (_label, payload) => {
    expect(() => cipher.decrypt(payload)).toThrow(TokenCryptoError);
  });

  it.each([0, 16, 31, 33, 64])("rejects a %i-byte key", (bytes) => {
    expect(() => createTokenCipher(randomBytes(bytes))).toThrow(RangeError);
  });
});
