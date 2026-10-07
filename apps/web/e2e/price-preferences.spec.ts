import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { PriceSource } from "../src/api";
import { navigate } from "./navigation";

type Source = PriceSource | null;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Every API request is intercepted: these tests never create or alter a real account.
async function accountApi(context: BrowserContext, preference: Source) {
  const state = {
    owner: "pricing-account-a",
    sources: new Map<string, Source>([["pricing-account-a", preference], ["pricing-account-b", "cardkingdom"]]),
    writes: [] as { owner: string; price_source: PriceSource; only_if_unset?: boolean }[],
    queries: [] as { provider: string; sort: string }[],
    failures: 0,
    migrationWinner: null as Source,
    holdWrite: null as ReturnType<typeof deferred> | null,
    holdSession: null as ReturnType<typeof deferred> | null,
    sessionHeld: false,
    unexpected: [] as string[],
  };
  await context.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === "/api/auth/session") {
      const account = { owner_id: state.owner, display_name: "Pricing tester", csrf_token: "test-csrf-" + state.owner, role: "member", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null, preferred_price_source: state.sources.get(state.owner) ?? null };
      const hold = state.holdSession;
      if (hold) { state.holdSession = null; state.sessionHeld = true; await hold.promise; }
      return json(account);
    }
    if (path === "/api/auth/preferences") {
      expect(route.request().method()).toBe("PATCH");
      expect(route.request().headers()["x-csrf-token"]).toBe("test-csrf-" + state.owner);
      const body = route.request().postDataJSON();
      const owner = state.owner;
      state.writes.push({ owner, ...body });
      const hold = state.holdWrite;
      if (hold) { state.holdWrite = null; await hold.promise; }
      if (state.failures) { state.failures--; return json({ detail: "Temporary save failure. Please retry." }, 503); }
      if (body.only_if_unset && state.migrationWinner) state.sources.set(owner, state.migrationWinner);
      if (!body.only_if_unset || state.sources.get(owner) == null) state.sources.set(owner, body.price_source);
      return json({ preferred_price_source: state.sources.get(owner) });
    }
    if (path === "/api/auth/status") return json({ setup_required: false, guest_signup_enabled: false });
    if (path === "/api/v1/capabilities") return json({ max_upload_bytes: 104857600 });
    if (path === "/api/v1/scans") return json({ items: [], next_offset: null });
    if (path === "/api/v1/binders") return json({ items: [] });
    if (path === "/api/v1/collection/filters") return json({ sets: [] });
    if (path === "/api/v1/data/status") return json({ feeds: [] });
    if (path === "/api/v1/collection/cards" || /^\/api\/v1\/collection\/cards\/printing-[0-2]$/.test(path)) {
      const provider = url.searchParams.get("provider") || "tcgplayer";
      const sort = url.searchParams.get("sort") || "name";
      const prices: Record<string, (string | null)[]> = { tcgplayer: ["1.00", "9.00", null], cardkingdom: ["10.00", "2.00", null], manapool: ["8.00", "4.00", null] };
      const items = ["Alpha", "Beta", "No quote"].map((name, index) => ({
        printing: { id: "printing-" + index, name, set_code: "tst", collector_number: String(index + 1), language: "en", finishes: ["nonfoil"], rarity: "common", image_url: null },
        quantity: 1, location_count: 0, locations: [], value: prices[provider][index], price_min: prices[provider][index], price_max: prices[provider][index], priced_copies: prices[provider][index] == null ? 0 : 1,
      }));
      if (path !== "/api/v1/collection/cards") return json(items.find(item => path.endsWith("/" + item.printing.id)));
      state.queries.push({ provider, sort });
      if (sort === "price_asc" || sort === "price_desc") items.sort((a, b) => a.price_min == null ? 1 : b.price_min == null ? -1 : (Number(a.price_min) - Number(b.price_min)) * (sort === "price_asc" ? 1 : -1));
      return json({ copies: 3, cards: 3, items, next_offset: null, valuation: { provider, amount: "12.00", priced_copies: 2, unpriced_copies: 1, feed: null } });
    }
    if (/^\/api\/v1\/collection\/printings\/printing-[0-2]\/decks$/.test(path)) return json({ name: "Alpha", owned: 1, used: 0, free: 1, decks: [] });
    if (/^\/api\/v1\/collection\/printings\/printing-[0-2]\/price-history$/.test(path)) return json({ provider: "tcgplayer", days: 365, finishes: {} });
    state.unexpected.push(path);
    return json({ detail: "Unexpected mocked endpoint " + path }, 404);
  });
  return state;
}

