import type { StorageDriver } from "@enmo/shared";

/*
 * Where rendered files live (DESIGN §F): local disk served by the API at /files/* in dev and
 * tests, Cloudflare R2 behind https://assets.enmo.marketing in production (Render's disk is
 * ephemeral, and Meta and TikTok pull media from public URLs). Keys are relative slash-separated
 * paths checked by isValidStorageKey (./keys.ts); every method rejects any other key.
 */

export interface StoredObject {
  body: Buffer;
  contentType: string;
}

export interface Storage {
  readonly driver: StorageDriver;
  /** Writes (or overwrites) the object and returns its public URL. */
  put(key: string, body: Uint8Array, contentType: string): Promise<{ url: string }>;
  /** The object, or null when there is none under `key`. */
  get(key: string): Promise<StoredObject | null>;
  /** The URL the object is (or will be) served at; pure string work, no I/O. */
  publicUrl(key: string): string;
  /** Removes the object; removing a missing one is not an error. */
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}
