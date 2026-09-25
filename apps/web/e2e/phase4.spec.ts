import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import {
  PLATFORM_LABEL,
  type CalendarGhostItem,
  type CalendarJobItem,
  type CalendarResponse,
  type ClientListResponse,
  type OAuthSelectionDto,
  type PostDto,
  type PostListResponse,
} from "@enmo/shared";
import {
  addDays,
  formatDayLabel,
  formatShortDay,
  monthGrid,
  monthOf,
} from "../src/components/calendar/calendar-model";
import { formatTimeIn } from "../src/components/calendar/zoned-time";
import { API_URL, E2E_ADMIN, WEB_URL } from "./env";
import { primaryNav, signIn, toast } from "./helpers";

/*
 * Phase 4 exit (DESIGN "Phase 4 — Go live (Meta)"): an approved post publishes itself, against the
 * mock LLM, MockProvider and dry-run publishing (see playwright.config.ts). A three-post brief for
 * a client in Riyadh runs to approval; the calendar shows the plan as ghost slots, dashed at 40%.
 * The Approvals Queue approves one post from its thumbnail, then the other two in one confirmed,
 * logged batch; the Publisher schedules every variant on Instagram and Facebook. On the calendar
 * each job sits on its client-local day at its client-local time; a drag the API refuses snaps
 * back with the reason, a drag it accepts moves at once and reports the hour the optimizer chose,
 * and "Move to date" does the same from the keyboard. Then the clock reaches the slots (the
 * ENMO_E2E tick hook runs tick.publish at the last one): every job publishes in dry run, each post
 * goes LIVE, and the calendar and the post card link the dryrun.enmo.marketing URL. Last, the
 * accounts tab: Connect Meta, the pick list the callback redirects back with (only what the admin
 * ticks is connected), and the other results it can come back with.
 *
 * The tests share one database and build on each other, so they run in order. The admin signs in
 * once (the API allows five sign-ins per email per minute, and earlier specs may have used some).
 */

test.describe.configure({ mode: "serial" });
// The whole month grid on screen: drags need both ends of the move in the viewport.
test.use({ viewport: { width: 1440, height: 1500 } });

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

const CLIENT = "Sahar Juice Bar";
const TIMEZONE = "Asia/Riyadh";
const BRIEF = `Launch campaign for ${CLIENT}: 1 reel and 2 static posts on Instagram and Facebook, next 2 weeks, push the cold-pressed line`;
/** Copy, shots, renders, reviews and QA for three posts; the mock is quick, CI isn't always. */
const PIPELINE_TIMEOUT = 90_000;
const DRY_RUN_URL = /^https:\/\/dryrun\.enmo\.marketing\//;
/** PATCH /v1/publish-jobs/:id (a reschedule), for holding or refusing one. */
const PUBLISH_JOB_URL = /\/v1\/publish-jobs\/[^/?]+$/;
const CANCELLED_MESSAGE = "The Meta sign-in was cancelled, so nothing was connected.";
/** A Meta sign-in's pick list, as the API's callback names it. */
const PICK = "pick-list-for-the-e2e-client-000000000000";

/** What Meta returned for the admin to pick from: one free Page and its Instagram account, and a
 * Page another client already has. */
function metaSelection(clientId: string): OAuthSelectionDto {
  const page = { pageId: "200000000000001", pageName: CLIENT, source: "oauth" as const };
  return {
    id: PICK,
    provider: "meta",
    clientId,
    clientName: CLIENT,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    accounts: [
      {
        key: "FACEBOOK:200000000000001",
        platform: "FACEBOOK",
        externalId: "200000000000001",
        handle: CLIENT,
        displayName: CLIENT,
        meta: page,
        status: "available",
        takenBy: null,
      },
      {
        key: "INSTAGRAM:17841400000000077",
        platform: "INSTAGRAM",
        externalId: "17841400000000077",
        handle: "sahar.juice",
        displayName: null,
        meta: { ...page, igUserId: "17841400000000077", username: "sahar.juice" },
        status: "available",
        takenBy: null,
      },
      {
        key: "FACEBOOK:200000000000002",
        platform: "FACEBOOK",
        externalId: "200000000000002",
        handle: "Other Brand",
        displayName: "Other Brand",
        meta: { pageId: "200000000000002", pageName: "Other Brand", source: "oauth" },
        status: "taken",
        takenBy: { clientId: "other-client", clientName: "Other Co" },
      },
    ],
  };
}

