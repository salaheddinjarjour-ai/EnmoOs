import { HiggsfieldProvider } from "@enmo/providers";
import {
  AssetParams,
  AssetReview,
  VisualReviewInput,
  aspectRatioFor,
  pixelSizeFor,
  type AspectRatio,
  type PostType,
  type TaskGraphDto,
} from "@enmo/shared";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { browserHeaders } from "../helpers/app";
import { sessionCookieFor } from "../helpers/auth";
import { testDb } from "../helpers/db";
import { seedProposedPlan, startHarness, type Harness } from "../helpers/harness";

/*
 * Provider swap proof (DESIGN §F: "adding a provider means one new file and one new case"): the
 * Phase 3 pipeline with VISUAL_PROVIDER=higgsfield. createDeps builds the HiggsfieldProvider from
 * the env through createVisualProvider, and the real provider code talks to an in-memory Higgsfield
 * behind the injected fetch: submit → status polls (queued → in_progress → completed) → the CDN
 * outputs are downloaded into Storage, reviewed by the Visual Director and served from /files.
 * Nothing else in the pipeline changes.
 */

const BASE_URL = "https://higgsfield.test";
const CDN = "https://cdn.higgsfield.test";
const KEY_ID = "hf-key-id";
const KEY_SECRET = "hf-key-secret";
const IMAGE_MODEL = "higgsfield-ai/soul/standard";
const VIDEO_MODEL = "higgsfield-ai/dop/lite";
/** Stand-in clip bytes: nothing in the pipeline decodes video (the poster is the still). */
const CLIP = Buffer.from("\x00\x00\x00\x18ftypmp42 fake clip");

interface Call {
  method: string;
  url: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

/** Higgsfield's REST API and CDN in memory, reached only through `fetch`. */
class FakeHiggsfield {
  readonly calls: Call[] = [];
  readonly #requests = new Map<
    string,
    { model: string; aspectRatio: AspectRatio; video: boolean; polls: number }
  >();
  readonly #files = new Map<string, { bytes: Buffer; type: string }>();

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    this.calls.push({ method, url, authorization: headers.get("authorization"), body });
    const { origin, pathname } = new URL(url);

    if (origin === CDN) {
      const file = this.#files.get(pathname);
      return file
        ? new Response(file.bytes, { headers: { "content-type": file.type } })
        : new Response("no such file", { status: 404 });
    }
    if (headers.get("authorization") !== `Key ${KEY_ID}:${KEY_SECRET}`) {
      return new Response("bad key", { status: 401 });
    }
    const status = /^\/requests\/([^/]+)\/status$/.exec(pathname);
    if (method === "GET" && status) return this.#status(decodeURIComponent(status[1]!));
    const model = pathname.slice(1);
    if (method === "POST" && (model === IMAGE_MODEL || model === VIDEO_MODEL) && body) {
      const id = `req-${this.#requests.size + 1}`;
      this.#requests.set(id, {
        model,
        aspectRatio: body.aspect_ratio as AspectRatio,
        video: model === VIDEO_MODEL,
        polls: 0,
      });
      return Response.json({ request_id: id, status: "queued" });
    }
    return new Response("not found", { status: 404 });
  };

  async #status(id: string): Promise<Response> {
    const request = this.#requests.get(id);
    if (!request) return new Response("not found", { status: 404 });
    request.polls += 1;
    if (request.polls === 1) return Response.json({ status: "queued" });
    if (request.polls === 2) return Response.json({ status: "in_progress" });
    const { width, height } = pixelSizeFor(request.aspectRatio);
    const still = await sharp({
      create: { width, height, channels: 3, background: { r: 36, g: 22, b: 14 } },
    })
      .png()
      .toBuffer();
    this.#files.set(`/${id}.png`, { bytes: still, type: "image/png" });
    if (!request.video) {
      return Response.json({ status: "completed", images: [{ url: `${CDN}/${id}.png` }] });
    }
    this.#files.set(`/${id}.mp4`, { bytes: CLIP, type: "video/mp4" });
    return Response.json({
      status: "completed",
      video: { url: `${CDN}/${id}.mp4` },
      images: [{ url: `${CDN}/${id}.png` }],
    });
  }

  /** The bytes the CDN serves at `url`. */
  file(url: string): Buffer | undefined {
    return this.#files.get(new URL(url).pathname)?.bytes;
  }
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

async function runOnHiggsfield(type: PostType, models: { video: boolean }) {
  const higgsfield = new FakeHiggsfield();
  const h = (harness = await startHarness({
    env: {
      VISUAL_PROVIDER: "higgsfield",
      HIGGSFIELD_KEY_ID: KEY_ID,
      HIGGSFIELD_KEY_SECRET: KEY_SECRET,
      HIGGSFIELD_BASE_URL: BASE_URL,
      HIGGSFIELD_IMAGE_MODEL: IMAGE_MODEL,
      ...(models.video ? { HIGGSFIELD_VIDEO_MODEL: VIDEO_MODEL } : {}),
    },
    fetch: higgsfield.fetch,
  }));
  const seeded = await seedProposedPlan(h, { postCount: 1, type });
  const cookie = await sessionCookieFor(seeded.admin, { now: h.clock.now() });
  const approved = await h.app.inject({
    method: "POST",
    url: `/v1/task-graphs/${seeded.graphId}/approve`,
    headers: browserHeaders(cookie),
    payload: {},
  });
  expect(approved.statusCode, approved.body).toBeLessThan(300);
  expect(approved.json<TaskGraphDto>().status).toBe("APPROVED");
  const post = await h.waitFor(async () => {
    const row = await testDb().post.findFirst({ where: { campaignId: seeded.campaignId } });
    return row?.status === "PENDING_APPROVAL" ? row : null;
  }, 30_000);
  const takes = await testDb().asset.findMany({
    where: { postId: post.id },
    orderBy: { shotId: "asc" },
  });
  return { h, higgsfield, post, takes };
}

