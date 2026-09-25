import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import type {
  AssetDetailDto,
  AssetListResponse,
  CampaignDto,
  PostDto,
  PostListResponse,
} from "@enmo/shared";
import { API_URL, E2E_ADMIN } from "./env";
import { primaryNav, signIn, toast } from "./helpers";

/*
 * Phase 3 exit (DESIGN "Phase 3 — Eyes"): brief → approvable post card with a placeholder visual,
 * against the mock LLM, MockProvider and local storage served at the API's /files (see
 * playwright.config.ts). A three-post brief (a reel, a carousel, a static) runs write → direct →
 * qa. While the takes render, their cards shimmer on the Command Center board; then every card
 * shows its current take, loaded from /files as a 1080×1920 PNG (the 9:16 master every post type
 * is rendered at). The post drawer links a shot to the Vault; there the take is found by searching
 * its prompt, and Regenerate adds v2: it shimmers at once, and swaps in over SSE once rendered and
 * reviewed, re-planned by the Visual Director from the shot's context and the note verbatim.
 *
 * The tests share one database and build on each other, so they run in order. The admin signs in
 * once (the API allows five sign-ins per email per minute, and earlier specs may have used some).
 */

test.describe.configure({ mode: "serial" });

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

const CLIENT = "Layali Tea House";
const BRIEF = `Eid campaign for ${CLIENT}: 1 reel, 1 carousel and 1 static on Instagram, March 1–30, push the iced line`;
const INSTRUCTION = "Warmer light, and bring the glass closer to camera.";
/** Copy, a shot list, renders, reviews and QA for three posts; the mock is quick, CI isn't always. */
const PIPELINE_TIMEOUT = 90_000;

/** DESIGN "Phase 3" exit test: every post's current take is served as a 1080×1920 PNG. */
const MASTER_SIZE: readonly [number, number] = [1080, 1920];

const shared: { state?: StorageState; campaignPath?: string; campaignId?: string } = {};

async function openCampaign(browser: {
  newContext(options: { storageState: StorageState }): Promise<BrowserContext>;
}): Promise<{ context: BrowserContext; page: Page }> {
  if (!shared.state || !shared.campaignPath) {
    throw new Error("An earlier test didn't leave a signed-in session and a campaign");
  }
  const context = await browser.newContext({ storageState: shared.state });
  const page = await context.newPage();
  await page.goto(shared.campaignPath);
  await expect(page.getByRole("list", { name: "Conversation" })).toBeVisible();
  return { context, page };
}

async function apiGet<T>(page: Page, path: string, params?: Record<string, string>): Promise<T> {
  const response = await page.request.get(`${API_URL}/v1${path}`, { params });
  expect(response.ok(), `GET ${path} → ${response.status()}`).toBe(true);
  return (await response.json()) as T;
}

async function campaignPosts(page: Page): Promise<PostDto[]> {
  const { items } = await apiGet<PostListResponse>(page, "/posts", {
    campaignId: shared.campaignId!,
  });
  return [...items].sort((a, b) => a.ref.localeCompare(b.ref, "en", { numeric: true }));
}

function postCard(page: Page, ref: string): Locator {
  return page.getByRole("article", { name: `Post ${ref}`, exact: true });
}