const shared: { state?: StorageState; clientId?: string; campaignId?: string } = {};

async function openAs(browser: {
  newContext(options: { storageState: StorageState }): Promise<BrowserContext>;
}): Promise<{ context: BrowserContext; page: Page }> {
  if (!shared.state || !shared.clientId || !shared.campaignId) {
    throw new Error("An earlier test didn't leave a signed-in session, a client and a campaign");
  }
  const context = await browser.newContext({ storageState: shared.state });
  return { context, page: await context.newPage() };
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

/** The client's items over the weeks around now (the brief's window is the next two). */
async function clientCalendar(page: Page): Promise<CalendarResponse> {
  const today = new Date().toISOString().slice(0, 10);
  return apiGet<CalendarResponse>(page, "/calendar", {
    from: addDays(today, -3),
    to: addDays(today, 50),
    clientId: shared.clientId!,
  });
}

async function clientJobs(page: Page): Promise<CalendarJobItem[]> {
  const { items } = await clientCalendar(page);
  return items.filter((item): item is CalendarJobItem => item.kind === "job");
}

function calendarPath(month: string): string {
  return `/calendar?client=${encodeURIComponent(shared.clientId!)}&month=${month}`;
}

/** One day's list of items in the month grid. */
function dayList(page: Page, date: string): Locator {
  return page.getByRole("list", { name: formatDayLabel(date), exact: true });
}

function jobChipName(job: CalendarJobItem, status: string): string {
  const time = formatTimeIn(job.scheduledFor, job.timezone);
  return `${CLIENT} · ${PLATFORM_LABEL[job.platform]} · ${time} · ${status} · ${job.title}`;
}

function jobChip(page: Page, job: CalendarJobItem, date = job.date): Locator {
  return dayList(page, date).getByRole("button", {
    name: new RegExp(
      `^${escape(CLIENT)} · ${PLATFORM_LABEL[job.platform]} · (moving|\\d{2}:\\d{2}) · SCHEDULED · ${escape(job.title)}$`,
    ),
  });
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A client-local "today", which is what the API's slots are counted from. */
function clientToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date());
}

/**
 * A day to move `job` to: in the same month grid, strictly after today (for the viewer and the
 * client alike, so the optimizer has a whole day), and free of the client's other posts on that
 * platform, so the day certainly has an open hour.
 */
function moveTarget(job: CalendarJobItem, jobs: readonly CalendarJobItem[], avoid: string[] = []) {
  const grid = monthGrid(monthOf(job.date));
  const floor = [new Date().toISOString().slice(0, 10), clientToday()].sort().at(-1)!;
  const busy = new Set(
    jobs.filter((other) => other.platform === job.platform).map((other) => other.date),
  );
  const days = grid.weeks
    .flat()
    .filter((day) => day > floor && !busy.has(day) && !avoid.includes(day));
  // Nearest first, so the move stays close to the plan.
  const distance = (day: string) => Math.abs(Date.parse(day) - Date.parse(job.date));
  const target = days.sort((a, b) => distance(a) - distance(b))[0];
  if (!target) throw new Error(`No free day to move ${job.id} to`);
  return target;
}

/** A pointer drag the way a person makes one: press, nudge past dnd-kit's threshold, glide, drop. */
async function drag(page: Page, source: Locator, target: Locator): Promise<void> {
  await source.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("drag: an end of the move isn't on screen");
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 12, startY + 4, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(to.height / 2, 30), { steps: 16 });
  await page.mouse.up();
}

