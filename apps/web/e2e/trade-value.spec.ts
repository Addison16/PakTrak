import { expect, test, type Page } from "@playwright/test";
import { navigate } from "./navigation";

const printing = (id: string, name: string, finishes: string[]) => ({ id, name, set_code: "trd", set_name: "Trade Fixtures", collector_number: id.slice(-1), language: "en", rarity: "rare", finishes, image_url: null });
const dragon = printing("trade-card-1", "Shivan Dragon", ["nonfoil", "foil"]);
const bolt = printing("trade-card-2", "Lightning Bolt", ["nonfoil", "foil"]);
const ring = printing("trade-card-3", "Sol Ring", ["nonfoil"]);
const unpriced = printing("trade-card-4", "Mystery Promo", ["foil"]);
// Sample reference prices by provider and finish; Card Kingdom doubles them.
const prices: Record<string, Record<string, number | null>> = {
  [dragon.id]: { nonfoil: 10, foil: 30 }, [bolt.id]: { nonfoil: 2.5, foil: 12 }, [ring.id]: { nonfoil: 5 }, [unpriced.id]: { foil: null },
};

async function fixture(page: Page) {
  const state = { source: "tcgplayer", valueCalls: [] as any[], removals: [] as any[], importBody: "", importPolls: 0, confirmed: null as any,
    lots: [{ id: "lot-1", printing: dragon, quantity: 3, finish: "foil", condition: "NM", binder: "Trade binder", binder_id: "b1", binder_kind: "binder", notes: "", version: 1 },
      { id: "lot-2", printing: dragon, quantity: 1, finish: "unknown", condition: "NM", binder: "Box", binder_id: "b2", binder_kind: "box", notes: "", version: 4 }] };
  await page.route("**/api/**", async (route) => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname, body = req.postData() && req.headers()["content-type"]?.includes("json") ? req.postDataJSON() : null;
    let json: any = {}, status = 200;
    if (path === "/api/auth/session") json = { owner_id: "trade-fixture", display_name: "Trader", role: "member", csrf_token: "trade-csrf", tour_dismissed: true, preferred_price_source: state.source, scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/scans") json = { items: [], next_offset: null };
    else if (path === "/api/auth/preferences") { state.source = body.price_source; json = { preferred_price_source: state.source }; }
    else if (path === "/api/v1/collection") json = { copies: 4, next_offset: null, items: url.searchParams.get("printing_id") ? state.lots.filter((lot) => lot.printing.id === url.searchParams.get("printing_id")) : url.searchParams.get("q")?.toLowerCase().startsWith("shi") ? state.lots.slice(0, 1) : [] };
    else if (/^\/api\/v1\/collection\/lot-\d\/quantity$/.test(path)) {
      const lot = state.lots.find((item) => path.includes(item.id))!;
      expect(body.expected_version).toBe(lot.version); state.removals.push({ lot: lot.id, quantity: body.quantity });
      lot.quantity = body.quantity; lot.version++; json = { id: lot.id, quantity: lot.quantity, version: lot.version };
    } else if (path === "/api/v1/imports" && req.method() === "POST") { state.importBody = req.postData() || ""; json = { id: "trade-import", state: "PREVIEWING", revision: 1, summary: null }; }
    else if (path === "/api/v1/imports/trade-import") { state.importPolls++; json = state.confirmed ? { id: "trade-import", state: "COMPLETED", revision: 3, summary: { ready_copies: 0, committed_copies: 3, unresolved_rows: 0 } } : { id: "trade-import", state: "REVIEW", revision: 2, summary: { ready_copies: 3, committed_copies: 0, unresolved_rows: 0 } }; }
    else if (path === "/api/v1/imports/trade-import/confirm") { state.confirmed = body; json = { id: "trade-import", state: "COMMITTING", revision: 3, summary: null }; }
    else if (path === "/api/v1/catalog/search") {
      const q = (url.searchParams.get("q") || "").toLowerCase();
      json = { items: [bolt, ring, unpriced].filter((card) => card.name.toLowerCase().includes(q)), next_offset: null, filters: { sets: [], rarities: [], languages: [] } };
    } else if (path === "/api/v1/decks/value") {
      expect(req.headers()["x-csrf-token"]).toBe("trade-csrf");
      state.valueCalls.push(body);
      const factor = body.provider === "cardkingdom" ? 2 : 1;
      json = { provider: body.provider, price_kind: "Fixture reference price", feed: { name: "scryfall", state: "READY", progress: {}, stale: false, updated_at: "2026-10-07T09:00:00Z" },
        items: body.cards.map((card: any) => { const value = prices[card.printing_id]?.[body.finish_preference]; return { printing_id: card.printing_id, finish: body.finish_preference, unit_amount: value == null ? null : String(value * factor) }; }) };
    } else { status = 500; json = { detail: "Unexpected fixture request: " + path }; }
    await route.fulfill({ status, json });
  });
  await page.goto("/");
  await navigate(page, "Trade value");
  await expect(page.getByRole("heading", { name: "Trade value", exact: true })).toBeVisible();
  return state;
}

