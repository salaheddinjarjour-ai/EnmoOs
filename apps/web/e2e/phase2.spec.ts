import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { API_URL, E2E_ADMIN } from "./env";
import { addChips, primaryNav, signIn, toast } from "./helpers";

/*
 * Phase 2 exit (DESIGN "Phase 2 — First words"): brief → caption drafts → approve in the UI, text
 * only, against the mock LLM with the embedded worker (see playwright.config.ts). The admin briefs
 * a new client's Ramadan campaign in chat; the Manager asks exactly one consolidated question,
 * then proposes a plan, and nothing is generated until a human approves it. A change request on
 * the plan comes back as version 2 quoting the note verbatim. Approving it drafts twelve posts
 * with live progress over SSE; p2 is approved on its own; a Request Changes on p3 reaches the
 * Copywriter word for word and opens approval round 2; a copy edit with a banned word is flagged
 * inline and refused by the API; the Command Center boards the posts in the Approval and Scheduled
 * columns; then one logged approve-all approves the other eleven, and the board moves them on.
 *
 * The tests share one database and build on each other, so they run in order. The admin signs in
 * once (the API allows five sign-ins per email per minute, and phase1 may have used four).
 */

test.describe.configure({ mode: "serial" });

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

const CLIENT = "Bayt Coffee Roasters";
const BRIEF = "Ramadan campaign for the coffee client — 12 posts, push the iced line";
const ANSWER = "Instagram and TikTok, March 1–30";
const PLAN_FEEDBACK = "Keep all 12, but open the month with the reels.";
const POST_FEEDBACK = "Lead with the iced cardamom latte, and land the hook in under two seconds.";
/** The pipeline runs 24+ agent calls; the mock is quick, but CI machines aren't always. */
const PIPELINE_TIMEOUT = 60_000;

const shared: { state?: StorageState; campaignPath?: string } = {};

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

function postCard(page: Page, ref: string): Locator {
  return page.getByRole("article", { name: `Post ${ref}`, exact: true });
}

