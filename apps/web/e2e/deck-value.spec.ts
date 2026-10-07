import { expect, test, type Page } from "@playwright/test";
import { navigate } from "./navigation";
import { noPriceAlerts } from "./price-alert-fixture";

const printings = ["Captain", "Island", "Shield", "No quote"].map((name, i) => ({ id: "value-card-" + i, name, set_code: "val", collector_number: String(i), language: "en", finishes: i === 2 ? ["nonfoil"] : ["nonfoil", "foil"], image_url: null }));
async function fixture(page: Page) {
  const state = { source: "tcgplayer", calls: [] as any[], failPrices: 0, failPreference: 0, noPrices: false, stale: false, hold: null as null | { promise: Promise<void>; release: () => void } };
  const deck: any = { id: "priced-deck", name: "Friday deck", format: "commander", version: 1, notes: "", match_mode: "any", cards: [{ printing_id: printings[0].id, quantity: 1, section: "commander" }, { printing_id: printings[1].id, quantity: 4, section: "main" }, { printing_id: printings[2].id, quantity: 2, section: "sideboard" }, { printing_id: printings[3].id, quantity: 2, section: "main" }] };
  function valuation(cards = deck.cards, provider = state.source, finish = "nonfoil") {
    const rates = finish === "foil" ? [15, 1, 3, null] : [10, .25, 3, null]; const factor = provider === "cardkingdom" ? 2 : provider === "manapool" ? 3 : 1;
    const items = cards.map((card: any) => { const index = printings.findIndex(p => p.id === card.printing_id), value = state.noPrices ? null : rates[index]; return { ...card, ...printings[index], printing_id: card.printing_id, finish: index === 2 ? "nonfoil" : finish, finish_fallback: index === 2 && finish !== "nonfoil", unit_amount: value === null ? null : String(value * factor), amount: value === null ? null : String(value * factor * card.quantity), unpriced_reason: value === null ? "missing_price" : null }; });
    function total(rows: any[]) { const copies = rows.reduce((n, r) => n + r.quantity, 0), priced_copies = rows.reduce((n, r) => n + (r.amount === null ? 0 : r.quantity), 0); return { copies, priced_copies, unpriced_copies: copies - priced_copies, amount: copies && !priced_copies ? null : String(rows.reduce((n, r) => n + Number(r.amount), 0)) }; }
    return { ...total(items), provider, currency: "USD", price_kind: "Fixture reference price", finish_preference: finish, fallback_copies: items.filter((i: any) => i.finish_fallback).reduce((n: number, r: any) => n + r.quantity, 0), sections: Object.fromEntries(["commander", "main", "sideboard"].map(section => [section, total(items.filter((r: any) => r.section === section))])), items, checked_at: "2026-09-22T16:00:00Z", feed: { name: provider === "tcgplayer" ? "scryfall" : provider, state: state.stale ? "ERROR" : "READY", progress: {}, stale: state.stale, error: state.stale ? "Temporary feed outage" : null, updated_at: state.stale ? "2026-09-18T16:00:00Z" : "2026-09-22T16:00:00Z" } };
  }
  function detail() { const cards = deck.cards.map((c: any) => ({ ...c, printing: printings.find(p => p.id === c.printing_id), available: 0, owned: 0, missing: c.quantity, locations: [] })); return { ...deck, cards, copies: cards.reduce((n: number, c: any) => n + c.quantity, 0), owned_copies: 0, missing_copies: cards.reduce((n: number, c: any) => n + c.quantity, 0), missing_cards: cards.map((c: any) => ({ printing: c.printing, quantity: c.quantity })), valuation: valuation(), tokens: { items: [], missing_details: 0 } }; }
  await page.route("**/api/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname, method = req.method(), body = req.postData() ? req.postDataJSON() : null;
    if (path === "/api/v1/price-alerts") return route.fulfill({ json: noPriceAlerts });
    state.calls.push({ path, method, body }); let json: any = {}, status = 200;
    if (path === "/api/auth/session") json = { owner_id: "value-fixture", display_name: "Deck collector", role: "member", csrf_token: "value-csrf", tour_dismissed: true, preferred_price_source: state.source, scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/scans" || path === "/api/v1/binders") json = { items: [], next_offset: null };
    else if (path === "/api/v1/collection/filters") json = { sets: [] };
    else if (path === "/api/v1/data/status") json = { feeds: [] };
    else if (path === "/api/v1/collection/cards") json = { copies: 0, cards: 0, items: [], next_offset: null, valuation: { provider: state.source, amount: null, priced_copies: 0, unpriced_copies: 0, feed: null } };
    else if (path === "/api/v1/decks") json = { items: [detail()], next_offset: null };
    else if (path === "/api/v1/decks/priced-deck") { if (method === "POST") { Object.assign(deck, body); deck.version++; } json = detail(); }
    else if (path === "/api/auth/preferences") { expect(method).toBe("PATCH"); expect(req.headers()["x-csrf-token"]).toBe("value-csrf"); if (state.failPreference) { state.failPreference--; status = 503; json = { detail: "Preference interrupted" }; } else { state.source = body.price_source; json = { preferred_price_source: state.source }; } }
    else if (path === "/api/v1/decks/value") { expect(req.headers()["x-csrf-token"]).toBe("value-csrf"); const value = valuation(body.cards, body.provider, body.finish_preference); const held = state.hold; state.hold = null; if (held) await held.promise; if (state.failPrices) { state.failPrices--; status = 503; json = { detail: "Prices temporarily unavailable" }; } else json = value; }
    else if (path === "/api/v1/decks/tokens") json = { items: [], missing_details: 0 };
    else if (path === "/api/v1/decks/legality") json = { format: body.format, status: "not_checked", counts: { main: 0, sideboard: 0, commander: 0 }, issues: [], checks: [], limitations: [] };
    else { status = 500; json = { detail: "Unexpected fixture request: " + path }; }
    await route.fulfill({ status, json });
  });
  await page.goto("/"); await navigate(page, "Decks"); await page.getByRole("button", { name: /Friday deck/ }).click();
  const panel = page.getByRole("region", { name: "Deck value", exact: true });
  await expect(panel.getByLabel("Estimated deck value", { exact: true })).toHaveText("$17.00");
  await panel.locator(".deck-value-options > summary").click();
  return { state, deck, panel, detail };
}

