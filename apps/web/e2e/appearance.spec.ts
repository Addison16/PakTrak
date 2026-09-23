import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { navigate, openNavigation } from "./navigation";

const printing = { id: "theme-card", name: "Appearance fixture", set_code: "tst", collector_number: "1", set_name: "Theme fixtures", language: "en", finishes: ["nonfoil", "foil"], rarity: "rare", type_line: "Creature", image_url: "/brand/paktrak-mark.svg" };
const card = { printing, quantity: 2, location_count: 1, locations: [{ id: "red", name: "Red binder", kind: "binder", quantity: 2 }], value: "4.00", price_min: "2.00", price_max: "2.00", priced_copies: 2 };
const deck = { id: "theme-deck", name: "Evening deck", format: "casual", notes: "", match_mode: "any", version: 1, copies: 4, owned_copies: 2, missing_copies: 2, cards: [{ ...card, section: "main", quantity: 4, owned: 2, available: 2, missing: 2 }], missing_cards: [{ printing, quantity: 2 }] };

async function fixture(context: BrowserContext, signedIn = true) {
  const unexpected: string[] = [];
  await context.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: any = {}, status = 200;
    if (route.request().method() !== "GET") { unexpected.push(path); status = 500; }
    else if (path === "/api/auth/session") { status = signedIn ? 200 : 401; json = signedIn ? { owner_id: "theme-fixture", display_name: "Theme collector", role: "admin", csrf_token: "fixture", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null } : { detail: "Signed out" }; }
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/collection/cards") json = { copies: 2, cards: 1, items: [card], next_offset: null, valuation: { provider: "tcgplayer", amount: "4.00", priced_copies: 2, unpriced_copies: 0, feed: null } };
    else if (path === "/api/v1/collection/printings/theme-card") json = { printing, faces: [{ name: printing.name, image_url: printing.image_url, oracle_text: "Synthetic theme fixture.", flavor_text: "Keep every card in reach.", power: "2", toughness: "2" }], legalities: { commander: "legal" }, released_at: null, scryfall_url: null, prices: [{ provider: "tcgplayer", name: "TCGplayer", kind: "Reference value", feed: null, finishes: [{ finish: "nonfoil", amount: "2.00", available: true, url: null }] }] };
    else if (path === "/api/v1/collection/filters") json = { sets: [] };
    else if (path === "/api/v1/data/status") json = { feeds: [] };
    else if (path === "/api/v1/catalog/status") json = { printings: 1 };
    else if (path === "/api/auth/settings") json = { guest_signup_enabled: true, version: 1 };
    else if (path === "/api/v1/decks") json = { items: [deck], next_offset: null };
    else if (path === "/api/v1/decks/theme-deck") json = deck;
    else if (["/api/v1/scans", "/api/v1/binders", "/api/v1/imports", "/api/v1/exports", "/api/auth/accounts"].includes(path)) json = { items: [], next_offset: null };
    else { unexpected.push(path); status = 500; json = { detail: "Unexpected fixture endpoint " + path }; }
    await route.fulfill({ status, json });
  });
  return unexpected;
}

