import { expect, test, type Page } from "@playwright/test";
import { navigate } from "./navigation";
import { noPriceAlerts } from "./price-alert-fixture";

const reference = "812af440-4e2b-43ef-90aa-c7c5b336a7f1";
const photo = { name: "diagnostic-test.jpg", mimeType: "image/jpeg", buffer: Buffer.from([255, 216, 255, 217]) };

// Fully intercepted requests: no real accounts, photos, or collections are changed.
async function fixture(page: Page, role = "member") {
  const state = { owner: "diagnostic-tester", csrf: "first-token", sessionStatus: 200, scansStatus: 200, scanReads: 0, sessionReads: 0, logReads: 0, logReference: "", postStatus: 422, postCode: "validation_failed", posts: [] as { csrf: string; key: string }[], unexpected: [] as string[], errors: [] as string[] };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as any).copiedError = text; } } }));
  await page.route("**/api/**", async (route) => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    if (path === "/api/v1/price-alerts") return route.fulfill({ json: noPriceAlerts });
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json, headers: { "X-Request-ID": reference } });
    if (path === "/api/auth/status") return reply({ setup_required: false, guest_signup_enabled: true });
    if (path === "/api/auth/session") {
      state.sessionReads++;
      return state.sessionStatus === 200 ? reply({ owner_id: state.owner, display_name: "Test collector", csrf_token: state.csrf, role, tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null }) : reply({ detail: "Sign in to continue.", error_code: "session_expired" }, state.sessionStatus);
    }
    if (path === "/api/v1/capabilities") return reply({ max_upload_bytes: 104857600 });
    if (path === "/api/v1/scans" && req.method() === "GET") {
      state.scanReads++;
      return state.scansStatus === 200 ? reply({ items: [], next_offset: null }) : route.fulfill({ status: state.scansStatus, contentType: "text/html", body: "<h1>Upstream unavailable</h1>", headers: { "X-Request-ID": reference } });
    }
    if (path === "/api/v1/scans" && req.method() === "POST") {
      state.posts.push({ csrf: req.headers()["x-csrf-token"], key: req.headers()["idempotency-key"] });
      return reply({ error_code: state.postCode, detail: state.postStatus === 403 ? "Your sign-in verification changed. Refresh sign-in and try the action again." : [{ loc: ["body", "foil_count"], msg: "Use a value at most 32.", type: "less_than_equal" }] }, state.postStatus);
    }
    if (path === "/api/auth/accounts") return reply({ items: [], next_offset: null });
    if (path === "/api/auth/settings") return reply({ guest_signup_enabled: true, version: 1 });
    if (path === "/api/v1/data/status") return reply({ feeds: [] });
    if (path === "/api/v1/diagnostics/errors") {
      state.logReads++; state.logReference = url.searchParams.get("reference") || "";
      return reply({ items: [{ request_id: reference, created_at: "2026-09-20T20:00:00Z", method: "POST", route: "/api/v1/scans/{scan_id}/finalize", status: 403, code: "csrf_mismatch", summary: "The request used an out-of-date sign-in verification token.", duration_ms: 12, context: {} }], next_offset: null, retention_days: 14 });
    }
    state.unexpected.push(path); return reply({ detail: "Unexpected test endpoint" }, 500);
  });
  return state;
}

async function refresh(page: Page) { await page.evaluate(() => window.dispatchEvent(new Event("online"))); }
async function ready(page: Page) { await page.goto("/"); await expect(page.getByRole("button", { name: "Take photo", exact: true })).toBeVisible(); }