test("a brief becomes posts waiting for approval, planned on the calendar as ghost slots", async ({
  page,
}) => {
  test.setTimeout(PIPELINE_TIMEOUT + 90_000);
  await signIn(page, E2E_ADMIN);

  await primaryNav(page).getByRole("link", { name: "Clients" }).click();
  await page.getByRole("button", { name: "New client" }).click();
  const dialog = page.getByRole("dialog", { name: "New client" });
  await dialog.getByLabel("Name").fill(CLIENT);
  await dialog.getByLabel("Time zone").selectOption(TIMEZONE);
  await dialog.getByLabel("Brand voice").fill("Bright, fresh, a little cheeky. Juice as sunshine.");
  await dialog.getByRole("button", { name: "Create client" }).click();
  await expect(toast(page, `${CLIENT} is on the roster`)).toBeVisible();
  const { items: clients } = await apiGet<ClientListResponse>(page, "/clients");
  const client = clients.find((candidate) => candidate.name === CLIENT);
  expect(client?.timezone).toBe(TIMEZONE);
  shared.clientId = client!.id;

  await primaryNav(page).getByRole("link", { name: "The Brief" }).click();
  // The client list's own search field ("Search clients") answers to "Client" until it's gone.
  await expect(page).toHaveURL(/\/brief$/);
  const composer = page.getByLabel("Brief the Manager");
  await expect(composer).toBeVisible();
  await page.getByLabel("Client").selectOption({ label: CLIENT });
  await composer.fill(BRIEF);
  await composer.press("Enter");
  await expect(page).toHaveURL(/\/brief\/[^/]+$/);
  shared.campaignId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!);

  const plan = page.getByRole("region", { name: "Plan v1" });
  await expect(plan).toContainText("Awaiting approval", { timeout: PIPELINE_TIMEOUT });
  await plan.getByRole("button", { name: "Approve plan" }).click();
  await expect(toast(page, "Plan approved")).toBeVisible();
  await expect(page.getByText("3 posts passed QA and are waiting for approval.")).toBeVisible({
    timeout: PIPELINE_TIMEOUT,
  });

  const posts = await campaignPosts(page);
  expect(posts.map((post) => post.type).sort()).toEqual(["REEL", "STATIC", "STATIC"]);
  for (const post of posts) {
    expect(post.status).toBe("PENDING_APPROVAL");
    expect(post.targetDate).not.toBeNull();
    expect(post.publishing.map((entry) => [entry.platform, entry.status])).toEqual([
      ["INSTAGRAM", null],
      ["FACEBOOK", null],
    ]);
  }

  // Nothing is scheduled yet: the calendar shows the plan, one ghost per post and platform.
  const { items } = await clientCalendar(page);
  const ghosts = items.filter((item): item is CalendarGhostItem => item.kind === "ghost");
  expect(ghosts).toHaveLength(6);
  expect(items.filter((item) => item.kind === "job")).toHaveLength(0);
  const month = monthOf(ghosts[0]!.date);
  await page.goto(calendarPath(month));
  await expect(page.getByRole("heading", { name: "Every slot, every client." })).toBeVisible();
  const grid = monthGrid(month);
  const onGrid = ghosts.filter((ghost) => ghost.date >= grid.from && ghost.date <= grid.to);
  const perDay = new Map<string, number>();
  for (const ghost of onGrid) perDay.set(ghost.date, (perDay.get(ghost.date) ?? 0) + 1);
  for (const ghost of onGrid) {
    // A cell lists its first VISIBLE_PER_DAY (3) items, then "+N more".
    if (perDay.get(ghost.date)! > 3) continue;
    const chip = dayList(page, ghost.date).getByRole("button", {
      name: `${CLIENT} · ${PLATFORM_LABEL[ghost.platform]} · planned · ${ghost.title}`,
      exact: true,
    });
    await expect(chip).toBeVisible();
    await expect(chip).toHaveCSS("opacity", "0.4");
    await expect(chip).toHaveCSS("border-top-style", "dashed");
  }
  const shown = [...perDay.values()].reduce((sum, count) => sum + Math.min(count, 3), 0);
  await expect(page.getByRole("button", { name: /· planned ·/ })).toHaveCount(shown);

  // A ghost opens to say what it is waiting for.
  const first = onGrid[0]!;
  await dayList(page, first.date)
    .getByRole("button", { name: new RegExp(`· ${PLATFORM_LABEL[first.platform]} · planned ·`) })
    .click();
  const details = page.getByRole("dialog", {
    name: `${CLIENT} · ${PLATFORM_LABEL[first.platform]}`,
  });
  await expect(details).toContainText("the Publisher picks its slot");
  await details.getByRole("button", { name: "Close" }).click();

  shared.state = await page.context().storageState();
});

