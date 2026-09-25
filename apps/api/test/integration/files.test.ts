import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { assetStorageKey } from "@enmo/providers";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, TEST_ORIGIN, type TestApp } from "../helpers/app";

/*
 * GET|HEAD /files/* (DESIGN §E "realtime and files", §F "Storage"): the local driver's files,
 * public, served from STORAGE_LOCAL_DIR at the URLs LocalStorage.publicUrl hands out. Only a URL
 * that spells a valid storage key reaches the disk.
 */

const CLIENT_ID = "cmclient0000000000000000a";
const ASSET_ID = "cmasset00000000000000000a";
/** Written beside (outside) the storage root; no URL may ever return it. */
const SECRET = "TOP-SECRET-OUTSIDE-THE-ROOT";

let t: TestApp;
let sandbox: string;
let root: string;
let png: Buffer;
let pngKey: string;
let pngPath: string;

beforeAll(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "enmo-files-test-"));
  root = path.join(sandbox, "assets");
  await mkdir(root);
  await writeFile(path.join(sandbox, "secret.png"), SECRET);
  await writeFile(path.join(sandbox, "passwd"), SECRET);

  t = await buildTestApp({ env: { STORAGE_LOCAL_DIR: root } });

  png = await sharp({
    create: { width: 8, height: 10, channels: 3, background: "#0E7C66" },
  })
    .png()
    .toBuffer();
  pngKey = assetStorageKey({ clientId: CLIENT_ID, assetId: ASSET_ID, mimeType: "image/png" });
  const { url } = await t.deps.storage.put(pngKey, png, "image/png");
  pngPath = new URL(url).pathname;
});

