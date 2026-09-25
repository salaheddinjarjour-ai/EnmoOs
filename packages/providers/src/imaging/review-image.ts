import sharp from "sharp";
import { VISUAL_LIMITS } from "@enmo/shared";

/**
 * The Messages API takes images up to 5 MB of base64 each; a file of this many bytes encodes to
 * just under that.
 */
export const REVIEW_IMAGE_MAX_BYTES = 3_750_000;

/** Shaped like @enmo/agents' LlmImageBlock, so it can go straight into runAgent's `images`. */
export interface ReviewImage {
  type: "image";
  mediaType: "image/png" | "image/jpeg";
  /** base64 */
  data: string;
  width: number;
  height: number;
}

/**
 * A render as VISUAL_DIRECTOR.review sees it (DESIGN §C): EXIF-rotated, downscaled to a 1568px long
 * edge (never enlarged) and sent as PNG, or as JPEG when the PNG would be too big to send. Takes
 * image bytes (PNG, JPEG, WebP); review a VIDEO through its poster frame.
 */
export async function toReviewImage(
  input: Uint8Array,
  maxEdge: number = VISUAL_LIMITS.reviewImageMaxEdge,
): Promise<ReviewImage> {
  const resized = () =>
    sharp(input, { failOn: "error" })
      .rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true });

  const png = await resized().png().toBuffer({ resolveWithObject: true });
  if (png.data.length <= REVIEW_IMAGE_MAX_BYTES) {
    return {
      type: "image",
      mediaType: "image/png",
      data: png.data.toString("base64"),
      width: png.info.width,
      height: png.info.height,
    };
  }
  const jpeg = await resized()
    .flatten({ background: "#000000" })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return {
    type: "image",
    mediaType: "image/jpeg",
    data: jpeg.data.toString("base64"),
    width: jpeg.info.width,
    height: jpeg.info.height,
  };
}
