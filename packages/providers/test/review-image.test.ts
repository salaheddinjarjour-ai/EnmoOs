import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { VISUAL_LIMITS } from "@enmo/shared";
import { REVIEW_IMAGE_MAX_BYTES, toReviewImage } from "../src";

function solid(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#4A3728" } })
    .png()
    .toBuffer();
}

describe("toReviewImage", () => {
  it("downscales a 9:16 render to a 1568px long edge as base64 PNG", async () => {
    const image = await toReviewImage(await solid(1080, 1920));
    expect(image).toMatchObject({
      type: "image",
      mediaType: "image/png",
      width: 882,
      height: 1568,
    });
    expect(Math.max(image.width, image.height)).toBe(VISUAL_LIMITS.reviewImageMaxEdge);
    const decoded = await sharp(Buffer.from(image.data, "base64")).metadata();
    expect([decoded.format, decoded.width, decoded.height]).toEqual(["png", 882, 1568]);
  });

  it("never enlarges a small render", async () => {
    const image = await toReviewImage(await solid(400, 500));
    expect([image.width, image.height]).toEqual([400, 500]);
  });

  it("falls back to JPEG when the PNG would exceed the API's image limit", async () => {
    const noise = await sharp({
      create: {
        width: 1568,
        height: 1568,
        channels: 3,
        background: "#000000",
        noise: { type: "gaussian", mean: 128, sigma: 90 },
      },
    })
      .png()
      .toBuffer();
    expect(noise.length).toBeGreaterThan(REVIEW_IMAGE_MAX_BYTES);
    const image = await toReviewImage(noise);
    expect(image.mediaType).toBe("image/jpeg");
    expect(Buffer.from(image.data, "base64").length).toBeLessThanOrEqual(REVIEW_IMAGE_MAX_BYTES);
    expect((await sharp(Buffer.from(image.data, "base64")).metadata()).format).toBe("jpeg");
  });

  it("rejects bytes that aren't an image", async () => {
    await expect(toReviewImage(Buffer.from("not an image"))).rejects.toThrow();
  });
});
