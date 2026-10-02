import { expect, test, type Page } from "@playwright/test";

const owner = "case-fixture";
const storageKey = "paktrak:deck-presentation:v1:case-fixture:case-deck";
const printings = ["Twilight Captain", "Island", "Forest Guardian"].map((name, index) => ({ id: `case-card-${index}`, name, set_code: "tst", collector_number: String(index + 1), language: "en", finishes: ["nonfoil", "foil"], image_url: `/api/v1/card-images/case-card-${index}/0/grid` }));

async function fixture(page: Page) {
  const writes: string[] = [];
  const deck: any = { id: "case-deck", name: "Twilight expedition", format: "commander", match_mode: "exact", notes: "A favorite deck.", version: 1, colors: ["U"], colors_known: true, cards: printings.map((printing, index) => ({ printing, quantity: index ? 4 : 1, section: index ? "main" : "commander", owned: 0, needed_in_deck: index ? 4 : 1, available: 0, missing: index ? 4 : 1, locations: [] })) };
  const detail = () => {
    const previews = deck.cards.map((card: any) => ({ ...card.printing, section: card.section, art_url: `/api/v1/card-images/${card.printing.id}/0/art` }));
    return { ...deck, copies: deck.cards.reduce((sum: number, card: any) => sum + card.quantity, 0), owned_copies: 0, missing_copies: 9, missing_cards: [], preview_cards: previews, cover_cards: previews.filter((card: any) => card.section === "commander") };
  };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") writes.push(path);
    if (path.startsWith("/api/v1/card-images/")) return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="336"><rect width="240" height="336" fill="#183943"/><circle cx="120" cy="150" r="85" fill="#afbf9b"/></svg>' });
    let json: any = {};
    if (path === "/api/auth/session") json = { owner_id: owner, display_name: "Case collector", csrf_token: "case-csrf", role: "member", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/scans") json = { items: [], next_offset: null };
    else if (path === "/api/v1/decks") json = { items: [detail()], next_offset: null };
    else if (path === "/api/v1/decks/case-deck") json = detail();
    else return route.fulfill({ status: 404, json: { detail: "Unexpected case fixture request" } });
    await route.fulfill({ json });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#/decks/case-deck");
  await expect(page.getByRole("heading", { name: deck.name, exact: true })).toBeVisible();
  return { deck, writes };
}

async function customize(page: Page) {
  await page.getByRole("button", { name: "Customize case", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Customize your case", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("case customization saves artwork, finish and emblem without changing the deck, and cancel and reset work", async ({ page }) => {
  const mock = await fixture(page);
  const original = JSON.stringify(mock.deck.cards);
  let dialog = await customize(page);
  await dialog.getByRole("radio", { name: "Amethyst", exact: true }).check();
  await dialog.getByRole("radio", { name: "Crescent", exact: true }).check();
  await dialog.getByRole("radio", { name: "Forest Guardian", exact: true }).check();
  await dialog.getByRole("button", { name: "Save case", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Customize case", exact: true })).toBeFocused();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), storageKey)).toMatchObject({ finish: "amethyst", emblem: "crescent", featuredCard: { id: "case-card-2" } });
  await expect(page.locator(".deck-hero img").first()).toHaveAttribute("src", "/api/v1/card-images/case-card-2/0/art");
  await page.getByRole("button", { name: "Close deck", exact: true }).click();
  const box = page.locator('.deck-box-button[data-deck-id="case-deck"]');
  await expect(box.locator("img")).toHaveAttribute("src", "/api/v1/card-images/case-card-2/0/art");
  expect(await box.locator(".deck-box").evaluate(element => getComputedStyle(element).getPropertyValue("--deck-paint").trim())).toBe("#392847");
  await page.reload();
  await expect(box.locator("img")).toHaveAttribute("src", "/api/v1/card-images/case-card-2/0/art");
  await box.click();
  dialog = await customize(page);
  await expect(dialog.getByRole("radio", { name: "Amethyst", exact: true })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Crescent", exact: true })).toBeChecked();
  await dialog.getByRole("radio", { name: "Champagne", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).finish, storageKey)).toBe("amethyst");
  dialog = await customize(page);
  await dialog.getByRole("button", { name: "Restore original case", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
  await expect(page.locator(".deck-hero img").first()).toHaveAttribute("src", "/api/v1/card-images/case-card-0/0/art");
  expect(JSON.stringify(mock.deck.cards)).toBe(original);
  expect(mock.writes).toEqual([]);
});

test("case settings update across browser tabs and remain scoped to the signed-in account", async ({ page, context }) => {
  await fixture(page);
  await page.getByRole("button", { name: "Close deck", exact: true }).click();
  const box = page.locator('.deck-box-button[data-deck-id="case-deck"] .deck-box');
  const tab = await context.newPage();
  await tab.route("**/__case-settings-tab", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Case settings test</title>" }));
  await tab.goto(new URL("/__case-settings-tab", page.url()).href);
  await tab.evaluate(({ key }) => localStorage.setItem(key, JSON.stringify({ finish: "oxblood", emblem: "leaf", featuredCard: null })), { key: storageKey });
  await expect.poll(() => box.evaluate(element => getComputedStyle(element).getPropertyValue("--deck-paint").trim())).toBe("#41242a");
  await tab.evaluate(() => localStorage.setItem("paktrak:deck-presentation:v1:another-owner:case-deck", JSON.stringify({ finish: "champagne", emblem: "spark", featuredCard: null })));
  expect(await box.evaluate(element => getComputedStyle(element).getPropertyValue("--deck-paint").trim())).toBe("#41242a");
  await tab.evaluate(key => localStorage.removeItem(key), storageKey);
  await expect.poll(() => box.evaluate(element => getComputedStyle(element).getPropertyValue("--deck-paint").trim())).toBe("#1c2d3c");
  await tab.close();
});

test("removed featured cards fall back to commander artwork while preserving case finish", async ({ page }) => {
  const mock = await fixture(page);
  const dialog = await customize(page);
  await dialog.getByRole("radio", { name: "Forest", exact: true }).check();
  await dialog.getByRole("radio", { name: "Forest Guardian", exact: true }).check();
  await dialog.getByRole("button", { name: "Save case", exact: true }).click();
  mock.deck.cards = mock.deck.cards.filter((card: any) => card.printing.id !== "case-card-2");
  await page.reload();
  await expect(page.locator(".deck-hero img").first()).toHaveAttribute("src", "/api/v1/card-images/case-card-0/0/art");
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)!), storageKey)).toMatchObject({ finish: "forest", featuredCard: null });
  const current = await customize(page);
  await expect(current.getByRole("radio", { name: "Forest", exact: true })).toBeChecked();
  await expect(current.getByRole("radio", { name: /Automatic Commander artwork/ })).toBeChecked();
});

test("invalid stored case choices fall back safely and a blocked save keeps the picker open", async ({ page }) => {
  await page.addInitScript(key => { localStorage.setItem(key, '{"finish":"broken","emblem":"broken","featuredCard":17}'); }, storageKey);
  await fixture(page);
  const dialog = await customize(page);
  await expect(dialog.locator('input[name="case-finish"]:checked')).toHaveCount(0);
  await expect(dialog.getByText("Original finish", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Crown", exact: true })).toBeChecked();
  await page.evaluate(key => {
    const save = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) { if (name === key) throw new DOMException("Fixture blocked storage", "QuotaExceededError"); return save.call(this, name, value); };
  }, storageKey);
  await dialog.getByRole("radio", { name: "Midnight", exact: true }).check();
  await dialog.getByRole("button", { name: "Save case", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("could not save this case");
  await expect(dialog.getByRole("radio", { name: "Midnight", exact: true })).toBeChecked();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Customize case", exact: true })).toBeFocused();
});

for (const theme of ["light", "dark"] as const) test(`${theme} case picker fits a narrow phone and restores keyboard focus`, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.emulateMedia({ colorScheme: theme });
  await fixture(page);
  const trigger = page.getByRole("button", { name: "Customize case", exact: true });
  await trigger.focus(); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Customize your case", exact: true });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
