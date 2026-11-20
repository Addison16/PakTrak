import { expect, test, type Page } from "@playwright/test";
import { noPriceAlerts } from "./price-alert-fixture";

const printing = (id: string, name: string) => ({ id, name, set_code: "tst", set_name: "Fixture set", collector_number: id.slice(-1), rarity: "rare", language: "en", finishes: ["nonfoil", "foil"], image_url: "/brand/paktrak-mark.svg" });
const breakdown = {
  provider: "tcgplayer", copies: 26, value: "17.00",
  colors: [{ key: "Red", label: "Red", copies: 1, value: "10.00" }, { key: "Multicolor", label: "Multicolor", copies: 2, value: "4.00" }, { key: "Colorless", label: "Colorless", copies: 23, value: "3.00" }],
  rarities: [{ key: "mythic", label: "Mythic", copies: 1, value: "10.00" }, { key: "common", label: "Common", copies: 20, value: null }],
  types: [{ key: "Land", label: "Land", copies: 20, value: null }, { key: "Creature", label: "Creature", copies: 4, value: "13.00" }],
  sets: [{ key: "aaa", label: "A set with quite a long name to wrap on a phone", copies: 3, value: "14.00" }, { key: "", label: "4 more", copies: 23, value: "3.00" }],
  locations: [{ key: "1", label: "Binder A", copies: 3, value: "14.00" }, { key: "2", label: "Bulk box", copies: 23, value: "3.00" }],
  top_cards: [{ printing: printing("top-1", "Fixture Dragon"), finish: "foil", quantity: 2, amount: "10.00" }, { printing: printing("top-2", "Fixture Charm"), finish: "nonfoil", quantity: 1, amount: "2.00" }],
  paid: { copies: 1, unpriced_copies: 20, paid: "4.00", value: "10.00", change: "6.00" },
};

async function fixture(page: Page, data: unknown = breakdown) {
  const seen: string[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()), path = url.pathname;
    seen.push(path + url.search);
    if (path === "/api/v1/price-alerts") return route.fulfill({ json: noPriceAlerts });
    let json: unknown = {};
    if (path === "/api/auth/session") json = { owner_id: "breakdown-owner", display_name: "Collector", role: "member", csrf_token: "test", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/collection/cards") json = { copies: 0, cards: 0, items: [], next_offset: null, valuation: { provider: "tcgplayer", amount: "17.00", priced_copies: 6, unpriced_copies: 20, feed: null } };
    else if (path === "/api/v1/collection/filters") json = { sets: [], foil_types: [] };
    else if (path === "/api/v1/collection/breakdown") json = data;
    else if (path.startsWith("/api/v1/collection/cards/")) return route.fulfill({ status: 404, json: { detail: "This card is not in your collection." } });
    else if (path === "/api/v1/binders") json = { items: [] };
    else if (path === "/api/v1/data/status") json = { feeds: [] };
    else if (["/api/v1/scans", "/api/v1/decks", "/api/v1/imports", "/api/v1/exports"].includes(path)) json = { items: [], next_offset: null };
    else { await route.fulfill({ status: 500, json: { detail: "Unexpected fixture endpoint " + path } }); return; }
    await route.fulfill({ json });
  });
  await page.goto("/#/collection");
  await expect(page.locator(".gallery-grid")).toHaveAttribute("aria-busy", "false");
  return seen;
}

for (const width of [320, 390, 1280]) test(`the breakdown groups the collection and lists its best cards at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const seen = await fixture(page);
  // Nothing is fetched until the section is opened.
  expect(seen.some((path) => path.startsWith("/api/v1/collection/breakdown"))).toBe(false);
  await page.getByText("Collection breakdown").click();
  const table = page.locator(".breakdown-table");
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.locator("tbody tr").first()).toHaveText(/Red\s*1\s*\$10\.00/);
  await page.getByLabel("Group by").selectOption("rarities");
  await expect(table.locator("tbody tr").last()).toHaveText(/Common\s*20\s*—/);
  await page.getByLabel("Group by").selectOption("sets");
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(page.getByText("You paid $4.00 for 1 copy worth $10.00 today, up $6.00.")).toBeVisible();
  await expect(page.getByText(/20 copies with a recorded price have no price today/)).toBeVisible();
  await expect(page.locator(".breakdown-top li")).toHaveCount(2);
  await expect(page.locator(".breakdown-top li").first()).toHaveText(/Fixture Dragon.*Foil · ×2.*\$10\.00/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator(".breakdown-top button").first().click();
  await expect(page).toHaveURL(/top-1/);
});

test("an empty collection explains itself instead of showing empty tables", async ({ page }) => {
  await fixture(page, { provider: "tcgplayer", copies: 0, value: "0.00", colors: [], rarities: [], types: [], sets: [], locations: [], top_cards: [], paid: null });
  await page.getByText("Collection breakdown").click();
  await expect(page.getByText("Add some cards and their breakdown appears here.")).toBeVisible();
  await expect(page.locator(".breakdown-table")).toHaveCount(0);
});