const total = (page: Page, side: "You give" | "You get") => page.getByLabel(`${side} total`, { exact: true });
const verdict = (page: Page) => page.locator(".trade-verdict");

test("compares both sides of a trade with per-card finishes and quantities", async ({ page }) => {
  const state = await fixture(page);
  await expect(verdict(page)).toContainText("Add cards to both sides");

  // Give a foil card from the collection; the lot's finish carries over.
  await page.getByRole("button", { name: "Add a card you give", exact: true }).click();
  await page.getByLabel("Search your collection").fill("Shiv");
  await page.getByRole("button", { name: /Shivan Dragon.*Foil.*3 in Trade binder/ }).click();
  await expect(page.getByText("Added Shivan Dragon.")).toBeVisible();
  await page.getByRole("button", { name: "Done adding", exact: true }).click();
  await expect(total(page, "You give")).toHaveText("$30.00");
  await expect(page.getByText("You have 3 in Trade binder")).toBeVisible();

  // Get two Lightning Bolts and a Sol Ring from the full catalog.
  await page.getByRole("button", { name: "Add a card you get", exact: true }).click();
  const finder = page.getByLabel("Find an exact printing");
  await finder.fill("Lightning");
  await page.getByRole("button", { name: /Lightning Bolt/ }).click();
  await finder.fill("Sol Ring");
  await page.getByRole("button", { name: /Sol Ring/ }).click();
  await page.getByRole("button", { name: "Done adding", exact: true }).click();
  await page.getByRole("button", { name: "One more Lightning Bolt", exact: true }).click();
  await expect(total(page, "You get")).toHaveText("$10.00");
  await expect(verdict(page)).toContainText("Uneven, in their favor");
  await expect(verdict(page)).toContainText("You give $20.00 more (67% of the bigger side).");

  // Switching the bolts to foil re-prices only that finish and evens things out.
  await page.getByLabel("Finish for Lightning Bolt").selectOption("foil");
  await expect(total(page, "You get")).toHaveText("$29.00");
  await expect(verdict(page)).toContainText("Even trade");
  expect(state.valueCalls.filter((call) => call.finish_preference === "foil").length).toBe(2);

  // A card with no quote is counted as a card but left out of the totals.
  await page.getByRole("button", { name: "Add a card you get", exact: true }).click();
  await page.getByLabel("Find an exact printing").fill("Mystery");
  await page.getByRole("button", { name: /Mystery Promo/ }).click();
  await page.getByRole("button", { name: "Done adding", exact: true }).click();
  await expect(page.locator(".trade-total--get small")).toHaveText("4 cards · 1 unpriced");
  await expect(verdict(page)).toContainText("Cards without a price are left out of the totals.");

  // A different price source prices every card again.
  await page.getByLabel("Price source").selectOption("cardkingdom");
  await expect(total(page, "You give")).toHaveText("$60.00");
  await expect(total(page, "You get")).toHaveText("$58.00");
  await expect(verdict(page)).toContainText("Even trade");
  await expect(verdict(page)).toContainText("You give $2.00 more");

  // The trade survives leaving the page, and removing the last copy drops the row.
  await navigate(page, "Collection");
  await navigate(page, "Trade value");
  await expect(total(page, "You give")).toHaveText("$60.00");
  await page.getByRole("button", { name: "Remove Shivan Dragon", exact: true }).click();
  await expect(total(page, "You give")).toHaveText("$0.00");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Clear trade", exact: true }).click();
  await expect(verdict(page)).toContainText("Add cards to both sides");
});

