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
  await expect(animations.getByRole("button", { name: "On", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(animations).toContainText("even if it asks for less motion");
});

test("Auto follows the device and stays chosen", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page);
  await page.goto("/");
  await navigate(page, "My account");
  const animations = page.getByRole("group", { name: "Animations" });
  await animations.getByRole("button", { name: "Auto", exact: true }).click();
  await expect(animations.getByRole("button", { name: "Auto", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "auto");
  await expect(animations).toContainText("Follows this device · Off right now");
  await expect(falling(page)).toBeHidden();

  await page.reload();
  await expect(page.getByRole("group", { name: "Animations" }).getByRole("button", { name: "Auto", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(falling(page)).toBeHidden();

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(falling(page)).toBeVisible();
  await expect(page.getByRole("group", { name: "Animations" })).toContainText("Follows this device · On right now");
});

test("Off stops every animation, even on a device that doesn't ask for less motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await fixture(page);
  await page.goto("/");
  await navigate(page, "My account");
  const animations = page.getByRole("group", { name: "Animations" });
  await animations.getByRole("button", { name: "Off", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
  await expect(animations).toContainText("Animations are off on this device");
  await expect(falling(page)).toBeHidden();
  // The page-wide reduce-motion rule applies under Off.
  expect(await cardAnimation(page)).toBe("none");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
  await expect(falling(page)).toBeHidden();

  await page.getByRole("group", { name: "Animations" }).getByRole("button", { name: "On", exact: true }).click();
  await expect(falling(page)).toBeVisible();
  expect(await cardAnimation(page)).toBe("falling-card-fall");
});
