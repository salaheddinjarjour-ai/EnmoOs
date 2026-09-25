import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { DEFAULT_VISUAL_STYLE, defaultVisualStyle, pixelSizeFor } from "@enmo/shared";
import {
  MOCK_MAX_VIDEO_SEC,
  MockProvider,
  createVisualProvider,
  type VisualJobStatus,
  type VisualRequest,
} from "../src";

const HIGGSFIELD_UNSET = {
  keyId: null,
  keySecret: null,
  baseUrl: "https://api.higgsfield.ai",
  imageModel: null,
  videoModel: null,
};

function request(overrides: Partial<VisualRequest> = {}): VisualRequest {
  const tokens = defaultVisualStyle();
  tokens.palette.accent = "#E0A458";
  return {
    kind: "IMAGE",
    prompt: "A sweating glass of cold brew on dark marble at golden hour, dates on a brass plate",
    negativePrompt: null,
    aspectRatio: "4:5",
    durationSec: null,
    seed: 1234,
    referenceImageUrl: null,
    brand: { name: "Qahwa House", tokens },
    meta: { shotId: "s1", sceneText: "Iftar, iced.", version: 1 },
    ...overrides,
  };
}

/** Downloads the job's only output the way the render poll does: plain fetch. */
async function download(status: VisualJobStatus): Promise<{ bytes: Buffer; type: string }> {
  expect(status.state).toBe("succeeded");
  expect(status.outputs).toHaveLength(1);
  const [output] = status.outputs!;
  expect(output!.url).toMatch(/^data:image\/png;base64,/);
  const response = await fetch(output!.url);
  expect(response.ok).toBe(true);
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    type: response.headers.get("content-type") ?? "",
  };
}

