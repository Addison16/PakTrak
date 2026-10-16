import { expect, test, type Page } from "@playwright/test";
import { noPriceAlerts } from "./price-alert-fixture";

const base = { filename: "my-cards.txt", format: "text", revision: 1, headers: [], mapping: {}, error: null, created_at: "2026-10-16T00:00:00Z" };
const previewing = { ...base, id: "preview-import", state: "PREVIEWING", options: {}, summary: {}, jobs: [{ id: "preview-job", kind: "IMPORT_PREVIEW", state: "RUNNING", stage: "Processing on the server", error: null, progress: { phase: "Matching card rows", done: 150, total: 420, unit: "rows", eta_seconds: 95, measured_at: new Date().toISOString() } }] };
const committing = { ...base, id: "commit-import", filename: "binder.csv", format: "generic", state: "COMMITTING", options: {}, summary: { rows: 300, ready_copies: 180, committed_copies: 120, unresolved_rows: 0, states: {} }, jobs: [{ id: "commit-job", kind: "IMPORT_COMMIT", state: "QUEUED", stage: "Waiting to retry on the server", error: "The server will retry this processing step.", progress: null }] };

async function fixture(page: Page) {
  const calls: string[] = [];
  const imports: Record<string, any> = { [previewing.id]: structuredClone(previewing), [committing.id]: structuredClone(committing) };
  await page.route("**/api/**", async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() !== "GET") calls.push(path);
    let json: any;
    if (path === "/api/v1/price-alerts") json = noPriceAlerts;
    else if (path === "/api/auth/session") json = { owner_id: "owner", display_name: "Collector", role: "member", csrf_token: "test", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/catalog/status") json = { printings: 1 };
    else if (path === "/api/v1/data/status") json = { feeds: [] };
    else if (path === "/api/v1/binders") json = { items: [] };
    else if (path === "/api/v1/exports") json = { items: [], next_offset: null };
    else if (path === "/api/v1/imports") json = { items: Object.values(imports), next_offset: null };
    else if (path.endsWith("/rows")) json = { items: [], next_offset: null, previous_issue: null, next_issue: null, attention_count: 0 };
    else if (path === "/api/v1/imports/preview-import/cancel") { imports[previewing.id] = { ...imports[previewing.id], state: "CANCELLED", revision: 2, jobs: [{ ...previewing.jobs[0], state: "FAILED", progress: null }] }; json = imports[previewing.id]; }
    else if (path === "/api/v1/imports/commit-import/undo") { imports[committing.id] = { ...imports[committing.id], state: "UNDOING", revision: 2, jobs: [] }; json = imports[committing.id]; }
    else if (path.startsWith("/api/v1/imports/")) json = imports[path.split("/")[4]];
    if (json === undefined) return route.fulfill({ status: 500, json: { detail: "Unexpected fixture endpoint " + path } });
    await route.fulfill({ json });
  });
  return calls;
}

for (const [width, mode] of [[390, "light"], [390, "dark"], [1280, "light"]] as const) {
  test(`an import being prepared can be cancelled at ${width}px ${mode}`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    const calls = await fixture(page); await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ colorScheme: mode });
    await page.goto("/#/transfers");
    await page.getByRole("button", { name: /my-cards\.txt/ }).click();
    const panel = page.getByRole("region", { name: "Import preview" });
    await expect(panel.getByRole("heading", { name: "Preparing preview" })).toBeVisible();
    await expect(panel.getByText("150 rows / 420 rows")).toBeVisible();
    const cancel = panel.getByRole("button", { name: "Cancel import" });
    await cancel.scrollIntoViewIfNeeded();
    if (process.env.IMPORT_CANCEL_SHOTS) await panel.screenshot({ path: `${process.env.IMPORT_CANCEL_SHOTS}/preparing-${width}-${mode}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await cancel.click();
    await expect(panel.getByRole("heading", { name: "Import cancelled" })).toBeVisible();
    await expect(panel.getByText("Nothing from this file was added to your collection.")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Cancel import" })).toHaveCount(0);
    if (process.env.IMPORT_CANCEL_SHOTS) await panel.screenshot({ path: `${process.env.IMPORT_CANCEL_SHOTS}/cancelled-${width}-${mode}.png` });
    expect(calls).toEqual(["/api/v1/imports/preview-import/cancel"]);
    expect(errors).toEqual([]);
  });
}

test("cancelling while copies are added asks first, then removes them", async ({ page }) => {
  const calls = await fixture(page); await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/transfers");
  await page.getByRole("button", { name: /binder\.csv/ }).click();
  const panel = page.getByRole("region", { name: "Import preview" });
  await expect(panel.getByText("The last try didn’t finish. The server is trying again.")).toBeVisible();
  if (process.env.IMPORT_CANCEL_SHOTS) await panel.screenshot({ path: `${process.env.IMPORT_CANCEL_SHOTS}/adding-retry-390.png` });
  page.once("dialog", (dialog) => void dialog.dismiss());
  await panel.getByRole("button", { name: "Cancel import" }).click();
  expect(calls).toEqual([]);
  page.once("dialog", (dialog) => { expect(dialog.message()).toContain("already added will be removed"); void dialog.accept(); });
  await panel.getByRole("button", { name: "Cancel import" }).click();
  await expect(panel.getByRole("heading", { name: "Undo in progress" })).toBeVisible();
  expect(calls).toEqual(["/api/v1/imports/commit-import/undo"]);
});
