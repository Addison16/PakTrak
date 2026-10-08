import { expect, test, type Page } from "@playwright/test";
import { navigate } from "./navigation";
import { noPriceAlerts } from "./price-alert-fixture";

// Fully intercepted: these checks never change a running server's scan policy.
async function fixture(page: Page) {
  const state = {
    settings: { guest_signup_enabled: true, enhanced_scanning_enabled: false, version: 1 },
    writes: [] as Record<string, unknown>[],
    errors: [] as string[], unexpected: [] as string[],
    hold: false, release: undefined as (() => void) | undefined,
    reject: false, failRead: false,
  };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path === "/api/v1/price-alerts") return route.fulfill({ json: noPriceAlerts });
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === "/api/auth/status") return reply({ setup_required: false, guest_signup_enabled: true });
    if (path === "/api/auth/session") return reply({ owner_id: "admin-fixture", display_name: "Test administrator", csrf_token: "scan-policy-token", role: "admin", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null });
    if (path === "/api/v1/capabilities") return reply({ max_upload_bytes: 104857600 });
    if (path === "/api/v1/scans" || path === "/api/auth/accounts") return reply({ items: [], next_offset: null });
    if (path === "/api/v1/data/status") return reply({ feeds: [] });
    if (path === "/api/v1/backups") return reply({ available: true, settings: { enabled: true, keep: 7 }, running: false, requested: false, last_success_at: null, last_error: null, last_error_at: null, next_at: null, restore_requested: null, last_restore: null, backups: [] });
    if (path === "/api/auth/settings") {
      if (req.method() === "GET") return state.failRead ? reply({ detail: "The server is temporarily unavailable." }, 503) : reply(state.settings);
      expect(req.headers()["x-csrf-token"]).toBe("scan-policy-token");
      const data = req.postDataJSON(); state.writes.push(data);
      if (state.hold) await new Promise<void>((resolve) => { state.release = resolve; });
      if (state.reject) return reply({ detail: "The server is temporarily unavailable." }, 503);
      if (data.expected_version !== state.settings.version) return reply({ detail: "Settings changed. Refresh before saving." }, 409);
      const { expected_version: _version, ...update } = data;
      state.settings = { ...state.settings, ...update, version: state.settings.version + 1 };
      return reply(state.settings);
    }
    state.unexpected.push(path); return reply({ detail: "Unexpected test request" }, 500);
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Take photo", exact: true })).toBeVisible();
  await navigate(page, "Administration");
  await expect(page.getByRole("region", { name: "Scan processing", exact: true })).toBeVisible();
  return state;
}

for (const theme of ["light", "dark"] as const) test(`scan processing settings persist independently on a narrow phone in ${theme} mode`, async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ colorScheme: theme });
  const state = await fixture(page);
  const panel = page.getByRole("region", { name: "Scan processing", exact: true });
  const toggle = panel.getByRole("checkbox", { name: "Enhanced scanning", exact: true });
  const guest = page.getByRole("checkbox", { name: "Allow guest signup", exact: true });
  await expect(toggle).not.toBeChecked();
  await expect(panel).toContainText("Off by default");
  await expect(panel).toContainText("CPU and memory");
  await expect(panel).toContainText("No GPU is required");
  state.hold = true;
  await toggle.click();
  await expect(toggle).toBeDisabled(); await expect(guest).toBeDisabled();
  await expect.poll(() => !!state.release).toBe(true);
  state.hold = false; state.release!();
  await expect(toggle).toBeEnabled(); await expect(toggle).toBeChecked();
  expect(state.writes[0]).toEqual({ enhanced_scanning_enabled: true, expected_version: 1 });
  await guest.click(); await expect(guest).not.toBeChecked(); await expect(guest).toBeEnabled();
  await expect(toggle).toBeChecked(); expect(state.settings.guest_signup_enabled).toBe(false);
  await page.reload(); await navigate(page, "Administration");
  await expect(toggle).toBeChecked(); await expect(guest).not.toBeChecked();
  await toggle.click(); await expect(toggle).not.toBeChecked(); await expect(toggle).toBeEnabled();
  expect(state.settings).toEqual({ enhanced_scanning_enabled: false, guest_signup_enabled: false, version: 4 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: `../../artifacts/enhanced-scanning/admin-${theme}-${info.project.name}.png` });
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a concurrent operator change is shown without overwriting either setting", async ({ page }) => {
  const state = await fixture(page);
  state.settings = { guest_signup_enabled: false, enhanced_scanning_enabled: true, version: 2 };
  const toggle = page.getByRole("checkbox", { name: "Enhanced scanning", exact: true });
  await toggle.click();
  await expect(page.getByRole("alert")).toContainText("Settings changed");
  await expect(toggle).toBeEnabled(); await expect(toggle).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Allow guest signup", exact: true })).not.toBeChecked();
  expect(state.settings.version).toBe(2);
  await toggle.click(); await expect(toggle).not.toBeChecked(); await expect(toggle).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(state.settings.version).toBe(3); expect(state.settings.guest_signup_enabled).toBe(false);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a failed save and refresh never display an unsaved scanning mode as enabled", async ({ page }) => {
  const state = await fixture(page); state.reject = true; state.failRead = true;
  const toggle = page.getByRole("checkbox", { name: "Enhanced scanning", exact: true });
  await toggle.click();
  await expect(page.getByRole("alert")).toContainText("temporarily unavailable");
  await expect(toggle).toBeEnabled(); await expect(toggle).not.toBeChecked();
  expect(state.settings.enhanced_scanning_enabled).toBe(false);
  state.reject = false; state.failRead = false;
  await toggle.click(); await expect(toggle).toBeChecked(); await expect(toggle).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(state.writes).toHaveLength(2); expect(state.settings.version).toBe(2);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});
