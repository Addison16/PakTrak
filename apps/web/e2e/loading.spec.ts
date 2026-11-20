import { expect, test, type Page } from "@playwright/test";
import { noPriceAlerts } from "./price-alert-fixture";

// Slow loads show placeholders and a spinner instead of an empty, frozen-looking page.
const shots = process.env.SCANNER_E2E_SHOTS;
test.use({ deviceScaleFactor: shots ? 2 : 1 });
const dark = process.env.SCANNER_E2E_COLOR_SCHEME === "dark";
const art = '<svg xmlns="http://www.w3.org/2000/svg" width="244" height="340"><rect width="244" height="340" rx="12" fill="#244d46"/><rect x="10" y="10" width="224" height="320" rx="8" fill="#f2e7d3"/><rect x="20" y="58" width="204" height="150" fill="#7a9b93"/></svg>';
const printing = (index: number) => ({ id: `load-${index}`, name: `Fixture Card ${index + 1}`, set_code: "tst", set_name: "Fixture set", collector_number: String(index + 1), rarity: "rare", language: "en", finishes: ["nonfoil"], image_url: `/api/v1/card-images/load-${index}/0/grid` });
const owned = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ printing: printing(from + i), quantity: 1, location_count: 1, locations: [{ id: "red", name: "Red binder", kind: "binder", quantity: 1 }], value: "1.00", priced_copies: 1, price_min: "1.00", price_max: "1.00" }));
const deck = (index: number) => ({ id: `deck-${index}`, name: ["Friday night", "Red hot spells", "Still brewing"][index % 3], notes: "", format: index % 2 ? "modern" : "commander", match_mode: "exact", version: 1, cards: [], colors: [["U"], ["R"], ["G"]][index % 3], colors_known: true, cover_cards: [], copies: 60, owned_copies: 60, missing_copies: 0, missing_cards: 0 });

function gate() { let open = () => {}; const opened = new Promise<void>((resolve) => { open = resolve; }); return { open, opened }; }

async function fixture(page: Page) {
  const cards = gate(), more = gate(), decks = gate();
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path.startsWith("/api/v1/card-images/")) return route.fulfill({ contentType: "image/svg+xml", body: art });
    let json: unknown = { items: [], next_offset: null };
    if (path === "/api/v1/price-alerts") json = noPriceAlerts;
    else if (path === "/api/auth/session") json = { owner_id: "loading-owner", display_name: "Collector", role: "member", csrf_token: "test", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/collection/cards") {
      const offset = Number(url.searchParams.get("offset") || 0);
      await (offset ? more : cards).opened;
      json = { copies: 24, cards: 24, items: owned(offset, 12), next_offset: offset ? null : 12, valuation: { provider: "tcgplayer", amount: "24.00", priced_copies: 24, unpriced_copies: 0, feed: null } };
    }
    else if (path === "/api/v1/collection/filters") json = { sets: [], foil_types: [] };
    else if (path === "/api/v1/data/status") json = { feeds: [] };
    else if (path === "/api/v1/decks") { await decks.opened; json = { items: [0, 1, 2].map(deck), next_offset: null }; }
    await route.fulfill({ json });
  });
  return { cards, more, decks };
}

const shot = (page: Page, name: string) => shots ? page.screenshot({ path: `${shots}/${name}-${page.viewportSize()!.width}${dark ? "-dark" : ""}.png` }) : Promise.resolve();

for (const width of [390, 1280]) test(`collection and decks show they are loading at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const { cards, more, decks } = await fixture(page);
  await page.goto("/#/collection");
  const grid = page.locator(".gallery-grid");
  await expect(grid).toHaveAttribute("aria-busy", "true");
  await expect(grid.locator(".skeleton-card")).toHaveCount(8);
  await expect(page.getByRole("status").filter({ hasText: "Finding your cards…" })).toBeVisible();
  // A slow load explains itself after a few seconds.
  await expect(page.getByText("Big collections can take a moment.", { exact: false })).toBeVisible({ timeout: 8000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator(".gallery-result-note").evaluate((note) => window.scrollTo(0, note.getBoundingClientRect().top + window.scrollY - 90));
  await shot(page, "collection-loading");
  cards.open();
  await expect(grid.locator(".gallery-card")).toHaveCount(12);
  await expect(grid.locator(".skeleton-card")).toHaveCount(0);
  await expect(grid).toHaveAttribute("aria-busy", "false");

  // More cards keeps the first page and adds placeholders below it.
  await page.getByRole("button", { name: "More cards" }).click();
  await expect(page.getByRole("button", { name: "Loading more…" })).toBeDisabled();
  await expect(grid.locator(".skeleton-card")).toHaveCount(4);
  await expect(grid.locator(".gallery-card")).toHaveCount(12);
  await expect(grid).not.toHaveAttribute("data-refreshing");
  await grid.locator(".skeleton-card").first().scrollIntoViewIfNeeded();
  await shot(page, "collection-more");
  more.open();
  await expect(grid.locator(".gallery-card")).toHaveCount(24);
  await expect(grid.locator(".skeleton-card")).toHaveCount(0);

  await page.goto("/#/decks");
  const rows = page.getByRole("list", { name: "Saved deck boxes" });
  await expect(rows.locator(".skeleton-deck")).toHaveCount(6);
  await expect(page.getByText("Loading your decks…")).toBeVisible();
  await expect(page.getByText("No saved decks yet", { exact: false })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, "decks-loading");
  decks.open();
  await expect(rows.locator(".deck-box-button")).toHaveCount(3);
  await expect(rows.locator(".skeleton-deck")).toHaveCount(0);
  await expect(page.getByText("Loading your decks…")).toHaveCount(0);
  await shot(page, "decks-loaded");
});

test("an empty deck list still says so once it has loaded", async ({ page }) => {
  const { decks } = await fixture(page);
  await page.route("**/api/v1/decks?*", (route) => route.fulfill({ json: { items: [], next_offset: null } }));
  decks.open();
  await page.goto("/#/decks");
  await expect(page.getByText("No saved decks yet. Start with a name or import a card list.")).toBeVisible();
  await expect(page.locator(".skeleton-deck")).toHaveCount(0);
});