test("background account refreshes keep exactly one deck value and token panel", async ({ page }) => {
  const keyErrors: string[] = [];
  page.on("console", message => { if (message.type() === "error" && message.text().includes("same key")) keyErrors.push(message.text()); });
  const { state, panel } = await fixture(page);
  await expect(page.locator(".deck-opening")).toHaveCount(0);
  await page.clock.install();
  for (let tick = 0; tick < 6; tick++) {
    // The sign-in check runs on every tick; the batch list itself refreshes less often while nothing is processing.
    const reads = state.calls.filter(call => call.path === "/api/auth/session").length;
    await page.clock.runFor(2500);
    await expect.poll(() => state.calls.filter(call => call.path === "/api/auth/session").length).toBeGreaterThan(reads);
    await expect(panel).toHaveCount(1);
    await expect(panel.getByLabel("Estimated deck value", { exact: true })).toHaveCount(1);
    await expect(page.locator(".deck-tokens")).toHaveCount(1);
  }
  expect(keyErrors).toEqual([]);
});

test("switching decks hides the previous value while the next deck loads", async ({ page }) => {
  const { panel, detail } = await fixture(page);
  await expect(page.locator(".deck-opening")).toHaveCount(0);
  const second = { ...detail(), id: "second-deck", name: "Second deck", valuation: { ...detail().valuation, amount: "37.00" } };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/decks/second-deck", async route => { await gate; await route.fulfill({ json: second }); });
  await page.evaluate(() => { location.hash = "#/decks/second-deck"; });
  await expect(page.getByText("Opening deck…", { exact: true })).toBeVisible();
  await expect(panel).toHaveCount(0);
  await expect(page.locator(".deck-detail")).toHaveCount(0);
  release();
  await expect(page.getByRole("heading", { name: "Second deck", exact: true })).toBeVisible();
  await expect(panel).toHaveCount(1);
  await expect(panel.getByLabel("Estimated deck value", { exact: true })).toHaveText("$37.00");
  await page.getByRole("button", { name: "Close deck", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Your decks", exact: true })).toBeVisible();
});

test("the value breakdown omits empty deck sections", async ({ page }) => {
  const { deck, panel } = await fixture(page);
  deck.cards = deck.cards.filter((card: any) => card.section === "main");
  await page.reload();
  await expect(panel.getByLabel("Estimated deck value", { exact: true })).toHaveText("$1.00");
  await panel.locator(".deck-value-options > summary").click();
  await panel.locator(".deck-value-breakdown > summary").click();
  const sections = panel.getByLabel("Value by deck section");
  await expect(sections.locator(":scope > div")).toHaveCount(1);
  await expect(sections).toContainText("Mainboard");
});

for (const mode of ["light", "dark"] as const) for (const width of [320, 390]) test(`${mode} deck value and partial-price breakdown fit ${width}px`, async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: mode }); await page.setViewportSize({ width, height: 844 });
  const { panel } = await fixture(page);
  await expect(panel).toContainText("7 of 9 copies priced · 2 unpriced");
  await expect(panel).toHaveCount(1);
  await expect(panel.getByLabel("Estimated deck value", { exact: true })).toHaveCount(1);
  await expect(panel.getByLabel("Value by deck section")).not.toBeVisible();
  await panel.locator(".deck-value-breakdown > summary").click();
  await expect(panel.getByLabel("Value by deck section")).toContainText("$10.00");
  await expect(panel.getByLabel("Value by deck section")).toContainText("$1.00");
  await expect(panel.getByLabel("Value by deck section")).toContainText("$6.00");
  await expect(panel.locator("li")).toHaveCount(4);
  await panel.getByRole("checkbox", { name: "Only unpriced cards", exact: true }).check();
  await expect(panel.locator("li")).toHaveCount(1); await expect(panel.locator("li")).toContainText("No quote");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: `../../artifacts/deck-value/${mode}-${width}-${info.project.name}.png` });
  await panel.getByRole("button", { name: "No quote", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("No quote");
});

