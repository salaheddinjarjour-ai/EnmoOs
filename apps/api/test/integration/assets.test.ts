import { Prisma, type Asset, type Client, type Post } from "@enmo/db";
import {
  AssetParams,
  ASSET_PAGE_DEFAULT,
  ASSET_PAGE_MAX,
  ASSET_SEARCH_MAX_LENGTH,
  VERBATIM_TEXT_MAX_LENGTH,
  type AssetDetailDto,
  type AssetDto,
  type AssetListResponse,
  type AssetReview,
} from "@enmo/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UNFINISHED_STATUSES } from "../../src/orchestrator/tasks";
import { promoteVaultTake } from "../../src/orchestrator/vault-takes";
import { browserHeaders, buildTestApp, type TestApp } from "../helpers/app";
import { testDb } from "../helpers/db";
import {
  createAsset,
  createAssetVersion,
  createClient,
  FIXTURE_ASSET_BASE_URL,
} from "../helpers/factories";
import {
  createTeam,
  obliterateQueues,
  queuedJobs,
  seedCampaign,
  seedPipeline,
  sender,
  testCopy,
  type SeedPipelineInput,
  type Team,
} from "../helpers/route-fixtures";

/*
 * The Vault routes (DESIGN §E "vault"): GET /v1/assets (search, filters, keyset pagination),
 * GET /v1/assets/:id (the lineage) and POST /v1/assets/:id/regenerate. Assets are seeded straight
 * through the factories, as the visual loop would have left them.
 */

let t: TestApp;
let team: Team;
const send = sender(() => t.app);

beforeAll(async () => {
  t = await buildTestApp();
});

afterAll(async () => {
  await obliterateQueues(t.deps);
  await t.close();
});

beforeEach(async () => {
  team = await createTeam();
});

/** Distinct, ordered creation times: at(1) is the oldest. */
const at = (second: number) => new Date(Date.UTC(2027, 1, 1, 12, 0, second));

function review(verdict: "accept" | "regenerate", score: number, attempt: number): AssetReview {
  return {
    verdict,
    score,
    issues: verdict === "accept" ? [] : [`Take ${attempt} is off-brand`],
    revisedPrompt: verdict === "accept" ? null : `Take ${attempt + 1}: warmer light`,
    attempt,
    reviewedAt: at(30 + attempt).toISOString(),
  };
}

async function list(query = "", cookie = team.cookies.editor) {
  const response = await send("GET", `/v1/assets${query ? `?${query}` : ""}`, cookie);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<AssetListResponse>();
}

const ids = async (query = "") => (await list(query)).items.map((item) => item.id);

interface Vault {
  qahwa: Client;
  other: Client;
  ramadanId: string;
  summerId: string;
  p1: Post;
  p2: Post;
  /** p1's first take of s1, superseded by `latte`. */
  latteV1: Asset;
  latte: Asset;
  courtyard: Asset;
  pour: Asset;
  can: Asset;
}

/**
 * Two clients. Qahwa's "Ramadan iced line" has p1 (s1: v1 → v2) and p2 (an image s1 and a video
 * s2 for script scene 1); Other Co's "Summer cold brew" has one post-less take. Current takes,
 * newest first: latte, can, pour, courtyard.
 */
async function seedVault(): Promise<Vault> {
  const qahwa = await createClient({ name: "Qahwa Co" });
  const other = await createClient({ name: "Other Co" });
  const ramadan = await seedPipeline({ createdBy: team.manager, client: qahwa, postCount: 2 });
  const summer = await seedCampaign({
    createdBy: team.manager,
    client: other,
    name: "Summer cold brew",
  });
  const [p1, p2] = ramadan.posts;
  if (!p1 || !p2) throw new Error("seedVault: posts missing");
  const onRamadan = { client: qahwa, campaignId: ramadan.campaign.id };

  const latteV1 = await createAsset({
    ...onRamadan,
    postId: p1.id,
    shotId: "s1",
    prompt: "Iced oat latte at GOLDEN hour on a rooftop",
    review: review("regenerate", 4, 1),
    createdAt: at(1),
  });
  const courtyard = await createAsset({
    ...onRamadan,
    postId: p2.id,
    shotId: "s1",
    prompt: "A date-palm courtyard at dusk",
    createdAt: at(2),
  });
  const pour = await createAsset({
    ...onRamadan,
    postId: p2.id,
    shotId: "s2",
    kind: "VIDEO",
    sceneIndex: 1,
    aspectRatio: "9:16",
    prompt: "Slow pour over ice, macro",
    createdAt: at(3),
  });
  const can = await createAsset({
    client: other,
    campaignId: summer.campaign.id,
    shotId: "s3",
    prompt: "A golden can of cold brew on sand",
    createdAt: at(4),
  });
  const latte = await createAssetVersion(latteV1, {
    prompt: "Iced oat latte, golden hour, closer crop",
    review: review("accept", 8, 2),
    createdAt: at(5),
  });
  return {
    qahwa,
    other,
    ramadanId: ramadan.campaign.id,
    summerId: summer.campaign.id,
    p1,
    p2,
    latteV1,
    latte,
    courtyard,
    pour,
    can,
  };
}

