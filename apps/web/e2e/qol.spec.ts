import { expect, test, type Page } from "@playwright/test";
import { navigate } from "./navigation";
import { noPriceAlerts } from "./price-alert-fixture";
const printing = { id: "qol-card", name: "Island", set_code: "tst", collector_number: "2", set_name: "Test expansion", language: "en", rarity: "common", type_line: "Basic Land — Island", finishes: ["nonfoil", "foil"], image_url: "/brand/paktrak-mark.svg" };
const card = { printing, quantity: 4, location_count: 1, locations: [{ id: "red", name: "Red binder", quantity: 4 }], value: "4.00", price_min: "1.00", price_max: "1.00", priced_copies: 4 };
const locations = [{ id: "red", name: "Red binder", kind: "binder", copies: 4, version: 1, notes: "" }, { id: "box", name: "Box 4", kind: "box", copies: 0, version: 1, notes: "" }];
const lot = { id: "qol-lot", version: 1, printing, quantity: 4, binder: "Red binder", binder_id: "red", finish: "nonfoil", condition: "near_mint", notes: "Gift copies" };
async function fixture(page: Page, emptyGallery = false) {
  const calls: { path: string; body: any }[] = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    if (path === "/api/v1/price-alerts") return route.fulfill({ json: noPriceAlerts });
    const body = req.postData() ? JSON.parse(req.postData()!) : null;
    if (req.method() !== "GET") calls.push({ path, body });
    let json: any = {};
    if (path === "/api/auth/session") json = { owner_id: "qol-owner", display_name: "Collector", role: "member", csrf_token: "test", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/collection/cards") json = { copies: emptyGallery ? 0 : 4, cards: emptyGallery ? 0 : 1, items: emptyGallery ? [] : [card], next_offset: null, valuation: { provider: "tcgplayer", amount: "4.00", priced_copies: 4, unpriced_copies: 0, feed: null } };
    else if (path === "/api/v1/collection/cards/qol-card") json = card;
    else if (path === "/api/v1/collection/printings/qol-card") json = { printing, faces: [{ name: "Island", image_url: printing.image_url }], legalities: {}, prices: [], released_at: null };
    else if (path === "/api/v1/collection") json = { items: [lot], next_offset: null };
    else if (path === "/api/v1/collection/filters") json = { sets: [{ code: "tst", name: "Test expansion" }] };
    else if (path === "/api/v1/binders") json = { items: locations };
    else if (path === "/api/v1/collection/bulk/preview") json = { token: "test-preview", copies: 4, groups_changed: 1, groups: [{ id: lot.id, name: "Island", binder: "Red binder", quantity: 4, finish: "nonfoil", condition: "near_mint" }] };
    else if (path === "/api/v1/collection/bulk/apply") json = { copies_changed: 4 };
    else if (path === "/api/v1/collection/qol-lot/move") json = {};
    else if (path === "/api/v1/data/status") json = { feeds: [] };
    else if (path === "/api/v1/catalog/status") json = { printings: 1 };
    else if (path === "/api/v1/catalog/search") json = { items: [printing], next_offset: null, filters: { sets: [{ code: "tst", name: "Test expansion" }], languages: ["en"], rarities: ["common"] } };
    else if (path === "/api/v1/decks/import-preview") json = { items: [{ line: 1, source_key: "stable-source", name: "Island", quantity: 0, section: null, printing, can_choose: true, error: "Quantity and section need attention", quantity_error: "Invalid quantity", section_error: "Invalid section", identity_error: null }] };
    else if (path === "/api/v1/decks/legality") json = { format: "casual", status: "not_checked", issues: [], counts: { main: 0, sideboard: 0, commander: 0 }, checks: [], limitations: [] };
    else if (["/api/v1/decks", "/api/v1/scans", "/api/v1/imports", "/api/v1/exports"].includes(path)) json = { items: [], next_offset: null };
    else { await route.fulfill({ status: 500, json: { detail: "Unexpected fixture endpoint " + path } }); return; }
    await route.fulfill({ json });
  });
  return calls;
}
for (const [width, mode] of [[320, "light"], [390, "dark"], [1280, "light"]] as const) {
  test(`collection views and exact bulk preview fit ${width}px ${mode}`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    const calls = await fixture(page); await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ colorScheme: mode });
    await page.goto("/#/collection"); await expect(page.locator(".gallery-card")).toHaveCount(1);
    await page.getByRole("button", { name: "Blue", exact: true }).click();
    await page.getByRole("button", { name: "List", exact: true }).click();
    await page.getByText("Saved collection views", { exact: true }).click();
    await page.getByLabel("View name", { exact: true }).fill("Blue favorites"); await page.getByRole("button", { name: "Save view", exact: true }).click();
    await page.reload(); await expect(page.getByRole("button", { name: "Blue", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".gallery-grid")).toHaveClass(/gallery-list/); await expect(page).toHaveURL(/filters=/);
    await navigate(page, "Upload photo"); await navigate(page, "Collection");
    await expect(page.getByRole("button", { name: "Blue", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".gallery-grid")).toHaveClass(/gallery-list/);
    await page.getByRole("button", { name: "Select cards", exact: true }).click(); await page.getByLabel("Select Island", { exact: true }).check();
    await page.getByRole("button", { name: "Organize selected", exact: true }).click();
    const dialog = page.getByRole("dialog"); await expect(dialog).toBeVisible();
    await dialog.getByRole("combobox", { name: "Destination", exact: true }).selectOption("box"); await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "4 copies will change", exact: true })).toBeVisible();
    await expect(dialog).toContainText("Red binder"); await page.screenshot({ path: `/tmp/paktrak-qol-artifacts/bulk-${width}-${mode}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.getByRole("button", { name: "Confirm 4 copies", exact: true }).click(); await expect(dialog).toHaveCount(0);
    expect(calls.find((call) => call.path.endsWith("bulk/apply"))?.body).toMatchObject({ printing_ids: ["qol-card"], binder_id: "box", token: "test-preview" }); expect(errors).toEqual([]);
  });
}
test("card links open outside the current collection page and partial moves send the exact quantity", async ({ page }) => {
  const calls = await fixture(page, true); await page.goto("/#/collection?card=qol-card");
  const dialog = page.getByRole("dialog"); await expect(dialog.getByRole("heading", { name: "Island", exact: true })).toBeVisible();
  await dialog.getByText("Manage copies", { exact: true }).click(); await expect(dialog.getByText("Gift copies", { exact: true })).toBeVisible();
  await dialog.getByText("Move to another location", { exact: true }).click(); await dialog.getByLabel("Copies to move", { exact: true }).fill("2");
  await dialog.getByRole("combobox", { name: "Destination", exact: true }).selectOption("box"); await dialog.getByRole("button", { name: "Move 2 copies", exact: true }).click();
  await expect.poll(() => calls.find((call) => call.path.endsWith("/move"))?.body).toMatchObject({ quantity: 2, binder_id: "box", expected_version: 1 });
  await page.getByRole("button", { name: "Close card details", exact: true }).click(); await expect(dialog).toHaveCount(0);
});
test("inline deck import repair survives repreview and reload", async ({ page }) => {
  await fixture(page); await page.goto("/#/decks/import");
  await page.getByRole("textbox", { name: "Import deck name", exact: true }).fill("Recovery deck"); await page.getByRole("textbox", { name: "Paste deck list", exact: true }).fill("0 Island");
  await page.getByRole("button", { name: "Preview deck list", exact: true }).click();
  await page.getByLabel("Quantity · line 1", { exact: true }).fill("3"); await page.getByRole("combobox", { name: "Section · line 1", exact: true }).selectOption("main");
  await expect(page.getByRole("button", { name: "Import deck", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Preview deck list", exact: true }).click();
  await expect(page.getByLabel("Quantity · line 1", { exact: true })).toHaveValue("3");
  await page.getByRole("textbox", { name: "Paste deck list", exact: true }).fill("0 Island\n");
  await page.reload(); await page.getByRole("button", { name: "Restore import draft", exact: true }).click();
  await page.getByRole("button", { name: "Preview deck list", exact: true }).click();
  await expect(page.getByLabel("Quantity · line 1", { exact: true })).toHaveValue("3"); await expect(page.getByRole("textbox", { name: "Import deck name", exact: true })).toHaveValue("Recovery deck");
});

test("fixing invalid import quantity and section makes unmatched cards selectable", async ({ page }) => {
  await fixture(page);
  await page.route("**/api/v1/decks/import-preview", (route) => route.fulfill({ json: { items: [{ line: 1, source_key: "invalid-source", name: "Island", quantity: 0, section: null, printing: null, can_choose: false, error: "Invalid quantity", quantity_error: "Invalid quantity", section_error: "Invalid section", identity_error: "Choose a printing" }] } }));
  await page.goto("/#/decks/import"); await page.getByRole("textbox", { name: "Import deck name", exact: true }).fill("Fixed deck");
  await page.getByRole("textbox", { name: "Paste deck list", exact: true }).fill("0 Island"); await page.getByRole("button", { name: "Preview deck list", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Quantity · line 1", exact: true }).fill("2"); await page.getByRole("combobox", { name: "Section · line 1", exact: true }).selectOption("main");
  await page.getByRole("button", { name: "Choose card", exact: true }).click(); await page.locator(".printing-choice").click();
  await expect(page.getByRole("button", { name: "Import deck", exact: true })).toBeEnabled();
});
