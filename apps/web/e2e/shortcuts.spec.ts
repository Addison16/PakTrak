import { expect, test } from "@playwright/test";
import { noPriceAlerts } from "./price-alert-fixture";

test("keyboard shortcuts search, move between pages and stay out of the way while typing", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/price-alerts") return route.fulfill({ json: noPriceAlerts });
    let json: unknown = {};
    if (path === "/api/auth/session") json = { owner_id: "keys-owner", display_name: "Collector", role: "member", csrf_token: "keys", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/collection/cards") json = { copies: 0, cards: 0, items: [], next_offset: null, valuation: { provider: "tcgplayer", amount: null, priced_copies: 0, unpriced_copies: 0, feed: null } };
    else if (path === "/api/v1/collection/filters") json = { sets: [], labels: [], for_trade: 0 };
    else if (path === "/api/v1/wishlist") json = { provider: "tcgplayer", items: [], copies: 0, priced_copies: 0, amount: null, at_target: 0 };
    else if (path === "/api/v1/data/status") json = { feeds: [] };
    else json = { items: [], next_offset: null };
    await route.fulfill({ json });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Take photo", exact: true })).toBeVisible();
  // "/" opens the collection and puts the cursor in its search box.
  // The page may still be settling right after sign-in, so press again if the first one was early.
  await expect(async () => { await page.keyboard.press("/"); await expect(page).toHaveURL(/#\/collection/, { timeout: 1500 }); }).toPass();
  const search = page.getByRole("searchbox", { name: "Find a card" });
  await expect(search).toBeFocused();
  // Letters typed into a field are text, never shortcuts.
  await page.keyboard.type("g w/?");
  await expect(search).toHaveValue("g w/?");
  await expect(page).toHaveURL(/#\/collection/);
  await search.blur();
  await page.keyboard.press("g"); await page.keyboard.press("w");
  await expect(page.getByRole("heading", { name: "Wishlist", exact: true })).toBeVisible();
  await page.keyboard.press("g"); await page.keyboard.press("d");
  await expect(page).toHaveURL(/#\/decks/);
  await page.keyboard.press("?");
  const list = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(list).toBeVisible();
  await expect(list.locator("dd")).toContainText(["Search this page, or your collection", "Upload photo"]);
  // While a dialog is open the letters do nothing.
  await page.keyboard.press("g"); await page.keyboard.press("c");
  await expect(page).toHaveURL(/#\/decks/);
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
  await expect(list).toBeVisible();
  await page.screenshot({ path: "/mnt/project-files/qol-round-two/keyboard-shortcuts-1280.png" });
  expect(errors).toEqual([]);
});

test("the menu offers the shortcut list only where there is a keyboard and mouse", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/price-alerts") return route.fulfill({ json: noPriceAlerts });
    if (path === "/api/auth/session") return route.fulfill({ json: { owner_id: "keys-owner", display_name: "Collector", role: "member", csrf_token: "keys", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null } });
    if (path === "/api/auth/status") return route.fulfill({ json: { setup_required: false, guest_signup_enabled: true } });
    return route.fulfill({ json: { items: [], next_offset: null, feeds: [] } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Menu" }).click();
  await expect(page.getByRole("button", { name: "Quick tour" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Keyboard shortcuts" })).toBeHidden();
  await context.close();
});