test("background errors explain server failures, stay dismissed, and clear after recovery", async ({ page }) => {
  const state = await fixture(page); state.scansStatus = 503;
  await ready(page);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Refresh batches: The server is temporarily unavailable");
  await expect(alert).not.toContainText("Check the fields");
  await alert.getByText("Error details", { exact: true }).click();
  await expect(alert.locator("pre")).toContainText(reference);
  await alert.getByRole("button", { name: "Copy error details", exact: true }).click();
  expect(await page.evaluate(() => (window as any).copiedError)).toContain("HTTP status: 503");
  await alert.getByRole("button", { name: "Dismiss error" }).click();
  const before = state.scanReads; await refresh(page); await expect.poll(() => state.scanReads).toBeGreaterThan(before);
  await expect(alert).toHaveCount(0);
  state.scansStatus = 200; const recovered = state.scanReads; await refresh(page); await expect.poll(() => state.scanReads).toBeGreaterThan(recovered);
  state.scansStatus = 503; await refresh(page); await expect(alert).toBeVisible();
  state.scansStatus = 200; await alert.getByRole("button", { name: "Retry refresh" }).click();
  await expect(alert).toHaveCount(0);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("invalid fields name the failed action and remain visible until dismissed or retried", async ({ page }) => {
  const state = await fixture(page); await ready(page);
  await page.getByTestId("photo-input").setInputFiles(photo);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Save photo batch: Foil count: Use a value at most 32.");
  const before = state.scanReads; await refresh(page); await expect.poll(() => state.scanReads).toBeGreaterThan(before);
  await expect(alert).toBeVisible(); expect(state.posts).toHaveLength(1);
  await alert.getByRole("button", { name: "Dismiss error" }).click();
  await expect(alert).toHaveCount(0);
  await expect(page.getByText(/Unfinished upload: diagnostic-test.jpg/)).toBeVisible();
});

test("a renewed session updates the verification token even for the same account", async ({ page }) => {
  const state = await fixture(page); await ready(page);
  await expect.poll(() => state.scanReads).toBeGreaterThan(0);
  state.csrf = "renewed-token";
  const before = state.scanReads; await refresh(page); await expect.poll(() => state.scanReads).toBeGreaterThan(before);
  await page.getByTestId("photo-input").setInputFiles(photo);
  await expect(page.getByRole("alert")).toBeVisible();
  expect(state.posts).toHaveLength(1); expect(state.posts[0].csrf).toBe("renewed-token");
});

test("refreshing stale sign-in preserves the upload draft and never replays a write", async ({ page }) => {
  const state = await fixture(page); state.postStatus = 403; state.postCode = "csrf_mismatch"; await ready(page);
  await page.getByTestId("photo-input").setInputFiles(photo);
  const alert = page.getByRole("alert"); await expect(alert).toContainText("verification changed");
  state.csrf = "refreshed-token";
  await alert.getByRole("button", { name: "Refresh sign-in", exact: true }).click();
  await expect(alert).toHaveCount(0); await expect(page.getByText("Sign-in refreshed. Try your action again.")).toBeVisible();
  expect(state.posts).toHaveLength(1);
  await page.getByTestId("photo-input").setInputFiles(photo);
  await expect(alert).toBeVisible(); expect(state.posts).toHaveLength(2);
  expect(state.posts[1]).toEqual({ csrf: "refreshed-token", key: state.posts[0].key });
});

test("an expired session offers sign-in and pauses repeated polling while preserving the page", async ({ page }) => {
  await page.clock.install(); const state = await fixture(page); await ready(page);
  state.sessionStatus = 401; await refresh(page);
  const alert = page.getByRole("alert"); await expect(alert).toContainText("Your session ended");
  await expect(alert.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/api/auth/login");
  const count = state.sessionReads; await page.clock.runFor(20000); expect(state.sessionReads).toBe(count);
  await alert.getByRole("button", { name: "Dismiss error" }).click(); await page.clock.runFor(10000);
  await expect(alert).toHaveCount(0); expect(state.sessionReads).toBe(count);
  state.sessionStatus = 200; await refresh(page); await expect.poll(() => state.sessionReads).toBeGreaterThan(count);
});

test("a failed sign-in shows a safe reference and the normal signed-out probe is quiet", async ({ page }) => {
  const state = await fixture(page); state.sessionStatus = 401;
  await page.goto(`/?login_error=login_expired&error_ref=${reference}`);
  const alert = page.getByRole("alert"); await expect(alert).toHaveCount(1); await expect(alert).toContainText("expired or was already used");
  await alert.getByText("Error details", { exact: true }).click(); await expect(alert.locator("pre")).toContainText(reference);
  await expect(alert.getByRole("link", { name: "Sign in again" })).toBeVisible();
  expect(new URL(page.url()).search).toBe("");
  await alert.getByRole("button", { name: "Dismiss error" }).click(); await page.reload();
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible(); await expect(alert).toHaveCount(0);
});

test("an unfinished server address change explains recovery without creating another account", async ({ page }) => {
  const state = await fixture(page); state.sessionStatus = 401;
  await page.goto(`/?login_error=login_address_changed&error_ref=${reference}`);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("The server’s address update is not finished");
  await expect(alert).toContainText("restart PakTrak");
  await alert.getByText("Error details", { exact: true }).click();
  await expect(alert.locator("pre")).toContainText(reference);
  expect(state.posts).toHaveLength(0); expect(state.errors).toEqual([]);
});

for (const mode of ["light", "dark"] as const) test(`administrators can find and copy logs without overflow in ${mode} mode`, async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 740 }); await page.emulateMedia({ colorScheme: mode });
  const state = await fixture(page, "admin"); await ready(page); await navigate(page, "Administration");
  expect(state.logReads).toBe(0);
  const logs = page.getByRole("region", { name: "Request error logs" });
  await logs.getByRole("button", { name: "View error logs" }).click();
  await expect(logs).toContainText("out-of-date sign-in verification token");
  await logs.getByLabel("Error reference", { exact: true }).fill(reference);
  await logs.getByRole("button", { name: "Find error", exact: true }).click(); await expect.poll(() => state.logReference).toBe(reference);
  await logs.getByText("Diagnostic details", { exact: true }).click();
  await logs.getByRole("button", { name: "Copy log entry" }).click();
  expect(JSON.parse(await page.evaluate(() => (window as any).copiedError))).toMatchObject({ request_id: reference, code: "csrf_mismatch" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await logs.screenshot({ path: `../../artifacts/request-errors/logs-${mode}-${info.project.name}.png` });
  await logs.getByRole("button", { name: "Close error logs" }).click();
  await expect(logs.getByLabel("Error reference", { exact: true })).toHaveCount(0);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("members do not get administrator error logs", async ({ page }) => {
  const state = await fixture(page); await ready(page); await page.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(page.getByRole("button", { name: "Administration", exact: true })).toHaveCount(0); expect(state.logReads).toBe(0);
});
