import { expect, test, type Page } from "@playwright/test";
import { navigate, openNavigation } from "./navigation";
import { noPriceAlerts } from "./price-alert-fixture";

type Account = { owner: string; dismissed: boolean; failures: number };
type ApiCall = { path: string; method: string; csrf: string | undefined };
const dismissPath = "/api/auth/onboarding/dismiss";
const headings = [
  "Make room for your collection.", "Find the card you need.",
  "Add cards when you’re ready.", "Build a place for every card.",
];

async function mockAccount(page: Page, account: Account = { owner: "new-collector", dismissed: false, failures: 0 }) {
  const calls: ApiCall[] = [];
  let fileChoosers = 0;
  page.on("filechooser", () => { fileChoosers++; });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/price-alerts") return route.fulfill({ json: noPriceAlerts });
    calls.push({ path, method: request.method(), csrf: request.headers()["x-csrf-token"] });
    let status = 200;
    let json: unknown;
    if (path === "/api/auth/session") json = {
      owner_id: account.owner, display_name: "New collector", csrf_token: "tour-csrf", role: "guest",
      scan_cards_used: 17, scan_card_limit: 100, scan_cards_remaining: 83,
      preferred_price_source: "tcgplayer", tour_dismissed: account.dismissed,
    };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === dismissPath && request.method() === "POST") {
      if (account.failures > 0) {
        account.failures--; status = 503; json = { detail: "The server is temporarily unavailable." };
      } else { account.dismissed = true; json = { tour_dismissed: true }; }
    } else if (["/api/v1/scans", "/api/v1/binders", "/api/v1/decks", "/api/v1/imports", "/api/v1/exports"].includes(path)) json = { items: [], next_offset: null };
    else if (path === "/api/v1/collection/cards") json = { copies: 0, cards: 0, items: [], next_offset: null,
      valuation: { provider: "tcgplayer", amount: null, priced_copies: 0, unpriced_copies: 0, feed: null } };
    else if (path === "/api/v1/collection/filters") json = { sets: [] };
    else if (path === "/api/v1/catalog/status") json = { printings: 1 };
    else if (path === "/api/v1/data/status") json = { feeds: [] };
    else { status = 500; json = { detail: "Unexpected mocked request: " + path }; }
    await route.fulfill({ status, json });
  });
  return { account, calls, fileChoosers: () => fileChoosers,
    mutations: () => calls.filter((call) => call.method !== "GET") };
}

function tour(page: Page) { return page.getByRole("dialog", { name: "Quick tour", exact: true }); }

async function expectStep(page: Page, step: number) {
  const dialog = tour(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: headings[step - 1], exact: true })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: headings[step - 1], exact: true })).toBeFocused();
  await expect(dialog.getByText(`${step} of 4`, { exact: true })).toBeVisible();
}

