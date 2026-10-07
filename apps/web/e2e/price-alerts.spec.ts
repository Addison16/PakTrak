import { expect, test, type Page } from "@playwright/test";

const mover = (id: string, name: string, old_amount: string, new_amount: string, extra: Record<string, unknown> = {}) => {
  const change = (Number(new_amount) - Number(old_amount)).toFixed(2);
  return { printing_id: id, name, set_code: "mh3", collector_number: id.slice(-3), finish: "nonfoil", quantity: 1, image_url: null, old_amount, new_amount, change, percent: Math.round(Number(change) / Number(old_amount) * 1000) / 10, since: "2026-10-01T12:00:00Z", ...extra };
};
const rises = [
  mover("00000000-0000-4000-8000-000000000101", "Ragavan, Nimble Pilferer", "42.10", "58.75", { quantity: 2 }),
  mover("00000000-0000-4000-8000-000000000102", "Orcish Bowmasters", "31.00", "39.50", { finish: "foil" }),
  mover("00000000-0000-4000-8000-000000000103", "The One Ring", "64.00", "77.20"),
  mover("00000000-0000-4000-8000-000000000104", "Sheoldred, the Apocalypse", "70.00", "86.00"),
];
const drops = [mover("00000000-0000-4000-8000-000000000201", "Fable of the Mirror-Breaker", "18.40", "12.15")];

// Every API request is intercepted with sample prices; nothing here reads a real catalog.
async function collector(page: Page, alerts = { rises, drops }) {
  const state = { seen: [] as unknown[], settings: [] as unknown[], unexpected: [] as string[], current: { enabled: true, percent: 20 as number | null, amount: "1.00" as string | null } };
  await page.route("**/api/**", async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === "/api/auth/session") return json({ owner_id: "alert-collector", display_name: "Alert collector", csrf_token: "alert-csrf", role: "member", tour_dismissed: true, scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null, preferred_price_source: "tcgplayer" });
    if (path === "/api/auth/status") return json({ setup_required: false, guest_signup_enabled: true });
    if (path === "/api/v1/capabilities") return json({ max_upload_bytes: 104857600 });
    if (path === "/api/v1/scans") return json({ items: [], next_offset: null });
    if (path === "/api/auth/me") return json({ id: "alert-collector", display_name: "Alert collector", role: "member", created_at: "2026-01-01T00:00:00Z", approved_at: "2026-01-01T00:00:00Z", scan_cards_used: 0, scan_card_limit: null, scan_card_limit_override: null, scan_cards_remaining: null, scans_paused: false, suspended: false, account_version: 1, collection_copies: 40, saved_decks: 1, saved_batches: 0, active_sessions: 1, activity: [] });
    if (path === "/api/v1/price-alerts" && req.method() === "GET") return json({ settings: state.current, provider: "tcgplayer", currency: "USD", feed: null, rises: alerts.rises, drops: alerts.drops, rise_count: alerts.rises.length, drop_count: alerts.drops.length });
    if (path === "/api/v1/price-alerts/seen" && req.method() === "POST") {
      expect(req.headers()["x-csrf-token"]).toBe("alert-csrf");
      state.seen.push(req.postDataJSON()); alerts = { rises: [], drops: [] };
      return json({ updated: 5 });
    }
    if (path === "/api/v1/price-alerts/settings" && req.method() === "PUT") {
      state.settings.push(req.postDataJSON()); state.current = req.postDataJSON();
      return json(state.current);
    }
    state.unexpected.push(req.method() + " " + path);
    return json({ detail: "Unexpected fixture endpoint " + path }, 500);
  });
  return state;
}

for (const width of [320, 390, 1280]) {
  test(`Home shows price rises and drops and dismisses them at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    const state = await collector(page);
    await page.goto("/");
    const banner = page.getByRole("button", { name: /Your cards are on the move!/ });
    await expect(banner).toContainText("4 cards went up · 1 went down · $71.00 up");
    await banner.screenshot({ path: `../../artifacts/price-alerts/banner-${width}-${test.info().project.name}.png` });
    await banner.click();
    const notice = page.getByRole("dialog", { name: "Some of your cards moved", exact: true });
    await expect(notice).toBeVisible();
    await expect(notice.getByText("Ragavan, Nimble Pilferer", { exact: true })).toBeVisible();
    await expect(notice.getByText("+$16.65", { exact: true })).toBeVisible();
    await expect(notice.getByText(/MH3 · #102 · Foil/)).toBeVisible();
    await expect(notice.getByText("−$6.25", { exact: true })).toBeVisible();
    await expect(notice.getByText("Sheoldred, the Apocalypse", { exact: true })).toHaveCount(0);
    await notice.getByRole("button", { name: "Show all 4", exact: true }).click();
    await expect(notice.getByText("Sheoldred, the Apocalypse", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await notice.screenshot({ path: `../../artifacts/price-alerts/home-${width}-${test.info().project.name}.png` });
    await notice.getByRole("button", { name: "Close", exact: true }).click();
    await expect(notice).toHaveCount(0);
    expect(state.seen).toEqual([]);
    await banner.click();
    await notice.getByRole("button", { name: "Got it", exact: true }).click();
    await expect(notice).toHaveCount(0);
    await expect(banner).toHaveCount(0);
    expect(state.seen).toEqual([{ cards: [...rises, ...drops].map(({ printing_id, finish }) => ({ printing_id, finish })) }]);
    await page.reload();
    await expect(page.getByRole("button", { name: "Take photo", exact: true })).toBeVisible();
    await expect(page.locator(".price-alert-banner")).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("Home stays clear when nothing moved and settings save from My account", async ({ page }) => {
  const state = await collector(page, { rises: [], drops: [] });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Take photo", exact: true })).toBeVisible();
  await expect(page.locator(".price-alert-banner")).toHaveCount(0);
  await page.goto("/#account");
  const form = page.getByRole("form", { name: "Price alerts", exact: true });
  await expect(form.getByLabel("Percent change")).toHaveValue("20");
  await expect(form.getByLabel("Dollar change")).toHaveValue("1.00");
  await form.getByLabel("Percent change").fill("");
  await form.getByLabel("Dollar change").fill("");
  await expect(form.getByText("Enter a percent, a dollar amount or both.", { exact: true })).toBeVisible();
  await expect(form.getByRole("button", { name: "Save price alerts", exact: true })).toBeDisabled();
  await form.getByLabel("Dollar change").fill("5");
  await form.getByRole("button", { name: "Save price alerts", exact: true }).click();
  await expect(form.getByText("Price alerts are saved.", { exact: true })).toBeVisible();
  await form.screenshot({ path: `../../artifacts/price-alerts/settings-${test.info().project.name}.png` });
  expect(state.settings).toEqual([{ enabled: true, percent: null, amount: "5.00" }]);
  expect(state.unexpected).toEqual([]);
});

test("Change alert amounts opens the settings in My account", async ({ page }) => {
  await collector(page);
  await page.goto("/");
  await page.getByRole("button", { name: /Your cards are on the move!/ }).click();
  await page.getByRole("button", { name: "Change alert amounts", exact: true }).click();
  const form = page.getByRole("form", { name: "Price alerts", exact: true });
  await expect(form).toBeInViewport();
});
