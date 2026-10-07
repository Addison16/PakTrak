import { expect, test, type Page } from "@playwright/test";
import { navigate, openNavigation } from "./navigation";
import { noPriceAlerts } from "./price-alert-fixture";

async function mockAccount(page: Page, role: "admin" | "member" | "guest" | null = "admin", setup = false) {
  const requests: { path: string; method: string; csrf: string | undefined }[] = [];
  let signedIn = role !== null;
  let rejectLogout = false;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/price-alerts") return route.fulfill({ json: noPriceAlerts });
    requests.push({ path, method: request.method(), csrf: request.headers()["x-csrf-token"] });
    let json: unknown;
    let status = 200;
    if (path === "/api/auth/session") {
      status = signedIn ? 200 : 401;
      json = signedIn ? { owner_id: "drawer-test", display_name: "PakTrak collector", csrf_token: "drawer-csrf", role,
        scan_cards_used: 0, scan_card_limit: role === "guest" ? 100 : null, scan_cards_remaining: role === "guest" ? 100 : null,
        preferred_price_source: "tcgplayer" } : { detail: "Not signed in" };
    } else if (path === "/api/auth/status") json = { setup_required: setup, guest_signup_enabled: !setup };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/auth/logout") {
      if (rejectLogout) { status = 503; json = { detail: "Sign out is temporarily unavailable." }; }
      else { signedIn = false; json = { logout_url: "/?signed_out=1" }; }
    } else if (path === "/api/v1/collection/cards") json = { copies: 0, cards: 0, items: [], next_offset: null,
      valuation: { provider: "tcgplayer", amount: null, priced_copies: 0, unpriced_copies: 0, feed: null } };
    else if (path === "/api/v1/collection/filters") json = { sets: [] };
    else if (path === "/api/v1/catalog/status") json = { printings: 1 };
    else if (path === "/api/v1/data/status") json = { feeds: [] };
    else if (path === "/api/auth/settings") json = { guest_signup_enabled: true, version: 1 };
    else if (["/api/v1/scans", "/api/v1/binders", "/api/v1/imports", "/api/v1/exports", "/api/v1/decks", "/api/auth/accounts"].includes(path)) json = { items: [], next_offset: null };
    else { status = 500; json = { detail: "Unexpected mocked request: " + path }; }
    await route.fulfill({ status, json });
  });
  return { requests, rejectLogout: (value: boolean) => { rejectLogout = value; } };
}