describe("GET /v1/assets", () => {
  it("lists the current takes, newest first", async () => {
    const vault = await seedVault();
    const body = await list();

    expect(body.nextCursor).toBeNull();
    expect(body.items.map((item) => item.id)).toEqual([
      vault.latte.id,
      vault.can.id,
      vault.pour.id,
      vault.courtyard.id,
    ]);
    expect(body.items[0]).toEqual({
      id: vault.latte.id,
      client: { id: vault.qahwa.id, name: "Qahwa Co" },
      campaign: { id: vault.ramadanId, name: "Ramadan iced line" },
      post: { id: vault.p1.id, ref: "p1", type: "STATIC" },
      variantId: null,
      position: null,
      role: "SHOT",
      kind: "IMAGE",
      status: "READY",
      version: 2,
      isCurrent: true,
      parentAssetId: vault.latteV1.id,
      rootAssetId: vault.latteV1.id,
      provider: "mock",
      providerModel: null,
      prompt: "Iced oat latte, golden hour, closer crop",
      negativePrompt: null,
      params: expect.objectContaining({
        origin: "review",
        shot: expect.objectContaining({ shotId: "s1", aspectRatio: "9:16" }) as unknown,
      }) as unknown,
      shotId: "s1",
      sceneIndex: null,
      slideIndex: null,
      aspectRatio: "9:16",
      url: `${FIXTURE_ASSET_BASE_URL}/clients/${vault.qahwa.id}/assets/${vault.latte.id}.png`,
      posterUrl: null,
      mimeType: "image/png",
      width: 1080,
      height: 1920,
      durationSec: null,
      bytes: 48_000,
      review: review("accept", 8, 2),
      regenCount: 1,
      createdBy: null,
      createdAt: at(5).toISOString(),
      updatedAt: expect.any(String) as string,
    });
    // v1 is its own lineage root.
    const v1 = (await list("allVersions=true")).items.find((item) => item.id === vault.latteV1.id);
    expect(v1).toMatchObject({ version: 1, isCurrent: false, rootAssetId: vault.latteV1.id });
    expect(v1?.parentAssetId).toBeNull();
  });

  it("includes superseded versions with allVersions=true", async () => {
    const vault = await seedVault();
    expect(await ids("allVersions=true")).toEqual([
      vault.latte.id,
      vault.can.id,
      vault.pour.id,
      vault.courtyard.id,
      vault.latteV1.id,
    ]);
    expect(await ids("allVersions=false")).toHaveLength(4);
    expect(await ids(`allVersions=true&postId=${vault.p1.id}`)).toEqual([
      vault.latte.id,
      vault.latteV1.id,
    ]);
  });

  it("filters by client, campaign, post, scene and kind", async () => {
    const vault = await seedVault();
    expect(await ids(`clientId=${vault.other.id}`)).toEqual([vault.can.id]);
    expect(await ids(`campaignId=${vault.ramadanId}`)).toEqual([
      vault.latte.id,
      vault.pour.id,
      vault.courtyard.id,
    ]);
    expect(await ids(`campaignId=${vault.summerId}`)).toEqual([vault.can.id]);
    expect(await ids(`postId=${vault.p2.id}`)).toEqual([vault.pour.id, vault.courtyard.id]);
    expect(await ids("sceneIndex=1")).toEqual([vault.pour.id]);
    expect(await ids("sceneIndex=0")).toEqual([]);
    expect(await ids("kind=VIDEO")).toEqual([vault.pour.id]);
    expect(await ids(`kind=IMAGE&clientId=${vault.qahwa.id}`)).toEqual([
      vault.latte.id,
      vault.courtyard.id,
    ]);
    expect(await ids(`clientId=${vault.other.id}&postId=${vault.p1.id}`)).toEqual([]);
    expect(await ids("clientId=nobody")).toEqual([]);
  });

  it("filters by carousel slide, which lives in the take's shot, as it does by scene", async () => {
    const vault = await seedVault();
    const onRamadan = { client: vault.qahwa, campaignId: vault.ramadanId, postId: vault.p1.id };
    const cover = await createAsset({
      ...onRamadan,
      shotId: "s1",
      slideIndex: 0,
      createdAt: at(6),
    });
    const secondV1 = await createAsset({
      ...onRamadan,
      shotId: "s2",
      slideIndex: 1,
      createdAt: at(7),
    });
    const second = await createAssetVersion(secondV1, { createdAt: at(8) });

    expect(await ids("slideIndex=0")).toEqual([cover.id]);
    expect(await ids("slideIndex=1")).toEqual([second.id]);
    expect(await ids("slideIndex=1&allVersions=true")).toEqual([second.id, secondV1.id]);
    expect(await ids("slideIndex=2")).toEqual([]);
    // A slide is not a scene: scene 1 is still the reel's pour, and nothing is both.
    expect(await ids("sceneIndex=1")).toEqual([vault.pour.id]);
    expect(await ids("sceneIndex=0")).toEqual([]);
    expect(await ids("sceneIndex=1&slideIndex=1")).toEqual([]);
    // Scene and slide narrow the other filters' results.
    expect(await ids(`slideIndex=0&campaignId=${vault.summerId}`)).toEqual([]);
    expect(await ids(`slideIndex=1&q=${encodeURIComponent("fixture shot")}`)).toEqual([second.id]);
    expect((await list("slideIndex=1")).items[0]).toMatchObject({
      slideIndex: 1,
      sceneIndex: null,
    });
  });

  it("searches prompts case-insensitively, plus the campaign name and the shot id", async () => {
    const vault = await seedVault();
    expect(await ids("q=golden")).toEqual([vault.latte.id, vault.can.id]);
    expect(await ids("q=GoLdEn%20HOUR")).toEqual([vault.latte.id]);
    expect(await ids("q=golden&allVersions=true")).toEqual([
      vault.latte.id,
      vault.can.id,
      vault.latteV1.id,
    ]);
    expect(await ids("q=summer")).toEqual([vault.can.id]);
    expect(await ids("q=ramadan%20ICED&kind=VIDEO")).toEqual([vault.pour.id]);
    expect(await ids("q=S2")).toEqual([vault.pour.id]);
    expect(await ids(`q=courtyard&campaignId=${vault.summerId}`)).toEqual([]);
    expect(await ids("q=nothing-like-this")).toEqual([]);
  });

  it("treats an empty or blank search as no search, and trims the rest", async () => {
    const vault = await seedVault();
    expect(await ids("q=")).toHaveLength(4);
    expect(await ids("q=%20%20%20")).toHaveLength(4);
    expect(await ids("q=%20%20courtyard%20")).toEqual([vault.courtyard.id]);
  });

  it("pages with a stable keyset cursor, ties broken by id", async () => {
    const client = await createClient();
    const tie = at(10);
    const assets = [
      await createAsset({ client, createdAt: at(8) }),
      await createAsset({ client, createdAt: at(9) }),
      await createAsset({ client, createdAt: tie }),
      await createAsset({ client, createdAt: tie }),
      await createAsset({ client, createdAt: tie }),
      await createAsset({ client, createdAt: at(11) }),
    ];
    const byNewest = [...assets]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
      .map((asset) => asset.id);
    expect(await ids("limit=100")).toEqual(byNewest);

    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const page: AssetListResponse = await list(
        `limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      pages.push(page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor !== null && pages.length < 10);

    expect(pages.map((page) => page.length)).toEqual([4, 2]);
    expect(pages.flat()).toEqual(byNewest);

    // A page boundary inside the tie still neither repeats nor skips anything.
    const first = await list("limit=2");
    expect(first.nextCursor).toBe(byNewest[1]);
    const rest = await list(`limit=100&cursor=${first.nextCursor}`);
    expect([...first.items, ...rest.items].map((item) => item.id)).toEqual(byNewest);
    expect(rest.nextCursor).toBeNull();
  });

  it("neither skips nor repeats a take when the cursor's take drops out of the filters", async () => {
    const client = await createClient();
    const assets: Asset[] = [];
    for (let second = 20; second < 25; second += 1) {
      assets.push(await createAsset({ client, createdAt: at(second) }));
    }
    const newest = assets.map((asset) => asset.id).reverse();

    const first = await list("limit=2");
    expect(first.items.map((item) => item.id)).toEqual(newest.slice(0, 2));
    expect(first.nextCursor).toBe(newest[1]);
    // Before the next page loads, a Vault regenerate of the cursor's take goes up: it is no longer
    // current, so the default filter leaves it out.
    await testDb().asset.update({ where: { id: newest[1] }, data: { isCurrent: false } });

    const rest = await list(`limit=100&cursor=${first.nextCursor}`);
    expect(rest.items.map((item) => item.id)).toEqual(newest.slice(2));
    expect(rest.nextCursor).toBeNull();
    // Paging in smaller steps from there doesn't lose anything either.
    const next = await list(`limit=1&cursor=${first.nextCursor}`);
    expect(next.items.map((item) => item.id)).toEqual([newest[2]]);
    const after = await list(`limit=100&cursor=${next.nextCursor}`);
    expect(after.items.map((item) => item.id)).toEqual(newest.slice(3));
  });

  it("keeps the filters across pages", async () => {
    const vault = await seedVault();
    const first = await list(`campaignId=${vault.ramadanId}&limit=2`);
    expect(first.items.map((item) => item.id)).toEqual([vault.latte.id, vault.pour.id]);
    const second = await list(`campaignId=${vault.ramadanId}&limit=2&cursor=${first.nextCursor}`);
    expect(second).toEqual({
      items: [expect.objectContaining({ id: vault.courtyard.id }) as unknown],
      nextCursor: null,
    });
  });

  it(`defaults to ${ASSET_PAGE_DEFAULT} per page`, async () => {
    const client = await createClient();
    for (let index = 0; index <= ASSET_PAGE_DEFAULT; index += 1) {
      await createAsset({ client, status: "QUEUED", createdAt: at(index) });
    }
    const body = await list();
    expect(body.items).toHaveLength(ASSET_PAGE_DEFAULT);
    expect(body.nextCursor).toBe(body.items.at(-1)?.id);
    expect((await list(`cursor=${body.nextCursor}`)).items).toHaveLength(1);
  });

  it("rejects invalid filters", async () => {
    const invalid = [
      "limit=0",
      `limit=${ASSET_PAGE_MAX + 1}`,
      "limit=ten",
      "kind=GIF",
      "sceneIndex=-1",
      "sceneIndex=first",
      "slideIndex=-1",
      "slideIndex=1.5",
      "allVersions=maybe",
      `q=${"a".repeat(ASSET_SEARCH_MAX_LENGTH + 1)}`,
      "cursor=",
    ];
    for (const query of invalid) {
      const response = await send("GET", `/v1/assets?${query}`, team.cookies.editor);
      expect(response.statusCode, `${query} → ${response.body}`).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    }
    expect(await ids(`limit=${ASSET_PAGE_MAX}`)).toEqual([]);
  });

  it("needs a session", async () => {
    const response = await send("GET", "/v1/assets");
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /v1/assets/:id", () => {
  async function seedLineage() {
    const client = await createClient();
    const v1 = await createAsset({ client, shotId: "s1", review: review("regenerate", 4, 1) });
    const v2 = await createAssetVersion(v1, { review: review("regenerate", 5, 2) });
    const v3 = await createAssetVersion(v2, { review: review("accept", 8, 3) });
    // Another shot's lineage, which must not leak in.
    const other = await createAsset({ client, shotId: "s2" });
    await createAssetVersion(other);
    return { client, v1, v2, v3 };
  }

  it("returns the asset and its whole lineage, oldest version first, with each review", async () => {
    const { v1, v2, v3 } = await seedLineage();
    const response = await send("GET", `/v1/assets/${v2.id}`, team.cookies.editor);
    expect(response.statusCode, response.body).toBe(200);
    const detail = response.json<AssetDetailDto>();

    expect(detail).toMatchObject({
      id: v2.id,
      version: 2,
      isCurrent: false,
      parentAssetId: v1.id,
      rootAssetId: v1.id,
      review: review("regenerate", 5, 2),
    });
    expect(detail.lineage.rootAssetId).toBe(v1.id);
    expect(detail.lineage.currentAssetId).toBe(v3.id);
    expect(
      detail.lineage.versions.map((take) => ({
        id: take.id,
        version: take.version,
        isCurrent: take.isCurrent,
        parentAssetId: take.parentAssetId,
        verdict: take.review?.verdict,
        score: take.review?.score,
      })),
    ).toEqual([
      {
        id: v1.id,
        version: 1,
        isCurrent: false,
        parentAssetId: null,
        verdict: "regenerate",
        score: 4,
      },
      {
        id: v2.id,
        version: 2,
        isCurrent: false,
        parentAssetId: v1.id,
        verdict: "regenerate",
        score: 5,
      },
      { id: v3.id, version: 3, isCurrent: true, parentAssetId: v2.id, verdict: "accept", score: 8 },
    ]);

    // Every version answers with the same lineage.
    for (const version of [v1, v3]) {
      const other = await send("GET", `/v1/assets/${version.id}`, team.cookies.editor);
      expect(other.json<AssetDetailDto>().lineage).toEqual(detail.lineage);
    }
  });

  it("says when no version of the lineage is current", async () => {
    const client = await createClient();
    const v1 = await createAsset({ client, status: "REJECTED", isCurrent: false });
    const v2 = await createAssetVersion(v1, { status: "FAILED", isCurrent: false });
    const response = await send("GET", `/v1/assets/${v2.id}`, team.cookies.manager);
    expect(response.statusCode, response.body).toBe(200);
    const { lineage } = response.json<AssetDetailDto>();
    expect(lineage.currentAssetId).toBeNull();
    expect(lineage.versions.map((version) => version.status)).toEqual(["REJECTED", "FAILED"]);
  });

  it("answers 404 for an unknown asset", async () => {
    const response = await send("GET", "/v1/assets/nope", team.cookies.editor);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});

describe("POST /v1/assets/:id/regenerate", () => {
  /** A drafted post waiting on approval (by default) with one READY current take of s1. */
  async function seedTake(
    postCount = 1,
    options: Pick<SeedPipelineInput, "postStatus" | "campaignStatus"> = {},
  ) {
    const client = await createClient();
    const pipeline = await seedPipeline({
      createdBy: team.manager,
      client,
      postCount,
      ...options,
    });
    const takes: Asset[] = [];
    for (const post of pipeline.posts) {
      takes.push(
        await createAsset({
          client,
          campaignId: pipeline.campaign.id,
          postId: post.id,
          shotId: "s1",
          prompt: `Take for ${post.ref}`,
          review: review("accept", 7, 1),
        }),
      );
    }
    return { client, pipeline, takes };
  }

  const regenerateUrl = (asset: { id: string }) => `/v1/assets/${asset.id}/regenerate`;

  it("answers 202 with the new QUEUED version, the instruction kept verbatim", async () => {
    const { takes } = await seedTake();
    const v1 = takes[0]!;
    const instruction = "  Warmer light;\nkeep the cup  ";

    const response = await send("POST", regenerateUrl(v1), team.cookies.editor, { instruction });
    expect(response.statusCode, response.body).toBe(202);
    const created = response.json<AssetDto>();
    expect(created).toMatchObject({
      status: "QUEUED",
      version: 2,
      isCurrent: false,
      parentAssetId: v1.id,
      rootAssetId: v1.id,
      post: { id: v1.postId, ref: "p1" },
      shotId: "s1",
      url: null,
      regenCount: 1,
      review: null,
      createdBy: { id: team.editor.id, name: team.editor.name },
      params: { origin: "vault", instruction },
    });
    expect(created.id).not.toBe(v1.id);

    const db = testDb();
    const stored = await db.asset.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored).toMatchObject({ status: "QUEUED", version: 2, createdById: team.editor.id });
    // The take on show stays current until its replacement is rendered and reviewed.
    expect((await db.asset.findUniqueOrThrow({ where: { id: v1.id } })).isCurrent).toBe(true);

    // The Visual Director was set to work on it.
    const jobs = await queuedJobs(t.deps);
    const references = (data: unknown) =>
      JSON.stringify(data).includes(created.id) ||
      (created.params.taskId !== null && JSON.stringify(data).includes(created.params.taskId));
    expect(jobs.some((job) => references(job.data))).toBe(true);

    // The lineage now reads v1 (current) then v2 (queued).
    const detail = await send("GET", `/v1/assets/${created.id}`, team.cookies.editor);
    const { lineage } = detail.json<AssetDetailDto>();
    expect(lineage).toMatchObject({ rootAssetId: v1.id, currentAssetId: v1.id });
    expect(lineage.versions.map((version) => version.id)).toEqual([v1.id, created.id]);
  });

  it("takes no instruction at all: an empty body, or none", async () => {
    const { takes } = await seedTake(2);
    const [first, second] = takes;

    const bare = await t.app.inject({
      method: "POST",
      url: regenerateUrl(first!),
      headers: browserHeaders(team.cookies.manager),
    });
    expect(bare.statusCode, bare.body).toBe(202);
    expect(bare.json<AssetDto>().params.instruction).toBeNull();

    const empty = await send("POST", regenerateUrl(second!), team.cookies.admin, {});
    expect(empty.statusCode, empty.body).toBe(202);
    expect(empty.json<AssetDto>()).toMatchObject({
      params: { instruction: null },
      createdBy: { id: team.admin.id },
    });
  });

  it("refuses a second regenerate while the first is still on its way", async () => {
    const { takes } = await seedTake();
    const v1 = takes[0]!;
    const first = await send("POST", regenerateUrl(v1), team.cookies.editor, { instruction: null });
    expect(first.statusCode, first.body).toBe(202);

    for (const target of [v1, first.json<AssetDto>()]) {
      const again = await send("POST", regenerateUrl(target), team.cookies.editor, {
        instruction: "Again",
      });
      expect(again.statusCode, again.body).toBe(409);
      expect(again.json()).toMatchObject({ error: { code: "CONFLICT" } });
    }
    expect(
      await testDb().asset.count({ where: { OR: [{ id: v1.id }, { rootAssetId: v1.id }] } }),
    ).toBe(2);
  });

  it("refuses an old take of a scene or slide the post's copy no longer has", async () => {
    const { client, pipeline, takes } = await seedTake();
    const post = pipeline.posts[0]!;
    // The STATIC post's copy has one place (its single image); this take filled a carousel slide
    // of an earlier shape of the post, superseded since.
    const orphan = await createAsset({
      client,
      campaignId: pipeline.campaign.id,
      postId: post.id,
      shotId: "s4",
      slideIndex: 3,
      isCurrent: false,
      review: review("accept", 7, 1),
    });
    const response = await send("POST", regenerateUrl(orphan), team.cookies.editor, {
      instruction: "Warmer",
    });
    expect(response.statusCode, response.body).toBe(409);
    const { error } = response.json<{ error: { code: string; message: string } }>();
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toContain("no longer in the post's copy");
    expect(await testDb().asset.count()).toBe(2);
    // The post's current take can still be regenerated.
    const current = await send("POST", regenerateUrl(takes[0]!), team.cookies.editor, {
      instruction: "Warmer",
    });
    expect(current.statusCode, current.body).toBe(202);
  });

  /** The regenerate answers 409 with `message`; nothing is created, queued up or reopened. */
  async function expectRefused(asset: { id: string }, message: string) {
    const db = testDb();
    const rounds = () =>
      db.approvalRequest.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true } });
    const posts = () => db.post.findMany({ orderBy: { id: "asc" }, select: { status: true } });
    const before = {
      assets: await db.asset.count(),
      tasks: await db.agentTask.count(),
      rounds: await rounds(),
      posts: await posts(),
    };
    const response = await send("POST", regenerateUrl(asset), team.cookies.editor, {
      instruction: "Warmer",
    });
    expect(response.statusCode, response.body).toBe(409);
    const { error } = response.json<{ error: { code: string; message: string } }>();
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toContain(message);
    expect({
      assets: await db.asset.count(),
      tasks: await db.agentTask.count(),
      rounds: await rounds(),
      posts: await posts(),
    }).toEqual(before);
  }

  /** A STATIC post outside any plan (no tasks), in approval, with one accepted take of s1. */
  async function seedOffPlanTake() {
    const client = await createClient();
    const { campaign } = await seedCampaign({
      createdBy: team.manager,
      client,
      status: "PRODUCING",
    });
    const post = await testDb().post.create({
      data: {
        campaignId: campaign.id,
        clientId: client.id,
        ref: "p1",
        type: "STATIC",
        platforms: ["INSTAGRAM"],
        status: "PENDING_APPROVAL",
        copy: testCopy(),
      },
    });
    const v1 = await createAsset({
      client,
      campaignId: campaign.id,
      postId: post.id,
      review: review("accept", 7, 1),
    });
    return { client, post, v1 };
  }

  it.each(["ESCALATED", "FAILED"] as const)(
    "refuses while a %s task of the post waits on a human",
    async (status) => {
      const { pipeline, takes } = await seedTake();
      await testDb().agentTask.create({
        data: {
          graphId: pipeline.graph.id,
          nodeKey: "n9",
          agent: "VISUAL_DIRECTOR",
          action: "direct",
          postId: pipeline.posts[0]!.id,
          status,
        },
      });
      await expectRefused(takes[0]!, "waiting on a human; accept the best take or retry it first");
    },
  );

  it.each(UNFINISHED_STATUSES)("refuses while a task of the post is %s", async (status) => {
    const { pipeline, takes } = await seedTake();
    await testDb().agentTask.create({
      data: {
        graphId: pipeline.graph.id,
        nodeKey: "n9",
        agent: "MANAGER",
        action: "qa",
        postId: pipeline.posts[0]!.id,
        status,
      },
    });
    await expectRefused(takes[0]!, "An agent is working on this post right now");
  });

  it.each(["IDEA", "DRAFTING", "VISUALIZING", "ADAPTING", "QA", "CHANGES_REQUESTED"] as const)(
    "refuses a planned post the agents haven't finished (%s)",
    async (postStatus) => {
      const { takes } = await seedTake(1, { postStatus });
      await expectRefused(takes[0]!, "The agents haven't finished this post yet");
    },
  );

  it.each(["PUBLISHING", "LIVE", "SCORED", "FAILED"] as const)(
    "refuses a post whose visuals are out in the world (%s)",
    async (postStatus) => {
      const { takes } = await seedTake(1, { postStatus });
      await expectRefused(takes[0]!, "This post's visuals can't change any more");
    },
  );

  it("refuses a take of an archived campaign", async () => {
    const { takes } = await seedTake(1, { campaignStatus: "ARCHIVED" });
    await expectRefused(takes[0]!, "The campaign is archived");
  });

  it("refuses a post with no copy yet", async () => {
    const { pipeline, takes } = await seedTake();
    await testDb().post.update({
      where: { id: pipeline.posts[0]!.id },
      data: { copy: Prisma.DbNull },
    });
    await expectRefused(takes[0]!, "The post has no copy yet");
  });

  it("refuses anything but a shot of a post", async () => {
    const { client, pipeline } = await seedTake();
    const master = await createAsset({
      client,
      campaignId: pipeline.campaign.id,
      postId: pipeline.posts[0]!.id,
      role: "MASTER",
      isCurrent: false,
    });
    await expectRefused(master, "Only the Visual Director's shots can be regenerated");
    const loose = await createAsset({ client, campaignId: pipeline.campaign.id });
    await expectRefused(loose, "isn't attached to a post");
  });

  it("refuses while a take of the shot is still rendering", async () => {
    const { takes } = await seedTake();
    const v1 = takes[0]!;
    const rendering = await createAssetVersion(v1, { status: "RENDERING", isCurrent: false });
    await expectRefused(v1, "still rendering or under review");
    await expectRefused(rendering, "still rendering or under review");
  });

  it("refuses while a take on trial outside any plan is still in the review loop", async () => {
    const { v1 } = await seedOffPlanTake();
    const onTrial = { origin: "vault" as const, taskId: null, onTrial: true };
    const v2 = await createAssetVersion(v1, { isCurrent: false, params: onTrial });
    // Waiting for its review, then accepted and waiting to go up: a second trial of the shot
    // would race it.
    await expectRefused(v1, "still rendering or under review");
    await testDb().asset.update({ where: { id: v2.id }, data: { review: review("accept", 8, 1) } });
    await expectRefused(v1, "still rendering or under review");

    // Set aside as weak, it no longer holds the shot.
    await testDb().asset.update({
      where: { id: v2.id },
      data: { status: "REJECTED", review: review("regenerate", 4, 3) },
    });
    const response = await send("POST", regenerateUrl(v1), team.cookies.editor, {
      instruction: "Warmer",
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json<AssetDto>()).toMatchObject({ version: 3, params: { taskId: null } });
  });

  it("refuses an old lineage of a place the post now shows another lineage's take of", async () => {
    const { client, post, v1 } = await seedOffPlanTake();
    // The single image's first lineage, left without a current take when a revision re-planned
    // the post; the post has shown v1, of a lineage of its own, there since.
    const orphan = await createAsset({
      client,
      campaignId: post.campaignId,
      postId: post.id,
      shotId: "s1",
      isCurrent: false,
      review: review("accept", 9, 1),
      createdAt: at(1),
    });
    await expectRefused(orphan, "The post shows another take of this shot now (s1 v1)");
    // The take on show is still the place's to regenerate.
    const response = await send("POST", regenerateUrl(v1), team.cookies.editor, {
      instruction: "Warmer",
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json<AssetDto>()).toMatchObject({ version: 2, parentAssetId: v1.id });
  });

  it("promotes an accepted Vault take as the post's only take of its place", async () => {
    const { client, post, v1 } = await seedOffPlanTake();
    // A take on trial of another lineage of the same place (the backstop regenerateAsset's
    // check keeps from happening): once accepted, it replaces the take on show there too.
    const trial = await createAsset({
      client,
      campaignId: post.campaignId,
      postId: post.id,
      shotId: "s1",
      isCurrent: false,
      review: review("accept", 8, 1),
      params: { origin: "vault", taskId: null, onTrial: true },
    });
    await promoteVaultTake(t.deps, trial.id);

    const db = testDb();
    const current = await db.asset.findMany({ where: { postId: post.id, isCurrent: true } });
    expect(current.map((take) => take.id)).toEqual([trial.id]);
    expect((await db.asset.findUniqueOrThrow({ where: { id: v1.id } })).isCurrent).toBe(false);
    const promoted = await db.asset.findUniqueOrThrow({ where: { id: trial.id } });
    expect(AssetParams.parse(promoted.params)).not.toHaveProperty("onTrial");
  });

  it("never lets a take on trial that a resolved task left behind hold the shot", async () => {
    const { pipeline, takes } = await seedTake();
    const v1 = takes[0]!;
    const resolved = await testDb().agentTask.create({
      data: {
        graphId: pipeline.graph.id,
        nodeKey: "n9.r1",
        agent: "VISUAL_DIRECTOR",
        action: "direct",
        postId: pipeline.posts[0]!.id,
        revision: 1,
        status: "SUCCEEDED",
      },
    });
    // Rendered, never reviewed (its review escalated), and nothing will review it any more.
    await createAssetVersion(v1, {
      isCurrent: false,
      params: { origin: "vault", taskId: resolved.id, onTrial: true },
    });
    const response = await send("POST", regenerateUrl(v1), team.cookies.editor, {
      instruction: "Warmer",
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json<AssetDto>()).toMatchObject({ version: 3, parentAssetId: v1.id });
  });

  it("validates the instruction before creating anything", async () => {
    const { takes } = await seedTake();
    const v1 = takes[0]!;
    const invalid = [
      { instruction: "   " },
      { instruction: "" },
      { instruction: "x".repeat(VERBATIM_TEXT_MAX_LENGTH + 1) },
      { instruction: 42 },
      ["not", "an", "object"],
    ];
    for (const body of invalid) {
      const response = await send("POST", regenerateUrl(v1), team.cookies.editor, body);
      expect(response.statusCode, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect(await testDb().asset.count()).toBe(1);
  });

  it("answers 404 for an unknown asset", async () => {
    const response = await send("POST", "/v1/assets/nope/regenerate", team.cookies.editor, {
      instruction: null,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("needs a session and the web origin", async () => {
    const { takes } = await seedTake();
    const url = regenerateUrl(takes[0]!);
    expect((await send("POST", url, undefined, { instruction: null })).statusCode).toBe(401);
    const crossSite = await t.app.inject({
      method: "POST",
      url,
      headers: { origin: "https://evil.example", cookie: team.cookies.editor },
      payload: { instruction: null },
    });
    expect(crossSite.statusCode).toBe(403);
    expect(await testDb().asset.count()).toBe(1);
  });
});