async function readable(locator: Locator) {
  const contrast = await locator.first().evaluate((element) => {
    const rgb = (value: string) => (value.match(/[\d.]+/g) || []).map(Number);
    const luminance = (values: number[]) => values.slice(0, 3).map((value) => { const n = value / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4; }).reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
    let background = element;
    while (background.parentElement && rgb(getComputedStyle(background).backgroundColor)[3] === 0) background = background.parentElement;
    const a = luminance(rgb(getComputedStyle(element).color)), b = luminance(rgb(getComputedStyle(background).backgroundColor));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
}
async function theme(page: Page, value: string) { await expect(page.locator("html")).toHaveAttribute("data-theme", value); }

test("Auto follows device changes; manual choices survive reload and override the device", async ({ page, context }) => {
  const unexpected = await fixture(context);
  await page.emulateMedia({ colorScheme: "light" }); await page.goto("/"); await theme(page, "light");
  await openNavigation(page);
  await expect(page.getByRole("button", { name: "Auto", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.emulateMedia({ colorScheme: "dark" }); await theme(page, "dark");
  await expect(page.getByText("Follows this device · Dark right now", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Light", exact: true }).click(); await theme(page, "light");
  await page.emulateMedia({ colorScheme: "light" }); await page.emulateMedia({ colorScheme: "dark" }); await theme(page, "light");
  await page.reload(); await theme(page, "light"); await openNavigation(page);
  await expect(page.getByRole("button", { name: "Light", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.emulateMedia({ colorScheme: "light" }); await theme(page, "dark");
  await page.reload(); await theme(page, "dark"); await openNavigation(page);
  await page.getByRole("button", { name: "Auto", exact: true }).click(); await theme(page, "light");
  await page.emulateMedia({ colorScheme: "dark" }); await theme(page, "dark");
  expect(unexpected).toEqual([]);
});

test("appearance stays in sync between tabs and clearing it restores Auto", async ({ page, context }) => {
  await fixture(context); await page.emulateMedia({ colorScheme: "light" }); await page.goto("/");
  const other = await context.newPage(); await other.emulateMedia({ colorScheme: "light" }); await other.goto("/");
  await openNavigation(page); await page.getByRole("button", { name: "Dark", exact: true }).click();
  await theme(other, "dark");
  await other.evaluate(() => localStorage.removeItem("paktrak-appearance"));
  await theme(page, "light");
  await expect(page.getByRole("button", { name: "Auto", exact: true })).toHaveAttribute("aria-pressed", "true");
  await other.close();
});

test("unavailable storage still allows immediate appearance changes", async ({ context, page }) => {
  await fixture(context, false);
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await context.addInitScript(() => { for (const name of ["getItem", "setItem"]) Object.defineProperty(Storage.prototype, name, { value: () => { throw new DOMException("Storage unavailable", "SecurityError"); } }); });
  await page.emulateMedia({ colorScheme: "dark" }); await page.goto("/"); await theme(page, "dark");
  await page.getByRole("button", { name: "Light", exact: true }).click(); await theme(page, "light");
  await page.getByRole("button", { name: "Auto", exact: true }).click(); await theme(page, "dark");
  expect(errors).toEqual([]);
});

test("stored appearance is applied before the application bundle loads", async ({ context, page }) => {
  await context.addInitScript(() => localStorage.setItem("paktrak-appearance", "dark"));
  await context.route("**/assets/*.js", (route) => route.abort());
  await page.emulateMedia({ colorScheme: "light" }); await page.goto("/");
  await theme(page, "dark");
  expect(await page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(15, 27, 25)");
  expect(await page.locator("#root").innerHTML()).toBe("");
});

for (const mode of ["light", "dark"] as const) for (const width of [320, 390, 1280]) {
  test(`${mode} palette is readable across collection, details and decks at ${width}px`, async ({ context, page }) => {
    const unexpected = await fixture(context);
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ colorScheme: mode });
    await page.goto("/"); await expect(page.getByRole("button", { name: "Take photo", exact: true })).toBeVisible();
    await readable(page.locator(".capture h2")); await readable(page.locator(".capture > p")); await readable(page.locator(".capture .primary"));
    await openNavigation(page); await readable(page.locator(".appearance-option[aria-pressed=true]"));
    await page.getByRole("button", { name: mode === "dark" ? "Dark" : "Light", exact: true }).click();
    await page.screenshot({ path: `../../artifacts/appearance/menu-${mode}-${width}-${test.info().project.name}.png` });
    await page.getByRole("button", { name: "Close menu", exact: true }).click();
    await navigate(page, "Collection"); await expect(page.locator(".gallery-card")).toHaveCount(1);
    await page.getByRole("button", { name: /^Filters/ }).click();
    await readable(page.locator(".gallery-card-title > strong")); await readable(page.locator(".gallery-card-set")); await readable(page.locator(".gallery-card .quantity-badge"));
    expect(await page.getByRole("combobox", { name: "Price source", exact: true }).evaluate((element) => getComputedStyle(element).colorScheme)).toContain(mode);
    await page.screenshot({ path: `../../artifacts/appearance/collection-${mode}-${width}-${test.info().project.name}.png`, fullPage: true });
    await page.locator(".gallery-card").click(); await expect(page.getByRole("heading", { name: printing.name, exact: true })).toBeVisible();
    await readable(page.locator(".dialog-heading .eyebrow")); await readable(page.locator(".detail-copy h2")); await readable(page.locator(".flavor-text"));
    await expect(page.locator(".detail-art img")).toHaveAttribute("src", printing.image_url);
    expect(await page.locator(".detail-art img").evaluate((element) => getComputedStyle(element).filter)).toBe("none");
    await page.getByRole("dialog").screenshot({ path: `../../artifacts/appearance/card-${mode}-${width}-${test.info().project.name}.png` });
    await page.getByRole("button", { name: "Close card details", exact: true }).click();
    await navigate(page, "Decks"); await page.getByRole("button", { name: /Evening deck/ }).click();
    await page.locator(".deck-shopping > summary").click();
    await expect(page.getByRole("textbox", { name: "Missing cards to copy", exact: true })).toHaveValue("2 Appearance fixture");
    await readable(page.locator(".deck-buy-list h3")); await readable(page.locator(".deck-buy-list .fine").first()); await readable(page.locator(".deck-cards .row-error"));
    await page.getByRole("region", { name: "Missing cards buy list", exact: true }).screenshot({ path: `../../artifacts/appearance/deck-${mode}-${width}-${test.info().project.name}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]); expect(unexpected).toEqual([]);
  });
}

for (const mode of ["light", "dark"] as const) test(`${mode} choice carries into sign-in and registration`, async ({ page }) => {
  test.skip(process.env.SCANNER_E2E_IDENTITY !== "1", "Requires the running identity service; no account is created.");
  const opposite = mode === "dark" ? "light" : "dark";
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: opposite });
  await page.goto("/");
  await page.getByRole("button", { name: mode === "dark" ? "Dark" : "Light", exact: true }).click();
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await expect(page.locator("#username")).toBeVisible({ timeout: 30000 }); await theme(page, mode);
  await readable(page.locator("#kc-page-title")); await readable(page.locator("#username")); await readable(page.locator("#kc-login"));
  await readable(page.locator(".appearance-note")); await readable(page.locator(".paktrak-footer"));
  await page.screenshot({ path: `../../artifacts/appearance/login-${mode}-${test.info().project.name}.png`, fullPage: true });
  await page.locator("#kc-registration a").click();
  await expect(page.locator("#password-confirm")).toBeVisible(); await theme(page, mode);
  await page.screenshot({ path: `../../artifacts/appearance/register-${mode}-${test.info().project.name}.png`, fullPage: true });
  await page.getByRole("button", { name: "Auto", exact: true }).click(); await theme(page, opposite);
  await page.emulateMedia({ colorScheme: mode }); await theme(page, mode);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