for (const viewport of [{ width: 320, height: 660 }, { width: 1280, height: 900 }]) {
  test(`drawer navigates every section and preserves deck drafts at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const mock = await mockAccount(page);
    await page.goto("/");
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("navigation", { name: "Main navigation" })).not.toBeVisible();
    const box = await menu.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeLessThan(110);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    for (const [destination, heading] of [
      ["Collection", "Your collection"], ["Batches", "Saved batches"], ["Decks", "Your decks"], ["Trade value", "Trade value"],
      ["Import / export", "Bring your collection"], ["Administration", "Account administration"],
      ["Upload photo", "Start with a clear photo."],
    ] as const) {
      await navigate(page, destination);
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await expect(menu).toBeVisible();
      // Opening the batch list deliberately focuses its heading after history navigation.
      if (destination === "Batches") await expect(page.getByRole("heading", { name: heading, exact: true })).toBeFocused();
      else await expect(menu).toBeFocused();
      await expect(menu).toHaveAttribute("aria-expanded", "false");
      const navigation = await openNavigation(page);
      await expect(navigation.locator("[aria-current=page]")).toHaveText(destination);
      await expect(navigation.getByRole("button")).toHaveCount(8);
      await navigation.getByRole("button", { name: destination, exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Menu", exact: true })).not.toBeVisible();
    }
    await navigate(page, "Decks");
    await page.getByRole("button", { name: "New deck", exact: true }).click();
    await page.getByRole("textbox", { name: "New deck name" }).fill("Keep my unfinished name");
    await navigate(page, "Collection");
    await navigate(page, "Decks");
    await expect(page.getByRole("textbox", { name: "New deck name" })).toHaveValue("Keep my unfinished name");
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(mock.requests.every((request) => request.method === "GET")).toBe(true);
  });
}

test("drawer traps keyboard focus, locks page scrolling, and dismisses accessibly", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 660 });
  await mockAccount(page);
  await page.goto("/");
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  const dialog = page.getByRole("dialog", { name: "Menu", exact: true });
  await openNavigation(page);
  await expect(page.getByRole("button", { name: "Close menu", exact: true })).toBeFocused();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  expect(await page.evaluate(() => [document.body.style.overflow, document.documentElement.style.overflow])).toEqual(["hidden", "hidden"]);
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  const initialScroll = await page.evaluate(() => scrollY);
  await page.mouse.move(5, 300);
  await page.mouse.wheel(0, 500);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(initialScroll);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(menu).toBeFocused();
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => page.evaluate(() => [document.body.style.overflow, document.documentElement.style.overflow])).toEqual(["", ""]);

  await openNavigation(page);
  await page.getByRole("heading", { name: "Menu", exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(5, 200);
  await expect(dialog).not.toBeVisible();
  await expect(menu).toBeFocused();

  await page.setViewportSize({ width: 660, height: 320 });
  await openNavigation(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "Close menu", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(menu).toBeFocused();
});

test("guest menu hides administration and keeps sign-out recovery working", async ({ page }) => {
  const mock = await mockAccount(page, "guest");
  await page.goto("/");
  const navigation = await openNavigation(page);
  await expect(navigation.getByRole("button", { name: "Administration", exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Menu", exact: true }).getByText("Guest account", { exact: true })).toBeVisible();
  mock.rejectLogout(true);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Menu", exact: true })).not.toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Sign out: Sign out is temporarily unavailable.");
  await expect(page.getByRole("alert").getByRole("button", { name: "Dismiss error" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeEnabled();
  mock.rejectLogout(false);
  await openNavigation(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Menu", exact: true })).toHaveCount(0);
  expect(mock.requests.filter((request) => request.path === "/api/auth/logout")).toEqual([
    { path: "/api/auth/logout", method: "POST", csrf: "drawer-csrf" },
    { path: "/api/auth/logout", method: "POST", csrf: "drawer-csrf" },
  ]);
});

test("public sign-in and initial administrator setup do not show an account menu", async ({ page }) => {
  await mockAccount(page, null);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute("href", "/api/auth/login");
  await expect(page.getByRole("link", { name: "Create an account", exact: true })).toHaveAttribute("href", "/api/auth/register");
  await expect(page.getByRole("button", { name: "Menu", exact: true })).toHaveCount(0);
  await page.unroute("**/api/**");
  await mockAccount(page, null, true);
  await page.reload();
  await expect(page.getByRole("link", { name: "Create administrator account", exact: true })).toHaveAttribute("href", "/api/auth/setup");
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute("href", "/api/auth/login");
  await expect(page.getByRole("button", { name: "Menu", exact: true })).toHaveCount(0);
});


test("browser history follows sections, dismisses the menu first and survives reload", async ({ page }) => {
  const mock = await mockAccount(page);
  await page.goto("/");
  await navigate(page, "Collection");
  await navigate(page, "Decks");
  await expect(page).toHaveURL(/#\/decks$/);
  await openNavigation(page);
  expect(await page.getByRole("dialog", { name: "Menu", exact: true }).evaluate((element) => getComputedStyle(element).overscrollBehaviorX)).toBe("auto");
  await page.evaluate(() => history.back());
  await expect(page.getByRole("dialog", { name: "Menu", exact: true })).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "Your decks", exact: true })).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(page.getByRole("heading", { name: "Your collection", exact: true })).toBeVisible();
  await page.evaluate(() => history.forward());
  await expect(page.getByRole("heading", { name: "Your decks", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your decks", exact: true })).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(page.getByRole("heading", { name: "Your collection", exact: true })).toBeVisible();
  expect(mock.requests.every((request) => request.method === "GET")).toBe(true);
});

test("browser history closes buttons without duplicate pages and can leave PakTrak", async ({ page }) => {
  await mockAccount(page);
  await page.goto("/brand/paktrak-mark.svg");
  await page.goto("/");
  await openNavigation(page);
  await page.getByRole("button", { name: "Close menu", exact: true }).click();
  await expect(page).toHaveURL(/#\/scan$/);
  await navigate(page, "Batches");
  await page.evaluate(() => history.back());
  await expect(page.getByRole("heading", { name: "Start with a clear photo.", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/brand\/paktrak-mark\.svg$/);
});