test("switches all three sources, remembers the account choice and never changes the deck", async ({ page }) => {
  const { panel, state, deck } = await fixture(page); const original = JSON.stringify(deck);
  for (const [source, amount] of [["cardkingdom", "$34.00"], ["manapool", "$51.00"], ["tcgplayer", "$17.00"]]) {
    await panel.getByRole("combobox", { name: "Deck price source", exact: true }).selectOption(source);
    await expect(panel.getByLabel("Estimated deck value", { exact: true })).toHaveText(amount);
    await expect(panel.getByRole("combobox", { name: "Deck price source", exact: true })).toBeEnabled();
  }
  await panel.getByRole("combobox", { name: "Deck price source", exact: true }).selectOption("manapool");
  await expect(panel.getByLabel("Estimated deck value", { exact: true })).toHaveText("$51.00");
  await page.reload(); await panel.locator(".deck-value-options > summary").click(); await expect(panel.getByRole("combobox", { name: "Deck price source", exact: true })).toHaveValue("manapool");
  await expect(panel.getByLabel("Estimated deck value", { exact: true })).toHaveText("$51.00");
  expect(JSON.stringify(deck)).toBe(original);
  expect(state.calls.some(call => call.method !== "GET" && call.path.startsWith("/api/v1/collection"))).toBe(false);
});

test("finish estimates disclose fallbacks and missing prices never become a zero deck value", async ({ page }) => {
  const { panel, state } = await fixture(page);
  await panel.getByRole("combobox", { name: "Finish for estimate", exact: true }).selectOption("foil");
  await expect(panel.getByLabel("Estimated deck value", { exact: true })).toHaveText("$25.00");
  await expect(panel).toContainText("2 copies use another available finish");
  state.noPrices = true; await panel.getByRole("button", { name: "Refresh value", exact: true }).click();
  await expect(panel.getByLabel("Estimated deck value", { exact: true })).toHaveText("—");
  await expect(panel).toContainText("0 of 9 copies priced · 9 unpriced");
  await expect(panel).toContainText("No prices available");
});