test("the Approvals Queue approves one post from its thumbnail, then the rest in one logged batch", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const { context, page } = await openAs(browser);
  try {
    const posts = await campaignPosts(page);
    await page.goto("/approvals");
    await expect(
      page.getByRole("heading", { name: "Nothing speaks for a brand unapproved." }),
    ).toBeVisible();
    await page.getByLabel("Client").selectOption({ label: CLIENT });
    await expect(page).toHaveURL(new RegExp(`[?&]clientId=${shared.clientId}`));

    const queue = page.getByRole("list", { name: "Waiting for approval" });
    const tiles = queue.getByRole("article", { name: new RegExp(`^p\\d+ · ${CLIENT}$`) });
    await expect(tiles).toHaveCount(3);
    await expect(page.getByText("3 waiting · 3 on you")).toBeVisible();
    // By platform: none of the posts is for TikTok; Instagram brings all three back.
    await page.getByLabel("Platform", { exact: true }).selectOption({ label: "TikTok" });
    await expect(page).toHaveURL(/[?&]platform=TIKTOK/);
    await expect(tiles).toHaveCount(0);
    await expect(
      page.getByText("Nothing waiting for approval matches these filters."),
    ).toBeVisible();
    await page.getByLabel("Platform", { exact: true }).selectOption({ label: "Instagram" });
    await expect(page).toHaveURL(/[?&]platform=INSTAGRAM/);
    await expect(tiles).toHaveCount(3);
    // Thumbnails: each tile carries the post's 9:16 card, which opens its details.
    for (const post of posts) {
      const tile = queue.getByRole("article", { name: `${post.ref} · ${CLIENT}`, exact: true });
      await expect(tile.getByRole("article", { name: `Thumbnail of ${post.ref}` })).toBeVisible();
    }

    // One approved on its own, from its thumbnail.
    const [single, ...rest] = posts;
    const singleTile = queue.getByRole("article", { name: `${single!.ref} · ${CLIENT}` });
    await singleTile.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(toast(page, `${single!.ref} approved`)).toBeVisible();
    await expect(tiles).toHaveCount(2);

    // The others, together: selected, confirmed, and logged as one approve-all.
    await page.getByLabel("Select all 2 waiting on you").check();
    const bar = page.getByRole("region", { name: "Batch approve" });
    await expect(bar).toContainText("2 selected");
    await bar.getByRole("button", { name: "Approve selected (2)" }).click();
    const confirm = page.getByRole("dialog", { name: "Approve 2 posts?" });
    await expect(confirm).toContainText("logged to the audit trail as one approve-all");
    await confirm.getByRole("button", { name: "Approve 2" }).click();
    await expect(toast(page, "2 posts approved")).toBeVisible();
    await expect(toast(page, /Logged to the audit trail as one approve-all/)).toBeVisible();
    await expect(tiles).toHaveCount(0);
    await expect(
      page.getByText("Nothing waiting for approval matches these filters."),
    ).toBeVisible();
    for (const post of rest) {
      expect((await campaignPosts(page)).find((p) => p.id === post.id)?.approved).toBe(true);
    }

    // The Publisher schedules every variant: one dry-run job per post and platform.
    await expect
      .poll(
        async () =>
          (await campaignPosts(page)).flatMap((post) =>
            post.publishing.map((entry) => `${post.status}:${entry.status}:${entry.dryRun}`),
          ),
        { timeout: 45_000 },
      )
      .toEqual(Array.from({ length: 6 }, () => "SCHEDULED:SCHEDULED:true"));
  } finally {
    await context.close();
  }
});

