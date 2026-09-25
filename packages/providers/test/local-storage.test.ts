import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidStorageKeyError, LocalStorage, assetStorageKey } from "../src";

const PUBLIC_BASE = "http://localhost:4000/files";

let sandbox: string;
let root: string;
let storage: LocalStorage;

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "enmo-local-storage-"));
  root = path.join(sandbox, "assets");
  storage = new LocalStorage({ dir: root, publicBaseUrl: PUBLIC_BASE });
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("LocalStorage", () => {
  it("round-trips a file under its key and serves it from the public base URL", async () => {
    const key = assetStorageKey({ clientId: "c1", assetId: "a1", mimeType: "image/png" });
    expect(await storage.put(key, png, "image/png")).toEqual({
      url: `${PUBLIC_BASE}/clients/c1/assets/a1.png`,
    });
    expect(await readFile(path.join(root, "clients", "c1", "assets", "a1.png"))).toEqual(png);
    expect(await storage.exists(key)).toBe(true);
    expect(await storage.get(key)).toEqual({ body: png, contentType: "image/png" });
    expect(storage.publicUrl(key)).toBe(`${PUBLIC_BASE}/clients/c1/assets/a1.png`);
  });

  it("answers null / false for missing keys, and deleting one is not an error", async () => {
    expect(await storage.get("clients/c1/assets/missing.png")).toBeNull();
    expect(await storage.exists("clients/c1/assets/missing.png")).toBe(false);
    await expect(storage.delete("clients/c1/assets/missing.png")).resolves.toBeUndefined();

    // A key naming a directory (or passing through a file) is no object either.
    await storage.put("clients/c1/a.png", png, "image/png");
    expect(await storage.get("clients/c1")).toBeNull();
    expect(await storage.exists("clients")).toBe(false);
    expect(await storage.get("clients/c1/a.png/b.png")).toBeNull();
    await expect(storage.delete("clients/c1")).resolves.toBeUndefined();
  });

  it("deletes a stored file", async () => {
    await storage.put("x/y.jpg", png, "image/jpeg");
    await storage.delete("x/y.jpg");
    expect(await storage.exists("x/y.jpg")).toBe(false);
    expect(await storage.get("x/y.jpg")).toBeNull();
  });

  it("overwrites through a temporary file, leaving nothing half-written behind", async () => {
    const key = "clients/c1/assets/a1.png";
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => storage.put(key, Buffer.alloc(4096, i), "image/png")),
    );
    const stored = (await storage.get(key))!.body;
    expect(stored).toHaveLength(4096);
    expect(new Set(stored).size).toBe(1);
    expect(await readdir(path.join(root, "clients", "c1", "assets"))).toEqual(["a1.png"]);
  });

  it("refuses keys that could leave the root, before touching the disk", async () => {
    await mkdir(root, { recursive: true });
    for (const key of ["../escape.png", "/etc/passwd", "a/../../escape.png", "a\\..\\b", ".env"]) {
      await expect(storage.put(key, png, "image/png"), key).rejects.toThrow(InvalidStorageKeyError);
      await expect(storage.get(key), key).rejects.toThrow(InvalidStorageKeyError);
      await expect(storage.exists(key), key).rejects.toThrow(InvalidStorageKeyError);
      await expect(storage.delete(key), key).rejects.toThrow(InvalidStorageKeyError);
      expect(() => storage.publicUrl(key), key).toThrow(InvalidStorageKeyError);
    }
    expect(existsSync(path.join(sandbox, "escape.png"))).toBe(false);
    expect(await readdir(sandbox)).toEqual(["assets"]);
  });

  it("resolves a relative dir against the working directory without touching the disk", () => {
    const relative = new LocalStorage({
      dir: ".data/never-created",
      publicBaseUrl: `${PUBLIC_BASE}/`,
    });
    expect(relative.root).toBe(path.resolve(".data/never-created"));
    expect(existsSync(relative.root)).toBe(false);
    expect(relative.publicUrl("a.png")).toBe(`${PUBLIC_BASE}/a.png`);
  });

  it("takes its content type from the key's extension", async () => {
    await storage.put("clip.mp4", png, "video/mp4");
    await storage.put("blob", png, "application/octet-stream");
    expect((await storage.get("clip.mp4"))?.contentType).toBe("video/mp4");
    expect((await storage.get("blob"))?.contentType).toBe("application/octet-stream");
  });
});
