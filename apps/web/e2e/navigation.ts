import { expect, type Page } from "@playwright/test";

type Destination = "Upload photo" | "Batches" | "Collection" | "Decks" | "Import / export" | "My account" | "Administration";

// Call only after a newly created account's first successful sign-in. Waiting
// for the tour explicitly avoids racing its asynchronous session hydration.
export async function skipWelcomeTour(page: Page) {
  const tour = page.getByRole("dialog", { name: "Quick tour", exact: true });
  await expect(tour).toBeVisible({ timeout: 15000 });
  const [saved] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/api/auth/onboarding/dismiss") && response.request().method() === "POST"),
    tour.getByRole("button", { name: "Skip tour", exact: true }).click(),
  ]);
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await expect(tour).not.toBeVisible();
}

export async function openNavigation(page: Page) {
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  const navigation = page.getByRole("dialog", { name: "Menu", exact: true }).getByRole("navigation", { name: "Main navigation", exact: true });
  await expect(navigation).toBeVisible();
  return navigation;
}

export async function navigate(page: Page, destination: Destination) {
  const navigation = await openNavigation(page);
  await navigation.getByRole("button", { name: destination, exact: true }).click();
  await expect(navigation).not.toBeVisible();
}

export async function cancelBrowserBack(page: Page) {
  const originalURL = page.url();
  const warning = page.waitForEvent("dialog");
  const traversal = page.evaluate(() => history.back());
  await (await warning).dismiss();
  await traversal;
  // history.back() returns before popstate. Wait for the warning and the
  // cancelled traversal to finish before attempting another Back gesture.
  await expect(page).toHaveURL(originalURL);
}