afterAll(async () => {
  await t.close();
  await rm(sandbox, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) =>
  t.app.inject({ method: "GET", url, headers });

interface RawResponse {
  status: number;
  contentType: string;
  body: string;
}

let listening: Promise<string> | undefined;

/** The app's origin on a real port (inject() would parse and normalise the URLs under test). */
function realOrigin(): Promise<string> {
  return (listening ??= t.app.listen({ host: "127.0.0.1", port: 0 }));
}

/** A GET whose path goes on the wire exactly as written: no URL parsing, no normalisation. */
function rawGet(origin: string, rawPath: string): Promise<RawResponse> {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname, port, path: rawPath, method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          contentType: response.headers["content-type"] ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

describe("serving a stored file", () => {
  it("answers at the URL Storage handed out, without a session", async () => {
    expect(pngPath).toBe(`/files/${pngKey}`);
    const response = await get(pngPath);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.rawPayload.equals(png)).toBe(true);
    expect(response.headers).toMatchObject({
      "content-type": "image/png",
      "content-length": String(png.length),
      "cache-control": "public, max-age=31536000, immutable",
      "cross-origin-resource-policy": "cross-origin",
      "x-content-type-options": "nosniff",
      "accept-ranges": "bytes",
    });
    expect(response.headers.etag).toEqual(expect.any(String));
    const metadata = await sharp(response.rawPayload).metadata();
    expect(metadata).toMatchObject({ format: "png", width: 8, height: 10 });
  });

  it("answers HEAD with the headers and no body", async () => {
    const response = await t.app.inject({ method: "HEAD", url: pngPath });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("");
    expect(response.headers).toMatchObject({
      "content-type": "image/png",
      "content-length": String(png.length),
      "cache-control": "public, max-age=31536000, immutable",
    });
  });

  it("takes the content type from the key's extension", async () => {
    const cases = [
      { mimeType: "image/jpeg", ext: "jpg" },
      { mimeType: "image/webp", ext: "webp" },
      { mimeType: "video/mp4", ext: "mp4" },
    ];
    for (const { mimeType, ext } of cases) {
      const key = assetStorageKey({ clientId: CLIENT_ID, assetId: `cmtype${ext}`, mimeType });
      expect(key.endsWith(`.${ext}`)).toBe(true);
      await t.deps.storage.put(key, Buffer.from(`bytes of ${ext}`), mimeType);
      const response = await get(`/files/${key}`);
      expect(response.statusCode, key).toBe(200);
      expect(response.headers["content-type"], key).toBe(mimeType);
    }

    const unknownKey = `clients/${CLIENT_ID}/assets/cmunknown.bin`;
    await t.deps.storage.put(unknownKey, Buffer.from("opaque"), "application/octet-stream");
    const unknown = await get(`/files/${unknownKey}`);
    expect(unknown.headers["content-type"]).toBe("application/octet-stream");
  });

  it("serves byte ranges (video scrubbing) and conditional GETs", async () => {
    const key = assetStorageKey({ clientId: CLIENT_ID, assetId: "cmclip", mimeType: "video/mp4" });
    await t.deps.storage.put(key, Buffer.from("0123456789"), "video/mp4");

    const partial = await get(`/files/${key}`, { range: "bytes=2-5" });
    expect(partial.statusCode).toBe(206);
    expect(partial.body).toBe("2345");
    expect(partial.headers["content-range"]).toBe("bytes 2-5/10");
    expect(partial.headers["content-type"]).toBe("video/mp4");

    const first = await get(`/files/${key}`);
    const etag = String(first.headers.etag);
    const revalidated = await get(`/files/${key}`, { "if-none-match": etag });
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.body).toBe("");
  });

  it("lets the web origin read it cross-origin", async () => {
    const response = await get(pngPath, { origin: TEST_ORIGIN });
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(TEST_ORIGIN);
    expect(String(response.headers.vary)).toMatch(/origin/i);
  });
});

describe("refusals", () => {
  const expectNotFound = (response: Awaited<ReturnType<typeof get>>, label: string) => {
    expect(response.statusCode, `${label} → ${response.body}`).toBe(404);
    expect(response.json(), label).toEqual({
      error: { code: "NOT_FOUND", message: "File not found" },
    });
    // A missing file may still be written (a render in flight): never cache its absence.
    expect(response.headers["cache-control"], label).toBe("no-store");
  };

  it("answers 404 for a valid key with no file, uncached", async () => {
    const key = assetStorageKey({
      clientId: CLIENT_ID,
      assetId: "cmmissing",
      mimeType: "image/png",
    });
    expectNotFound(await get(`/files/${key}`), "missing");
    const head = await t.app.inject({ method: "HEAD", url: `/files/${key}` });
    expect(head.statusCode).toBe(404);
  });

  it("never lists or indexes a directory", async () => {
    for (const url of [
      `/files/clients/${CLIENT_ID}/assets`,
      `/files/clients/${CLIENT_ID}/assets/`,
      `/files/clients/${CLIENT_ID}`,
      "/files/clients",
      "/files/",
      "/files",
    ]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(404);
      expect(response.body, url).not.toContain(ASSET_ID);
    }
  });

  it("never serves a dotfile, such as LocalStorage's half-written temp files", async () => {
    const dir = path.join(root, "clients", CLIENT_ID, "assets");
    await writeFile(path.join(dir, `.${ASSET_ID}.png.tmp`), png);
    expectNotFound(await get(`/files/clients/${CLIENT_ID}/assets/.${ASSET_ID}.png.tmp`), "dotfile");
  });

  it("keeps every traversal attempt inside the storage root, over a real socket", async () => {
    // inject() parses the URL (collapsing "..", "%2e%2e"); a raw request reaches the router as sent.
    const attempts = [
      "/files/../secret.png",
      "/files/..%2Fsecret.png",
      "/files/%2e%2e/secret.png",
      "/files/%2e%2e%2fsecret.png",
      "/files/%2E%2E%2Fpasswd",
      "/files/.%2e/secret.png",
      "/files/%252e%252e%252fsecret.png",
      "/files/clients/../../secret.png",
      `/files/clients/${CLIENT_ID}/../../../secret.png`,
      `/files/clients/${CLIENT_ID}/%2e%2e/%2e%2e/%2e%2e/secret.png`,
      "/files/clients%2F..%2F..%2Fsecret.png",
      "/files/..%5c..%5csecret.png",
      "/files/..\\secret.png",
      "/files/./secret.png",
      `/files/${encodeURIComponent(path.join(sandbox, "secret.png"))}`,
      `/files/${path.join(sandbox, "secret.png")}`,
      "/files//etc/passwd",
      "/files/%2Fetc%2Fpasswd",
      "/files/secret.png%00.png",
      `/files/clients/${CLIENT_ID}/assets/${ASSET_ID}.png%00`,
      // Even a detour that would land back on a real file inside the root.
      `/files/clients/elsewhere/../${CLIENT_ID}/assets/${ASSET_ID}.png`,
      `/files/clients/${CLIENT_ID}/./assets/${ASSET_ID}.png`,
    ];
    const origin = await realOrigin();
    for (const url of attempts) {
      const response = await rawGet(origin, url);
      const label = `${url} → ${response.status} ${response.body}`;
      expect(response.status, label).toBe(404);
      expect(response.contentType, label).toMatch(/^application\/json/);
      expect(JSON.parse(response.body), label).toEqual({
        error: { code: "NOT_FOUND", message: "File not found" },
      });
    }
    // The same socket serves the real file, so the refusals above came from the route itself.
    const served = await rawGet(origin, pngPath);
    expect(served.status).toBe(200);
    expect(served.contentType).toBe("image/png");
  });

  it("answers a malformed percent-encoding in the usual error shape", async () => {
    const origin = await realOrigin();
    for (const url of ["/files/%zz", `/files/clients/${CLIENT_ID}/assets/%E0%A4%A.png`]) {
      const response = await rawGet(origin, url);
      const label = `${url} → ${response.status} ${response.body}`;
      expect(response.status, label).toBe(400);
      expect(response.contentType, label).toMatch(/^application\/json/);
      expect(JSON.parse(response.body), label).toMatchObject({
        error: {
          code: "BAD_REQUEST",
          message: expect.stringContaining("not a valid url") as unknown,
        },
      });
    }
  });

  it("only serves a key at its canonical URL", async () => {
    const variants = {
      "encoded slashes": `/files/${pngKey.replaceAll("/", "%2F")}`,
      "encoded dot": `/files/${pngKey.replace(".png", "%2Epng")}`,
      "encoded letter": `/files/${pngKey.replace("clients", "%63lients")}`,
      "trailing slash": `${pngPath}/`,
      "doubled slash": `/files/${pngKey.replace("/assets/", "/assets//")}`,
    };
    for (const [label, url] of Object.entries(variants)) expectNotFound(await get(url), label);
    expect((await get(`${pngPath}?v=2`)).statusCode).toBe(200);
  });

  it("only answers reads", async () => {
    for (const method of ["POST", "PUT", "DELETE"] as const) {
      const response = await t.app.inject({
        method,
        url: pngPath,
        headers: { origin: TEST_ORIGIN },
      });
      expect(response.statusCode, method).toBe(404);
    }
    expect((await get(pngPath)).rawPayload.equals(png)).toBe(true);
  });
});

describe("before anything was stored", () => {
  it("answers 404 while STORAGE_LOCAL_DIR doesn't exist yet", async () => {
    const fresh = await buildTestApp({
      env: { STORAGE_LOCAL_DIR: path.join(sandbox, "never-created") },
    });
    try {
      const response = await fresh.app.inject({ method: "GET", url: `/files/${pngKey}` });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: { code: "NOT_FOUND", message: "File not found" } });
    } finally {
      await fresh.close();
    }
  });
});

describe("with STORAGE_DRIVER=r2", () => {
  it("does not mount /files at all: R2 serves the assets", async () => {
    const r2 = await buildTestApp({
      env: {
        STORAGE_DRIVER: "r2",
        R2_ACCOUNT_ID: "test-account",
        R2_ACCESS_KEY_ID: "test-key",
        R2_SECRET_ACCESS_KEY: "test-secret",
        R2_BUCKET: "enmo-test",
      },
    });
    try {
      expect(r2.app.routeAccess.some(({ url }) => url.startsWith("/files"))).toBe(false);
      const response = await r2.app.inject({ method: "GET", url: `/files/${pngKey}` });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    } finally {
      await r2.close();
    }
  });
});
