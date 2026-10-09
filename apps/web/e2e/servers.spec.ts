import { expect, test, type Page } from "@playwright/test";
import { navigate } from "./navigation";
import { noPriceAlerts } from "./price-alert-fixture";

type Server = { id: string; url: string; host: string; state: string; created_at: string; connected_at: string | null; last_seen_at: string | null; friendships: number };

// Fully intercepted: no request reaches a real server or another PakTrak.
async function fixture(page: Page) {
  const state = {
    enabled: false,
    servers: [{ id: "s-asking", url: "https://cards.friend.example", host: "cards.friend.example", state: "pending", created_at: "2026-10-09T12:00:00Z", connected_at: null, last_seen_at: null, friendships: 0 }] as Server[],
    writes: [] as { method: string; path: string; body: unknown }[],
    errors: [] as string[], unexpected: [] as string[],
  };
  const status = () => ({ enabled: state.enabled, address: "https://paktrak.example", secure: true, servers: state.servers });
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path === "/api/v1/price-alerts") return route.fulfill({ json: noPriceAlerts });
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === "/api/auth/status") return reply({ setup_required: false, guest_signup_enabled: true });
    if (path === "/api/auth/session") return reply({ owner_id: "admin-fixture", display_name: "Test administrator", csrf_token: "servers-token", role: "admin", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null });
    if (path === "/api/v1/capabilities") return reply({ max_upload_bytes: 104857600 });
    if (path === "/api/v1/scans" || path === "/api/auth/accounts") return reply({ items: [], next_offset: null });
    if (path === "/api/v1/data/status") return reply({ feeds: [] });
    if (path === "/api/auth/settings") return reply({ guest_signup_enabled: true, enhanced_scanning_enabled: false, version: 1 });
    if (path === "/api/v1/backups") return reply({ available: true, settings: { enabled: true, keep: 7 }, running: false, requested: false, last_success_at: null, last_error: null, last_error_at: null, next_at: null, restore_requested: null, last_restore: null, backups: [] });
    if (path.startsWith("/api/v1/servers")) {
      if (req.method() === "GET") return reply(status());
      expect(req.headers()["x-csrf-token"]).toBe("servers-token");
      const body = req.postData() ? req.postDataJSON() : undefined;
      state.writes.push({ method: req.method(), path, body });
      if (path === "/api/v1/servers/settings") state.enabled = body.enabled;
      else if (path === "/api/v1/servers" && req.method() === "POST") {
        if (body.url.includes("offline")) return reply({ detail: "Couldn’t reach offline.example. Check the address, or try again later." }, 503);
        state.servers.push({ id: "s-new", url: "https://pals.example", host: "pals.example", state: "requested", created_at: "2026-10-09T13:00:00Z", connected_at: null, last_seen_at: null, friendships: 0 });
      } else if (path.endsWith("/approve")) state.servers = state.servers.map((item) => path.includes(item.id) ? { ...item, state: "connected", connected_at: "2026-10-09T14:00:00Z", last_seen_at: "2026-10-09T14:00:00Z", friendships: 2 } : item);
      else if (req.method() === "DELETE") state.servers = state.servers.filter((item) => !path.endsWith(item.id));
      return reply(status());
    }
    state.unexpected.push(path); return reply({ detail: "Unexpected test request" }, 500);
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Take photo", exact: true })).toBeVisible();
  await navigate(page, "Administration");
  const panel = page.getByRole("region", { name: "Other PakTrak servers", exact: true });
  await expect(panel).toBeVisible();
  return { state, panel };
}

for (const [label, width, height] of [["phone", 390, 844], ["desktop", 1280, 900]] as const) test(`administrators connect other servers on ${label}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height });
  const { state, panel } = await fixture(page);
  const toggle = panel.getByRole("checkbox", { name: "Allow connections with other servers", exact: true });
  await expect(toggle).not.toBeChecked();
  await expect(panel.getByRole("textbox", { name: "Connect to a server" })).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(panel).toContainText("https://paktrak.example");

  const input = panel.getByRole("textbox", { name: "Connect to a server" });
  await input.fill("offline.example");
  await panel.getByRole("button", { name: "Send request", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Couldn’t reach offline.example");
  await input.fill("https://pals.example");
  await panel.getByRole("button", { name: "Send request", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Request sent");
  await expect(panel.getByRole("region", { name: "Waiting for approval" }).or(panel.getByLabel("Waiting for approval"))).toContainText("pals.example");

  const asking = panel.getByLabel("Asking to connect");
  await expect(asking).toContainText("cards.friend.example");
  await page.screenshot({ path: info.outputPath(`servers-${label}.png`), fullPage: false });
  await panel.locator("h3").scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`servers-${label}-panel.png`) });
  await asking.getByRole("button", { name: "Approve", exact: true }).click();
  const connected = panel.getByLabel("Connected servers");
  await expect(connected).toContainText("cards.friend.example");
  await expect(connected).toContainText("2 friendships");
  await panel.locator("h3").scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`servers-${label}-connected.png`) });
  await connected.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`servers-${label}-list.png`) });

  page.once("dialog", (dialog) => void dialog.accept());
  await connected.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(panel.getByLabel("Connected servers")).toHaveCount(0);
  await panel.getByLabel("Waiting for approval").getByRole("button", { name: "Cancel request", exact: true }).click();
  await expect(panel).toContainText("No other servers yet.");

  expect(state.writes.map((write) => `${write.method} ${write.path}`)).toEqual([
    "POST /api/v1/servers/settings", "POST /api/v1/servers", "POST /api/v1/servers",
    "POST /api/v1/servers/s-asking/approve", "DELETE /api/v1/servers/s-asking", "DELETE /api/v1/servers/s-new",
  ]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(state.errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
