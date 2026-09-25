import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3ServiceException,
  type DeleteObjectCommand,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  InvalidStorageKeyError,
  R2_CACHE_CONTROL,
  R2Storage,
  createStorage,
  r2Endpoint,
  type R2Client,
  type R2StorageOptions,
} from "../src";

const PUBLIC_BASE = "https://assets.enmo.marketing";
const KEY = "clients/c1/assets/a1.png";
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);

const CREDENTIALS = {
  accountId: "acct123",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "not-a-real-secret",
  bucket: "enmo-assets",
  endpoint: null,
};

type Command = PutObjectCommand | GetObjectCommand | HeadObjectCommand | DeleteObjectCommand;

/** An in-memory bucket behind the R2Client interface, recording every command it gets. */
function fakeS3(options: { failWith?: Error } = {}) {
  const objects = new Map<string, { body: Uint8Array; contentType: string | undefined }>();
  const commands: Command[] = [];
  const missing = (Error: typeof NoSuchKey | typeof NotFound) =>
    new Error({ message: "missing", $metadata: { httpStatusCode: 404 } });

  const send = (command: Command): Promise<unknown> => {
    commands.push(command);
    if (options.failWith) return Promise.reject(options.failWith);
    const key = command.input.Key!;
    if (command instanceof PutObjectCommand) {
      objects.set(key, {
        body: command.input.Body as Uint8Array,
        contentType: command.input.ContentType,
      });
      return Promise.resolve({ $metadata: {} });
    }
    const object = objects.get(key);
    if (command instanceof GetObjectCommand) {
      if (!object) return Promise.reject(missing(NoSuchKey));
      const Body = { transformToByteArray: () => Promise.resolve(object.body) };
      return Promise.resolve({
        $metadata: {},
        ContentType: object.contentType,
        Body: Body as unknown as GetObjectCommandOutput["Body"],
      });
    }
    if (command instanceof HeadObjectCommand) {
      return object ? Promise.resolve({ $metadata: {} }) : Promise.reject(missing(NotFound));
    }
    objects.delete(key);
    return Promise.resolve({ $metadata: {} });
  };
  return { client: { send } as R2Client, objects, commands };
}

function storageWith(client: R2Client, overrides: Partial<R2StorageOptions> = {}): R2Storage {
  return new R2Storage({ ...CREDENTIALS, publicBaseUrl: PUBLIC_BASE, client, ...overrides });
}

describe("R2Storage with an injected client", () => {
  it("puts objects with their type and a long-lived cache header", async () => {
    const s3 = fakeS3();
    const storage = storageWith(s3.client);
    expect(await storage.put(KEY, BYTES, "image/png")).toEqual({ url: `${PUBLIC_BASE}/${KEY}` });

    const [put] = s3.commands;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put!.input).toEqual({
      Bucket: "enmo-assets",
      Key: KEY,
      Body: BYTES,
      ContentType: "image/png",
      ContentLength: BYTES.byteLength,
      CacheControl: R2_CACHE_CONTROL,
    });
  });

  it("gets, heads and deletes, treating missing objects as null / false / fine", async () => {
    const s3 = fakeS3();
    const storage = storageWith(s3.client);
    await storage.put(KEY, BYTES, "image/png");

    const stored = await storage.get(KEY);
    expect(stored?.contentType).toBe("image/png");
    expect(Buffer.isBuffer(stored?.body)).toBe(true);
    expect(new Uint8Array(stored!.body)).toEqual(BYTES);
    expect(await storage.exists(KEY)).toBe(true);

    await storage.delete(KEY);
    expect(await storage.get(KEY)).toBeNull();
    expect(await storage.exists(KEY)).toBe(false);
    await expect(storage.delete(KEY)).resolves.toBeUndefined();

    expect(s3.commands.map((command) => command.constructor.name)).toEqual([
      "PutObjectCommand",
      "GetObjectCommand",
      "HeadObjectCommand",
      "DeleteObjectCommand",
      "GetObjectCommand",
      "HeadObjectCommand",
      "DeleteObjectCommand",
    ]);
    for (const command of s3.commands) expect(command.input.Bucket).toBe("enmo-assets");
  });

  it("falls back to the key's type when the object has none", async () => {
    const s3 = fakeS3();
    s3.objects.set("x.jpg", { body: BYTES, contentType: undefined });
    expect((await storageWith(s3.client).get("x.jpg"))?.contentType).toBe("image/jpeg");
  });

  it("passes other S3 errors through", async () => {
    const denied = new S3ServiceException({
      name: "AccessDenied",
      $fault: "client",
      message: "Access Denied",
      $metadata: { httpStatusCode: 403 },
    });
    const storage = storageWith(fakeS3({ failWith: denied }).client);
    await expect(storage.get(KEY)).rejects.toBe(denied);
    await expect(storage.exists(KEY)).rejects.toBe(denied);
    await expect(storage.delete(KEY)).rejects.toBe(denied);
  });

  it("refuses invalid keys before sending anything", async () => {
    const s3 = fakeS3();
    const storage = storageWith(s3.client);
    for (const key of ["../x.png", "/abs.png", "a//b.png"]) {
      await expect(storage.put(key, BYTES, "image/png")).rejects.toThrow(InvalidStorageKeyError);
      await expect(storage.get(key)).rejects.toThrow(InvalidStorageKeyError);
      await expect(storage.exists(key)).rejects.toThrow(InvalidStorageKeyError);
      await expect(storage.delete(key)).rejects.toThrow(InvalidStorageKeyError);
      expect(() => storage.publicUrl(key)).toThrow(InvalidStorageKeyError);
    }
    expect(s3.commands).toHaveLength(0);
  });

  it("serves from R2_PUBLIC_BASE_URL", () => {
    const storage = storageWith(fakeS3().client, { publicBaseUrl: `${PUBLIC_BASE}/` });
    expect(storage.publicUrl(KEY)).toBe(`${PUBLIC_BASE}/${KEY}`);
  });
});

