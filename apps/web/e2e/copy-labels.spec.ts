import { expect, test, type Page } from "@playwright/test";
import { noPriceAlerts } from "./price-alert-fixture";

const dragon = { id: "label-dragon", name: "Shivan Dragon", set_code: "lab", collector_number: "1", set_name: "Label fixtures", language: "en", rarity: "rare", type_line: "Creature — Dragon", finishes: ["nonfoil", "foil"], image_url: "/brand/paktrak-mark.svg" };

async function fixture(page: Page) {
  const state = { lot: { id: "lot-1", printing: dragon, quantity: 3, finish: "foil", condition: "NM", binder: "Red binder", binder_id: "red", binder_kind: "binder", notes: "", version: 1, purchase_price: "2.00", purchase_currency: "USD", market_price: "3.50", labels: ["Signed"], for_trade: false } as Record<string, unknown>,
    edits: [] as Record<string, unknown>[], lists: [] as URLSearchParams[] };
  const card = () => ({ printing: dragon, quantity: 3, location_count: 1, locations: [{ id: "red", name: "Red binder", quantity: 3 }], value: "10.50", price_min: "3.50", price_max: "3.50", priced_copies: 3 });
  await page.route("**/api/**", async (route) => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    if (path === "/api/v1/price-alerts") return route.fulfill({ json: noPriceAlerts });
    let json: unknown = {}, status = 200;
    if (path === "/api/auth/session") json = { owner_id: "label-owner", display_name: "Collector", role: "member", csrf_token: "test", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/collection/cards") { state.lists.push(url.searchParams); json = { copies: 3, cards: 1, items: [card()], next_offset: null, valuation: { provider: "tcgplayer", amount: "10.50", priced_copies: 3, unpriced_copies: 0, feed: null } }; }
    else if (path === "/api/v1/collection/cards/" + dragon.id) json = card();
    else if (path === "/api/v1/collection/printings/" + dragon.id) json = { printing: dragon, faces: [{ name: dragon.name, image_url: dragon.image_url }], legalities: {}, prices: [], released_at: null, scryfall_url: null };
    else if (path === "/api/v1/collection") json = { copies: 3, items: [state.lot], next_offset: null };
    else if (path === "/api/v1/collection/lot-1/details") {
      const body = req.postDataJSON(); state.edits.push(body);
      state.lot = { ...state.lot, ...body, version: 2, market_price: body.purchase_price === null ? null : state.lot.market_price };
      json = { id: "lot-1", printing: dragon, finish: "foil", quantity: 3, version: 2, condition: "NM", notes: "" };
    }
    else if (path === "/api/v1/collection/filters") json = { sets: [{ code: "lab", name: "Label fixtures" }], foil_types: [], labels: ["Cube", "Signed"], for_trade: true };
    else if (path === "/api/v1/binders") json = { items: [{ id: "red", name: "Red binder", kind: "binder", copies: 3, version: 1, notes: "" }] };
    else if (path === "/api/v1/data/status") json = { feeds: [] };
    else if (["/api/v1/decks", "/api/v1/scans", "/api/v1/imports", "/api/v1/exports"].includes(path)) json = { items: [], next_offset: null };
    else { status = 404; json = { detail: "Not in fixture: " + path }; }
    await route.fulfill({ status, json });
  });
  await page.goto("/#/collection");
  await expect(page.locator(".gallery-card")).toHaveCount(1);
  return state;
}

for (const width of [390, 1280]) test(`copies show what was paid and their labels, and both can be edited at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const state = await fixture(page);
  await page.getByRole("button", { name: /^Open Shivan Dragon/ }).click();
  const dialog = page.getByRole("dialog", { name: "Shivan Dragon" });
  await dialog.getByText("Manage copies").click();
  await expect(dialog.locator(".copy-paid")).toHaveText("Paid $2.00 each · now $3.50 (up $1.50)");
  await expect(dialog.locator(".copy-labels")).toHaveText("Signed");
  await dialog.getByText("Edit card details").click();
  const save = dialog.getByRole("button", { name: "Save card details" });
  await expect(save).toBeDisabled();
  await expect(dialog.getByLabel("Paid per copy (optional)")).toHaveValue("2.00");
  await dialog.getByLabel("Paid per copy (optional)").fill("two dollars");
  await expect(dialog.getByText(/Enter what you paid for one copy/)).toBeVisible();
  await expect(save).toBeDisabled();
  await dialog.getByLabel("Paid per copy (optional)").fill("");
  await dialog.getByLabel("Labels (optional)").fill("Signed, cube night , signed");
  await dialog.getByLabel("Available for trade").check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await save.click();
  await expect.poll(() => state.edits.length).toBe(1);
  expect(state.edits[0]).toMatchObject({ purchase_price: null, labels: ["Signed", "cube night"], for_trade: true, finish: "foil" });
});

test("the Label filter lists your labels and the trade list", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: /^Filters/ }).click();
  const select = page.getByRole("combobox", { name: "Label", exact: true });
  await expect(select.locator("option")).toHaveText(["All cards", "For trade", "Cube", "Signed"]);
  await select.selectOption({ label: "Signed" });
  await expect.poll(() => state.lists.at(-1)?.get("label")).toBe("Signed");
  expect(state.lists.at(-1)?.has("for_trade")).toBe(false);
  await select.selectOption({ label: "For trade" });
  await expect.poll(() => state.lists.at(-1)?.get("for_trade")).toBe("true");
  expect(state.lists.at(-1)?.has("label")).toBe(false);
  await expect(page.getByRole("button", { name: /^Filters · 1/ })).toBeVisible();
  // The choice survives a reload, like the other filters.
  await page.reload();
  await expect.poll(() => state.lists.at(-1)?.get("for_trade")).toBe("true");
});
