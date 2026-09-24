import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { E2E_ADMIN } from "./env";
import { addChips, openClientTab, primaryNav, signIn, toast } from "./helpers";

/*
 * Phase 1 exit (DESIGN "Phase 1 — Foundation"): log in, create a client, see the dashboard.
 * The seeded admin signs in, sees the idle Arsenal, creates "Qahwa Co" with banned words, finds
 * it on the roster and works through its settings tabs; an invited Editor joins through the
 * one-time link and gets no admin controls. The admin then revokes her mid-session (her open tab
 * is sent to sign in), restores and promotes her, and she names herself on Qahwa Co's approval
 * chain but still gets no admin-only controls; finally the admin archives Qahwa Co and signs out.
 *
 * The tests share one database and build on each other, so they run in order (and are never
 * retried: see playwright.config.ts). The API allows five sign-in attempts per email and ten per IP
 * per minute: the admin uses four (later tests reuse its session), Layla three.
 */

test.describe.configure({ mode: "serial" });

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** Signed-in browser state handed from the invite test to the ones after it. */
const sessions: { admin?: StorageState; layla?: StorageState } = {};

async function contextFor(
  browser: { newContext(options: { storageState: StorageState }): Promise<BrowserContext> },
  state: StorageState | undefined,
): Promise<{ context: BrowserContext; page: Page }> {
  if (!state) throw new Error("An earlier test didn't leave a signed-in session");
  const context = await browser.newContext({ storageState: state });
  return { context, page: await context.newPage() };
}

/** Every field on a read-only settings panel is locked, and no control that would change it shows. */
async function expectReadOnly(panel: Locator, notice: string): Promise<void> {
  await expect(panel.getByText(notice)).toBeVisible();
  await expect(
    panel.getByRole("button", { name: /^(Save |Discard|Add step|Restore default|Remove |Move )/ }),
  ).toHaveCount(0);
  for (const field of await panel.getByRole("textbox").all())
    await expect(field).not.toBeEditable();
  for (const role of ["checkbox", "combobox"] as const) {
    for (const control of await panel.getByRole(role).all()) await expect(control).toBeDisabled();
  }
}

const CLIENT = "Qahwa Co";
const CLIENT_LINK = new RegExp(CLIENT);
const IDLE = "The Arsenal is idle. Give it a brief.";
const VIEW_ONLY = "View only · Managers and Admins edit client settings";
const EDITOR = {
  name: "Layla Haddad",
  email: "layla.editor@enmo.test",
  password: "cardamom-and-saffron-42",
};

