import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/*
 * At-rest encryption for social platform tokens (SocialAccount.accessTokenEnc / refreshTokenEnc).
 *
 * Format: `v1:<iv>:<tag>:<ciphertext>`, each part standard base64. AES-256-GCM with a random
 * 12-byte IV per message and a 16-byte auth tag, so any change to the stored string (or a wrong
 * key) makes decryption throw instead of returning garbage. The version prefix leaves room for key
 * rotation or a new scheme without guessing at stored values.
 */

export const TOKEN_KEY_BYTES = 32;
const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Decryption failed: malformed payload, unknown version, wrong key or tampered data. */
export class TokenCryptoError extends Error {
  override readonly name = "TokenCryptoError";
}

export interface TokenCipher {
  encrypt(plaintext: string): string;
  /** Throws TokenCryptoError unless `payload` was produced by `encrypt` with the same key. */
  decrypt(payload: string): string;
}

/** `key` is the decoded TOKEN_ENC_KEY (config.ts accepts base64 or hex and decodes it). */
export function createTokenCipher(key: Uint8Array): TokenCipher {
  if (key.byteLength !== TOKEN_KEY_BYTES) {
    throw new RangeError(
      `Token encryption key must be ${TOKEN_KEY_BYTES} bytes, got ${key.byteLength}`,
    );
  }
  // Copied so later mutation of the caller's buffer cannot change the key.
  const secret = Buffer.from(key);

  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, secret, iv, { authTagLength: TAG_BYTES });
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv, tag, ciphertext].map(encodePart).join(":");
    },

    decrypt(payload) {
      const { iv, tag, ciphertext } = parsePayload(payload);
      const decipher = createDecipheriv(ALGORITHM, secret, iv, { authTagLength: TAG_BYTES });
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch (error) {
        throw new TokenCryptoError("Token could not be decrypted (wrong key or tampered data)", {
          cause: error,
        });
      }
    },
  };
}

function encodePart(part: string | Buffer): string {
  return typeof part === "string" ? part : part.toString("base64");
}

function decodePart(value: string, label: string, expectedBytes?: number): Buffer {
  if (!BASE64.test(value)) throw new TokenCryptoError(`Encrypted token has an invalid ${label}`);
  const bytes = Buffer.from(value, "base64");
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
    throw new TokenCryptoError(`Encrypted token has an invalid ${label}`);
  }
  return bytes;
}

function parsePayload(payload: string) {
  const parts = payload.split(":");
  if (parts.length !== 4) throw new TokenCryptoError("Encrypted token is malformed");
  const [version = "", iv = "", tag = "", ciphertext = ""] = parts;
  if (version !== VERSION) {
    throw new TokenCryptoError(`Unsupported encrypted token version "${version.slice(0, 8)}"`);
  }
  return {
    iv: decodePart(iv, "IV", IV_BYTES),
    tag: decodePart(tag, "auth tag", TAG_BYTES),
    ciphertext: decodePart(ciphertext, "ciphertext"),
  };
}