async function replay(page: Page) {
  const navigation = await openNavigation(page);
  await expect(navigation.getByRole("button", { name: "Quick tour", exact: true })).toHaveCount(0);
  await page.getByRole("dialog", { name: "Menu", exact: true }).getByRole("button", { name: "Quick tour", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Menu", exact: true })).not.toBeVisible();
  await expectStep(page, 1);
}

test("first sign-in can finish all four steps without adding cards or consuming scans", async ({ page, browser }) => {
  const mock = await mockAccount(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expectStep(page, 1);
  await expect(tour(page).getByRole("button", { name: "Back", exact: true })).toHaveCount(0);
  await tour(page).getByRole("button", { name: "Next", exact: true }).click();
  await expectStep(page, 2);
  await tour(page).getByRole("button", { name: "Back", exact: true }).click();
  await expectStep(page, 1);
  for (let step = 2; step <= 4; step++) {
    await tour(page).getByRole("button", { name: "Next", exact: true }).click();
    await expectStep(page, step);
  }
  await expect(tour(page).getByRole("button", { name: "Next", exact: true })).toHaveCount(0);
  expect(mock.mutations()).toEqual([]);
  await tour(page).getByRole("button", { name: "Start exploring", exact: true }).click();
  await expect(tour(page)).not.toBeVisible();
  await expect.poll(() => mock.account.dismissed).toBe(true);
  expect(mock.mutations()).toEqual([{ path: dismissPath, method: "POST", csrf: "tour-csrf" }]);
  expect(mock.fileChoosers()).toBe(0);
  await expect(page.getByRole("heading", { name: "Your collection", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeVisible();
  await expect(tour(page)).not.toBeVisible();

  // A clean browser has no local dismissal fallback; the account flag is enough.
  const fresh = await browser.newContext();
  try {
    const freshPage = await fresh.newPage();
    const second = await mockAccount(freshPage, mock.account);
    await freshPage.goto(new URL("/", page.url()).href);
    await expect(freshPage.getByRole("button", { name: "Menu", exact: true })).toBeVisible();
    await expect(tour(freshPage)).not.toBeVisible();
    expect(second.mutations()).toEqual([]);
  } finally { await fresh.close(); }
  expect(errors).toEqual([]);
});

for (const action of ["skip", "escape"] as const) {
  test(`${action} dismisses a new-account tour and saves the choice`, async ({ page }) => {
    const mock = await mockAccount(page);
    await page.goto("/");
    await expectStep(page, 1);
    if (action === "skip") await tour(page).getByRole("button", { name: "Skip tour", exact: true }).click();
    else await page.keyboard.press("Escape");
    await expect(tour(page)).not.toBeVisible();
    await expect.poll(() => mock.account.dismissed).toBe(true);
    await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeFocused();
    await page.reload();
    await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeVisible();
    await expect(tour(page)).not.toBeVisible();
    expect(mock.mutations()).toEqual([{ path: dismissPath, method: "POST", csrf: "tour-csrf" }]);
    expect(mock.fileChoosers()).toBe(0);
  });
}

test("existing collectors can replay from Menu without changing their account or current section", async ({ page }) => {
  const mock = await mockAccount(page, { owner: "existing-collector", dismissed: true, failures: 0 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeVisible();
  await expect(tour(page)).not.toBeVisible();
  await navigate(page, "Collection");
  await expect(page.getByRole("heading", { name: "Your collection", exact: true })).toBeVisible();
  await replay(page);
  await expect.poll(() => page.evaluate(() => [document.body.style.overflow, document.documentElement.style.overflow])).toEqual(["hidden", "hidden"]);
  for (let step = 2; step <= 4; step++) {
    await tour(page).getByRole("button", { name: "Next", exact: true }).click();
    await expectStep(page, step);
  }
  await tour(page).getByRole("button", { name: "Done", exact: true }).click();
  await expect(tour(page)).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "Your collection", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeFocused();
  await expect.poll(() => page.evaluate(() => [document.body.style.overflow, document.documentElement.style.overflow])).toEqual(["", ""]);
  expect(mock.account.dismissed).toBe(true);
  expect(mock.mutations()).toEqual([]);
  expect(mock.fileChoosers()).toBe(0);
});

test("small-screen tour traps focus and supports interior clicks, backdrop dismissal and short landscape", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const mock = await mockAccount(page);
  await page.goto("/");
  await expectStep(page, 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await tour(page).evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  for (const direction of ["Tab", "Shift+Tab"]) {
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press(direction);
      expect(await tour(page).evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
    }
  }
  await tour(page).getByRole("heading", { name: headings[0], exact: true }).click();
  await expect(tour(page)).toBeVisible();
  await page.mouse.click(1, 1);
  await expect(tour(page)).not.toBeVisible();
  await expect.poll(() => mock.account.dismissed).toBe(true);
  await page.setViewportSize({ width: 660, height: 320 });
  await replay(page);
  const next = tour(page).getByRole("button", { name: "Next", exact: true });
  await next.scrollIntoViewIfNeeded();
  await expect(next).toBeInViewport();
  await next.click();
  await expectStep(page, 2);
  await page.keyboard.press("Escape");
  await expect(tour(page)).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => [document.body.style.overflow, document.documentElement.style.overflow])).toEqual(["", ""]);
  expect(mock.mutations()).toEqual([{ path: dismissPath, method: "POST", csrf: "tour-csrf" }]);
});

test("a failed dismissal save leaves the app usable and can be retried", async ({ page }) => {
  const mock = await mockAccount(page, { owner: "retry-collector", dismissed: false, failures: 1 });
  await page.goto("/");
  await expectStep(page, 1);
  await tour(page).getByRole("button", { name: "Skip tour", exact: true }).click();
  await expect(tour(page)).not.toBeVisible();
  await expect.poll(() => mock.mutations().length).toBe(1);
  const retry = page.getByRole("button", { name: "Retry saving tour", exact: true });
  await expect(retry).toBeVisible();
  await navigate(page, "Batches");
  await expect(page.getByRole("heading", { name: "Saved batches", exact: true })).toBeVisible();
  await retry.click();
  await expect.poll(() => mock.account.dismissed).toBe(true);
  await expect(retry).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeVisible();
  await expect(tour(page)).not.toBeVisible();
  expect(mock.mutations()).toEqual(Array.from({ length: 2 }, () => ({ path: dismissPath, method: "POST", csrf: "tour-csrf" })));
});

test("local fallback suppresses a failed-save tour only for the same account", async ({ page }) => {
  const mock = await mockAccount(page, { owner: "offline-collector", dismissed: false, failures: 20 });
  await page.goto("/");
  await expectStep(page, 1);
  await tour(page).getByRole("button", { name: "Skip tour", exact: true }).click();
  await expect(tour(page)).not.toBeVisible();
  await expect.poll(() => mock.mutations().length).toBe(1);
  await page.reload();
  await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeVisible();
  await expect(tour(page)).not.toBeVisible();
  expect(mock.account.dismissed).toBe(false);
  mock.account.owner = "another-new-collector";
  await page.reload();
  await expectStep(page, 1);
  expect(mock.mutations().every((call) => call.path === dismissPath && call.method === "POST" && call.csrf === "tour-csrf")).toBe(true);
  expect(mock.fileChoosers()).toBe(0);
});