test("the admin signs in, sees the idle Arsenal and creates Qahwa Co", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await page.getByLabel("Email").fill(E2E_ADMIN.email);
  await page.getByLabel("Password", { exact: true }).fill("not-the-right-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByText("That email and password don't match an active account."),
  ).toBeVisible();

  await page.getByLabel("Password", { exact: true }).fill(E2E_ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/command$/);

  // The Command Center shell and its cinematic empty state, with one green CTA.
  await expect(page.getByRole("heading", { name: IDLE })).toBeVisible();
  await expect(page.getByRole("link", { name: "Start a brief" })).toHaveAttribute("href", "/brief");
  await expect(primaryNav(page).getByRole("link", { name: "Admin" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Simulated modes" })).toContainText("Dry-run");

  await primaryNav(page).getByRole("link", { name: "Clients" }).click();
  await expect(page).toHaveURL(/\/clients$/);
  await expect(page.getByRole("heading", { name: "No brands on the roster yet." })).toBeVisible();

  await page.getByRole("button", { name: "New client" }).click();
  const dialog = page.getByRole("dialog", { name: "New client" });
  await dialog.getByLabel("Name").fill(CLIENT);
  await expect(dialog.getByText("/qahwa-co")).toBeVisible();
  await dialog.getByLabel("Brand voice").fill("Warm, confident and rooted in Gulf coffee culture.");
  const bannedWords = dialog.getByLabel("Banned words");
  await addChips(bannedWords, ["cheap", "instant coffee", "CHEAP"]);
  await expect(dialog.getByText("Already listed")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Remove cheap" })).toBeVisible();
  await dialog.getByRole("button", { name: "Create client" }).click();

  await expect(dialog).toBeHidden();
  await expect(toast(page, `${CLIENT} is on the roster`)).toBeVisible();
  const card = page.getByRole("link", { name: CLIENT_LINK });
  await expect(card).toBeVisible();
  await expect(card).toContainText("/qahwa-co");

  // The client now has its own tab in the Command Center.
  await primaryNav(page).getByRole("link", { name: "Command Center" }).click();
  await page.getByRole("tablist", { name: "Clients" }).getByRole("tab", { name: CLIENT }).click();
  const clientPanel = page.getByRole("tabpanel", { name: CLIENT });
  await expect(clientPanel.getByRole("heading", { name: IDLE })).toBeVisible();
  await expect(clientPanel.getByRole("link", { name: "Start a brief" })).toHaveAttribute(
    "href",
    /\/brief\?clientId=/,
  );
  // A narrow window still says the run is simulated.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("list", { name: "Simulated modes" })).toBeHidden();
  await expect(page.getByText("Simulated", { exact: true })).toBeVisible();
});

test("Qahwa Co's settings hold its voice, style, banned words, accounts and chain", async ({
  page,
}) => {
  // Signed out, a deep link goes through /login and comes back.
  await page.goto("/clients");
  await expect(page).toHaveURL(/\/login\?next=%2Fclients$/);
  await page.getByLabel("Email").fill(E2E_ADMIN.email);
  await page.getByLabel("Password", { exact: true }).fill(E2E_ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/clients$/);

  await page.getByRole("link", { name: CLIENT_LINK }).click();
  await expect(page.getByRole("heading", { level: 1, name: CLIENT })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Client settings" }).getByRole("tab")).toHaveText([
    "Brand voice",
    "Visual style",
    /^Banned words/,
    "Accounts",
    /^Approval chain/,
  ]);

  // Brand voice
  const voice = page.getByRole("tabpanel", { name: "Brand voice" });
  const voiceField = voice.getByLabel("Brand voice");
  await expect(voiceField).toHaveValue("Warm, confident and rooted in Gulf coffee culture.");
  await voiceField.fill("Warm, confident, rooted in Gulf coffee culture. Never salesy.");
  await voice.getByRole("button", { name: "Save brand voice" }).click();
  await expect(toast(page, "Brand voice saved")).toBeVisible();

  // Visual style: palette swatches, mood, light, and the character sheet preview
  const visual = await openClientTab(page, "Visual style");
  for (const slot of ["Primary", "Secondary", "Accent", "Background", "Text"]) {
    await expect(visual.getByLabel(`${slot} hex`)).toBeVisible();
  }
  await visual.getByLabel("Accent hex").fill("#c8a165");
  await addChips(visual.getByLabel("Mood"), ["warm", "unhurried"]);
  await visual.getByLabel("Lighting").fill("Late-afternoon sun through lattice shadows");
  await expect(visual.getByRole("figure")).toContainText("warm, unhurried");
  await visual.getByRole("button", { name: "Save visual style" }).click();
  await expect(toast(page, "Visual style saved")).toBeVisible();
  await expect(visual.getByLabel("Accent hex")).toHaveValue("#C8A165");

  // Banned words: chip editor
  const banned = await openClientTab(page, "Banned words");
  await expect(banned.getByText("cheap", { exact: true })).toBeVisible();
  await expect(banned.getByText("instant coffee", { exact: true })).toBeVisible();
  await addChips(banned.getByLabel("Banned words"), ["knock-off"]);
  await banned.getByRole("button", { name: "Remove instant coffee" }).click();
  await banned.getByRole("button", { name: "Save banned words" }).click();
  await expect(toast(page, "Banned words saved")).toBeVisible();

  // Accounts: manual connect by an admin; the token never comes back
  const accounts = await openClientTab(page, "Accounts");
  await expect(accounts.getByText("No accounts connected yet.")).toBeVisible();
  await accounts.getByLabel("Platform").selectOption("INSTAGRAM");
  await accounts.getByLabel("Handle").fill("@qahwaco");
  await accounts.getByLabel("Instagram user ID").fill("17841400000000001");
  await accounts.getByLabel("Access token").fill("EAAG-e2e-very-secret-token");
  await accounts.getByRole("button", { name: "Connect account" }).click();
  await expect(toast(page, "Connected @qahwaco")).toBeVisible();
  await expect(accounts.getByRole("list", { name: "Connected accounts" })).toContainText(
    "@qahwaco",
  );
  await expect(accounts.getByLabel("Access token")).toHaveValue("");
  await expect(page.getByText("EAAG-e2e-very-secret-token")).toHaveCount(0);

  // Approval chain: add a second step. The editor counts who could approve each step today, and
  // with one admin on the team a step asking two admins could never complete, so it can't be saved.
  const chain = await openClientTab(page, "Approval chain");
  const first = chain.getByRole("group", { name: /Step 1/ });
  await expect(first.getByLabel("Step name")).toHaveValue("Manager review");
  await expect(first).toContainText("1 eligible approver · Admin");
  await chain.getByRole("button", { name: "Add step" }).click();
  const second = chain.getByRole("group", { name: /Step 2/ });
  await second.getByLabel("Step name").fill("Brand lead sign-off");
  await second.getByLabel("Approvals needed").selectOption("2");
  await expect(second).toContainText(
    "Needs 2 approvals, but only 1 active teammate can approve it.",
  );
  const saveChain = chain.getByRole("button", { name: "Save approval chain" });
  await expect(saveChain).toBeDisabled();
  await second.getByLabel("Approvals needed").selectOption("1");
  await expect(second).not.toContainText("Needs 2 approvals");
  await saveChain.click();
  await expect(toast(page, "Approval chain saved")).toBeVisible();

  // Everything persisted.
  await page.reload();
  const reloadedVoice = await openClientTab(page, "Brand voice");
  await expect(reloadedVoice.getByLabel("Brand voice")).toHaveValue(
    "Warm, confident, rooted in Gulf coffee culture. Never salesy.",
  );
  const reloadedBanned = await openClientTab(page, "Banned words");
  await expect(reloadedBanned.getByText("knock-off", { exact: true })).toBeVisible();
  await expect(reloadedBanned.getByText("instant coffee", { exact: true })).toHaveCount(0);
  const reloadedVisual = await openClientTab(page, "Visual style");
  await expect(reloadedVisual.getByLabel("Accent hex")).toHaveValue("#C8A165");
  for (const mood of ["warm", "unhurried"]) {
    await expect(
      reloadedVisual.getByRole("button", { name: `Remove ${mood}`, exact: true }),
    ).toBeVisible();
  }
  await expect(reloadedVisual.getByLabel("Lighting")).toHaveValue(
    "Late-afternoon sun through lattice shadows",
  );
  await expect(reloadedVisual.getByRole("figure")).toContainText("warm, unhurried");
  const reloadedChain = await openClientTab(page, "Approval chain");
  const reloadedSecond = reloadedChain.getByRole("group", { name: /Step 2/ });
  await expect(reloadedSecond.getByLabel("Step name")).toHaveValue("Brand lead sign-off");
  await expect(reloadedSecond.getByLabel("Approvals needed")).toHaveValue("1");
});

test("an invited Editor joins through the link and gets no admin controls", async ({
  page,
  browser,
}) => {
  await signIn(page, E2E_ADMIN);
  await primaryNav(page).getByRole("link", { name: "Admin" }).click();
  await expect(page).toHaveURL(/\/admin\/users$/);
  await expect(page.getByRole("heading", { name: "The team." })).toBeVisible();

  await page.getByRole("button", { name: "Invite teammate" }).click();
  const dialog = page.getByRole("dialog", { name: "Invite a teammate" });
  await dialog.getByLabel("Email").fill(EDITOR.email);
  await dialog.getByLabel("Role").selectOption("EDITOR");
  await dialog.getByRole("button", { name: "Create invite" }).click();
  const linkField = dialog.getByLabel("Invite link");
  await expect(linkField).toHaveValue(/\/invite\/[^/]+$/);
  const inviteLink = await linkField.inputValue();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("table", { name: "Invites" })).toContainText(EDITOR.email);

  const editorContext = await browser.newContext();
  try {
    const editor = await editorContext.newPage();
    await editor.goto(inviteLink);
    await expect(editor.getByRole("heading", { name: "Join ENMO OS" })).toBeVisible();
    await expect(editor.getByText(EDITOR.email)).toBeVisible();
    await editor.getByLabel("Your name").fill(EDITOR.name);
    await editor.getByLabel("Password", { exact: true }).fill(EDITOR.password);
    await editor.getByLabel("Confirm password").fill(EDITOR.password);
    await editor.getByRole("button", { name: "Join ENMO OS" }).click();

    await expect(editor).toHaveURL(/\/command$/);
    await expect(editor.getByRole("heading", { name: IDLE })).toBeVisible();
    const nav = primaryNav(editor);
    await expect(nav.getByRole("link", { name: "Clients" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Admin" })).toHaveCount(0);

    // Editors read clients but can't create or change them, on any settings tab.
    await nav.getByRole("link", { name: "Clients" }).click();
    await expect(editor.getByRole("link", { name: CLIENT_LINK })).toBeVisible();
    await expect(editor.getByRole("button", { name: "New client" })).toHaveCount(0);
    await editor.getByRole("link", { name: CLIENT_LINK }).click();
    // The header (and its actions) render with the client, so wait for it before checking.
    await expect(editor.getByRole("heading", { level: 1, name: CLIENT })).toBeVisible();
    await expect(editor.getByRole("button", { name: "Archive client" })).toHaveCount(0);
    for (const tab of ["Brand voice", "Visual style", "Banned words", "Approval chain"]) {
      await expectReadOnly(await openClientTab(editor, tab), VIEW_ONLY);
    }
    // Named approvers and eligibility show as names, not ids, to every reader.
    const chain = editor.getByRole("tabpanel", { name: "Approval chain" });
    await expect(chain.getByRole("group", { name: /Step 2/ })).toContainText(
      "1 eligible approver · Admin",
    );
    const accounts = await openClientTab(editor, "Accounts");
    await expect(accounts).toContainText("@qahwaco");
    await expect(accounts.getByRole("button", { name: "Connect account" })).toHaveCount(0);

    // Admin screens stay closed, and the invite link was single-use.
    await editor.goto("/admin/users");
    await expect(editor.getByRole("heading", { name: "Admins only." })).toBeVisible();
    await editor.goto(inviteLink);
    await expect(editor.getByRole("heading", { name: "This invite has closed." })).toBeVisible();
    sessions.layla = await editorContext.storageState();
  } finally {
    await editorContext.close();
  }

  // Back with the admin: the Editor is on the team and the invite is used up.
  await page.reload();
  await expect(page.getByRole("table", { name: "Team members" })).toContainText(EDITOR.name);
  await expect(page.getByRole("table", { name: "Invites" })).toContainText("Accepted");
  sessions.admin = await page.context().storageState();
});

test("a teammate revoked mid-session is sent to sign in; restored and promoted, she edits the chain", async ({
  browser,
}) => {
  const { context: adminContext, page: admin } = await contextFor(browser, sessions.admin);
  const { context: laylaContext, page: layla } = await contextFor(browser, sessions.layla);
  try {
    // Layla is signed in and working on the roster.
    await layla.goto("/clients");
    await expect(layla.getByRole("link", { name: CLIENT_LINK })).toBeVisible();

    await admin.goto("/admin/users");
    const members = admin.getByRole("table", { name: "Team members" });
    const laylaRow = members.getByRole("row", { name: new RegExp(EDITOR.name) });
    const deactivate = async () => {
      await laylaRow.getByRole("button", { name: `Deactivate ${EDITOR.name}` }).click();
      const confirm = admin.getByRole("dialog", { name: `Deactivate ${EDITOR.name}?` });
      await confirm.getByRole("button", { name: "Deactivate" }).click();
      await expect(confirm).toBeHidden();
      await expect(laylaRow).toContainText("Deactivated");
    };
    await deactivate();
    await expect(toast(admin, `${EDITOR.name} deactivated`)).toBeVisible();

    // Her open tab learns on its next request: the session is gone, so it goes to sign in and
    // keeps the way back. The deactivated account can't sign in.
    // click(), not check(): the page leaves for /login before the box can be seen checked, and
    // check() would then wait for a checkbox that no longer exists.
    await layla.getByLabel("Show archived").click();
    await expect(layla).toHaveURL(/\/login\?next=%2Fclients$/);
    await layla.getByLabel("Email").fill(EDITOR.email);
    await layla.getByLabel("Password", { exact: true }).fill(EDITOR.password);
    await layla.getByRole("button", { name: "Sign in" }).click();
    await expect(
      layla.getByText("That email and password don't match an active account."),
    ).toBeVisible();

    // Reactivated and made a Manager, she signs back in to where she was, now able to edit.
    await laylaRow.getByRole("button", { name: `Reactivate ${EDITOR.name}` }).click();
    await expect(toast(admin, `${EDITOR.name} can sign in again`)).toBeVisible();
    await laylaRow.getByLabel(`Role for ${EDITOR.name}`).selectOption("MANAGER");
    await expect(toast(admin, `${EDITOR.name} is now Manager`)).toBeVisible();

    await layla.getByLabel("Password", { exact: true }).fill(EDITOR.password);
    await layla.getByRole("button", { name: "Sign in" }).click();
    await expect(layla).toHaveURL(/\/clients$/);
    await expect(layla.getByRole("button", { name: "New client" })).toBeVisible();

    // Managers pick named approvers from the team directory too. Naming herself on the
    // brand-lead step gives it a second eligible approver, so it may now ask for two.
    await layla.getByRole("link", { name: CLIENT_LINK }).click();
    await expect(layla.getByRole("heading", { level: 1, name: CLIENT })).toBeVisible();
    // Archiving clients, connected accounts and the team stay with admins.
    await expect(layla.getByRole("button", { name: "Archive client" })).toHaveCount(0);
    await expect(primaryNav(layla).getByRole("link", { name: "Clients" })).toBeVisible();
    await expect(primaryNav(layla).getByRole("link", { name: "Admin" })).toHaveCount(0);
    const laylaAccounts = await openClientTab(layla, "Accounts");
    await expect(laylaAccounts.getByRole("list", { name: "Connected accounts" })).toContainText(
      "@qahwaco",
    );
    await expect(
      laylaAccounts.getByRole("button", { name: /^(Connect account|Check |Disconnect )/ }),
    ).toHaveCount(0);
    const chain = await openClientTab(layla, "Approval chain");
    const second = chain.getByRole("group", { name: /Step 2/ });
    await second.getByRole("checkbox", { name: EDITOR.name }).check();
    await expect(second).toContainText("2 eligible approvers · Admin, Layla Haddad");
    await second.getByLabel("Approvals needed").selectOption("2");
    await chain.getByRole("button", { name: "Save approval chain" }).click();
    await expect(toast(layla, "Approval chain saved")).toBeVisible();
    await layla.goto("/admin/users");
    await expect(layla.getByRole("heading", { name: "Admins only." })).toBeVisible();

    // Deactivating her now would leave that step an approver short; the team screen says so, and
    // the warning clears once she's back.
    await admin.reload();
    const stalled = admin.getByRole("region", { name: "Approval chains the team can't complete" });
    // The notice mounts with the page header and says when it has checked the fresh chains.
    await expect(admin.getByRole("heading", { name: "The team." })).toBeVisible();
    await expect(admin.getByText("Checking approval chains")).toHaveCount(0);
    await expect(members).toContainText(EDITOR.name);
    await expect(stalled).toHaveCount(0);
    await deactivate();
    await expect(stalled).toContainText(CLIENT);
    await expect(stalled).toContainText(
      'Step 2 "Brand lead sign-off": needs 2 approvals, but only 1 active teammate can approve it',
    );
    await laylaRow.getByRole("button", { name: `Reactivate ${EDITOR.name}` }).click();
    await expect(laylaRow).toContainText("Active");
    await expect(stalled).toHaveCount(0);
  } finally {
    await laylaContext.close();
    await adminContext.close();
  }
});

test("the app can't be framed and never leaks the page URL in a Referer", async ({ request }) => {
  for (const path of ["/login", "/invite/some-one-time-token", "/clients"]) {
    const response = await request.get(path);
    const headers = response.headers();
    expect(headers["x-frame-options"], path).toBe("DENY");
    expect(headers["content-security-policy"], path).toBe("frame-ancestors 'none'");
    expect(headers["referrer-policy"], path).toBe("no-referrer");
    expect(headers["x-content-type-options"], path).toBe("nosniff");
  }
});

test("a sign-in link can't send anyone off-site", async ({ page }) => {
  // Any request to the attacker's host is recorded and aborted, so a redirect can't hide.
  const offSite: string[] = [];
  await page.route(
    (url) => url.hostname === "evil.example",
    (route) => {
      offSite.push(route.request().url());
      return route.abort();
    },
  );

  // The URL parser drops the tab, so a naive check would read this as //evil.example/phish.
  await page.goto("/login?next=%2F%09%2Fevil.example%2Fphish");
  await page.getByLabel("Email").fill(EDITOR.email);
  await page.getByLabel("Password", { exact: true }).fill(EDITOR.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/command$/);
  await expect(page.getByRole("heading", { name: IDLE })).toBeVisible();

  // Already signed in, /login forwards straight to `next`: hostile values land on the dashboard.
  for (const next of [
    "%2F%0A%2Fevil.example",
    "%2F%5Cevil.example",
    "https%3A%2F%2Fevil.example",
  ]) {
    await page.goto(`/login?next=${next}`);
    await expect(page).toHaveURL(/\/command$/);
  }
  // …while a same-origin deep link is still honoured.
  await page.goto("/login?next=%2Fclients");
  await expect(page).toHaveURL(/\/clients$/);

  expect(offSite).toEqual([]);
});

test("an archived client leaves the roster but stays readable; signing out ends the session", async ({
  browser,
}) => {
  const { context, page } = await contextFor(browser, sessions.admin);
  try {
    await page.goto("/clients");
    await page.getByRole("link", { name: CLIENT_LINK }).click();
    await page.getByRole("button", { name: "Archive client" }).click();
    const dialog = page.getByRole("dialog", { name: `Archive ${CLIENT}?` });
    await dialog.getByRole("button", { name: "Archive client" }).click();
    await expect(page).toHaveURL(/\/clients$/);
    await expect(toast(page, `${CLIENT} archived`)).toBeVisible();

    // No active clients is not the same as no clients.
    await expect(page.getByRole("heading", { name: "No active clients." })).toBeVisible();
    await expect(page.getByText("1 archived client is hidden.")).toBeVisible();
    await page.getByRole("button", { name: "Show archived" }).click();
    const card = page.getByRole("link", { name: CLIENT_LINK });
    await expect(card).toContainText("Archived");
    await card.click();
    await expect(page.getByRole("heading", { level: 1, name: CLIENT })).toBeVisible();
    await expect(page.getByText("Archived", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Archive client" })).toHaveCount(0);
    for (const tab of ["Brand voice", "Visual style", "Banned words", "Approval chain"]) {
      await expectReadOnly(await openClientTab(page, tab), "Archived · read-only");
    }

    await primaryNav(page).getByRole("link", { name: "Command Center" }).click();
    await expect(page.getByText("No active clients (1 archived).")).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Clients" }).getByRole("tab")).toHaveText([
      "All clients",
    ]);

    // Signing out ends the session.
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/command");
    await expect(page).toHaveURL(/\/login$/);
  } finally {
    await context.close();
  }
});
