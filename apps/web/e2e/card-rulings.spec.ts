import { expect, test, type Page } from "@playwright/test";
import { fixture as deckFixture } from "./deck-fixture";
import { navigate } from "./navigation";
import { noPriceAlerts } from "./price-alert-fixture";

const printing = { id: "ruled-card", name: "Rulings fixture", set_code: "tst", collector_number: "1", set_name: "Rule fixtures", language: "en", finishes: ["nonfoil"], rarity: "rare", type_line: "Instant", image_url: "/brand/paktrak-mark.svg" };
const card = { printing, quantity: 1, location_count: 1, locations: [{ id: "red", name: "Red binder", kind: "binder", quantity: 1 }], value: "2.00", price_min: "2.00", price_max: "2.00", priced_copies: 1 };
const rulings = {
  legalities: { standard: "not_legal", pioneer: "not_legal", modern: "legal", legacy: "legal", vintage: "restricted", commander: "banned", oathbreaker: "legal", pauper: "legal", paupercommander: "legal", premodern: "legal", duel: "legal", brawl: "not_legal", alchemy: "legal" },
  rulings: [
    { source: "wotc", published_at: "2004-10-04", comment: "The first ruling explains when the spell's target is chosen." },
    { source: "wotc", published_at: "2009-10-01", comment: "If the target becomes illegal before the spell resolves, it doesn't resolve." },
    { source: "scryfall", published_at: "2016-06-08", comment: "A short note from Scryfall about an older wording." },
    { source: "wotc", published_at: "2021-06-18", comment: "A fourth ruling that stays tucked away until asked for." },
  ],
  rulings_saved: true,
};

async function collection(page: Page, rules: unknown = rulings) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: any = {}, status = 200;
    if (path === "/api/v1/price-alerts") json = noPriceAlerts;
    else if (path === "/api/auth/session") json = { owner_id: "rules-fixture", display_name: "Rules collector", role: "member", csrf_token: "fixture", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/collection/cards/ruled-card") json = card;
    else if (path === "/api/v1/collection/cards") json = { copies: 1, cards: 1, items: [card], next_offset: null, valuation: { provider: "tcgplayer", amount: "2.00", priced_copies: 1, unpriced_copies: 0, feed: null } };
    else if (path === "/api/v1/collection/printings/ruled-card") json = { printing, faces: [{ name: printing.name, image_url: printing.image_url, oracle_text: "Counter target spell." }], legalities: {}, released_at: null, scryfall_url: null, prices: [{ provider: "tcgplayer", name: "TCGplayer", kind: "Market", feed: null, finishes: [{ finish: "nonfoil", amount: "2.00", available: true, url: null }] }] };
    else if (path === "/api/v1/collection/printings/ruled-card/price-history") json = { provider: "tcgplayer", days: 365, finishes: {} };
    else if (path === "/api/v1/collection/printings/ruled-card/decks") json = { name: printing.name, owned: 1, used: 0, free: 1, decks: [] };
    else if (path === "/api/v1/catalog/printings/ruled-card/rulings") json = rules;
    else if (path === "/api/v1/collection/filters") json = { sets: [] };
    else if (["/api/v1/scans", "/api/v1/binders", "/api/v1/decks"].includes(path)) json = { items: [], next_offset: null };
    else { status = 500; json = { detail: "Unexpected fixture endpoint " + path }; }
    await route.fulfill({ status, json });
  });
  await page.goto("/"); await navigate(page, "Collection");
  await page.locator(".gallery-card").click();
  return page.getByRole("dialog", { name: printing.name, exact: true });
}

for (const width of [320, 390, 1280]) test(`card details list format legality and rulings under the card at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const dialog = await collection(page);
  const section = dialog.getByRole("region", { name: "Legality and rulings" });
  await expect(section.getByRole("heading", { name: "Format legality" })).toBeVisible();
  // Paper formats only, in a fixed order, with readable labels.
  await expect(section.locator(".card-legality dt")).toHaveText(["Standard", "Pioneer", "Modern", "Legacy", "Vintage", "Commander", "Oathbreaker", "Pauper", "Pauper Commander", "Premodern", "Duel Commander", "Brawl"]);
  await expect(section.locator(".legality-banned dd")).toHaveText("Banned");
  await expect(section.locator(".legality-restricted dd")).toHaveText("Restricted");
  await expect(section.locator(".card-legality .legality-not_legal dd").first()).toHaveText("Not legal");
  // Rulings sit above the price guide, so they're easy to find.
  const order = await dialog.evaluate((node) => [...node.querySelectorAll(".card-rules, .price-section")].map((item) => item.className));
  expect(order[0]).toBe("card-rules");
  const items = section.locator(".card-rulings li");
  await expect(items).toHaveCount(3);
  await expect(items.nth(2)).toContainText("Scryfall note");
  await section.getByRole("button", { name: "Show all 4 rulings" }).click();
  await expect(items).toHaveCount(4);
  await expect(items.nth(3)).toContainText("stays tucked away");
  await section.getByRole("button", { name: "Show fewer rulings" }).click();
  await expect(items).toHaveCount(3);
  // Nothing spills past the section edge, even on the narrowest phones.
  expect(await section.evaluate((node) => { const edge = node.getBoundingClientRect().right + 0.5; return [...node.querySelectorAll("dt, dd, li")].filter((item) => item.getBoundingClientRect().right > edge).length; })).toBe(0);
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/card-rulings-${width}.png` });
});

test("a card without rulings says so, and rulings not downloaded yet say when they arrive", async ({ page }) => {
  const dialog = await collection(page, { legalities: { modern: "legal" }, rulings: [], rulings_saved: true });
  await expect(dialog.locator(".card-rules")).toContainText("This card has no official rulings.");
  await page.unroute("**/api/**");
  const second = await collection(page, { legalities: {}, rulings: [], rulings_saved: false });
  await expect(second.locator(".card-rules")).toContainText("Rulings arrive with the server’s next daily catalog update.");
  await expect(second.getByRole("heading", { name: "Format legality" })).toHaveCount(0);
});

test("deck card previews show legality and rulings too", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await deckFixture(page);
  await page.route("**/api/v1/catalog/printings/*/rulings", (route) => route.fulfill({ json: rulings }));
  await page.getByRole("button", { name: /Friday night/ }).click();
  await page.locator(".deck-art-button").first().click();
  const dialog = page.locator(".deck-preview-dialog");
  await expect(dialog.getByRole("heading", { name: "Rulings" })).toBeVisible();
  await expect(dialog.locator(".card-rulings li")).toHaveCount(3);
  // Previous and Next stay pinned at the bottom below the new section.
  await expect(dialog.locator(".deck-preview-navigation")).toBeInViewport();
  await dialog.locator(".card-rules").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/card-rulings-deck.png" });
});
