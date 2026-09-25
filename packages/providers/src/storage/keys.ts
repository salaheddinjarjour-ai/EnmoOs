/*
 * Storage keys: relative, slash-separated paths whose segments start with a letter or digit. That
 * rules out absolute paths, empty segments and "." / ".." (so a key can never leave the local
 * storage root, even when it arrives in a /files/* URL) and keeps every key a plain S3 key.
 */

export const STORAGE_KEY_MAX_LENGTH = 512;

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class InvalidStorageKeyError extends Error {
  override readonly name = "InvalidStorageKeyError";

  constructor(readonly key: string) {
    super(`Invalid storage key: ${JSON.stringify(key.slice(0, 80))}`);
  }
}

export function isValidStorageKey(key: string): boolean {
  if (key.length === 0 || key.length > STORAGE_KEY_MAX_LENGTH) return false;
  return key.split("/").every((segment) => SEGMENT.test(segment));
}

/** Returns the key, or throws InvalidStorageKeyError. */
export function assertStorageKey(key: string): string {
  if (!isValidStorageKey(key)) throw new InvalidStorageKeyError(key);
  return key;
}

const EXTENSION_BY_MIME_TYPE: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

const MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(EXTENSION_BY_MIME_TYPE).map(([mime, ext]) => [ext, mime])),
  jpeg: "image/jpeg",
};

/** "image/png; charset=binary" → "png"; unknown types → "bin". */
export function extensionForMimeType(mimeType: string): string {
  const essence = mimeType.split(";")[0]!.trim().toLowerCase();
  return EXTENSION_BY_MIME_TYPE[essence] ?? "bin";
}

/** The content type a key's extension implies; application/octet-stream when unknown. */
export function mimeTypeForKey(key: string): string {
  const dot = key.lastIndexOf(".");
  const extension = dot === -1 ? "" : key.slice(dot + 1).toLowerCase();
  return MIME_TYPE_BY_EXTENSION[extension] ?? "application/octet-stream";
}

/**
 * Where an asset's file lives: `clients/<clientId>/assets/<assetId>.<ext>`, or
 * `…/<assetId>-poster.<ext>` for a video's poster frame. One key per Asset row: a regenerate is a
 * new row, so a URL never changes content under a cache.
 */
export function assetStorageKey(input: {
  clientId: string;
  assetId: string;
  mimeType: string;
  poster?: boolean;
}): string {
  const name = input.poster ? `${input.assetId}-poster` : input.assetId;
  return assertStorageKey(
    `clients/${input.clientId}/assets/${name}.${extensionForMimeType(input.mimeType)}`,
  );
}
