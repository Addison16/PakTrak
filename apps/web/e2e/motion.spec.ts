import { expect, test, type Page } from "@playwright/test";
import { navigate } from "./navigation";
import { noPriceAlerts } from "./price-alert-fixture";

// A standard member, not an administrator: animations belong to every account.
const session = { owner_id: "motion-fixture", display_name: "Motion collector", role: "member", csrf_token: "fixture", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
const account = { id: "motion-fixture", display_name: "Motion collector", role: "member", created_at: "2026-01-01T00:00:00Z", approved_at: "2026-01-01T00:00:00Z", scan_cards_used: 0, scan_card_limit: null, scan_card_limit_override: null, scan_cards_remaining: null, scans_paused: false, suspended: false, account_version: 1, collection_copies: 0, saved_decks: 0, saved_batches: 0, active_sessions: 1, activity: [] };

async function fixture(page: Page) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: any = { items: [], next_offset: null };
    if (path === "/api/auth/session") json = session;
    else if (path === "/api/auth/me") json = account;
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/price-alerts") json = noPriceAlerts;
    await route.fulfill({ json });
  });
}
const falling = (page: Page) => page.locator(".falling-cards");
const cardAnimation = (page: Page) => page.locator(".falling-card").first().evaluate((element) => getComputedStyle(element).animationName);

// A fresh browser, without the Follow device choice playwright.config.ts starts with.
test.use({ storageState: { cookies: [], origins: [] } });

test("animations are on by default, even on a device that asks for less motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page);
  await page.goto("/");
  await expect(page.getByText("Start with a clear photo.")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "on");
  await expect(falling(page)).toBeVisible();
  // The page-wide reduce-motion rule doesn't stop animations.
  expect(await cardAnimation(page)).toBe("falling-card-fall");
  await navigate(page, "My account");
  const animations = page.getByRole("group", { name: "Animations" });
  await expect(animations.getByRole("button", { name: "Always on" })).toHaveAttribute("aria-pressed", "true");
  await expect(animations).toContainText("even if the device asks for less motion");
});

test("Follow device hands animations back to the device and stays chosen", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page);
  await page.goto("/");
  await navigate(page, "My account");
  const animations = page.getByRole("group", { name: "Animations" });
  await animations.getByRole("button", { name: "Follow device" }).click();
  await expect(animations.getByRole("button", { name: "Follow device" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).not.toHaveAttribute("data-motion", "on");
  await expect(animations).toContainText("This device asks for less motion");
  await expect(falling(page)).toBeHidden();

  await page.reload();
  await expect(page.getByRole("group", { name: "Animations" })).toBeVisible();
  await expect(falling(page)).toBeHidden();

  // A device that doesn't ask for less motion keeps animating under Follow device.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(falling(page)).toBeVisible();
  await expect(page.getByRole("group", { name: "Animations" })).toContainText("Animations are on.");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("group", { name: "Animations" }).getByRole("button", { name: "Always on" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "on");
  await expect(falling(page)).toBeVisible();
});
