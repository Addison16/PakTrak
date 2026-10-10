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

test("animations follow the device until this browser turns them on", async ({ page }) => {
  await fixture(page);
  await page.goto("/");
  await expect(page.getByText("Start with a clear photo.")).toBeVisible();
  await expect(falling(page)).toBeVisible();
  await navigate(page, "My account");
  const animations = page.getByRole("group", { name: "Animations" });
  await expect(animations.getByRole("button", { name: "Follow device" })).toHaveAttribute("aria-pressed", "true");
  await expect(animations).toContainText("Animations are on.");
});

test.describe("on a device that asks for less motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("Always on brings every animation back in this browser and stays chosen", async ({ page }) => {
    await fixture(page);
    await page.goto("/");
    await expect(page.getByText("Start with a clear photo.")).toBeVisible();
    await expect(falling(page)).toBeHidden();
    await navigate(page, "My account");
    const animations = page.getByRole("group", { name: "Animations" });
    await expect(animations).toContainText("This device asks for less motion");

    await animations.getByRole("button", { name: "Always on" }).click();
    await expect(animations.getByRole("button", { name: "Always on" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("html")).toHaveAttribute("data-motion", "on");
    await expect(falling(page)).toBeVisible();
    // The page-wide reduce-motion rule no longer stops animations.
    expect(await cardAnimation(page)).toBe("falling-card-fall");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-motion", "on");
    await expect(falling(page)).toBeVisible();

    await page.getByRole("group", { name: "Animations" }).getByRole("button", { name: "Follow device" }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-motion", "on");
    await expect(falling(page)).toBeHidden();
  });
});
