import sharp from "sharp";
import type { PixelSize } from "@enmo/shared";

/*
 * A frame a platform can fetch, cut from a stored master: the centre `size` crop (cover, so
 * nothing is stretched), as a JPEG. The Publisher uses it for Instagram, which fetches JPEG only
 * and whose feed takes 4:5 to 1.91:1, until the Adapter (Phase 5) cuts frames around the focus
 * point instead of the centre.
 */

/** JPEG quality for published frames: visually lossless at 1080 wide, well under Meta's 8 MB. */
export const PUBLISH_FRAME_JPEG_QUALITY = 90;

export async function renderJpegFrame(input: Uint8Array, size: PixelSize): Promise<Buffer> {
  return sharp(input, { failOn: "error" })
    .rotate()
    .resize({ width: size.width, height: size.height, fit: "cover", position: "centre" })
    // JPEG has no alpha: a transparent pixel would otherwise come out black by accident.
    .flatten({ background: "#000000" })
    .jpeg({ quality: PUBLISH_FRAME_JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
}