/** GETs a /files URL over the real port. */
async function served(h: Harness, url: string) {
  const response = await fetch(`${h.url}${new URL(url).pathname}`);
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    bytes: Buffer.from(await response.arrayBuffer()),
  };
}

describe("phase3 provider swap: VISUAL_PROVIDER=higgsfield", () => {
  it("renders, downloads into Storage and reviews image shots through Higgsfield", async () => {
    const { h, higgsfield, takes } = await runOnHiggsfield("STATIC", { video: false });
    // createVisualProvider switched on VISUAL_PROVIDER; nothing else was told.
    expect(h.deps.visual).toBeInstanceOf(HiggsfieldProvider);
    expect(h.deps.visual.capabilities()).toEqual({ image: true, video: false, maxVideoSec: 0 });

    const [take] = takes;
    expect(takes).toHaveLength(1);
    expect(take).toMatchObject({
      kind: "IMAGE",
      status: "READY",
      isCurrent: true,
      provider: "higgsfield",
      providerModel: IMAGE_MODEL,
      providerJobId: "req-1",
      mimeType: "image/png",
      ...pixelSizeFor(aspectRatioFor("STATIC")),
    });
    expect(AssetReview.parse(take!.review).verdict).toBe("accept");
    // A generated image, not a placeholder: the review holds it to the whole rubric.
    const review = await testDb().agentRun.findFirstOrThrow({
      where: { agent: "VISUAL_DIRECTOR", action: "review" },
    });
    expect(VisualReviewInput.parse(review.inputSnapshot).render).toMatchObject({
      assetId: take!.id,
      placeholder: false,
    });

    // The exact exchange: one authenticated submit, polls until completed, then the CDN download.
    const shot = AssetParams.parse(take!.params).shot!;
    expect(higgsfield.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${BASE_URL}/${IMAGE_MODEL}`,
      `GET ${BASE_URL}/requests/req-1/status`,
      `GET ${BASE_URL}/requests/req-1/status`,
      `GET ${BASE_URL}/requests/req-1/status`,
      `GET ${CDN}/req-1.png`,
    ]);
    expect(higgsfield.calls[0]).toMatchObject({
      authorization: `Key ${KEY_ID}:${KEY_SECRET}`,
      body: {
        prompt: take!.prompt,
        aspect_ratio: "9:16",
        ...(shot.seed === null ? {} : { seed: shot.seed }),
      },
    });

    // Our copy, not a link to Higgsfield's CDN: the same bytes, in Storage and at /files.
    const cdnBytes = higgsfield.file(`${CDN}/req-1.png`)!;
    expect(take!.url!.startsWith(`${h.deps.config.PUBLIC_ASSET_BASE_URL}/`)).toBe(true);
    const stored = await h.deps.storage.get(take!.storageKey!);
    expect(stored).toEqual({ body: cdnBytes, contentType: "image/png" });
    const file = await served(h, take!.url!);
    expect(file).toMatchObject({ status: 200, type: "image/png" });
    expect(file.bytes.equals(cdnBytes)).toBe(true);
  }, 60_000);

  it("stores a Higgsfield clip with its still frame as the poster the Visual Director reviews", async () => {
    const { h, higgsfield, takes } = await runOnHiggsfield("REEL", { video: true });
    expect(h.deps.visual.capabilities()).toMatchObject({ image: true, video: true });
    expect(takes.length).toBeGreaterThan(0);

    for (const take of takes) {
      expect(take).toMatchObject({
        kind: "VIDEO",
        status: "READY",
        provider: "higgsfield",
        providerModel: VIDEO_MODEL,
        mimeType: "video/mp4",
        ...pixelSizeFor(aspectRatioFor("REEL")),
      });
      const params = AssetParams.parse(take.params);
      expect(params.mockVideo).toBe(false);
      expect(params.posterStorageKey).toMatch(/-poster\.png$/);
      expect(AssetReview.parse(take.review).verdict).toBe("accept");
      const submit = higgsfield.calls.find(
        (call) => call.method === "POST" && call.body?.prompt === take.prompt,
      );
      expect(submit?.body).toMatchObject({
        aspect_ratio: "9:16",
        duration: Math.ceil(params.shot!.durationSec!),
      });

      const clip = await served(h, take.url!);
      expect(clip).toMatchObject({ status: 200, type: "video/mp4" });
      expect(clip.bytes.equals(CLIP)).toBe(true);
      const poster = await served(h, take.posterUrl!);
      expect(poster).toMatchObject({ status: 200, type: "image/png" });
      expect(poster.bytes.equals(higgsfield.file(`${CDN}/${take.providerJobId}.png`)!)).toBe(true);
    }
  }, 60_000);
});
