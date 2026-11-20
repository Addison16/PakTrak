import { expect, test, type Page } from "@playwright/test";
import { noPriceAlerts } from "./price-alert-fixture";

type Sent = { path: string; body: Record<string, unknown>; key: string | undefined };
const printing = (id: string, name: string, finishes: string[], extra = {}) => ({ id, name, set_code: "tst", set_name: "Fixture set", collector_number: id.slice(-1), rarity: "rare", language: "en", finishes, image_url: "/brand/paktrak-mark.svg", ...extra });
const catalog = [printing("add-1", "Fixture Bolt", ["nonfoil", "foil"]), printing("add-2", "Fixture Bolt", ["foil"], { foil_type: "galaxy" })];

async function fixture(page: Page, { binders = [{ id: "11111111-1111-4111-8111-111111111111", name: "Red binder" }, { id: "22222222-2222-4222-8222-222222222222", name: "Deck box" }], failAdd = 0 } = {}) {
  const sent: Sent[] = [], owned: unknown[] = [];
  let failures = failAdd;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()), path = url.pathname, post = route.request().method() === "POST";
    if (path === "/api/v1/price-alerts") return route.fulfill({ json: noPriceAlerts });
    if (post) sent.push({ path, body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"] });
    let json: unknown = {};
    if (path === "/api/auth/session") json = { owner_id: "add-owner", display_name: "Collector", role: "member", csrf_token: "test", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/collection/cards") json = { copies: owned.length, cards: owned.length, items: owned, next_offset: null, valuation: { provider: "tcgplayer", amount: "0.00", priced_copies: 0, unpriced_copies: 0, feed: null } };
    else if (path === "/api/v1/collection/filters") json = { sets: [], foil_types: [] };
    else if (path === "/api/v1/binders" && post) json = { id: "33333333-3333-4333-8333-333333333333" };
    else if (path === "/api/v1/binders") json = { items: binders.map((binder) => ({ ...binder, kind: "binder", notes: "", version: 1, copies: 0 })) };
    else if (path === "/api/v1/catalog/search") json = { items: catalog, next_offset: null, filters: { sets: [{ code: "tst", name: "Fixture set" }], rarities: ["rare"], languages: ["en"] } };
    else if (path === "/api/v1/collection/add") {
      if (failures-- > 0) return route.fulfill({ status: 503, json: { detail: "The server is busy. Try again." } });
      const body = route.request().postDataJSON();
      owned.push({ printing: catalog.find((card) => card.id === body.printing_id), quantity: body.quantity, location_count: 1, locations: [{ id: body.binder_id, name: "Red binder", kind: "binder", quantity: body.quantity }], value: null, priced_copies: 0, price_min: null, price_max: null });
      json = { id: "lot-1", printing_id: body.printing_id, quantity: body.quantity, finish: body.finish, version: 1 };
    }
    else if (path === "/api/v1/data/status") json = { feeds: [] };
    else if (["/api/v1/scans", "/api/v1/decks", "/api/v1/imports", "/api/v1/exports"].includes(path)) json = { items: [], next_offset: null };
    else { await route.fulfill({ status: 500, json: { detail: "Unexpected fixture endpoint " + path } }); return; }
    await route.fulfill({ json });
  });
  await page.goto("/#/collection");
  await expect(page.locator(".gallery-grid")).toHaveAttribute("aria-busy", "false");
  return sent;
}
const adds = (sent: Sent[]) => sent.filter((item) => item.path === "/api/v1/collection/add");

for (const width of [390, 1280]) test(`a card found by name joins the collection at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const sent = await fixture(page);
  await page.getByRole("button", { name: "Add a card" }).click();
  await page.getByLabel("Find an exact printing").fill("Fixture Bolt");
  await page.getByRole("button", { name: /Fixture Bolt.*#1/ }).click();
  await expect(page.getByLabel("Finish")).toHaveValue("nonfoil");
  await page.getByLabel("Finish").selectOption("foil");
  await page.getByLabel("Storage location").selectOption({ label: "Deck box" });
  await page.getByLabel("Paid per copy (optional)").fill("$3.5");
  await page.getByRole("button", { name: "One more copy" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Add 2 copies" }).click();
  await expect(page.getByText("Added 2 foil copies of Fixture Bolt to Deck box.")).toBeVisible();
  expect(adds(sent).map((item) => item.body)).toEqual([{ printing_id: "add-1", binder_id: "22222222-2222-4222-8222-222222222222", quantity: 2, finish: "foil", condition: "ungraded", purchase_price: "3.50" }]);
  // The new card shows in the collection, and the search is ready for the next one.
  await expect(page.locator(".gallery-card")).toHaveCount(1);
  await expect(page.getByLabel("Find an exact printing")).toHaveValue("");
  // The location is remembered for the next card.
  await page.getByLabel("Find an exact printing").fill("Fixture Bolt");
  await page.getByRole("button", { name: /Fixture Bolt.*#2/ }).click();
  await expect(page.getByLabel("Storage location")).toHaveValue("22222222-2222-4222-8222-222222222222");
  await expect(page.getByLabel("Finish")).toHaveValue("foil");
  await expect(page.getByLabel("Finish").locator("option")).toHaveText(["Galaxy foil"]);
  await page.getByRole("button", { name: "Done adding" }).click();
  await expect(page.getByRole("heading", { name: "Add a card" })).toHaveCount(0);
});

test("a first card names its storage location, and a retry can't add twice", async ({ page }) => {
  const sent = await fixture(page, { binders: [], failAdd: 1 });
  await page.getByRole("button", { name: "Add a card" }).click();
  await page.getByLabel("Find an exact printing").fill("Fixture Bolt");
  await page.getByRole("button", { name: /Fixture Bolt.*#1/ }).click();
  await page.getByRole("button", { name: "Add to collection" }).click();
  await expect(page.getByText("Name the storage location for this card.", { exact: true })).toBeVisible();
  await page.getByLabel("Storage location").fill("Binder A");
  await page.getByRole("button", { name: "Add to collection" }).click();
  await expect(page.getByText("Add card to collection: The server is busy. Try again.", { exact: true })).toBeVisible();
  // The location made on the first try is now a choice, so the retry doesn't ask for its name again.
  await expect(page.getByLabel("Storage location")).toHaveValue("33333333-3333-4333-8333-333333333333");
  await page.getByRole("button", { name: "Add to collection" }).click();
  await expect(page.getByText("Added 1 copy of Fixture Bolt to Binder A.")).toBeVisible();
  expect(sent.filter((item) => item.path === "/api/v1/binders").map((item) => item.body)).toEqual([{ name: "Binder A" }]);
  const tries = adds(sent);
  expect(tries).toHaveLength(2);
  expect(tries[0].key).toBeTruthy();
  expect(tries[1].key).toBe(tries[0].key);
  expect(tries[1].body.binder_id).toBe("33333333-3333-4333-8333-333333333333");
});