test("the calendar shows each job at its client's time; a drag moves it, a refused one snaps back, and Move to date does it by keyboard", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const { context, page } = await openAs(browser);
  try {
    const jobs = await clientJobs(page);
    expect(jobs).toHaveLength(6);
    const moved = jobs.find((job) => job.platform === "INSTAGRAM")!;
    const month = monthOf(moved.date);
    await page.goto(calendarPath(month));

    // Every job of the month, on its Riyadh day at its Riyadh time, marked as a dry run.
    const grid = monthGrid(month);
    for (const job of jobs.filter((job) => job.date >= grid.from && job.date <= grid.to)) {
      const chip = dayList(page, job.date).getByRole("button", {
        name: jobChipName(job, "SCHEDULED"),
        exact: true,
      });
      await expect(chip).toBeVisible();
      await expect(chip).toContainText("DRY");
      await expect(chip).toHaveAttribute("title", /client time \(Asia\/Riyadh\)/);
    }

    // Refused (a day the optimizer finds full): the job snaps back and the reason is shown.
    const target = moveTarget(moved, jobs);
    await page.route(PUBLISH_JOB_URL, (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              error: { code: "CONFLICT", message: "That day has no free slot left." },
            }),
          })
        : route.fallback(),
    );
    await drag(page, jobChip(page, moved), dayList(page, target));
    await expect(
      toast(page, `Couldn't move ${CLIENT} · Instagram to ${formatShortDay(target)}`),
    ).toBeVisible();
    await expect(toast(page, "That day has no free slot left.")).toBeVisible();
    await expect(jobChip(page, moved)).toBeVisible();
    await expect(jobChip(page, moved, target)).toHaveCount(0);
    await page.unroute(PUBLISH_JOB_URL);

    // Accepted: it lands on the new day at once, while the optimizer is still picking the hour.
    await page.route(PUBLISH_JOB_URL, async (route) => {
      if (route.request().method() === "PATCH")
        await new Promise((done) => setTimeout(done, 1_500));
      await route.fallback();
    });
    await drag(page, jobChip(page, moved), dayList(page, target));
    await expect(
      dayList(page, target).getByRole("button", {
        name: /^Sahar Juice Bar · Instagram · moving ·/,
      }),
    ).toBeVisible();
    await expect(
      toast(
        page,
        new RegExp(`^${CLIENT} · Instagram moved to ${formatShortDay(target)}, \\d{2}:\\d{2}$`),
      ),
    ).toBeVisible();
    await page.unroute(PUBLISH_JOB_URL);
    const afterDrag = (await clientJobs(page)).find((job) => job.id === moved.id)!;
    expect(afterDrag).toMatchObject({ date: target, status: "SCHEDULED", slotSource: "manual" });
    await expect(
      dayList(page, target).getByRole("button", {
        name: jobChipName(afterDrag, "SCHEDULED"),
        exact: true,
      }),
    ).toBeVisible();

    // By keyboard: open another post's job and move it to a date.
    const current = await clientJobs(page);
    const keyed = current.find(
      (job) => job.platform === "FACEBOOK" && job.postId !== moved.postId,
    )!;
    if (monthOf(keyed.date) !== month) await page.goto(calendarPath(monthOf(keyed.date)));
    const keyedTarget = moveTarget(keyed, current, [target]);
    const keyedChip = dayList(page, keyed.date).getByRole("button", {
      name: jobChipName(keyed, "SCHEDULED"),
      exact: true,
    });
    await keyedChip.focus();
    await page.keyboard.press("Enter");
    const details = page.getByRole("dialog", { name: `${CLIENT} · Facebook` });
    await expect(details).toContainText("Asia/Riyadh");
    await details.getByLabel("Move to date").fill(keyedTarget);
    await details.getByRole("button", { name: "Move", exact: true }).press("Enter");
    await expect(details).toBeHidden();
    await expect(
      toast(page, new RegExp(`^${CLIENT} · Facebook moved to ${formatShortDay(keyedTarget)}, `)),
    ).toBeVisible();
    await expect
      .poll(async () => (await clientJobs(page)).find((job) => job.id === keyed.id)?.date)
      .toBe(keyedTarget);

    // A platform left with nothing scheduled (its publish called off here; the Publisher also
    // leaves one when the campaign window has no free slot) goes on a day from its ghost.
    const dropped = (await clientJobs(page)).find(
      (job) => job.platform === "INSTAGRAM" && job.id !== moved.id,
    )!;
    const cancelled = await page.request.post(`${API_URL}/v1/publish-jobs/${dropped.id}/cancel`, {
      headers: { origin: WEB_URL },
    });
    expect(cancelled.ok(), `cancel → ${cancelled.status()}`).toBe(true);
    const ghost = (await clientCalendar(page)).items.find(
      (item): item is CalendarGhostItem =>
        item.kind === "ghost" && item.postId === dropped.postId && item.platform === "INSTAGRAM",
    )!;
    await page.goto(calendarPath(monthOf(ghost.date)));
    await expect(dayList(page, ghost.date)).toBeVisible();
    const ghostChip = page.getByRole("button", {
      name: `${CLIENT} · Instagram · planned · ${ghost.title}`,
      exact: true,
    });
    const showAll = page.getByRole("button", {
      name: new RegExp(`^Show all \\d+ on ${formatShortDay(ghost.date)}$`),
    });
    // The day renders before its items arrive: wait for one of the two before choosing.
    await expect(ghostChip.or(showAll).first()).toBeVisible();
    if (!(await ghostChip.isVisible())) await showAll.click();
    await ghostChip.click();
    const ghostDetails = page.getByRole("dialog", { name: `${CLIENT} · Instagram` });
    await expect(ghostDetails).toContainText("Put it on a day");
    await ghostDetails.getByLabel("Schedule on date").fill(ghost.date);
    await ghostDetails.getByRole("button", { name: "Schedule", exact: true }).click();
    await expect(ghostDetails).toBeHidden();
    await expect(toast(page, "Scheduled on Instagram")).toBeVisible();
    await expect
      .poll(async () => {
        const job = (await clientJobs(page)).find(
          (candidate) => candidate.postId === dropped.postId && candidate.platform === "INSTAGRAM",
        );
        return job && [job.status, job.date, job.slotSource];
      })
      .toEqual(["SCHEDULED", ghost.date, "manual"]);
  } finally {
    await context.close();
  }
});

