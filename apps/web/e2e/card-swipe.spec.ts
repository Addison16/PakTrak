import { expect, test, type Locator, type Page } from "@playwright/test";
import { fixture as deckFixture } from "./deck-fixture";
import { noPriceAlerts } from "./price-alert-fixture";

test.use({ hasTouch: true });

const printings = ["Island", "Forest", "Swamp"].map((name, index) => ({ id: `swipe-${index}`, name, set_code: "tst", collector_number: String(index + 1), set_name: "Swipe fixtures", language: "en", rarity: "common", type_line: "Basic Land", finishes: ["nonfoil"], image_url: "/brand/paktrak-mark.svg" }));
const cards = printings.map((printing) => ({ printing, quantity: 1, location_count: 1, locations: [{ id: "red", name: "Red binder", quantity: 1 }], value: "1.00", price_min: "1.00", price_max: "1.00", priced_copies: 1 }));

async function collectionFixture(page: Page) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/price-alerts") return route.fulfill({ json: noPriceAlerts });
    const index = printings.findIndex((printing) => path.endsWith("/" + printing.id));
    let json: any = {};
    if (path === "/api/auth/session") json = { owner_id: "swipe-owner", display_name: "Collector", role: "member", csrf_token: "test", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/collection/cards") json = { copies: 3, cards: 3, items: cards, next_offset: null, valuation: { provider: "tcgplayer", amount: "3.00", priced_copies: 3, unpriced_copies: 0, feed: null } };
    else if (path.startsWith("/api/v1/collection/cards/") && index >= 0) json = cards[index];
    else if (path.startsWith("/api/v1/collection/printings/") && index >= 0) json = { printing: printings[index], faces: [{ name: printings[index].name, image_url: printings[index].image_url }], legalities: {}, prices: [], released_at: null, scryfall_url: null };
    else if (path === "/api/v1/collection") json = { items: [], next_offset: null };
    else if (path === "/api/v1/collection/filters") json = { sets: [{ code: "tst", name: "Swipe fixtures" }] };
    else if (path === "/api/v1/binders") json = { items: [{ id: "red", name: "Red binder", kind: "binder", copies: 3, version: 1, notes: "" }] };
    else if (path === "/api/v1/data/status") json = { feeds: [] };
    else if (["/api/v1/decks", "/api/v1/scans", "/api/v1/imports", "/api/v1/exports"].includes(path)) json = { items: [], next_offset: null };
    await route.fulfill({ json });
  });
}

// Chromium gets a real touch gesture, so the browser's own scroll handling is
// part of the test. WebKit has no touch input API here and gets pointer events.
async function swipe(page: Page, surface: Locator, from: number, to: number) {
  const box = (await surface.boundingBox())!, y = box.y + Math.min(box.height / 2, 200);
  const points = Array.from({ length: 8 }, (_, step) => box.x + box.width * (from + (to - from) * step / 7));
  if (test.info().project.name === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: points[0], y }] });
    for (const x of points.slice(1)) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    return;
  }
  await surface.evaluate((element, { points, y }) => {
    const send = (type: string, x: number) => element.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 9, pointerType: "touch", isPrimary: true, clientX: x, clientY: y }));
    send("pointerdown", points[0]);
    for (const x of points.slice(1)) send("pointermove", x);
    send("pointerup", points[points.length - 1]);
  }, { points, y });
}

test("swiping the collection card viewer steps through the cards in list order", async ({ page }) => {
  await collectionFixture(page);
  await page.goto("/#/collection?card=swipe-0");
  const title = page.locator("#card-detail-title");
  await expect(title).toHaveText("Island");
  const art = page.locator(".detail-art");
  await swipe(page, art, .9, .1);
  await expect(title).toHaveText("Forest");
  await expect(page).toHaveURL(/card=swipe-1/);
  await swipe(page, page.locator("dialog .detail-copy"), .9, .1);
  await expect(title).toHaveText("Swamp");
  await swipe(page, art, .9, .1);
  await page.waitForTimeout(400);
  await expect(title).toHaveText("Swamp");
  await swipe(page, art, .1, .9);
  await expect(title).toHaveText("Forest");
  await swipe(page, art, .5, .55);
  await page.waitForTimeout(400);
  await expect(title).toHaveText("Forest");
  await expect(page.locator(".detail-art .card-art")).toBeVisible();
  expect(await page.locator(".detail-art .card-art").evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  await page.keyboard.press("ArrowLeft");
  await expect(title).toHaveText("Island");
  await page.keyboard.press("ArrowRight");
  await expect(title).toHaveText("Forest");
});

test("swiping the deck card preview steps through the deck and stops at the ends", async ({ page }) => {
  await deckFixture(page);
  await page.getByRole("button", { name: /Friday night/ }).click();
  await page.locator(".deck-art-button").first().click();
  const title = page.locator("#deck-preview-title"), dialog = page.locator(".deck-preview-dialog");
  await expect(title).toHaveText("Fixture Card 2");
  await swipe(page, dialog, .1, .9);
  await page.waitForTimeout(400);
  await expect(title).toHaveText("Fixture Card 2");
  await swipe(page, dialog, .9, .1);
  await expect(title).toHaveText("Fixture Card 1");
  await expect(dialog).toContainText("2 of 3");
  await swipe(page, dialog, .9, .1);
  await expect(title).toHaveText("Fixture Card 3");
  await swipe(page, dialog, .1, .9);
  await expect(title).toHaveText("Fixture Card 1");
  await expect(page.locator(".deck-preview-art .card-art")).toHaveCSS("opacity", "1");
  await expect(page.locator(".deck-preview-art .card-art")).toHaveCSS("transform", "none");
  await expect(dialog).toBeVisible();
});

test("tapping into the card viewer starts on Close and shows no keyboard focus ring", async ({ page }) => {
  await collectionFixture(page);
  await page.goto("/#/collection");
  await page.locator(".gallery-card").nth(1).tap();
  await expect(page.locator("#card-detail-title")).toHaveText("Forest");
  await expect(page.getByRole("button", { name: "Close card details" })).toBeFocused();
  const previous = page.getByRole("button", { name: "Previous card" });
  // Safari treats focus moved by a dialog as keyboard focus even after a tap.
  await previous.evaluate((button) => button.focus({ focusVisible: true } as FocusOptions));
  await expect(previous).toHaveCSS("outline-style", "none");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(previous).toBeFocused();
  await expect(previous).toHaveCSS("outline-style", "solid");
});
