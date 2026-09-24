import { createHash, randomBytes } from "node:crypto";

/** URL-safe random secret (session cookies, invite links, OAuth state). 32 bytes = 256 bits. */
export function randomToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 16) throw new RangeError("Use at least 16 random bytes");
  return randomBytes(bytes).toString("base64url");
}

/** Hex sha256; the database stores this instead of raw tokens so a leaked row cannot be replayed. */
export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}
