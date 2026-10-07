import { expect, test, type Page } from "@playwright/test";
import { navigate } from "./navigation";

const dragon = { id: "offline-dragon", name: "Shivan Dragon", set_code: "off", collector_number: "1", set_name: "Offline fixtures", language: "en", rarity: "rare", type_line: "Creature — Dragon", finishes: ["nonfoil", "foil"], image_url: "/brand/paktrak-mark.svg" };

// A server that can be switched off. While "down" every API request fails the
// way an unreachable home server does from mobile data.
async function fixture(page: Page, options: { reject?: boolean } = {}) {
  const state = { down: false, lot: { id: "lot-1", printing: dragon, quantity: 3, finish: "foil", condition: "NM", binder: "Red binder", binder_id: "red", binder_kind: "binder", notes: "", version: 1 },
    edits: [] as { path: string; body: any; csrf: string; key: string }[] };
  const card = () => ({ printing: dragon, quantity: state.lot.quantity, location_count: 1, locations: [{ id: "red", name: "Red binder", quantity: state.lot.quantity }], value: "9.00", price_min: "3.00", price_max: "3.00", priced_copies: state.lot.quantity });
  await page.route("**/api/**", async (route) => {
    if (state.down) { await route.abort("addressunreachable"); return; }
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    let json: any = {}, status = 200;
    if (path === "/api/health/live") json = { status: "ok" };
    else if (path === "/api/auth/session") json = { owner_id: "offline-owner", display_name: "Collector", role: "member", csrf_token: "csrf-" + state.edits.length, tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/collection/cards") json = { copies: state.lot.quantity, cards: 1, items: [card()], next_offset: null, valuation: { provider: "tcgplayer", amount: "9.00", priced_copies: 3, unpriced_copies: 0, feed: null } };
    else if (path === "/api/v1/collection/cards/" + dragon.id) json = card();
    else if (path === "/api/v1/collection/printings/" + dragon.id) json = { printing: dragon, faces: [{ name: dragon.name, image_url: dragon.image_url }], legalities: {}, prices: [], released_at: null, scryfall_url: null };
    else if (path === "/api/v1/collection") json = { copies: state.lot.quantity, items: [state.lot], next_offset: null };
    else if (path === "/api/v1/collection/lot-1/quantity") {
      const body = req.postDataJSON();
      state.edits.push({ path, body, csrf: req.headers()["x-csrf-token"], key: req.headers()["idempotency-key"] });
      if (options.reject) { status = 409; json = { detail: "These copies changed on another device. Reload and try again." }; }
      else if (body.expected_version !== state.lot.version) { status = 409; json = { detail: "Version conflict" }; }
      else { state.lot = { ...state.lot, quantity: body.quantity, version: state.lot.version + 1 }; json = { id: "lot-1", quantity: state.lot.quantity, version: state.lot.version }; }
    }
    else if (path === "/api/v1/collection/filters") json = { sets: [{ code: "off", name: "Offline fixtures" }] };
    else if (path === "/api/v1/binders") json = { items: [{ id: "red", name: "Red binder", kind: "binder", copies: 3, version: 1, notes: "" }] };
    else if (path === "/api/v1/data/status") json = { feeds: [] };
    else if (["/api/v1/decks", "/api/v1/scans", "/api/v1/imports", "/api/v1/exports"].includes(path)) json = { items: [], next_offset: null };
    else { status = 404; json = { detail: "Not in fixture: " + path }; }
    await route.fulfill({ status, json });
  });
  return state;
}

async function openCopies(page: Page) {
  await page.getByRole("button", { name: /^Open Shivan Dragon/ }).click();
  const dialog = page.getByRole("dialog", { name: "Shivan Dragon" });
  await dialog.getByText("Manage copies").click();
  await expect(dialog.locator(".copy-groups .badge")).toHaveText("3 copies");
  return dialog;
}
const status = (page: Page) => page.locator(".connection-status");

test("edits made offline are queued, listed and sent in order when the server is back", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/#/collection");
  const dialog = await openCopies(page);
  await expect(status(page)).toHaveCount(0);

  state.down = true;
  page.on("dialog", (prompt) => void prompt.accept());
  await dialog.getByRole("button", { name: "Remove 1 copy" }).click();
  await expect(dialog.getByText(/Saved on this device/)).toBeVisible();
  await expect(dialog.locator(".copy-groups .badge")).toHaveText("2 copies");
  await expect(status(page)).toHaveText("Offline · 1");
  // A second edit made against the same version is sent with the version the first one produces.
  await dialog.getByRole("button", { name: "Remove 1 copy" }).click();
  await expect(dialog.locator(".copy-groups .badge")).toHaveText("1 copy");
  await expect(status(page)).toHaveText("Offline · 2");
  expect(state.edits).toHaveLength(0);

  await dialog.getByRole("button", { name: "Close card details" }).click();
  await status(page).click();
  await expect(page.getByRole("heading", { name: "Queued actions" })).toBeVisible();
  const list = page.getByRole("list", { name: "Queued changes" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.getByRole("listitem").first()).toContainText("Remove 1 copy of Shivan Dragon");
  await expect(list.getByRole("listitem").first()).toContainText("Red binder · 2 copies stay");
  await expect(list.getByRole("listitem").first()).toContainText("Waiting");
  await expect(page.locator(".queue-connection")).toContainText("Offline");

  state.down = false;
  await page.getByRole("button", { name: "Check connection" }).click();
  await expect(page.getByText("Nothing is waiting.")).toBeVisible();
  await expect(status(page)).toHaveCount(0);
  expect(state.edits.map((edit) => edit.body)).toEqual([{ quantity: 2, expected_version: 1 }, { quantity: 1, expected_version: 2 }]);
  // A fresh CSRF token is used, and each edit keeps its own Idempotency-Key.
  expect(state.edits.every((edit) => edit.csrf.startsWith("csrf-"))).toBeTruthy();
  expect(new Set(state.edits.map((edit) => edit.key)).size).toBe(2);
  expect(state.lot.quantity).toBe(1);
});

test("the collection opens from saved copies when the server can't be reached", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/#/collection");
  await openCopies(page);
  state.down = true;
  await page.reload();
  await expect(status(page)).toHaveText("Offline");
  // The open card comes back from its saved copy too.
  const dialog = page.getByRole("dialog", { name: "Shivan Dragon" });
  await dialog.getByText("Manage copies").click();
  await expect(dialog.locator(".copy-groups .badge")).toHaveText("3 copies");
  await expect(dialog.locator(".copy-groups")).toContainText("Red binder");
  await dialog.getByRole("button", { name: "Close card details" }).click();
  await expect(page.getByRole("button", { name: /^Open Shivan Dragon/ })).toBeVisible();
  // Something never opened while connected says so instead of failing silently.
  await navigate(page, "Queued actions");
  await expect(page.locator(".queue-connection")).toContainText("you’re seeing copies saved on this device");
});