async function collection(page: Page) {
  await navigate(page, "Collection");
  await expect(page.getByRole("combobox", { name: "Price source", exact: true })).toBeEnabled();
  await expect(page.locator(".gallery-card")).toHaveCount(3);
  await expect(page.locator(".gallery-grid")).toHaveAttribute("aria-busy", "false");
}
async function choice(page: Page, source: PriceSource) {
  const select = page.getByRole("combobox", { name: "Price source", exact: true });
  await select.selectOption(source);
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue(source);
  await expect(page.locator("#price-source-status")).toHaveText("Price source is remembered for your account.");
  await expect(page.locator(".gallery-grid")).toHaveAttribute("aria-busy", "false");
}

test("account source wins over an old device value and remains through navigation and reload", async ({ context, page }) => {
  const state = await accountApi(context, "cardkingdom");
  await context.addInitScript(() => localStorage.setItem("collection-price-source:pricing-account-a", "tcgplayer"));
  await page.goto("/"); await collection(page);
  const select = page.getByRole("combobox", { name: "Price source", exact: true });
  await expect(select).toHaveValue("cardkingdom");
  expect(state.writes).toHaveLength(0);
  await choice(page, "manapool");
  await navigate(page, "Upload photo"); await collection(page);
  await expect(select).toHaveValue("manapool");
  await page.reload(); await collection(page);
  await expect(select).toHaveValue("manapool");
  expect(state.writes).toEqual([{ owner: "pricing-account-a", price_source: "manapool" }]);
  expect(state.unexpected).toEqual([]);
});

test("legacy migration only initializes an unset account and respects a concurrent saved choice", async ({ context, page }) => {
  const state = await accountApi(context, null);
  state.migrationWinner = "manapool";
  await context.addInitScript(() => localStorage.setItem("collection-price-source:pricing-account-a", "cardkingdom"));
  await page.goto("/"); await collection(page);
  await expect(page.getByRole("combobox", { name: "Price source", exact: true })).toHaveValue("manapool");
  expect(state.writes).toEqual([{ owner: "pricing-account-a", price_source: "cardkingdom", only_if_unset: true }]);
  await navigate(page, "Upload photo"); await collection(page);
  expect(state.writes).toHaveLength(1);
});

