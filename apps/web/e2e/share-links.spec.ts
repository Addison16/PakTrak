import { expect, test, type Page } from "@playwright/test";
import { navigate } from "./navigation";
import { noPriceAlerts } from "./price-alert-fixture";

const token = "fixtureTokenFixtureTokenFixtureTokenFixture";
const printing = (id: string, name: string) => ({ id, name, set_code: "tst", set_name: "Fixture set", collector_number: id.slice(-1), rarity: "rare", language: "en", finishes: ["nonfoil", "foil"], image_url: `/api/public/shares/${token}/images/${id}` });

for (const width of [320, 390, 1280]) test(`a shared deck opens without signing in at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const asked: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    asked.push(path);
    if (path === `/api/public/shares/${token}`) return route.fulfill({ json: { kind: "deck", name: "Friday night with a rather long deck name", format: "commander", copies: 7, cards: [
      { printing: printing("share-1", "Fixture Captain"), quantity: 1, section: "commander" },
      { printing: printing("share-2", "Fixture Island"), quantity: 4, section: "main" },
      { printing: printing("share-3", "Fixture Shield"), quantity: 2, section: "sideboard" },
    ] } });
    if (path.startsWith(`/api/public/shares/${token}/images/`)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 401, json: { detail: "Sign in" } });
  });
  await page.goto(`/#/shared/${token}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Friday night with a rather long deck name");
  await expect(page.getByText("7 cards · Commander")).toBeVisible();
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(["Commander 1", "Mainboard 4", "Sideboard 2"]);
  await expect(page.locator(".shared-cards li")).toHaveCount(3);
  // The visitor's page never asks for an account or any signed-in data.
  expect(asked.filter((path) => !path.startsWith("/api/public/shares/"))).toEqual([]);
  await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("a link that was turned off says so plainly", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ status: 404, json: { detail: "This link isn’t active." } }));
  await page.goto(`/#/shared/${token}`);
  await expect(page.getByRole("alert")).toHaveText("This link isn’t active. Ask the person who sent it for a new one.");
});

async function wishlist(page: Page) {
  const state = { links: [] as { id: string; kind: string; deck_id: null; token: string }[], posts: [] as unknown[], deleted: [] as string[] };
  await page.route("**/api/**", async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path === "/api/v1/price-alerts") return route.fulfill({ json: noPriceAlerts });
    let json: unknown = {};
    if (path === "/api/auth/session") json = { owner_id: "share-owner", display_name: "Collector", role: "member", csrf_token: "share-csrf", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/wishlist") json = { provider: "tcgplayer", items: [], copies: 0, priced_copies: 0, amount: null };
    else if (path === "/api/v1/shares" && req.method() === "POST") { expect(req.headers()["x-csrf-token"]).toBe("share-csrf"); state.posts.push(req.postDataJSON()); state.links = [{ id: "link-1", kind: "wishlist", deck_id: null, token }]; json = state.links[0]; }
    else if (path === "/api/v1/shares") json = { items: state.links };
    else if (path === "/api/v1/shares/link-1") { state.deleted.push(req.method()); state.links = []; json = { removed: true }; }
    else if (path === "/api/v1/data/status") json = { feeds: [] };
    else if (["/api/v1/scans", "/api/v1/decks", "/api/v1/imports", "/api/v1/exports", "/api/v1/binders", "/api/v1/trade-offers", "/api/v1/friends"].includes(path)) json = { items: [], next_offset: null };
    else { await route.fulfill({ status: 404, json: { detail: "Not in fixture: " + path } }); return; }
    await route.fulfill({ json });
  });
  await page.goto("/");
  await navigate(page, "Wishlist");
  return state;
}

test("the wishlist link is made on request, copied, and turned off", async ({ page }) => {
  const state = await wishlist(page);
  await page.getByText("Share your wishlist").click();
  await expect(page.getByText(/Nothing is shared until you create one/)).toBeVisible();
  await page.getByRole("button", { name: "Create share link" }).click();
  await expect(page.getByLabel("Share link")).toHaveValue(new RegExp(`/#/shared/${token}$`));
  expect(state.posts).toEqual([{ kind: "wishlist" }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Turn off link" }).click();
  await expect(page.getByText("The link is off.")).toBeVisible();
  expect(state.deleted).toEqual(["DELETE"]);
  await expect(page.getByRole("button", { name: "Create share link" })).toBeVisible();
});

test("Back and Forward switch between the app and a pasted shared link", async ({ page }) => {
  await wishlist(page);
  await page.route(`**/api/public/shares/${token}`, (route) => route.fulfill({ json: { kind: "wishlist", name: "Wishlist", format: null, copies: 0, cards: [] } }));
  await page.evaluate((token) => { location.hash = `#/shared/${token}`; }, token);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Wishlist");
  await expect(page.getByRole("button", { name: "Menu" })).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole("button", { name: "Menu" })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("button", { name: "Menu" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Wishlist");
});