test("an edit the server turns down stays in the list with the reason until removed", async ({ page }) => {
  const state = await fixture(page, { reject: true });
  await page.goto("/#/collection");
  const dialog = await openCopies(page);
  state.down = true;
  page.on("dialog", (prompt) => void prompt.accept());
  await dialog.getByRole("button", { name: "Remove 1 copy" }).click();
  await expect(status(page)).toHaveText("Offline · 1");
  await dialog.getByRole("button", { name: "Close card details" }).click();
  await navigate(page, "Queued actions");
  state.down = false;
  await page.getByRole("button", { name: "Check connection" }).click();
  const item = page.getByRole("list", { name: "Queued changes" }).getByRole("listitem");
  await expect(item).toContainText("Not sent");
  await expect(item).toContainText("These copies changed on another device.");
  await expect(status(page)).toHaveText("1 not sent");
  await page.getByRole("button", { name: "Remove from queue: Remove 1 copy of Shivan Dragon" }).click();
  await expect(page.getByText("Nothing is waiting.")).toBeVisible();
  await expect(status(page)).toHaveCount(0);
  expect(state.edits).toHaveLength(1);
});

test("saving for offline lets any card's copies open later without a connection", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/#/queue");
  await page.getByRole("button", { name: "Save collection for offline" }).click();
  await expect(page.getByText(/^Saved 1 card and 0 decks/)).toBeVisible();
  state.down = true;
  await navigate(page, "Collection");
  // Manage copies was never opened while connected; the saved list of every copy fills in.
  await openCopies(page);
  await expect(status(page)).toHaveText("Offline");
});

test.describe("installed app", () => {
  test.use({ serviceWorkers: "allow" });
  test("opens with no connection at all once it has been loaded over HTTPS or localhost", async ({ page, context }) => {
    const state = await fixture(page);
    await page.goto("/#/collection");
    await expect(page.getByRole("button", { name: /^Open Shivan Dragon/ })).toBeVisible();
    const controlled = await page.evaluate(() => Promise.race([
      navigator.serviceWorker?.ready.then(async () => { for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i++) await new Promise((resolve) => setTimeout(resolve, 100)); return !!navigator.serviceWorker.controller; }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]));
    test.skip(!controlled, "The service worker only runs in production builds.");
    state.down = true;
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("button", { name: /^Open Shivan Dragon/ })).toBeVisible();
    await expect(status(page)).toHaveText("Offline");
    await context.setOffline(false);
  });
});
