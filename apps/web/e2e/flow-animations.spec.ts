import { expect, test, type Page } from "@playwright/test";
import { navigate } from "./navigation";
import { noPriceAlerts } from "./price-alert-fixture";

const session = { owner_id: "flow-fixture", display_name: "Flow collector", role: "member", csrf_token: "fixture", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
const account = { id: "flow-fixture", display_name: "Flow collector", role: "member", created_at: "2026-01-01T00:00:00Z", approved_at: "2026-01-01T00:00:00Z", scan_cards_used: 0, scan_card_limit: null, scan_card_limit_override: null, scan_cards_remaining: null, scans_paused: false };

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
const running = (page: Page, selector: string) => page.locator(selector).first().evaluate((element) => element.getAnimations().map((animation) => animation instanceof CSSAnimation ? animation.animationName : "screen"));

test.describe("with animations on", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a new screen fades in, and an opened section settles in", async ({ page }) => {
    await fixture(page);
    await page.goto("/");
    await expect(page.getByText("Start with a clear photo.")).toBeVisible();
    // The first screen appears as it always did.
    expect(await running(page, "main")).toEqual([]);
    await page.getByText("Supported photo formats").click();
    expect(await running(page, ".photo-format-help > p")).toContain("flow-reveal");

    await page.evaluate(() => {
      const animate = Element.prototype.animate;
      (window as any).screenFades = 0;
      Element.prototype.animate = function (...args: Parameters<Element["animate"]>) { if (this.tagName === "MAIN") (window as any).screenFades++; return animate.apply(this, args); };
    });
    await navigate(page, "My account");
    await expect(page.getByRole("group", { name: "Animations" })).toBeVisible();
    expect(await page.evaluate(() => (window as any).screenFades)).toBe(1);
  });

  test("the shortcut list rises in on desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await fixture(page);
    await page.goto("/");
    await expect(page.getByText("Start with a clear photo.")).toBeVisible();
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    expect(await running(page, ".shortcuts-dialog")).toContain("flow-dialog-in");
  });
});

test("Off keeps screens, sections and dialogs still", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("paktrak-motion", "off"));
  await page.setViewportSize({ width: 1280, height: 800 });
  await fixture(page);
  await page.goto("/");
  await expect(page.getByText("Start with a clear photo.")).toBeVisible();
  await page.getByText("Supported photo formats").click();
  expect(await running(page, ".photo-format-help > p")).toEqual([]);
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  expect(await running(page, ".shortcuts-dialog")).toEqual([]);
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const animate = Element.prototype.animate;
    (window as any).screenFades = 0;
    Element.prototype.animate = function (...args: Parameters<Element["animate"]>) { if (this.tagName === "MAIN") (window as any).screenFades++; return animate.apply(this, args); };
  });
  await navigate(page, "My account");
  expect(await page.evaluate(() => (window as any).screenFades)).toBe(0);
});