test("editing quantities updates the estimate and clearing an input pauses it until a valid quantity", async ({ page }) => {
  const { panel, state, deck } = await fixture(page);
  await page.getByRole("button", { name: "Edit deck", exact: true }).click();
  const quantity = page.locator(".deck-card-row").filter({ hasText: "Island" }).getByRole("spinbutton", { name: "Copies in deck", exact: true });
  await quantity.fill(""); await expect(panel).toContainText("Finish entering card quantities");
  await expect(panel.getByLabel("Estimated deck value", { exact: true })).toHaveCount(0);
  await quantity.fill("30"); await expect(panel.getByLabel("Estimated deck value", { exact: true })).toHaveText("$23.50");
  await expect(panel).toContainText("Unsaved deck changes");
  expect(deck.cards[1].quantity).toBe(4);
  await page.getByRole("button", { name: "Save deck", exact: true }).click();
  await expect(panel.getByLabel("Estimated deck value", { exact: true })).toHaveText("$23.50");
  await quantity.fill("0"); await expect(panel.getByLabel("Estimated deck value", { exact: true })).toHaveText("$16.00");
  expect(state.calls.filter(call => call.path.endsWith("/value")).every(call => call.body.cards.every((c: any) => c.quantity > 0))).toBe(true);
});

test("failed price reads and preference saves explain their own recovery without overwriting choices", async ({ page }) => {
  const { panel, state } = await fixture(page);
  state.failPreference = 1; await panel.getByRole("combobox", { name: "Deck price source", exact: true }).selectOption("cardkingdom");
  await expect(panel).toContainText("account preference could not be saved");
  await expect(panel.getByLabel("Estimated deck value", { exact: true })).toHaveText("$34.00");
  await panel.getByRole("button", { name: "Retry price preference", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Retry price preference", exact: true })).toHaveCount(0);
  state.failPrices = 1; await panel.getByRole("button", { name: "Refresh value", exact: true }).click();
  await expect(panel).toContainText("Deck value unavailable");
  await expect(panel.getByLabel("Estimated deck value", { exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "Retry deck value", exact: true }).click();
  await expect(panel.getByLabel("Estimated deck value", { exact: true })).toHaveText("$34.00");
  state.stale = true; await panel.getByRole("button", { name: "Refresh value", exact: true }).click();
  await expect(panel).toContainText("Cached prices may be out of date"); await expect(panel).toContainText("latest source update failed");
});

test("late source responses cannot put a previous provider's value under the new source label", async ({ page }) => {
  const { panel, state } = await fixture(page);
  let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); state.hold = { promise, release };
  await panel.getByRole("combobox", { name: "Deck price source", exact: true }).selectOption("cardkingdom");
  await expect.poll(() => state.calls.some(call => call.path.endsWith("/value") && call.body.provider === "cardkingdom")).toBe(true);
  await panel.getByRole("combobox", { name: "Deck price source", exact: true }).selectOption("manapool");
  await expect(panel.getByLabel("Estimated deck value", { exact: true })).toHaveText("$51.00");
  release();
  await expect(panel.getByRole("combobox", { name: "Deck price source", exact: true })).toHaveValue("manapool");
  await expect(panel.getByLabel("Estimated deck value", { exact: true })).toHaveText("$51.00");
});


test("a deck source change updates an already-open collection without waiting for its polling interval", async ({ page }) => {
  const { panel } = await fixture(page);
  await navigate(page, "Collection");
  await expect(page.getByRole("combobox", { name: "Price source", exact: true })).toHaveValue("tcgplayer");
  await navigate(page, "Decks"); await page.getByRole("button", { name: /Friday deck/ }).click();
  await panel.locator(".deck-value-options > summary").click();
  await panel.getByRole("combobox", { name: "Deck price source", exact: true }).selectOption("cardkingdom");
  await expect(panel.getByLabel("Estimated deck value", { exact: true })).toHaveText("$34.00");
  await navigate(page, "Collection");
  await expect(page.getByRole("combobox", { name: "Price source", exact: true })).toHaveValue("cardkingdom");
});