test("when the slots come, every post publishes itself in dry run and goes LIVE with its live URL", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const { context, page } = await openAs(browser);
  try {
    const jobs = await clientJobs(page);
    const last = jobs
      .map((job) => job.scheduledFor)
      .sort()
      .at(-1)!;
    const first = [...jobs].sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))[0]!;
    const month = monthOf(first.date);
    await page.goto(calendarPath(month));
    await expect(jobChip(page, first)).toBeVisible();

    // The clock reaches the last slot: tick.publish queues every due job, the worker publishes.
    const tick = await page.request.post(`${API_URL}/v1/e2e/ticks/publish`, {
      data: { at: last },
      headers: { origin: WEB_URL },
    });
    expect(tick.ok(), `tick → ${tick.status()}`).toBe(true);
    // At least this campaign's six (another spec's campaign may have slots before then too).
    expect(((await tick.json()) as { queued: number }).queued).toBeGreaterThanOrEqual(6);

    await expect
      .poll(async () => (await campaignPosts(page)).map((post) => post.status), {
        timeout: 45_000,
      })
      .toEqual(["LIVE", "LIVE", "LIVE"]);
    const posts = await campaignPosts(page);
    for (const post of posts) {
      expect(post.liveAt).not.toBeNull();
      for (const entry of post.publishing) {
        expect(entry).toMatchObject({ status: "PUBLISHED", dryRun: true });
        expect(entry.liveUrl).toMatch(DRY_RUN_URL);
        expect(entry.publishedAt).not.toBeNull();
      }
    }

    // The open calendar follows over SSE: the job reads LIVE and links its live post.
    const published = (await clientJobs(page)).find((job) => job.id === first.id)!;
    expect(published.liveUrl).toMatch(DRY_RUN_URL);
    const liveChip = dayList(page, published.date).getByRole("link", {
      name: `${jobChipName(published, "LIVE")}, open the live post`,
      exact: true,
    });
    await expect(liveChip).toBeVisible();
    await expect(liveChip).toHaveAttribute("href", published.liveUrl!);
    await expect(liveChip).toHaveAttribute("target", "_blank");

    // The post card says the same, per platform, with the DRY RUN tag.
    const post = posts.find((candidate) => candidate.id === published.postId)!;
    await page.goto(`/brief/${shared.campaignId!}`);
    const card = page.getByRole("article", { name: `Post ${post.ref}`, exact: true });
    await expect(card).toContainText("LIVE");
    const publishing = card.getByRole("list", { name: "Publishing" });
    for (const entry of post.publishing) {
      const line = publishing.getByRole("listitem", {
        name: `${PLATFORM_LABEL[entry.platform]}: LIVE`,
      });
      await expect(line).toContainText("DRY RUN");
      await expect(line.getByRole("link", { name: "View live post" })).toHaveAttribute(
        "href",
        entry.liveUrl!,
      );
    }
  } finally {
    await context.close();
  }
});

