import { expect, type Locator, type Page } from "@playwright/test";

/* Small page helpers shared by the browser specs. */

export interface Credentials {
  email: string;
  password: string;
}

/** Signs in through the login form and waits for the Command Center. */
export async function signIn(page: Page, { email, password }: Credentials): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
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