test("the trade page fits a phone screen without sideways scrolling", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "Add a card you get", exact: true }).click();
  await page.getByLabel("Find an exact printing").fill("Lightning");
  await page.getByRole("button", { name: /Lightning Bolt/ }).click();
  await page.getByRole("button", { name: "Done adding", exact: true }).click();
  await expect(total(page, "You get")).toHaveText("$2.50");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("prices are checked again when returning to the page after a while", async ({ page }) => {
  await page.clock.install();
  const state = await fixture(page);
  await page.getByRole("button", { name: "Add a card you get", exact: true }).click();
  await page.getByLabel("Find an exact printing").fill("Sol Ring");
  await page.getByRole("button", { name: /Sol Ring/ }).click();
  await page.getByRole("button", { name: "Done adding", exact: true }).click();
  await expect(total(page, "You get")).toHaveText("$5.00");
  const calls = state.valueCalls.length;
  await navigate(page, "Collection");
  prices[ring.id].nonfoil = 7;
  await page.clock.fastForward("06:00");
  await navigate(page, "Trade value");
  await expect(total(page, "You get")).toHaveText("$7.00");
  expect(state.valueCalls.length).toBe(calls + 1);
  prices[ring.id].nonfoil = 5;
});

test("accepting a trade removes the cards given and imports the cards received", async ({ page }) => {
  const state = await fixture(page);
  // Give 4 foil Shivan Dragons: 3 from the picked lot, then 1 from a lot with no recorded finish.
  await page.getByRole("button", { name: "Add a card you give", exact: true }).click();
  await page.getByLabel("Search your collection").fill("Shiv");
  await page.getByRole("button", { name: /Shivan Dragon/ }).click();
  await page.getByRole("button", { name: "Done adding", exact: true }).click();
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "One more Shivan Dragon", exact: true }).click();
  await page.getByRole("button", { name: "Add a card you get", exact: true }).click();
  const finder = page.getByLabel("Find an exact printing");
  await finder.fill("Lightning"); await page.getByRole("button", { name: /Lightning Bolt/ }).click();
  await finder.fill("Sol Ring"); await page.getByRole("button", { name: /Sol Ring/ }).click();
  await page.getByRole("button", { name: "Done adding", exact: true }).click();
  await page.getByRole("button", { name: "One more Lightning Bolt", exact: true }).click();

  // Asking for more copies than the collection holds stops before anything changes.
  await page.getByRole("button", { name: "One more Shivan Dragon", exact: true }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Accept trade", exact: true }).click();
  await expect(page.getByRole("paragraph").filter({ hasText: /Your collection has 4 foil copies of Shivan Dragon, but this trade gives 5/ })).toBeVisible();
  expect(state.importBody).toBe(""); expect(state.removals).toEqual([]);
  await page.getByRole("button", { name: "One fewer Shivan Dragon", exact: true }).click();

  let prompt = "";
  page.once("dialog", (dialog) => { prompt = dialog.message(); void dialog.accept(); });
  await page.getByRole("button", { name: "Accept trade", exact: true }).click();
  await expect(page.getByText("Trade accepted. Added 3 copies to “Trades” and removed 4 copies from your collection.")).toBeVisible();
  expect(prompt).toContain("remove 4 copies you give from your collection and add 3 copies you get to a binder named “Trades”");
  expect(state.importBody).toContain(`"${bolt.id}","Lightning Bolt","trd","2","en","2","nonfoil","Trades"`);
  expect(state.importBody).toContain(`"${ring.id}","Sol Ring","trd","3","en","1","nonfoil","Trades"`);
  expect(state.confirmed).toEqual({ expected_revision: 2, owned_cards: true });
  expect(state.removals).toEqual([{ lot: "lot-1", quantity: 0 }, { lot: "lot-2", quantity: 0 }]);
  await expect(page.getByText("No cards yet. Add the cards you’re handing over.")).toBeVisible();
  await expect(page.getByText("No cards yet. Add the cards you’re receiving.")).toBeVisible();
});

test("declining the confirmation leaves the collection untouched", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "Add a card you get", exact: true }).click();
  await page.getByLabel("Find an exact printing").fill("Sol Ring");
  await page.getByRole("button", { name: /Sol Ring/ }).click();
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("button", { name: "Accept trade", exact: true }).click();
  await expect(total(page, "You get")).toHaveText("$5.00");
  expect(state.importBody).toBe("");
});
