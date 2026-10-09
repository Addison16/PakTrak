import { expect, test, type Page } from "@playwright/test";
import { navigate } from "./navigation";
import { noPriceAlerts } from "./price-alert-fixture";

const session = { owner_id: "backdrop-fixture", display_name: "Backdrop collector", role: "admin", csrf_token: "fixture", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };

async function fixture(page: Page, signedIn: boolean) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: any = { items: [], next_offset: null }, status = 200;
    if (path === "/api/auth/session") { status = signedIn ? 200 : 401; json = signedIn ? session : { detail: "Signed out" }; }
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/price-alerts") json = noPriceAlerts;
    else if (path === "/api/v1/collection/cards") json = { copies: 0, cards: 0, items: [], next_offset: null, valuation: null };
    else if (path === "/api/v1/collection/filters") json = { sets: [] };
    await route.fulfill({ status, json });
  });
}

test("cards fall behind every page, stay put while moving between pages, and never take taps", async ({ page }) => {
  await fixture(page, false);
  await page.goto("/");
  await expect(page.getByText("Your next favorite is already here.")).toBeVisible();
  const cards = page.locator(".falling-cards");
  await expect(cards).toHaveCount(1);
  await expect(cards).toHaveAttribute("aria-hidden", "true");
  expect(await cards.evaluate((element) => { const style = getComputedStyle(element); return [style.position, style.pointerEvents, style.zIndex]; })).toEqual(["fixed", "none", "-1"]);

  await page.unroute("**/api/**");
  await fixture(page, true);
  await page.goto("/");
  await expect(page.getByText("Start with a clear photo.")).toBeVisible();
  await expect(cards).toHaveCount(1);
  // The same layer keeps falling across pages instead of starting over on each one.
  await cards.evaluate((element) => { element.dataset.marker = "home"; });
  await navigate(page, "Collection");
  await expect(page.locator("main.collection-view")).toBeVisible();
  await expect(cards).toHaveCount(1);
  await expect(cards).toHaveAttribute("data-marker", "home");
  await navigate(page, "Decks");
  await expect(page.locator("main.decks-view")).toBeVisible();
  await expect(cards).toHaveAttribute("data-marker", "home");
});

test("each color theme has its own backdrop", async ({ page }) => {
  await fixture(page, false);
  await page.goto("/");
  const seen = new Set<string>();
  for (const palette of ["forest", "ocean", "amethyst", "ember", "slate"]) {
    await page.evaluate((value) => { document.documentElement.dataset.palette = value; }, palette);
    seen.add(await page.evaluate(() => getComputedStyle(document.documentElement, "::before").backgroundImage + getComputedStyle(document.body, "::before").maskImage));
  }
  expect(seen.size).toBe(5);
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("cards stay still", async ({ page }) => {
    await fixture(page, false);
    await page.goto("/");
    await expect(page.getByText("Your next favorite is already here.")).toBeVisible();
    await expect(page.locator(".falling-cards")).toBeHidden();
  });
});