describe("R2Storage configuration", () => {
  it("uses the account's R2 endpoint unless R2_ENDPOINT overrides it", () => {
    expect(r2Endpoint({ accountId: "acct123", endpoint: null })).toBe(
      "https://acct123.r2.cloudflarestorage.com",
    );
    expect(r2Endpoint({ accountId: "acct123", endpoint: "http://127.0.0.1:9000" })).toBe(
      "http://127.0.0.1:9000",
    );
    expect(r2Endpoint({ accountId: null, endpoint: null })).toBeNull();
  });

  it("boots without credentials and says what's missing on first use", async () => {
    const base = { publicBaseUrl: PUBLIC_BASE, localDir: ".data/x", driver: "r2" as const };
    const noKeys = createStorage({
      ...base,
      r2: { ...CREDENTIALS, secretAccessKey: null },
    });
    await expect(noKeys.put(KEY, BYTES, "image/png")).rejects.toThrow(/R2_SECRET_ACCESS_KEY/);
    const noBucket = createStorage({ ...base, r2: { ...CREDENTIALS, bucket: null } });
    await expect(noBucket.exists(KEY)).rejects.toThrow(/R2_BUCKET/);
    // Building URLs needs no credentials at all.
    expect(noKeys.publicUrl(KEY)).toBe(`${PUBLIC_BASE}/${KEY}`);
  });
});

/*
 * The real S3Client against a tiny S3-compatible server on R2_ENDPOINT: proves the client
 * configuration (path-style addressing, signing, no checksum trailers) and the error mapping.
 */
describe("R2Storage over the S3 API", () => {
  interface Seen {
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
    body: Buffer;
  }
  const seen: Seen[] = [];
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  let server: Server;
  let endpoint: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const path = new URL(req.url!, "http://s3.local").pathname;
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
        const object = objects.get(path);
        switch (req.method ?? "") {
          case "PUT":
            objects.set(path, { body, contentType: req.headers["content-type"] ?? "" });
            res.writeHead(200, { ETag: '"etag"' }).end();
            return;
          case "GET":
            if (!object) {
              res
                .writeHead(404, { "Content-Type": "application/xml" })
                .end(
                  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>',
                );
              return;
            }
            res
              .writeHead(200, {
                "Content-Type": object.contentType,
                "Content-Length": object.body.length,
              })
              .end(object.body);
            return;
          case "HEAD":
            res.writeHead(object ? 200 : 404).end();
            return;
          case "DELETE":
            objects.delete(path);
            res.writeHead(204).end();
            return;
          default:
            res.writeHead(405).end();
            return;
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("round-trips an object through a path-style bucket", async () => {
    const storage = createStorage({
      driver: "r2",
      publicBaseUrl: PUBLIC_BASE,
      localDir: ".data/unused",
      r2: { ...CREDENTIALS, endpoint },
    });

    expect(await storage.put(KEY, BYTES, "image/png")).toEqual({ url: `${PUBLIC_BASE}/${KEY}` });
    const put = seen.at(-1)!;
    expect(put.method).toBe("PUT");
    expect(new URL(put.url, endpoint).pathname).toBe(`/enmo-assets/${KEY}`);
    expect(put.headers["content-type"]).toBe("image/png");
    expect(put.headers["cache-control"]).toBe(R2_CACHE_CONTROL);
    expect(put.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\//,
    );
    expect(put.body).toEqual(Buffer.from(BYTES));

    const stored = await storage.get(KEY);
    expect(stored).toEqual({ body: Buffer.from(BYTES), contentType: "image/png" });
    expect(await storage.exists(KEY)).toBe(true);

    await storage.delete(KEY);
    expect(await storage.get(KEY)).toBeNull();
    expect(await storage.exists(KEY)).toBe(false);
    await expect(storage.delete(KEY)).resolves.toBeUndefined();
  });
});
