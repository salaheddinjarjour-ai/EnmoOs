import { expect, test, type Locator, type Page } from "@playwright/test";

/* Small page helpers shared by the browser specs. */

export interface Credentials {
  email: string;
  password: string;
}

/** How many times signIn waits out the sign-in rate limit before giving up. */
const RATE_LIMIT_WAITS = 2;
/** How long one sign-in click may take to land on the Command Center or on the limit. */
const SIGN_IN_TIMEOUT = 15_000;

/**
 * Signs in through the login form and waits for the Command Center. The API allows five sign-ins
 * per email per minute (DESIGN §E) and the specs share one admin, so when earlier specs spent that
 * budget the form says when to try again: wait that long, then sign in.
 */
export async function signIn(page: Page, { email, password }: Credentials): Promise<void> {
  const limited = page.getByRole("alert").filter({ hasText: /Too many sign-in attempts/ });
  for (let waits = 0; ; waits += 1) {
    // A fresh form each time, so an earlier attempt's alert can't be mistaken for this one's.
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    const outcome = await Promise.race([
      page.waitForURL(/\/command$/, { timeout: SIGN_IN_TIMEOUT }).then(
        () => "signed-in" as const,
        () => null,
      ),
      limited.waitFor({ timeout: SIGN_IN_TIMEOUT }).then(
        () => "limited" as const,
        () => null,
      ),
    ]);
    if (outcome !== "limited" || waits === RATE_LIMIT_WAITS) break;
    const waitMs = (Number(/in (\d+)s/.exec(await limited.innerText())?.[1] ?? 60) + 1) * 1_000;
    // The wait is the API's, not the test's: give the test that much more time.
    test.info().setTimeout(test.info().timeout + waitMs);
    await page.waitForTimeout(waitMs);
  }
  await expect(page).toHaveURL(/\/command$/);
}

export function primaryNav(page: Page): Locator {
  return page.getByRole("navigation", { name: "Primary" });
}

/** A tab panel of the client settings page, after selecting its tab. */
export async function openClientTab(page: Page, name: string): Promise<Locator> {
  await page.getByRole("tablist", { name: "Client settings" }).getByRole("tab", { name }).click();
  const panel = page.getByRole("tabpanel", { name });
  await expect(panel).toBeVisible();
  return panel;
}

/** Adds entries to a chip editor (Enter after each, like a person would). */
export async function addChips(input: Locator, entries: readonly string[]): Promise<void> {
  for (const entry of entries) {
    await input.fill(entry);
    await input.press("Enter");
  }
}

export function toast(page: Page, text: string | RegExp): Locator {
  return page.getByRole("region", { name: "Notifications" }).getByText(text);
}
