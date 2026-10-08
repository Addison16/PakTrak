import { expect, test, type Page } from "@playwright/test";
import { noPriceAlerts } from "./price-alert-fixture";

test.use({ hasTouch: true, isMobile: true });
// Chromium gets a real touch gesture through the DevTools protocol; desktop WebKit has no touch input here.
test.skip(({ browserName }) => browserName !== "chromium", "Needs real touch input");

const printing = (name: string) => ({ id: "pull-" + name.toLowerCase(), name, set_code: "tst", collector_number: "1", set_name: "Pull fixtures", language: "en", rarity: "common", type_line: "Basic Land", finishes: ["nonfoil"], image_url: "/brand/paktrak-mark.svg" });
const card = (name: string) => ({ printing: printing(name), quantity: 1, location_count: 1, locations: [{ id: "red", name: "Red binder", quantity: 1 }], value: "1.00", price_min: "1.00", price_max: "1.00", priced_copies: 1 });

async function fixture(page: Page) {
  const state = { names: ["Island"], down: false, cardReads: 0, setReads: 0 };
  await page.route("**/api/**", async (route) => {
    if (state.down) return route.abort("addressunreachable");
    const path = new URL(route.request().url()).pathname;
    let json: any = {};
    if (path === "/api/health/live") json = { status: "ok" };
    else if (path === "/api/v1/price-alerts") json = noPriceAlerts;
    else if (path === "/api/auth/session") json = { owner_id: "pull-owner", display_name: "Collector", role: "member", csrf_token: "test", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/collection/cards") { state.cardReads++; json = { copies: state.names.length, cards: state.names.length, items: state.names.map(card), next_offset: null, valuation: { provider: "tcgplayer", amount: "1.00", priced_copies: 1, unpriced_copies: 0, feed: null } }; }
    else if (path.startsWith("/api/v1/collection/cards/")) json = card(state.names[0]);
    else if (path.startsWith("/api/v1/collection/printings/")) json = { printing: printing(state.names[0]), faces: [{ name: state.names[0], image_url: "/brand/paktrak-mark.svg" }], legalities: {}, prices: [], released_at: null, scryfall_url: null };
    else if (path === "/api/v1/collection/filters") json = { sets: [{ code: "tst", name: "Pull fixtures" }] };
    else if (path === "/api/v1/binders") json = { items: [{ id: "red", name: "Red binder", kind: "binder", copies: 1, version: 1, notes: "" }] };
    else if (path === "/api/v1/data/status") json = { feeds: [] };
    else if (path === "/api/v1/collection/sets") { if (state.setReads++) await new Promise((resolve) => setTimeout(resolve, 2000)); json = { items: [] }; }
    else if (path === "/api/auth/me") json = { display_name: "Collector", account_version: 1 };
    else json = { items: [], next_offset: null };
    await route.fulfill({ json });
  });
  return state;
}

// Drags a finger straight down from below the header, the way a phone pull starts.
async function pull(page: Page, distance: number) {
  const cdp = await page.context().newCDPSession(page);
  const x = 195, y = 260;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 10; step++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + distance * step / 10 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("pulling down on the collection reloads it in place", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/#/collection");
  await expect(page.getByRole("button", { name: /^Open Island/ })).toBeVisible();
  await page.evaluate(() => { (window as any).samePage = true; });
  state.names = ["Island", "Forest"];
  // A short pull springs back without reloading.
  const before = state.cardReads;
  await pull(page, 60);
  await page.waitForTimeout(500);
  expect(state.cardReads).toBe(before);
  await expect(page.locator("main.signed-in")).not.toHaveAttribute("style", /translateY\([1-9]/);
  await pull(page, 260);
  await expect(page.locator(".pull-refresh-spinner")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Open Forest/ })).toBeVisible();
  await expect(page.locator(".pull-refresh-spinner")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).samePage)).toBe(true);
  await expect.poll(() => page.locator("main.signed-in").evaluate((element) => element.style.transform)).toBe("");
});

test("pulling down while the server can't be reached says so", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/#/collection");
  await expect(page.getByRole("button", { name: /^Open Island/ })).toBeVisible();
  state.down = true;
  await pull(page, 260);
  await expect(page.locator(".pull-refresh-message")).toHaveText("You’re offline. Showing saved copies.");
  await expect(page.getByRole("button", { name: /^Open Island/ })).toBeVisible();
  await expect(page.locator(".pull-refresh-message")).toHaveCount(0, { timeout: 5000 });
});

test("pulling does nothing in the card viewer or on screens without a refresh", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/#/collection?card=pull-island");
  await expect(page.locator("#card-detail-title")).toHaveText("Island");
  const before = state.cardReads;
  await pull(page, 260);
  await page.waitForTimeout(500);
  await expect(page.locator(".pull-refresh-spinner")).toHaveCount(0);
  expect(state.cardReads).toBe(before);
  await page.goto("/#/account");
  await expect(page).toHaveTitle(/My account/);
  await pull(page, 260);
  await page.waitForTimeout(300);
  await expect(page.locator(".pull-refresh-spinner")).toHaveCount(0);
});

test("the spinner stays until a slow screen has its new data", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/#/sets");
  await expect(page.getByText("Add cards to your collection")).toBeVisible();
  await pull(page, 260);
  await page.waitForTimeout(1200);
  await expect(page.locator(".pull-refresh-spinner")).toBeVisible();
  expect(state.setReads).toBe(2);
  await expect(page.locator(".pull-refresh-spinner")).toHaveCount(0, { timeout: 5000 });
});
