import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultVisualStyle } from "@enmo/shared";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  HiggsfieldProvider,
  LocalStorage,
  MockProvider,
  assetStorageKey,
  createVisualProvider,
  downloadOutput,
  type VisualJobStatus,
  type VisualProvider,
  type VisualProviderConfig,
  type VisualRequest,
} from "../src";

/*
 * The provider swap (DESIGN §F): the pipeline's render loop, reduced to its provider calls, runs
 * unchanged whichever provider createVisualProvider picks for VISUAL_PROVIDER. Here it drives the
 * real HiggsfieldProvider against a fake Higgsfield behind an injected fetch (submit → status polls
 * → completed → the output downloaded into Storage), then the MockProvider the same way.
 */

const BASE_URL = "https://hf.fake.test";
const CDN = "https://cdn.hf.fake.test";

const higgsfield: VisualProviderConfig["higgsfield"] = {
  keyId: "kid",
  keySecret: "ksecret",
  baseUrl: BASE_URL,
  imageModel: "higgsfield-ai/soul/standard",
  videoModel: null,
};

const request: VisualRequest = {
  kind: "IMAGE",
  prompt: "Iced cardamom latte on dark marble, lamp light",
  negativePrompt: null,
  aspectRatio: "9:16",
  durationSec: null,
  seed: 7,
  referenceImageUrl: null,
  brand: { name: "Qahwa House", tokens: defaultVisualStyle() },
  meta: { shotId: "s1", sceneText: "Iftar, iced.", version: 1 },
};

/** Higgsfield's API and CDN in memory: queued, then in progress, then completed with one PNG. */
async function fakeHiggsfield() {
  const png = await sharp({
    create: { width: 1080, height: 1920, channels: 3, background: "#2a1a10" },
  })
    .png()
    .toBuffer();
  const calls: string[] = [];
  let polls = 0;
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === `${BASE_URL}/higgsfield-ai/soul/standard`) {
      return Promise.resolve(Response.json({ request_id: "req-1", status: "queued" }));
    }
    if (url === `${BASE_URL}/requests/req-1/status`) {
      polls += 1;
      const status = polls === 1 ? "queued" : polls === 2 ? "in_progress" : "completed";
      return Promise.resolve(
        Response.json({
          status,
          ...(status === "completed" ? { images: [{ url: `${CDN}/req-1.png` }] } : {}),
        }),
      );
    }
    if (url === `${CDN}/req-1.png`) {
      return Promise.resolve(new Response(png, { headers: { "content-type": "image/png" } }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  return { fetch, calls, png };
}

/** render.submit → render.poll until settled → download into Storage, as apps/api runs it. */
async function renderInto(
  provider: VisualProvider,
  storage: LocalStorage,
  fetch: typeof globalThis.fetch,
) {
  const { jobId } = await provider.submit(request);
  const states: VisualJobStatus["state"][] = [];
  let status: VisualJobStatus;
  do {
    status = await provider.status(jobId);
    states.push(status.state);
  } while (status.state === "queued" || status.state === "running");
  expect(status.state).toBe("succeeded");
  const file = await downloadOutput(status.outputs![0]!, fetch);
  const key = assetStorageKey({ clientId: "c1", assetId: "a1", mimeType: file.mimeType });
  const { url } = await storage.put(key, file.bytes, file.mimeType);
  return { states, key, url, file };
}

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function tempStorage(): Promise<LocalStorage> {
  dir = await mkdtemp(path.join(tmpdir(), "enmo-swap-"));
  return new LocalStorage({ dir, publicBaseUrl: "http://api.test/files" });
}

describe("provider swap", () => {
  it("runs the render loop on Higgsfield when VISUAL_PROVIDER=higgsfield", async () => {
    const fake = await fakeHiggsfield();
    const provider = createVisualProvider(
      { provider: "higgsfield", higgsfield },
      { fetch: fake.fetch },
    );
    expect(provider).toBeInstanceOf(HiggsfieldProvider);
    const storage = await tempStorage();

    const rendered = await renderInto(provider, storage, fake.fetch);
    expect(rendered.states).toEqual(["queued", "running", "succeeded"]);
    expect(fake.calls).toEqual([
      `POST ${BASE_URL}/higgsfield-ai/soul/standard`,
      `GET ${BASE_URL}/requests/req-1/status`,
      `GET ${BASE_URL}/requests/req-1/status`,
      `GET ${BASE_URL}/requests/req-1/status`,
      `GET ${CDN}/req-1.png`,
    ]);
    // Our own copy of the CDN file, under our key and public URL.
    expect(rendered.key).toBe("clients/c1/assets/a1.png");
    expect(rendered.url).toBe("http://api.test/files/clients/c1/assets/a1.png");
    expect(await storage.get(rendered.key)).toEqual({ body: fake.png, contentType: "image/png" });
  });

  it("runs the same loop on MockProvider when VISUAL_PROVIDER=mock", async () => {
    const provider = createVisualProvider({ provider: "mock", higgsfield });
    expect(provider).toBeInstanceOf(MockProvider);
    const storage = await tempStorage();

    // MockProvider's outputs are data: URLs, which the global fetch reads without a network.
    const rendered = await renderInto(provider, storage, globalThis.fetch);
    expect(rendered.states).toEqual(["running", "succeeded"]);
    const stored = await storage.get(rendered.key);
    const meta = await sharp(stored!.body).metadata();
    expect({ format: meta.format, width: meta.width, height: meta.height }).toEqual({
      format: "png",
      width: 1080,
      height: 1920,
    });
  });

  it("refuses to store a download the provider's CDN failed", async () => {
    const fetch: typeof globalThis.fetch = () =>
      Promise.resolve(new Response("gone", { status: 410 }));
    await expect(
      downloadOutput({ url: `${CDN}/missing.png`, mimeType: "image/png" }, fetch),
    ).rejects.toThrow("HTTP 410");
  });
});
