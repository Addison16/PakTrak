import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page) {
  const items = [
    { name: "Normal copies", quantity: 2, finish_counts: { nonfoil: 2, foil: 0, etched: 0, unknown: 0 } },
    { name: "Unknown copies", quantity: 1, finish_counts: { nonfoil: 0, foil: 0, etched: 0, unknown: 1 } },
    { name: "Foil copies", quantity: 3, finish_counts: { nonfoil: 2, foil: 1, etched: 0, unknown: 0 } },
    { name: "Etched copies", quantity: 1, finish_counts: { nonfoil: 0, foil: 0, etched: 1, unknown: 0 } },
    { name: "Legacy copies", quantity: 2 },
  ].map((card, index) => ({ ...card, printing: { id: "finish-" + index, name: card.name, set_code: "tst", collector_number: String(index + 1), rarity: "rare", language: "en", finishes: ["nonfoil", "foil", "etched"], image_url: "/brand/paktrak-mark.svg" }, location_count: 1, locations: [{ id: "red", name: "Red binder", kind: "binder", quantity: card.quantity }], value: "1.00", priced_copies: card.quantity, price_min: "1.00", price_max: "1.00" }));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = {};
    if (path === "/api/auth/session") json = { owner_id: "foil-owner", display_name: "Collector", role: "member", csrf_token: "test", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/collection/cards") json = { copies: 9, cards: items.length, items, next_offset: null, valuation: { provider: "tcgplayer", amount: "9.00", priced_copies: 9, unpriced_copies: 0, feed: null } };
    else if (path === "/api/v1/collection/filters") json = { sets: [{ code: "tst", name: "Finish fixtures" }] };
    else if (path === "/api/v1/binders") json = { items: [] };
    else if (path === "/api/v1/data/status") json = { feeds: [] };
    else if (["/api/v1/scans", "/api/v1/decks", "/api/v1/imports", "/api/v1/exports"].includes(path)) json = { items: [], next_offset: null };
    else { await route.fulfill({ status: 500, json: { detail: "Unexpected fixture endpoint " + path } }); return; }
    await route.fulfill({ json });
  });
  await page.goto("/#/collection");
  await expect(page.locator(".gallery-card")).toHaveCount(items.length);
  await expect(page.locator(".gallery-grid")).toHaveAttribute("aria-busy", "false");
}

test("only recorded owned foil and etched copies receive a finish reflection", async ({ page }) => {
  await fixture(page);
  await expect(page.locator(".card-finish-art[data-owned-finish]")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /Open Normal copies/ }).locator(".card-finish-art")).not.toHaveAttribute("data-owned-finish");
  await expect(page.getByRole("button", { name: /Open Unknown copies/ }).locator(".card-finish-art")).not.toHaveAttribute("data-owned-finish");
  await expect(page.getByRole("button", { name: /Open Legacy copies/ }).locator(".card-finish-art")).not.toHaveAttribute("data-owned-finish");
  await expect(page.getByRole("button", { name: /Open Foil copies/ })).toHaveAccessibleName(/Includes 1 foil copy/);
  await expect(page.getByRole("button", { name: /Open Foil copies/ }).locator(".card-finish-label")).toHaveText("✧Foil · ×1");
  await expect(page.getByRole("button", { name: /Open Etched copies/ }).locator(".card-finish-art")).toHaveAttribute("data-owned-finish", "etched");
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator(".gallery-grid")).toHaveClass(/gallery-list/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("foil reflection runs once on focus and honors reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await fixture(page);
  const button = page.getByRole("button", { name: /Open Foil copies/ });
  const art = button.locator(".card-finish-art");
  await button.scrollIntoViewIfNeeded();
  expect(await art.evaluate((element) => getComputedStyle(element, "::after").animationName)).toBe("none");
  await button.focus();
  await expect(button).toBeFocused();
  expect(await art.evaluate((element) => getComputedStyle(element, "::after").animationIterationCount)).toBe("1");
  await expect.poll(() => art.evaluate((element) => element.getAnimations({ subtree: true }).some((animation) => animation.playState === "running"))).toBe(true);
  await expect.poll(() => art.evaluate((element) => element.getAnimations({ subtree: true }).some((animation) => animation.playState === "running"))).toBe(false);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await art.evaluate((element) => getComputedStyle(element, "::after").animationName)).toBe("none");
  expect(await art.evaluate((element) => getComputedStyle(element, "::before").transitionDuration)).toBe("0s");
  await expect(button).toBeFocused();
});

test.describe("touch finish reflection", () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 320, height: 780 } });
  test("recorded foils respond to a press without creating page overflow", async ({ page }) => {
    await fixture(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const button = page.getByRole("button", { name: /Open Etched copies/ });
    const art = button.locator(".card-finish-art");
    await button.scrollIntoViewIfNeeded();
    await button.hover();
    expect(await art.evaluate((element) => getComputedStyle(element, "::after").animationName)).toBe("none");
    await page.mouse.down();
    await expect.poll(() => art.evaluate((element) => getComputedStyle(element, "::before").opacity)).toBe("0.6");
    expect(await art.evaluate((element) => getComputedStyle(element, "::after").animationName)).toBe("owned-card-reflection");
    await page.mouse.move(0, 0); await page.mouse.up();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