test("an invalid device value is ignored, failed saves are explicit and can be retried", async ({ context, page }) => {
  const state = await accountApi(context, null);
  await context.addInitScript(() => localStorage.setItem("collection-price-source:pricing-account-a", "invalid-provider"));
  await page.goto("/"); await collection(page);
  expect(state.writes).toHaveLength(0);
  state.failures = 1;
  const select = page.getByRole("combobox", { name: "Price source", exact: true });
  await select.selectOption("cardkingdom");
  await expect(page.getByRole("alert")).toContainText("account preference could not be saved");
  await expect(select).toBeEnabled();
  expect(state.sources.get(state.owner)).toBeNull();
  await page.evaluate(() => dispatchEvent(new Event("focus")));
  await expect(select).toHaveValue("cardkingdom");
  await page.getByRole("button", { name: "Retry saving price source", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(select).toBeEnabled();
  expect(state.sources.get(state.owner)).toBe("cardkingdom");
});

test("late account reads cannot overwrite a new explicit selection", async ({ context, page }) => {
  const state = await accountApi(context, "tcgplayer");
  await page.goto("/"); await collection(page);
  const held = deferred(); state.holdSession = held;
  await page.evaluate(() => dispatchEvent(new Event("focus")));
  await expect.poll(() => state.sessionHeld).toBe(true);
  await choice(page, "cardkingdom");
  held.resolve();
  await page.waitForTimeout(100);
  await expect(page.getByRole("combobox", { name: "Price source", exact: true })).toHaveValue("cardkingdom");
  expect(state.sources.get(state.owner)).toBe("cardkingdom");
});

test("a pending save survives leaving Collection and the next screen waits for it", async ({ context, page }) => {
  const state = await accountApi(context, "tcgplayer");
  await page.goto("/"); await collection(page);
  const held = deferred(); state.holdWrite = held;
  const select = page.getByRole("combobox", { name: "Price source", exact: true });
  await select.selectOption("manapool");
  await expect(select).toBeDisabled();
  await expect.poll(() => state.writes.length).toBe(1);
  await navigate(page, "Upload photo"); await navigate(page, "Collection");
  await expect(select).toBeDisabled();
  held.resolve();
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue("manapool");
  expect(state.sources.get(state.owner)).toBe("manapool");
});

test("other tabs follow saved account changes and a different account stays separate", async ({ context, page }) => {
  const state = await accountApi(context, "tcgplayer");
  await page.goto("/"); await collection(page);
  const other = await context.newPage(); await other.goto("/"); await collection(other);
  await choice(page, "manapool");
  await other.bringToFront();
  await expect(other.getByRole("combobox", { name: "Price source", exact: true })).toHaveValue("manapool");
  state.owner = "pricing-account-b";
  await other.reload(); await collection(other);
  await expect(other.getByRole("combobox", { name: "Price source", exact: true })).toHaveValue("cardkingdom");
  expect(state.sources.get("pricing-account-a")).toBe("manapool");
  expect(state.sources.get("pricing-account-b")).toBe("cardkingdom");
  await other.close();
});

test("both price sort directions are always available and use the selected source without overflow", async ({ context, page }, info) => {
  const state = await accountApi(context, "tcgplayer");
  await page.goto("/"); await collection(page);
  await expect(page.getByRole("button", { name: /^Filters/ })).toHaveAttribute("aria-expanded", "false");
  const sort = page.getByRole("combobox", { name: "Sort by", exact: true });
  await expect(sort).toBeVisible();
  await expect(sort.locator('option[value="price_asc"]')).toHaveText("Price: Low to high");
  await expect(sort.locator('option[value="price_desc"]')).toHaveText("Price: High to low");
  await sort.selectOption("price_asc");
  await expect(page.locator(".gallery-card-title strong")).toHaveText(["Alpha", "Beta", "No quote"]);
  await expect.poll(() => state.queries.at(-1)).toEqual({ provider: "tcgplayer", sort: "price_asc" });
  await sort.selectOption("price_desc");
  await expect(page.locator(".gallery-card-title strong")).toHaveText(["Beta", "Alpha", "No quote"]);
  await choice(page, "cardkingdom");
  await expect(page.locator(".gallery-card-title strong")).toHaveText(["Alpha", "Beta", "No quote"]);
  await expect(page.locator(".gallery-card-price").first()).toContainText("$10.00");
  await sort.selectOption("price_asc");
  await expect(page.locator(".gallery-card-title strong")).toHaveText(["Beta", "Alpha", "No quote"]);
  await expect(page.locator(".gallery-card-price").first()).toContainText("$2.00");
  await page.screenshot({ path: `../../artifacts/price-preferences/collection-390-${info.project.name}.png`, fullPage: true });
  await page.setViewportSize({ width: 320, height: 780 });
  await expect(sort).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await sort.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: `../../artifacts/price-preferences/collection-320-${info.project.name}.png`, fullPage: true });
});


test("browser history closes card details and keeps collection searches, sorting and scroll", async ({ context, page }) => {
  const state = await accountApi(context, "tcgplayer");
  await page.route("**/api/v1/collection/printings/*", (route) => route.fulfill({ json: { faces: [], legalities: {}, released_at: null, scryfall_url: null, prices: [] } }));
  await page.goto("/"); await collection(page);
  const search = page.getByRole("searchbox", { name: "Find a card", exact: true });
  await search.fill("Alpha");
  await page.getByRole("combobox", { name: "Sort by", exact: true }).selectOption("price_asc");
  await expect(page.locator(".gallery-grid")).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "Open Alpha · TST #1", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Alpha", exact: true })).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(page.getByRole("dialog", { name: "Alpha", exact: true })).toHaveCount(0);
  await expect(search).toHaveValue("Alpha");
  await page.evaluate(() => history.forward());
  await expect(page.getByRole("dialog", { name: "Alpha", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close card details", exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const url = new URL(location.hash.slice(1), location.origin);
    const filters = new URLSearchParams(url.searchParams.get("filters") || "");
    return { path: url.pathname, card: url.searchParams.get("card"), query: filters.get("q"), sort: filters.get("sort") };
  })).toEqual({ path: "/collection", card: null, query: "Alpha", sort: "price_asc" });
  await navigate(page, "Batches");
  await page.evaluate(() => history.back());
  await expect(search).toHaveValue("Alpha");
  await expect(page.getByRole("combobox", { name: "Sort by", exact: true })).toHaveValue("price_asc");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.evaluate(() => scrollTo(0, 200));
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(200);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.evaluate(() => history.forward());
  await expect(page.getByRole("heading", { name: "Saved batches", exact: true })).toBeVisible();
  await page.evaluate(() => history.back());
  await expect.poll(() => page.evaluate(() => Math.abs(scrollY - 200))).toBeLessThan(3);
  expect(state.unexpected).toEqual([]);
});