test("Connect Meta sends an admin to Meta's consent screen, and its result comes back to the accounts tab", async ({
  browser,
}) => {
  const { context, page } = await openAs(browser);
  try {
    const accountsPath = `/clients/${shared.clientId!}`;

    // This server has no Meta app: the API refuses to start, and the button says why up front.
    const refused = await page.request.get(`${API_URL}/v1/oauth/meta/start`, {
      params: { clientId: shared.clientId! },
    });
    expect(refused.status()).toBe(503);
    expect(await refused.text()).toContain("META_APP_ID");
    await page.goto(`${accountsPath}?tab=accounts`);
    const panel = page.getByRole("tabpanel", { name: "Accounts" });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("button", { name: "Connect Meta" })).toBeDisabled();
    await expect(panel).toContainText("META_APP_ID and META_APP_SECRET");

    // With a Meta app, /start answers with the consent URL and the browser goes there; the consent
    // screen and the API's callback (covered by the API's own tests) are stood in for by sending
    // the browser straight to where the callback redirects: the pick list of what Meta returned.
    await page.route(/\/v1\/capabilities$/, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { integrations: Record<string, boolean> };
      await route.fulfill({
        response,
        json: { ...body, integrations: { ...body.integrations, meta: true } },
      });
    });
    await page.route(/\/v1\/oauth\/meta\/start\?/, (route) =>
      route.fulfill({
        json: {
          authorizeUrl: `${WEB_URL}${accountsPath}?tab=accounts&oauth=meta&outcome=choose&pick=${PICK}`,
        },
      }),
    );
    const listed = metaSelection(shared.clientId!);
    let picked: string[] = [];
    await page.route(new RegExp(`/v1/oauth/meta/selections/${PICK}$`), async (route) => {
      if (route.request().method() === "GET") return route.fulfill({ json: listed });
      picked = (route.request().postDataJSON() as { keys: string[] }).keys;
      return route.fulfill({ json: { connected: picked.length, items: [] } });
    });
    await page.reload();
    await panel.getByRole("button", { name: "Connect Meta" }).click();
    const picker = page.getByRole("dialog", { name: "Choose what to connect" });
    await expect(picker).toBeVisible();
    // A lone free Page comes ticked with its Instagram account; another client's can't be picked.
    await expect(picker.getByRole("checkbox", { name: "Facebook: Sahar Juice Bar" })).toBeChecked();
    await expect(picker.getByRole("checkbox", { name: "Instagram: @sahar.juice" })).toBeChecked();
    const taken = picker.getByRole("checkbox", { name: "Facebook: Other Brand" });
    await expect(taken).toBeDisabled();
    await expect(picker).toContainText("Already connected to Other Co. Disconnect it there first.");
    await picker.getByRole("checkbox", { name: "Instagram: @sahar.juice" }).uncheck();
    await picker.getByRole("button", { name: "Connect 1 account" }).click();
    await expect(toast(page, "1 Meta account connected")).toBeVisible();
    expect(picked).toEqual(["FACEBOOK:200000000000001"]);
    await expect(picker).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`${accountsPath}\\?tab=accounts$`));
    await expect(page.getByRole("tabpanel", { name: "Accounts" })).toBeVisible();

    // A connect that came back without a pick list says how many it connected.
    await page.goto(`${accountsPath}?tab=accounts&oauth=meta&outcome=connected&connected=2`);
    await expect(toast(page, "2 Meta accounts connected")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${accountsPath}\\?tab=accounts$`));

    // A declined consent comes back as an error on the same tab.
    await page.goto(
      `${accountsPath}?tab=accounts&oauth=meta&outcome=error&message=${encodeURIComponent(CANCELLED_MESSAGE)}`,
    );
    await expect(toast(page, "Couldn't connect Meta")).toBeVisible();
    await expect(toast(page, CANCELLED_MESSAGE)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${accountsPath}\\?tab=accounts$`));

    // A callback that lost track of the client lands on the client list with its error.
    await page.goto(
      `/clients?oauth=meta&outcome=error&message=${encodeURIComponent("Start again.")}`,
    );
    await expect(toast(page, "Couldn't connect Meta")).toBeVisible();
    await expect(page).toHaveURL(/\/clients$/);
  } finally {
    await context.close();
  }
});