/** [naturalWidth, naturalHeight] once the image has loaded, else null. */
function loadedSize(image: Locator): Promise<[number, number] | null> {
  return image.evaluate((element) => {
    const img = element as HTMLImageElement;
    return img.complete && img.naturalWidth > 0 ? [img.naturalWidth, img.naturalHeight] : null;
  });
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(bytes: Buffer): [number, number] {
  expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test("a brief becomes approvable post cards, each with its placeholder visual", async ({
  page,
}) => {
  test.setTimeout(PIPELINE_TIMEOUT + 60_000);
  await signIn(page, E2E_ADMIN);

  await primaryNav(page).getByRole("link", { name: "Clients" }).click();
  await page.getByRole("button", { name: "New client" }).click();
  const dialog = page.getByRole("dialog", { name: "New client" });
  await dialog.getByLabel("Name").fill(CLIENT);
  await dialog.getByLabel("Brand voice").fill("Quiet, generous, lamp-lit. Tea as hospitality.");
  await dialog.getByRole("button", { name: "Create client" }).click();
  await expect(toast(page, `${CLIENT} is on the roster`)).toBeVisible();

  // A brief with everything in it: the Manager plans without a question.
  await primaryNav(page).getByRole("link", { name: "The Brief" }).click();
  await expect(page).toHaveURL(/\/brief$/);
  // Until the Brief renders, the client list's "Search clients" field answers to "Client" too.
  const composer = page.getByLabel("Brief the Manager");
  await expect(composer).toBeVisible();
  await page.getByLabel("Client").selectOption({ label: CLIENT });
  await composer.fill(BRIEF);
  await composer.press("Enter");
  await expect(page).toHaveURL(/\/brief\/[^/]+$/);
  shared.campaignPath = new URL(page.url()).pathname;
  shared.campaignId = decodeURIComponent(shared.campaignPath.split("/").at(-1)!);

  const plan = page.getByRole("region", { name: "Plan v1" });
  await expect(plan).toContainText("Awaiting approval", { timeout: PIPELINE_TIMEOUT });

  // The Command Center watches in a second tab: while a take renders, its card shimmers in the
  // Visual column, in the take's final shape.
  const board = await page.context().newPage();
  await board.goto("/command");
  await board.getByRole("tablist", { name: "Clients" }).getByRole("tab", { name: CLIENT }).click();
  const visualColumn = board
    .getByRole("tabpanel", { name: CLIENT })
    .getByRole("region", { name: "Visual column" });

  await plan.getByRole("button", { name: "Approve plan" }).click();
  await expect(toast(page, "Plan approved")).toBeVisible();
  await expect(
    visualColumn.getByRole("img", { name: /^p\d+ visual, rendering$/ }).first(),
  ).toBeVisible({ timeout: PIPELINE_TIMEOUT });

  // Copy, then the Visual Director's shots render and pass review, then QA: three cards.
  await expect(page.getByText("3 posts passed QA and are waiting for approval.")).toBeVisible({
    timeout: PIPELINE_TIMEOUT,
  });
  const cards = page
    .getByRole("list", { name: "Posts for approval" })
    .getByRole("article", { name: /^Post p\d+$/ });
  await expect(cards).toHaveCount(3);

  const posts = await campaignPosts(page);
  expect(posts.map((post) => post.type).sort()).toEqual(["CAROUSEL", "REEL", "STATIC"]);
  for (const post of posts) {
    expect(post.status).toBe("PENDING_APPROVAL");
    expect(post.currentAssets.length).toBeGreaterThan(0);
    // Every current take is READY and served by the API's /files at the master size.
    for (const take of post.currentAssets) {
      expect(take.status).toBe("READY");
      expect([take.width, take.height]).toEqual(MASTER_SIZE);
      const still = take.posterUrl ?? take.url;
      expect(still).toBeTruthy();
      const file = await page.request.get(still!);
      expect(file.ok()).toBe(true);
      expect(file.headers()["content-type"]).toBe("image/png");
      expect(pngSize(await file.body())).toEqual(MASTER_SIZE);
    }

    // The card shows the first shot's image (alt text from the copy), loaded at full size.
    const card = postCard(page, post.ref);
    await expect(card.getByRole("button", { name: "Approve" })).toBeVisible();
    const alt = post.copy!.altText.trim() || `${post.ref} visual`;
    const image = card.getByRole("img", { name: alt, exact: true });
    await expect(image).toBeVisible();
    await expect.poll(() => loadedSize(image), { timeout: 15_000 }).toEqual(MASTER_SIZE);
    if (post.currentAssets.length > 1) {
      await expect(card).toContainText(`1/${post.currentAssets.length}`);
    }
    await expect(card.getByRole("img", { name: /, rendering$/ })).toHaveCount(0);
  }
  // The board has moved every card on to Approval, each showing its image now.
  const approvalColumn = board
    .getByRole("tabpanel", { name: CLIENT })
    .getByRole("region", { name: "Approval column" });
  await expect(approvalColumn.getByRole("article")).toHaveCount(3);
  await expect(visualColumn.getByRole("article")).toHaveCount(0);
  await expect(board.getByRole("img", { name: /, rendering$/ })).toHaveCount(0);
  await board.close();

  shared.state = await page.context().storageState();
});

test("the post drawer lists each shot's take and opens it in the Vault", async ({ browser }) => {
  const { context, page } = await openCampaign(browser);
  try {
    const [first] = await campaignPosts(page);
    const take = first!.currentAssets[0]!;
    await postCard(page, first!.ref)
      .getByRole("button", { name: `Open ${first!.ref} details` })
      .click();
    const drawer = page.getByRole("dialog", { name: new RegExp(`^${first!.ref}`) });
    const shots = drawer.getByRole("list", { name: "Shots" });
    await expect(shots.getByRole("link")).toHaveCount(first!.currentAssets.length);
    await shots.getByRole("link", { name: `Open ${take.shotId} · v1 in the Vault` }).click();

    await expect(page).toHaveURL(new RegExp(`/vault\\?asset=${take.id}$`));
    const takeDrawer = page.getByRole("dialog", { name: `${first!.ref} · ${take.shotId} v1` });
    await expect(takeDrawer).toBeVisible();
    await expect(takeDrawer).toContainText("Current take");
    await expect(takeDrawer).toContainText("MOCK");
    await takeDrawer.getByRole("button", { name: "Close" }).click();
    await expect(page).toHaveURL(/\/vault$/);
  } finally {
    await context.close();
  }
});

test("the Vault narrows to one scene of the reel or one slide of the carousel", async ({
  browser,
}) => {
  const { context, page } = await openCampaign(browser);
  try {
    const posts = await campaignPosts(page);
    const reel = posts.find((post) => post.type === "REEL")!;
    const carousel = posts.find((post) => post.type === "CAROUSEL")!;
    const sceneTwo = reel.currentAssets.find((take) => take.sceneIndex === 1)!;
    const slideOne = carousel.currentAssets.find((take) => take.slideIndex === 0)!;
    const campaign = await apiGet<CampaignDto>(page, `/campaigns/${shared.campaignId!}`);

    await primaryNav(page).getByRole("link", { name: "The Vault" }).click();
    const grid = page.getByRole("list", { name: "Takes" });
    await expect(grid.getByRole("article").first()).toBeVisible();
    await page.getByLabel("Campaign").selectOption({ label: campaign.name });
    const place = page.getByLabel("Scene or slide");

    // Scene 2 (sceneIndex 1): only the reel's take of that scene.
    await place.selectOption({ label: "Scene 2" });
    await expect(page).toHaveURL(/[?&]sceneIndex=1(&|$)/);
    const sceneTile = grid.getByRole("article", {
      name: `${reel.ref} · ${sceneTwo.shotId} · v${sceneTwo.version}`,
      exact: true,
    });
    await expect(sceneTile).toBeVisible();
    const byScene = await apiGet<AssetListResponse>(page, "/assets", {
      campaignId: shared.campaignId!,
      sceneIndex: "1",
    });
    expect(byScene.items.map((item) => item.id)).toEqual([sceneTwo.id]);
    await expect(grid.getByRole("article")).toHaveCount(1);

    // Slide 1 (slideIndex 0): only the carousel's cover.
    await place.selectOption({ label: "Slide 1" });
    await expect(page).toHaveURL(/[?&]slideIndex=0(&|$)/);
    await expect(page).not.toHaveURL(/sceneIndex=/);
    await expect(
      grid.getByRole("article", {
        name: `${carousel.ref} · ${slideOne.shotId} · v${slideOne.version}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(grid.getByRole("article")).toHaveCount(1);

    // The address keeps the place, so a reload (or a shared link) shows the same takes.
    await page.reload();
    await expect(page.getByLabel("Scene or slide")).toHaveValue("slide:0");
    await expect(grid.getByRole("article")).toHaveCount(1);

    // Any scene or slide: every current take of the campaign again.
    await page.getByLabel("Scene or slide").selectOption({ label: "Any scene or slide" });
    await expect(page).not.toHaveURL(/(scene|slide)Index=/);
    const all = posts.reduce((count, post) => count + post.currentAssets.length, 0);
    await expect(grid.getByRole("article")).toHaveCount(all);
  } finally {
    await context.close();
  }
});

test("Vault search finds a take by its prompt, and Regenerate adds v2 from its original context", async ({
  browser,
}) => {
  test.setTimeout(PIPELINE_TIMEOUT + 30_000);
  const { context, page } = await openCampaign(browser);
  try {
    const posts = await campaignPosts(page);
    const staticPost = posts.find((post) => post.type === "STATIC")!;
    const target = staticPost.currentAssets[0]!;
    const v1 = await apiGet<AssetDetailDto>(page, `/assets/${target.id}`);
    const campaign = await apiGet<CampaignDto>(page, `/campaigns/${shared.campaignId!}`);
    const label = `${staticPost.ref} · ${target.shotId} · v1`;

    await primaryNav(page).getByRole("link", { name: "The Vault" }).click();
    await expect(page.getByRole("heading", { name: "Every take, versioned." })).toBeVisible();
    const grid = page.getByRole("list", { name: "Takes" });
    await expect(grid.getByRole("article").first()).toBeVisible();

    // Narrow to the campaign, then search the prompt: the take is found, versioned and MOCK.
    await page.getByLabel("Campaign").selectOption({ label: campaign.name });
    const search = page.getByLabel("Search the Vault");
    const phrase = v1.prompt.slice(0, 60).trim();
    await search.fill(phrase);
    await expect(page).toHaveURL(/[?&]q=/);
    const tile = grid.getByRole("article", { name: label, exact: true });
    await expect(tile).toBeVisible();
    await expect(tile).toContainText("v1");
    await expect(tile).toContainText("MOCK");
    await expect(tile).toContainText(staticPost.ref);
    // What the grid shows is what the API finds for the same search.
    const found = await apiGet<AssetListResponse>(page, "/assets", {
      q: phrase,
      campaignId: shared.campaignId!,
    });
    expect(found.items.map((item) => item.id)).toContain(target.id);
    await expect(grid.getByRole("article")).toHaveCount(found.items.length);
    await expect
      .poll(() => loadedSize(tile.getByRole("img", { name: v1.prompt, exact: true })))
      .toEqual(MASTER_SIZE);

    await search.fill("no take has this prompt zq9");
    await expect(page.getByText(/No take matches/)).toBeVisible();
    await search.fill(phrase);
    await expect(tile).toBeVisible();

    // The drawer: large preview, the prompt in mono, one version so far.
    await tile.getByRole("button", { name: `Open ${label}` }).click();
    // The drawer's title follows the version on its stage, so it is found by the shot.
    const drawer = page.getByRole("dialog", {
      name: new RegExp(`^${staticPost.ref} · ${target.shotId} v\\d+$`),
    });
    await expect(drawer).toHaveAccessibleName(`${staticPost.ref} · ${target.shotId} v1`);
    await expect(drawer.getByText(v1.prompt, { exact: true })).toBeVisible();
    const versions = drawer.getByRole("list", { name: "Versions" });
    await expect(versions.getByRole("button")).toHaveCount(1);
    await expect(versions.getByRole("button", { name: "v1, ready, current" })).toBeVisible();

    // Regenerate with a note: v2 shimmers at once, before the API has even answered.
    await drawer.getByLabel("Instruction (optional)").fill(INSTRUCTION);
    await drawer.getByRole("button", { name: "Regenerate" }).click();
    await expect(versions.getByRole("button")).toHaveCount(2);
    await expect(versions.getByRole("button", { name: /^v2, (queued|rendering)$/ })).toBeVisible();
    await expect(toast(page, "v2 is rendering")).toBeVisible();

    // …then, over SSE, it renders, passes review and becomes the current take.
    await expect(versions.getByRole("button", { name: "v2, ready, current" })).toBeVisible({
      timeout: PIPELINE_TIMEOUT,
    });
    await expect(versions.getByRole("button", { name: /^v1, / })).not.toHaveAccessibleName(
      /current/,
    );
    await expect(drawer).toHaveAccessibleName(`${staticPost.ref} · ${target.shotId} v2`);
    await expect(drawer).toContainText("Current take");
    await expect(drawer).toContainText("Regenerated from the Vault");

    // The Visual Director re-planned the same shot from its original context, the note verbatim.
    const v2 = (await apiGet<AssetDetailDto>(page, `/assets/${target.id}`)).lineage.versions.at(
      -1,
    )!;
    expect(v2).toMatchObject({
      version: 2,
      parentAssetId: target.id,
      shotId: target.shotId,
      status: "READY",
      isCurrent: true,
      createdBy: { name: expect.any(String) },
    });
    expect(v2.params.origin).toBe("vault");
    expect(v2.params.instruction).toBe(INSTRUCTION);
    expect(v2.prompt).toContain(INSTRUCTION);
    await expect(drawer.getByText(v2.prompt, { exact: true })).toBeVisible();
    await expect
      .poll(() => loadedSize(drawer.getByRole("img", { name: v2.prompt, exact: true })))
      .toEqual(MASTER_SIZE);

    // The grid swaps to the new current take, and the post's card follows.
    await drawer.getByRole("button", { name: "Close" }).click();
    await search.fill("");
    await expect(
      grid.getByRole("article", { name: `${staticPost.ref} · ${target.shotId} · v2`, exact: true }),
    ).toBeVisible();
    await expect(grid.getByRole("article", { name: label, exact: true })).toHaveCount(0);
    await page.getByLabel("Show all versions").check();
    await expect(grid.getByRole("article", { name: label, exact: true })).toBeVisible();
    await expect
      .poll(async () => {
        const post = (await campaignPosts(page)).find((p) => p.id === staticPost.id)!;
        return post.currentAssets.map((take) => take.version);
      })
      .toEqual([2]);
  } finally {
    await context.close();
  }
});