function campaignId(page: Page): string {
  const id = /\/brief\/([^/?#]+)/.exec(page.url())?.[1];
  if (!id) throw new Error(`Not on a campaign thread: ${page.url()}`);
  return decodeURIComponent(id);
}

test("a brief gets one consolidated question, and the answer a plan before any spend", async ({
  page,
}) => {
  await signIn(page, E2E_ADMIN);

  // A client to brief for, with a word the Arsenal must never use.
  await primaryNav(page).getByRole("link", { name: "Clients" }).click();
  await page.getByRole("button", { name: "New client" }).click();
  const dialog = page.getByRole("dialog", { name: "New client" });
  await dialog.getByLabel("Name").fill(CLIENT);
  await dialog.getByLabel("Brand voice").fill("Unhurried and warm. Coffee as a ritual.");
  await addChips(dialog.getByLabel("Banned words"), ["cheap"]);
  await dialog.getByRole("button", { name: "Create client" }).click();
  await expect(toast(page, `${CLIENT} is on the roster`)).toBeVisible();

  // The Brief: nothing yet, so the idle Arsenal holds the composer.
  await primaryNav(page).getByRole("link", { name: "The Brief" }).click();
  await expect(page).toHaveURL(/\/brief$/);
  await expect(
    page.getByRole("heading", { name: "The Arsenal is idle. Give it a brief." }),
  ).toBeVisible();
  await page.getByLabel("Client").selectOption({ label: CLIENT });
  const composer = page.getByLabel("Brief the Manager");
  await composer.fill(BRIEF);
  await composer.press("Enter");

  await expect(page).toHaveURL(/\/brief\/[^/]+$/);
  shared.campaignPath = new URL(page.url()).pathname;
  const conversation = page.getByRole("list", { name: "Conversation" });
  await expect(conversation.getByText(BRIEF)).toBeVisible();

  // Exactly one clarifying question, naming what's missing.
  const clarify = page.getByRole("region", { name: "Clarifying question" });
  await expect(clarify).toBeVisible();
  await expect(clarify).toContainText("Ramadan");
  const missing = clarify.getByRole("list", { name: "Missing from the brief" });
  await expect(missing.getByRole("listitem")).toHaveText(["Platforms", "Dates"]);
  await expect(clarify).toContainText(CLIENT);

  const answer = clarify.getByLabel("Your answer");
  await answer.fill(ANSWER);
  await answer.press("Enter");
  await expect(conversation.getByText(ANSWER)).toBeVisible();

  // The brief is locked (gaps filled as written assumptions, never a second question)…
  const brief = page.getByRole("region", { name: "Brief", exact: true });
  await expect(brief).toContainText("12 posts");
  await expect(brief.getByRole("list", { name: "Platforms" }).getByRole("listitem")).toHaveText([
    "Instagram",
    "TikTok",
  ]);
  await expect(clarify).toContainText("Answered");
  await expect(page.getByRole("region", { name: "Clarifying question" })).toHaveCount(1);

  // …and the plan arrives: summary, twelve posts, and the estimate against today's budget.
  const plan = page.getByRole("region", { name: "Plan v1" });
  await expect(plan).toContainText("Awaiting approval", { timeout: PIPELINE_TIMEOUT });
  // One row per planned post (each row nests its own platform list).
  await expect(
    plan.getByRole("list", { name: "Planned posts" }).locator(":scope > li"),
  ).toHaveCount(12);
  await expect(plan).toContainText("Estimate");
  await expect(
    plan.getByRole("meter", { name: "Today's token budget with this plan" }),
  ).toBeVisible();
  await expect(plan.getByRole("button", { name: "Approve plan" })).toBeVisible();

  // No generation spend before approval: no agent tasks exist, no progress shows.
  const tasks = await page.request.get(`${API_URL}/v1/campaigns/${campaignId(page)}/tasks`);
  expect(tasks.ok()).toBe(true);
  expect(((await tasks.json()) as { items: unknown[] }).items).toEqual([]);
  await expect(page.getByRole("region", { name: "Live progress" })).toHaveCount(0);

  // While the plan waits, the composer asks the Manager for changes rather than chatting.
  await expect(page.getByLabel("Message the Manager")).toHaveAttribute(
    "placeholder",
    /change in the plan/,
  );

  shared.state = await page.context().storageState();
});

test("a change request re-plans verbatim; approving starts the Arsenal with live progress", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await openCampaign(browser);
  try {
    const v1 = page.getByRole("region", { name: "Plan v1" });
    await v1.getByRole("button", { name: "Request changes" }).click();
    await v1.getByLabel("What should change in the plan?").fill(PLAN_FEEDBACK);
    await v1.getByRole("button", { name: "Send to the Manager" }).click();
    await expect(toast(page, "Sent to the Manager")).toBeVisible();

    const v2 = page.getByRole("region", { name: "Plan v2" });
    await expect(v2).toContainText("You asked", { timeout: PIPELINE_TIMEOUT });
    await expect(v2).toContainText(PLAN_FEEDBACK);
    await expect(v1).toContainText("Superseded");
    await expect(v1.getByRole("button", { name: "Approve plan" })).toHaveCount(0);

    await v2.getByRole("button", { name: "Approve plan" }).click();
    await expect(toast(page, "Plan approved")).toBeVisible();
    await expect(v2).toContainText("Approved");

    // Live over SSE, no reload: the progress line, the Copywriter's sign-off, then the cards.
    const progress = page.getByRole("region", { name: "Live progress" });
    await expect(progress).toBeVisible({ timeout: PIPELINE_TIMEOUT });
    await expect(page.getByText("Copywriter ✓ 12/12 — copy drafted.")).toBeVisible({
      timeout: PIPELINE_TIMEOUT,
    });
    await expect(progress).toContainText("Copywriter ✓ 12/12", { timeout: PIPELINE_TIMEOUT });
    await expect(page.getByText("12 posts passed QA and are waiting for approval.")).toBeVisible({
      timeout: PIPELINE_TIMEOUT,
    });

    const cards = page
      .getByRole("list", { name: "Posts for approval" })
      .getByRole("article", { name: /^Post p\d+$/ });
    await expect(cards).toHaveCount(12);
    for (const card of await cards.all()) {
      await expect(card).toContainText("PENDING_APPROVAL");
      await expect(card.getByRole("button", { name: "Approve" })).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Approve all 12" })).toBeVisible();
    // The brief is locked now: the composer is closed.
    await expect(page.getByLabel("Message the Manager")).toBeDisabled();
  } finally {
    await context.close();
  }
});

test("one post is approved on its own; Request Changes reaches the Copywriter verbatim and opens round 2; banned words are refused", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await openCampaign(browser);
  try {
    // Approve one: the card goes green at once and leaves the approve-all count.
    const p2 = postCard(page, "p2");
    await p2.getByRole("button", { name: "Approve" }).click();
    await expect(toast(page, "p2 approved")).toBeVisible();
    await expect(p2).toContainText("SCHEDULED");
    await expect(p2.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Approve all 11" })).toBeVisible();

    const p3 = postCard(page, "p3");
    await p3.getByRole("button", { name: "Request changes" }).click();
    const dialog = page.getByRole("dialog", { name: "Request changes to p3" });
    await dialog.getByLabel("What should change?").fill(POST_FEEDBACK);
    // Text only until the Visual Director joins: Copy is the target.
    await expect(dialog.getByRole("radio", { name: "Copy" })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: "Visual" })).toBeDisabled();
    await expect(dialog.getByRole("radio", { name: "Both" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Request changes" }).click();
    await expect(toast(page, "Changes requested on p3")).toBeVisible();

    // The revision comes back through QA as a new card, quoting the note word for word.
    await expect(page.getByText("1 post passed QA and is waiting for approval.")).toBeVisible({
      timeout: PIPELINE_TIMEOUT,
    });
    await expect(p3).toHaveCount(1);
    await expect(p3).toContainText(POST_FEEDBACK);
    await expect(p3).toContainText("Round 2");
    await expect(page.getByRole("article", { name: "Thumbnail of p3" })).toBeVisible();

    // A human edit with a banned word is flagged as typed, and the API refuses it.
    const p1 = postCard(page, "p1");
    await p1.getByRole("button", { name: "Edit" }).click();
    const drawer = page.getByRole("dialog", { name: /p1/ });
    const caption = drawer.getByLabel("Caption", { exact: true });
    await caption.fill("Cheap thrills are over. This is the iced line.");
    await expect(drawer.getByText("Banned word: “Cheap”")).toBeVisible();
    await drawer.getByRole("button", { name: "Save copy" }).click();
    await expect(drawer.getByRole("alert")).toContainText("The API refused the copy");

    await caption.fill("Poured slow over ice, for Ramadan nights.");
    await expect(drawer.getByText(/Banned word/)).toHaveCount(0);
    await drawer.getByRole("button", { name: "Save copy" }).click();
    await expect(toast(page, "p1 copy saved")).toBeVisible();
    await expect(drawer).toContainText("Poured slow over ice, for Ramadan nights.");
    await drawer.getByRole("button", { name: "Close" }).click();
    await expect(p1).toContainText("Round 2");
  } finally {
    await context.close();
  }
});

test("the Command Center boards the posts waiting for approval and the one approved", async ({
  browser,
}) => {
  const { context, page } = await openCampaign(browser);
  try {
    await primaryNav(page).getByRole("link", { name: "Command Center" }).click();
    await page.getByRole("tablist", { name: "Clients" }).getByRole("tab", { name: CLIENT }).click();
    const panel = page.getByRole("tabpanel", { name: CLIENT });
    const approval = panel.getByRole("region", { name: "Approval column" });
    const scheduled = panel.getByRole("region", { name: "Scheduled column" });
    await expect(approval.getByRole("article")).toHaveCount(11);
    await expect(scheduled.getByRole("article")).toHaveCount(1);
    await expect(scheduled.getByRole("button", { name: "Open p2 details" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("approve-all is one logged click that approves the other eleven", async ({ browser }) => {
  const { context, page } = await openCampaign(browser);
  try {
    const bar = page.getByRole("region", { name: "Approve all" });
    await expect(bar).toContainText("logged as one approve-all");
    // The one click is the decision: no confirmation step in between.
    await bar.getByRole("button", { name: "Approve all 11" }).click();
    await expect(toast(page, "11 posts approved")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(bar).toHaveCount(0);

    for (let ref = 1; ref <= 12; ref++) {
      const card = postCard(page, `p${ref}`);
      await expect(card).toContainText("SCHEDULED");
      await expect(card.getByRole("button", { name: "Approve" })).toHaveCount(0);
    }

    // Exactly one audit row for the whole batch.
    const audit = await page.request.get(`${API_URL}/v1/audit`, {
      params: { action: "approval.approve_all" },
    });
    expect(audit.ok()).toBe(true);
    expect(((await audit.json()) as { items: unknown[] }).items).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("the Command Center boards the approved posts, with the budget and live status on top", async ({
  browser,
}) => {
  const { context, page } = await openCampaign(browser);
  try {
    await expect(page.getByRole("meter", { name: "Daily token budget" })).toBeVisible();
    await expect(page.getByRole("status", { name: "Live updates: live" })).toBeVisible();

    await primaryNav(page).getByRole("link", { name: "The Brief" }).click();
    const group = page.getByRole("region", { name: new RegExp(CLIENT) });
    await expect(group.getByRole("link")).toHaveCount(1);
    await expect(group.getByRole("link")).toContainText(/PRODUCING|ACTIVE/);

    await primaryNav(page).getByRole("link", { name: "Command Center" }).click();
    await page.getByRole("tablist", { name: "Clients" }).getByRole("tab", { name: CLIENT }).click();
    const panel = page.getByRole("tabpanel", { name: CLIENT });
    const scheduled = panel.getByRole("region", { name: "Scheduled column" });
    await expect(scheduled.getByRole("article")).toHaveCount(12);
    await expect(
      panel.getByRole("region", { name: "Approval column" }).getByRole("article"),
    ).toHaveCount(0);
    await expect(panel.getByRole("region", { name: "Alerts" })).toContainText("All clear");

    // A card opens its details, with the way back to the thread.
    await scheduled.getByRole("button", { name: "Open p3 details" }).click();
    const drawer = page.getByRole("dialog", { name: /p3/ });
    await expect(drawer).toContainText(POST_FEEDBACK);
    await expect(drawer.getByRole("link", { name: "Open the campaign thread" })).toBeVisible();
  } finally {
    await context.close();
  }
});