describe("MockProvider", () => {
  it("renders images and (as posters) video up to its clip limit", () => {
    expect(new MockProvider().capabilities()).toEqual({
      image: true,
      video: true,
      maxVideoSec: MOCK_MAX_VIDEO_SEC,
    });
    expect(createVisualProvider({ provider: "mock", higgsfield: HIGGSFIELD_UNSET }).name).toBe(
      "mock",
    );
  });

  it("reports running on the first poll and a PNG of the shot's size on the second", async () => {
    const provider = new MockProvider();
    const { jobId, model } = await provider.submit(request());
    expect(jobId).toMatch(/^mock_[A-Za-z0-9_-]+$/);
    expect(model).toBeNull();

    expect(await provider.status(jobId)).toEqual({ state: "running" });
    const { bytes, type } = await download(await provider.status(jobId));
    expect(type).toBe("image/png");
    const meta = await sharp(bytes).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 1080, 1350]);

    // Settled jobs stay settled.
    expect((await provider.status(jobId)).state).toBe("succeeded");
  });

  it("answers for a job another process submitted, with the same bytes", async () => {
    const api = new MockProvider();
    const worker = new MockProvider();
    const { jobId } = await api.submit(request({ aspectRatio: "9:16" }));

    await api.status(jobId);
    const fromApi = await download(await api.status(jobId));
    expect((await worker.status(jobId)).state).toBe("running");
    const fromWorker = await download(await worker.status(jobId));

    expect(fromWorker.bytes.equals(fromApi.bytes)).toBe(true);
    const meta = await sharp(fromWorker.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1920]);
  });

  it("gives every submit its own job, and identical requests identical renders", async () => {
    const provider = new MockProvider({ pollsBeforeSuccess: 0 });
    const first = await provider.submit(request());
    const second = await provider.submit(request());
    expect(first.jobId).not.toBe(second.jobId);

    const a = await download(await provider.status(first.jobId));
    const b = await download(await provider.status(second.jobId));
    expect(a.bytes.equals(b.bytes)).toBe(true);

    // A regenerated take (a new version with a revised prompt) looks different.
    const retake = await provider.submit(
      request({ prompt: "Overhead shot, crushed ice", meta: { ...request().meta, version: 2 } }),
    );
    const c = await download(await provider.status(retake.jobId));
    expect(c.bytes.equals(a.bytes)).toBe(false);
  });

  it("answers a VIDEO shot with a 9:16 poster PNG", async () => {
    const provider = new MockProvider({ pollsBeforeSuccess: 0 });
    const { jobId } = await provider.submit(
      request({ kind: "VIDEO", aspectRatio: "9:16", durationSec: 3.5 }),
    );
    const status = await provider.status(jobId);
    expect(status.outputs?.[0]?.mimeType).toBe("image/png");
    const meta = await sharp((await download(status)).bytes).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 1080, 1920]);
  });

  it("refuses clips longer than it claims to render", async () => {
    await expect(
      new MockProvider().submit(
        request({ kind: "VIDEO", aspectRatio: "9:16", durationSec: MOCK_MAX_VIDEO_SEC + 1 }),
      ),
    ).rejects.toThrow(RangeError);
  });

  it("paints from the brand's palette", async () => {
    const provider = new MockProvider({ pollsBeforeSuccess: 0 });
    const tokens = { ...DEFAULT_VISUAL_STYLE, palette: { ...DEFAULT_VISUAL_STYLE.palette } };
    tokens.palette.background = "#0B3D2E";
    const green = await provider.submit(request({ brand: { name: "Verde", tokens } }));
    const grey = await provider.submit(
      request({ brand: { name: "Verde", tokens: defaultVisualStyle() } }),
    );
    const [greenStats, greyStats] = await Promise.all(
      [green, grey].map(async ({ jobId }) =>
        sharp((await download(await provider.status(jobId))).bytes).stats(),
      ),
    );
    const [red, greenChannel] = greenStats!.channels;
    expect(greenChannel!.mean).toBeGreaterThan(red!.mean + 10);
    const [greyRed, greyGreen] = greyStats!.channels;
    expect(Math.abs(greyGreen!.mean - greyRed!.mean)).toBeLessThan(10);
  });

  it("polls as many times as configured before settling", async () => {
    const provider = new MockProvider({ pollsBeforeSuccess: 3 });
    const { jobId } = await provider.submit(request({ aspectRatio: "1:1" }));
    for (let poll = 0; poll < 3; poll++)
      expect((await provider.status(jobId)).state).toBe("running");
    const meta = await sharp((await download(await provider.status(jobId))).bytes).metadata();
    const size = pixelSizeFor("1:1");
    expect([meta.width, meta.height]).toEqual([size.width, size.height]);
  });

  it("ends jobs the outcome hook picks as failed or rejected, after the same polls", async () => {
    const provider = new MockProvider({
      outcome: (req) =>
        req.meta.shotId === "s2"
          ? { state: "rejected", error: "content filter" }
          : req.meta.shotId === "s3"
            ? { state: "failed", error: "GPU on fire" }
            : null,
    });
    const rejected = await provider.submit(request({ meta: { ...request().meta, shotId: "s2" } }));
    const failed = await provider.submit(request({ meta: { ...request().meta, shotId: "s3" } }));

    expect(await provider.status(rejected.jobId)).toEqual({ state: "running" });
    expect(await provider.status(rejected.jobId)).toEqual({
      state: "rejected",
      error: "content filter",
    });
    await provider.status(failed.jobId);
    // The outcome travels in the job id, so another process sees it too.
    const other = new MockProvider();
    await other.status(failed.jobId);
    expect(await other.status(failed.jobId)).toEqual({ state: "failed", error: "GPU on fire" });
  });

  it("fails job ids it didn't issue instead of throwing", async () => {
    const provider = new MockProvider({ pollsBeforeSuccess: 0 });
    for (const jobId of ["req_123", "mock_", "mock_not-deflate", `mock_${"A".repeat(40)}`]) {
      const status = await provider.status(jobId);
      expect(status.state, jobId).toBe("failed");
      expect(status.error).toMatch(/no job/);
    }
  });

  it("rejects a negative poll count at construction", () => {
    expect(() => new MockProvider({ pollsBeforeSuccess: -1 })).toThrow(RangeError);
  });
});
