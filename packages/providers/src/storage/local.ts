import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertStorageKey, mimeTypeForKey } from "./keys";
import type { Storage, StoredObject } from "./types";

/*
 * Local disk storage: files under `dir`, served by the API at /files/* (STORAGE_DRIVER=local, dev
 * and tests). Keys are validated before they touch the filesystem, so none can leave `dir`. Writes
 * go to a temporary file beside the target and are renamed into place, so a reader (or a crash)
 * never sees half a file. The disk keeps no content type: it follows from the key's extension,
 * which assetStorageKey derives from the type the file was stored with.
 */

export interface LocalStorageOptions {
  /** STORAGE_LOCAL_DIR, resolved against the process's working directory. */
  dir: string;
  /** `${API_PUBLIC_URL}/files` unless PUBLIC_ASSET_BASE_URL overrides it. */
  publicBaseUrl: string;
}

/** Filesystem errors that mean "there is no object under this key". */
const MISSING = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);

export class LocalStorage implements Storage {
  readonly driver = "local" as const;
  readonly options: LocalStorageOptions;
  /** Absolute root; resolving is string work only, so construction still does no I/O. */
  readonly root: string;

  constructor(options: LocalStorageOptions) {
    this.options = options;
    this.root = path.resolve(options.dir);
  }

  async put(key: string, body: Uint8Array, _contentType: string): Promise<{ url: string }> {
    const file = this.#pathFor(key);
    await mkdir(path.dirname(file), { recursive: true });
    // Dot-prefixed, so a temp file can never be a valid key (and never be served).
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, body);
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return { url: this.publicUrl(key) };
  }

  async get(key: string): Promise<StoredObject | null> {
    const file = this.#pathFor(key);
    try {
      return { body: await readFile(file), contentType: mimeTypeForKey(key) };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  publicUrl(key: string): string {
    return `${this.options.publicBaseUrl.replace(/\/+$/, "")}/${assertStorageKey(key)}`;
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.#pathFor(key));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.#pathFor(key))).isFile();
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  #pathFor(key: string): string {
    const file = path.join(this.root, ...assertStorageKey(key).split("/"));
    // assertStorageKey already rules out traversal; this keeps the guarantee local to the join.
    const relative = path.relative(this.root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Storage key escapes the storage root: ${key}`);
    }
    return file;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && MISSING.has(String(error.code));
}
