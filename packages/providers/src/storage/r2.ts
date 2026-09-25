import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type DeleteObjectCommandOutput,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
  type PutObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { assertStorageKey, mimeTypeForKey } from "./keys";
import type { Storage, StoredObject } from "./types";

/*
 * Cloudflare R2 through the S3 API (@aws-sdk/client-s3, region "auto", endpoint
 * https://<accountId>.r2.cloudflarestorage.com unless R2_ENDPOINT overrides it), served publicly
 * from https://assets.enmo.marketing. The S3 client is built on first use, so a process without
 * R2 credentials boots and only fails when it actually stores something.
 */

export interface R2Config {
  accountId: string | null;
  accessKeyId: string | null;
  secretAccessKey: string | null;
  bucket: string | null;
  /** R2_ENDPOINT: an S3-compatible endpoint that replaces the account's R2 one (tests). */
  endpoint: string | null;
}

/** The S3 calls R2Storage makes; S3Client satisfies it, and tests pass a fake. */
export interface R2Client {
  send(command: PutObjectCommand): Promise<PutObjectCommandOutput>;
  send(command: GetObjectCommand): Promise<GetObjectCommandOutput>;
  send(command: HeadObjectCommand): Promise<HeadObjectCommandOutput>;
  send(command: DeleteObjectCommand): Promise<DeleteObjectCommandOutput>;
}

export interface R2StorageOptions extends R2Config {
  /** R2_PUBLIC_BASE_URL, https://assets.enmo.marketing by default. */
  publicBaseUrl: string;
  /** Replaces the S3Client built from the credentials (tests). */
  client?: R2Client;
}

/**
 * Every key names one immutable file (a regenerate is a new Asset row with a new key), so the
 * public CDN and browsers may cache it for good.
 */
export const R2_CACHE_CONTROL = "public, max-age=31536000, immutable";

export class R2Storage implements Storage {
  readonly driver = "r2" as const;
  readonly options: R2StorageOptions;
  #client: R2Client | undefined;

  constructor(options: R2StorageOptions) {
    this.options = options;
    this.#client = options.client;
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<{ url: string }> {
    await this.#s3().send(
      new PutObjectCommand({
        Bucket: this.#bucket(),
        Key: assertStorageKey(key),
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
        CacheControl: R2_CACHE_CONTROL,
      }),
    );
    return { url: this.publicUrl(key) };
  }

  async get(key: string): Promise<StoredObject | null> {
    const command = new GetObjectCommand({ Bucket: this.#bucket(), Key: assertStorageKey(key) });
    let output: GetObjectCommandOutput;
    try {
      output = await this.#s3().send(command);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const bytes = (await output.Body?.transformToByteArray()) ?? new Uint8Array();
    return {
      body: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      contentType: output.ContentType ?? mimeTypeForKey(key),
    };
  }

  publicUrl(key: string): string {
    return `${this.options.publicBaseUrl.replace(/\/+$/, "")}/${assertStorageKey(key)}`;
  }

  async delete(key: string): Promise<void> {
    const command = new DeleteObjectCommand({ Bucket: this.#bucket(), Key: assertStorageKey(key) });
    try {
      await this.#s3().send(command);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    const command = new HeadObjectCommand({ Bucket: this.#bucket(), Key: assertStorageKey(key) });
    try {
      await this.#s3().send(command);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  #bucket(): string {
    if (!this.options.bucket) throw new Error("R2Storage needs R2_BUCKET");
    return this.options.bucket;
  }

  #s3(): R2Client {
    this.#client ??= createR2Client(this.options);
    return this.#client;
  }
}

/** R2_ENDPOINT when set, else the account's own R2 endpoint; null without either. */
export function r2Endpoint(config: Pick<R2Config, "accountId" | "endpoint">): string | null {
  if (config.endpoint) return config.endpoint;
  return config.accountId ? `https://${config.accountId}.r2.cloudflarestorage.com` : null;
}

function createR2Client(config: R2Config): S3Client {
  const { accessKeyId, secretAccessKey } = config;
  const endpoint = r2Endpoint(config);
  if (!accessKeyId || !secretAccessKey || !endpoint) {
    throw new Error("R2Storage needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY");
  }
  return new S3Client({
    region: "auto",
    endpoint,
    // Path-style works on R2 and on every S3-compatible store an R2_ENDPOINT may point at.
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    // The SDK's default CRC32 checksums aren't supported by every S3-compatible store.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

/** GetObject/DeleteObject say NoSuchKey, HeadObject (no body) only NotFound or a bare 404. */
function isNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "NoSuchKey" || error.name === "NotFound") return true;
  const metadata = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return metadata?.httpStatusCode === 404;
}
