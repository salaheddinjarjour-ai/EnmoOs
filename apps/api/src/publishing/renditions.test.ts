import { PublishError, type StoredObject } from "@enmo/providers";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { cropInto, ensureRenditions, takeFrameOf, type Rendition } from "./renditions";

/* What Instagram fetches instead of a 9:16 PNG master, and how it gets into Storage. */

class MemoryStorage {
  readonly objects = new Map<string, StoredObject>();
  puts = 0;

  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(key));
  }

  get(key: string): Promise<StoredObject | null> {
    return Promise.resolve(this.objects.get(key) ?? null);
  }

  put(key: string, body: Uint8Array, contentType: string): Promise<{ url: string }> {
    this.puts += 1;
    this.objects.set(key, { body: Buffer.from(body), contentType });
    return Promise.resolve({ url: `https://files.enmo.test/${key}` });
  }
}

const MASTER_KEY = "clients/c1/assets/a1.png";
const image = { kind: "IMAGE" as const, storageKey: MASTER_KEY, mimeType: "image/png" };

async function masterPng(): Promise<Buffer> {
  // Top half red, bottom half blue: a centre crop keeps both, a top crop wouldn't.
  const half = { width: 1080, height: 960, channels: 3 as const };
  return sharp({ create: { ...half, height: 1920, background: "#0000ff" } })
    .composite([{ input: { create: { ...half, background: "#ff0000" } }, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

describe("cropInto", () => {
  it("keeps the largest centred crop inside the range", () => {
    const feed = { min: 4 / 5, max: 1.91 };
    expect(cropInto({ width: 1080, height: 1920 }, feed)).toEqual({ width: 1080, height: 1350 });
    expect(cropInto({ width: 1920, height: 1000 }, feed)).toEqual({ width: 1910, height: 1000 });
    expect(cropInto({ width: 1080, height: 1080 }, feed)).toEqual({ width: 1080, height: 1080 });
  });
});

describe("takeFrameOf", () => {
  const size = { width: 1080, height: 1920 };

  it("gives Instagram a JPEG: 4:5 in the feed, 9:16 in a story; Facebook and videos the master", () => {
    expect(takeFrameOf("INSTAGRAM", "STATIC", { ...image, ...size })).toEqual({
      kind: "rendition",
      rendition: {
        sourceKey: MASTER_KEY,
        key: "clients/c1/assets/a1-instagram-1080x1350.jpg",
        mimeType: "image/jpeg",
        width: 1080,
        height: 1350,
      },
    });
    expect(takeFrameOf("INSTAGRAM", "STORY", { ...image, ...size })).toMatchObject({
      rendition: { key: "clients/c1/assets/a1-instagram-1080x1920.jpg", height: 1920 },
    });
    expect(takeFrameOf("FACEBOOK", "STATIC", { ...image, ...size })).toEqual({ kind: "master" });
    expect(
      takeFrameOf("INSTAGRAM", "REEL", { ...image, kind: "VIDEO", mimeType: "video/mp4", ...size }),
    ).toEqual({ kind: "master" });
    expect(takeFrameOf("INSTAGRAM", "STATIC", { ...image, storageKey: null, ...size })).toEqual({
      kind: "unavailable",
      reason: "it has no stored file to cut the platform's frame from",
    });
  });
});

describe("ensureRenditions", () => {
  const rendition: Rendition = {
    sourceKey: MASTER_KEY,
    key: "clients/c1/assets/a1-instagram-1080x1350.jpg",
    mimeType: "image/jpeg",
    width: 1080,
    height: 1350,
  };

  it("writes a centre-cropped JPEG of the master once, then reuses it", async () => {
    const storage = new MemoryStorage();
    await storage.put(MASTER_KEY, await masterPng(), "image/png");
    await ensureRenditions(storage, [rendition]);
    await ensureRenditions(storage, [rendition]);
    expect(storage.puts).toBe(2);

    const stored = storage.objects.get(rendition.key)!;
    expect(stored.contentType).toBe("image/jpeg");
    const meta = await sharp(stored.body).metadata();
    expect(meta).toMatchObject({ format: "jpeg", width: 1080, height: 1350 });
    // The centre of a red-over-blue master: red at the top edge, blue at the bottom.
    const { data } = await sharp(stored.body).raw().toBuffer({ resolveWithObject: true });
    const pixel = (row: number) => [...data.subarray(row * 1080 * 3, row * 1080 * 3 + 3)];
    expect(pixel(5)[0]).toBeGreaterThan(200);
    expect(pixel(1340)[2]).toBeGreaterThan(200);
  });

  it("fails for good when the master is gone from storage", async () => {
    const error = await ensureRenditions(new MemoryStorage(), [rendition]).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PublishError);
    expect(error).toMatchObject({ code: "MEDIA_FAILED", retryable: false });
  });
});
