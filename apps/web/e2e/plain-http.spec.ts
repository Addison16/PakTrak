import { expect, test } from "@playwright/test";
import { noPriceAlerts } from "./price-alert-fixture";

// Browsers leave crypto.randomUUID out on plain http:// addresses other than
// localhost, such as http://192.168.1.50:8095. PakTrak used to stop with a
// blank page there; it must open and sign in the same as on HTTPS.
test("PakTrak opens at a plain http:// address", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => { Object.defineProperty(Crypto.prototype, "randomUUID", { value: undefined, configurable: true }); });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = { items: [], next_offset: null };
    if (path === "/api/v1/price-alerts") json = noPriceAlerts;
    else if (path === "/api/auth/session") json = { owner_id: "http-owner", display_name: "Collector", role: "member", csrf_token: "test", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/collection/filters") json = { sets: [], foil_types: [] };
    else if (path === "/api/v1/data/status") json = { feeds: [] };
    return route.fulfill({ json });
  });
  await page.goto("/");
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");
  await expect(page.getByRole("navigation").first()).toBeVisible();
  expect(errors).toEqual([]);
});
