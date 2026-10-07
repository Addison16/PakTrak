import { expect, test, type Page } from "@playwright/test";
import { cancelBrowserBack, navigate } from "./navigation";
import { noPriceAlerts } from "./price-alert-fixture";

const batchId = "scan-review-fixture";
const base = "/api/v1/scans/" + batchId;
const printing = (index: number) => ({ id: "printing-" + index, name: "Fixture Card " + (index + 1), set_code: "tst", collector_number: String(index + 1), language: "en", finishes: ["nonfoil", "foil"], set_name: "Fixture Expansion", rarity: "rare", image_url: "/api/v1/card-images/fixture/0/grid" });

async function fixture(page: Page, count = 15, pending = 0, imported: number[] = [], rotation = 0, initialFoils = 1, cardName?: string) {
  let deleted = false;
  let processing = pending > 0;
  const calls: { path: string; method: string; body: any }[] = [];
  let foilCount = initialFoils;
  const rows = Array.from({ length: count }, (_, index) => ({
    id: "region-" + index, region_index: index, polygon: [[.05,.05],[.20,.05],[.20,.25],[.05,.25]],
    version: 1, state: "NEEDS_REVIEW", finish: initialFoils === 0 ? "nonfoil" : "unknown", crop_url: base + "/observations/region-" + index + "/image",
    rotation,
    recognition: index >= count - pending ? {} : { status: "MATCHED", reason: "Check the collector number." },
    candidates: index >= count - pending ? [] : [{ printing_id: "printing-" + index, printing: { ...printing(index), ...(cardName ? { name: cardName } : {}) }, match_score: index ? .85 : .97, evidence: ["Card name matches", "Artwork features match"] }],
    estimate: { min: "2.00", max: "4.00" }, lot: null as any,
  }));
  for (const index of imported) {
    rows[index].state = "COMMITTED";
    Object.assign(rows[index].recognition, { auto_imported: true });
    rows[index].lot = { id: "lot-" + rows[index].id, version: 1, printing: printing(index), finish: rows[index].finish, condition: "ungraded", quantity: 1, binder: "Scanned cards" };
  }
  function finishes() { return { foil_count: foilCount, foil_ids: rows.filter((r) => ["foil", "etched"].includes(r.finish)).map((r) => r.id), etched_ids: [], confirmed: rows.every((r) => r.finish !== "unknown"), token: "f".repeat(64) }; }
  function summary() { return { regions: rows.length, cards: rows.filter((r) => r.state !== "IGNORED").length, identified: rows.filter((r) => r.candidates.length).length,
    checked: rows.filter((r) => "status" in r.recognition).length, imported: rows.filter((r) => r.state === "COMMITTED").length, needs_review: rows.filter((r) => r.state === "NEEDS_REVIEW").length,
    value_min: "30.00", value_max: "60.00", priced_cards: rows.length, unpriced_cards: 0, unknown_finish: rows.length,
    provider: "tcgplayer", prices_updated_at: "2026-09-19T12:00:00Z", auto_add_enabled: true, auto_add_threshold: .88 }; }
  function scan() { return { id: batchId, filename: "fifteen-card-test.jpg", state: processing ? "PROCESSING" : "PHOTO_READY", uploaded: true,
    accepted_at: "2026-09-19T12:00:00Z", created_at: "2026-09-19T12:00:00Z", expires_at: "2026-09-26T12:00:00Z", width: 1200, height: 1600,
    thumbnail_url: base + "/image", duplicate_scan_id: null, summary: summary(), finishes_confirmed: finishes().confirmed,
    preview_cards: rows.filter((r) => r.state !== "IGNORED").slice(0, 6).map((r) => ({ id: r.id, name: r.lot?.printing.name || r.candidates[0]?.printing.name || "Awaiting identification", image_url: r.crop_url })),
    job: { id: "job", state: processing ? "RUNNING" : "SUCCEEDED", stage: "Checking saved cards", attempts: 1,
      error_message: null, progress: { phase: "Identifying cards", done: summary().checked, total: rows.length, unit: "cards", eta_seconds: 12 } } }; }
  await page.route("**/api/**", async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname, method = req.method();
    if (path === "/api/v1/price-alerts") return route.fulfill({ json: noPriceAlerts });
    const body = req.postData() ? JSON.parse(req.postData()!) : null;
    calls.push({ path, method, body });
    if (path.endsWith("/image") || path.startsWith("/api/v1/card-images/")) {
      await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840"><rect width="600" height="840" rx="26" fill="#244d46"/><rect x="32" y="36" width="536" height="765" rx="16" fill="#f2e7d3"/><rect x="55" y="130" width="490" height="410" fill="#7a9b93"/><text x="65" y="97" font-size="36">Fixture Card</text><text x="66" y="620" font-size="28">Synthetic test artwork</text></svg>' }); return;
    }
    let json: any = {}, status = 200;
    if (path === "/api/auth/session") json = { owner_id: "scan-review-user", display_name: "Fixture collector", role: "member", csrf_token: "csrf-fixture", tour_dismissed: true, scan_cards_used: 15, scan_card_limit: null, scan_cards_remaining: null, preferred_price_source: "tcgplayer" };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/scans") json = { items: deleted ? [] : [scan()], next_offset: null };
    else if (path === base && method === "GET") { json = deleted ? { detail: "Batch not found." } : scan(); status = deleted ? 404 : 200; }
    else if (path === base + "/observations" && method === "GET") json = { items: rows, summary: summary(), finishes: finishes() };
    else if (path === "/api/v1/binders") json = { items: [{ id: "red", name: "Red binder", kind: "binder", version: 1, copies: 0 }] };
    else if (path === "/api/auth/preferences") json = { preferred_price_source: body.price_source };
    else if (path === base + "/approve") {
      expect(req.headers()["x-csrf-token"]).toBe("csrf-fixture");
      for (const item of body.items) { const row = rows.find((r) => r.id === item.observation_id)!; row.state = "COMMITTED"; row.version++;
        row.finish = item.finish;
        row.lot = { id: "lot-" + row.id, version: 1, printing: row.candidates[0].printing, finish: item.finish, condition: body.condition, quantity: 1, binder: body.binder }; }
      json = { imported: body.items.length };
    } else if (path === base + "/finishes") {
      foilCount = body.foil_count;
      for (const row of rows) { row.finish = body.foil_ids.includes(row.id) ? "foil" : "nonfoil"; row.version++; if (row.lot) { row.lot.finish = row.finish; row.lot.version++; } }
      json = { foil_cards: foilCount, nonfoil_cards: rows.length - foilCount };
    } else if (path === base + "/deletion-preview") json = { copies: summary().imported, token: "a".repeat(64), warning: "Removes every remaining collection copy added by this scan, including copies moved to another binder. Copies from other batches stay. Guest scan allowance is not restored." };
    else if (path === base && method === "DELETE") { deleted = true; json = { deleted: true, copies_removed: summary().imported }; }
    else if (path.endsWith("/orientation")) {
      expect(method).toBe("PUT"); expect(req.headers()["x-csrf-token"]).toBe("csrf-fixture");
      const row = rows.find((r) => path.includes(r.id))!;
      expect(body.expected_version).toBe(row.version);
      row.rotation = body.rotation; row.version++; row.crop_url = base + "/observations/" + row.id + "/image?v=" + row.version;
      processing = row.state === "NEEDS_REVIEW"; json = { id: row.id };
    }
    else if (path.endsWith("/undo-approval")) { const row = rows.find((r) => path.includes(r.id))!; expect(body.expected_version).toBe(row.version); row.state = "NEEDS_REVIEW"; row.lot = null; row.version++; json = { state: row.state, version: row.version }; }
    else if (path.endsWith("/geometry")) { const row = rows.find((r) => path.includes(r.id))!; row.polygon = body.polygon; row.version++; processing = true; json = { id: row.id }; }
    else if (path === base + "/observations" && method === "POST") { processing = true; json = { id: "new-region" }; status = 201; }
    else if (path === base + "/identify") { processing = true; json = { queued: true }; status = 202; }
    else if (path === "/api/v1/catalog/search") json = { items: [{ ...printing(0), id: "alternate-printing", collector_number: "99", rarity: "mythic" }], next_offset: null, filters: { sets: [{ code: "tst", name: "Fixture Expansion" }], rarities: ["rare", "mythic"], languages: ["en"] } };
    else if (path.endsWith("/details")) { const row = rows.find((r) => r.lot?.id === path.split("/")[4])!; row.lot.printing = { ...printing(0), id: body.printing_id, collector_number: "99", rarity: "mythic" }; row.finish = row.lot.finish = body.finish; row.lot.version++; json = { id: row.lot.id }; }
    else { status = 500; json = { detail: "Unexpected fixture endpoint: " + path }; }
    await route.fulfill({ status, json });
  });
  await page.goto("/");
  await navigate(page, "Batches");
  await page.getByRole("button", { name: /fifteen-card-test.jpg/ }).click();
  return { calls, rows, scan, finish: () => { processing = false; } };
}

test("alternate printed names remain visible when finding and selecting a batch card", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const mock = await fixture(page, 1, 0, [], 0, 0);
  const card = { ...printing(0), id: "esper-printing", name: "Nature's Claim", display_name: "Search for the Frozen Esper", set_code: "fca", collector_number: "47", set_name: "FINAL FANTASY: Through the Ages", rarity: "uncommon" };
  await page.route("**/api/v1/catalog/search?*", (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    return route.fulfill({ json: { items: query === "Search for the Frozen Esper #47" ? [card] : [], next_offset: null, filters: { sets: [{ code: "fca", name: card.set_name }], rarities: ["uncommon"], languages: ["en"] } } });
  });
  await page.getByRole("button", { name: "Edit card / printing", exact: true }).click();
  const picker = page.locator(".printing-picker");
  await picker.getByRole("searchbox", { name: "Find an exact printing", exact: true }).fill("Search for the Frozen Esper #47");
  const choice = picker.locator(".printing-choice");
  await expect(choice).toHaveCount(1);
  await expect(choice.locator("strong")).toHaveText("Search for the Frozen Esper");
  await expect(choice).toContainText("Nature's Claim");
  await expect(choice).toContainText("(FCA) · #47");
  await choice.click();
  await expect(page.locator(".scan-suggested h3")).toHaveText("Search for the Frozen Esper");
  await expect(page.locator(".scan-suggested")).toContainText("Nature's Claim");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(mock.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  await page.getByRole("button", { name: "Approve & import", exact: true }).click();
  expect(mock.calls.find((call) => call.path.endsWith("/approve"))!.body.items[0].printing_id).toBe(card.id);
});

for (const cardName of ["Plains", "Lightning Bolt"]) test(`collector-number shortcut narrows ${cardName} before explicit scan approval`, async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const mock = await fixture(page, 1, 0, [], 0, 0, cardName);
  const queries: URLSearchParams[] = [];
  const editions = ["first", "second"].map((edition) => ({ ...printing(0), id: edition, name: cardName, set_code: edition, set_name: edition + " expansion", collector_number: "287" }));
  await page.route("**/api/v1/catalog/search?*", (route) => {
    const params = new URL(route.request().url()).searchParams; queries.push(params);
    const q = params.get("q"), number = params.get("collector_number");
    let items = q === `${cardName} #287` ? editions : q === cardName && number === "287a" ? [{ ...editions[0], id: "suffix", collector_number: "287a" }] : q === cardName && !number ? [printing(0)] : [];
    if (params.get("set_code")) items = items.filter((item) => item.set_code === params.get("set_code"));
    return route.fulfill({ json: { items, next_offset: null, filters: { sets: editions.map((card) => ({ code: card.set_code, name: card.set_name })), rarities: ["rare"], languages: ["en"] } } });
  });
  await page.getByRole("button", { name: "Edit card / printing", exact: true }).click();
  const picker = page.locator(".printing-picker"), search = picker.getByRole("searchbox", { name: "Find an exact printing", exact: true });
  await expect(search).toHaveAttribute("placeholder", "e.g. Plains #287");
  await search.fill(`${cardName} #287`);
  await expect(picker.locator(".printing-choice")).toHaveCount(2);
  await expect(picker.getByRole("textbox", { name: "Collector number", exact: true })).toHaveValue("287");
  expect(queries.at(-1)!.get("exact_name")).toBe("true");
  expect(mock.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  await picker.getByRole("combobox", { name: "Set / expansion", exact: true }).selectOption("second");
  await expect(picker.locator(".printing-choice")).toHaveCount(1);
  await expect(picker.locator(".printing-choice")).toContainText("second expansion (SECOND) · #287");
  await picker.getByRole("button", { name: "Clear printing filters", exact: true }).click();
  await expect(search).toHaveValue(cardName);
  await expect(picker.getByRole("textbox", { name: "Collector number", exact: true })).toHaveValue("");
  await search.fill(`${cardName} #287`);
  await picker.getByRole("textbox", { name: "Collector number", exact: true }).fill("287a");
  await expect(search).toHaveValue(cardName);
  await expect(picker.locator(".printing-choice")).toHaveCount(1);
  await expect(picker.locator(".printing-choice")).toContainText("#287a");
  await search.fill(`${cardName} #999999`);
  await expect(picker.locator(".printing-choice")).toHaveCount(0);
  await expect(picker.getByRole("status")).toContainText("Check the name and collector number");
  await search.fill(`${cardName} #287`);
  await expect(picker.locator(".printing-choice")).toHaveCount(2);
  await picker.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `../../artifacts/collector-search/${cardName.toLowerCase().replaceAll(" ", "-")}-${info.project.name}.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await picker.locator(".printing-choice").filter({ hasText: "second expansion" }).click();
  await expect(page.locator(".scan-suggested")).toContainText("second expansion · #287");
  expect(mock.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  await page.getByRole("button", { name: "Approve & import", exact: true }).click();
  const approved = mock.calls.find((call) => call.path.endsWith("/approve"))!;
  expect(approved.body.items[0].printing_id).toBe("second");
  expect(approved.body.items[0].finish).toBe("nonfoil");
});

for (const mode of ["light", "dark"] as const) test(`${mode} batch guidance opens foil choices directly and leads into card review`, async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 844 }); await page.emulateMedia({ colorScheme: mode, reducedMotion: "reduce" });
  const mock = await fixture(page, 15, 0, [0], 0, 2);
  const steps = page.getByRole("region", { name: "Batch next steps", exact: true });
  await expect(steps.getByRole("heading", { name: "Finish your batch", exact: true })).toBeVisible();
  await expect(steps).toContainText("14 cards need approval");
  expect((await steps.getByRole("button", { name: "Choose foil cards", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: `../../artifacts/batch-guidance/overview-${mode}-${info.project.name}.png` });
  await steps.getByRole("button", { name: "Choose foil cards", exact: true }).click();
  const panel = page.getByRole("region", { name: "Foil cards", exact: true });
  await expect(panel.getByRole("heading", { name: "Tap any foil cards", exact: true })).toBeVisible();
  await expect(panel.getByLabel("How many cards are foil?", { exact: true })).toHaveCount(0);
  await expect.poll(async () => (await panel.boundingBox())!.y).toBeLessThan(75);
  const first = panel.getByRole("button", { name: "Foil card 1: Fixture Card 1", exact: true });
  expect((await first.boundingBox())!.width).toBeGreaterThanOrEqual(85);
  await first.click(); await panel.getByRole("button", { name: "Foil card 3: Fixture Card 3", exact: true }).click();
  await expect(panel.getByText("2 foil cards selected", { exact: true })).toBeVisible();
  const confirm = panel.getByRole("button", { name: "Confirm card finishes", exact: true });
  await expect(confirm).toBeEnabled();
  const confirmBox = (await confirm.boundingBox())!;
  expect(confirmBox.y).toBeGreaterThanOrEqual(0); expect(confirmBox.y + confirmBox.height).toBeLessThanOrEqual(844);
  expect(mock.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  await page.screenshot({ path: `../../artifacts/batch-guidance/foils-${mode}-${info.project.name}.png` });
  await confirm.click();
  await expect(panel.getByRole("heading", { name: "2 foil · 13 nonfoil", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next: review 14 matches", exact: true }).click();
  const detail = page.getByRole("region", { name: "Review selected card", exact: true });
  await expect(detail).toBeFocused();
  await expect(detail.getByRole("heading", { name: "Card 2 · Review suggestion", exact: true })).toBeVisible();
  await expect(detail.getByRole("combobox", { name: "Finish", exact: true })).toHaveValue("nonfoil");
  await page.getByRole("button", { name: /Back to batches/ }).click();
  const row = page.getByRole("button", { name: /fifteen-card-test.jpg/ });
  await expect(row).toHaveAttribute("data-needs-review", "true"); await expect(row).toContainText("Review batch");
  await page.screenshot({ path: `../../artifacts/batch-guidance/list-${mode}-${info.project.name}.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await navigate(page, "Upload photo");
  await page.getByRole("button", { name: "Review saved batches", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Saved batches", exact: true })).toBeVisible();
});

test("review shortcut reaches the first pending card and foil shortcuts preserve unsaved selections", async ({ page }) => {
  const mock = await fixture(page, 3, 0, [0], 0, 1);
  const steps = page.getByRole("region", { name: "Batch next steps", exact: true });
  await steps.getByRole("button", { name: "Review card matches", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Card 2 · Review suggestion", exact: true })).toBeVisible();
  await steps.getByRole("button", { name: "Choose foil cards", exact: true }).click();
  const panel = page.getByRole("region", { name: "Foil cards", exact: true });
  const chosen = panel.getByRole("button", { name: "Foil card 3: Fixture Card 3", exact: true });
  await chosen.click();
  await steps.getByRole("button", { name: "Review card matches", exact: true }).click();
  await steps.getByRole("button", { name: "Choose foil cards", exact: true }).click();
  await expect(chosen).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".batch-save-status")).toContainText("Unsaved edits");
  expect(mock.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
});

test("completed nonfoil batches have no unfinished foil prompt and processing batches explain the wait", async ({ page }) => {
  const mock = await fixture(page, 3, 0, [0, 1, 2], 0, 0);
  const steps = page.getByRole("region", { name: "Batch next steps", exact: true });
  await expect(steps.getByRole("heading", { name: "Batch complete", exact: true })).toBeVisible();
  await expect(steps).toContainText("0 foil · 3 nonfoil");
  await expect(steps.getByRole("button", { name: "Choose foil cards", exact: true })).toHaveCount(0);
  await steps.getByRole("button", { name: "Browse scanned cards", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Card 1 · Imported", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close batch", exact: true }).click();
  await expect(page.getByRole("button", { name: /fifteen-card-test.jpg/ })).not.toHaveAttribute("data-needs-review");
  expect(mock.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  await page.unroute("**/api/**");
  const waiting = await fixture(page, 3, 1, [], 0, 1);
  await expect(steps.getByRole("button", { name: "Choose foil cards", exact: true })).toBeDisabled();
  await expect(steps).toContainText("Ready when scanning finishes");
  waiting.finish(); await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(steps.getByRole("button", { name: "Choose foil cards", exact: true })).toBeEnabled();
});

for (const imported of [false, true]) test(`photo flip is saved across reopening for ${imported ? "imported" : "pending"} cards`, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const mock = await fixture(page, 1, 0, imported ? [0] : [], 180);
  const flip = page.getByRole("button", { name: "Flip photo 180°", exact: true });
  expect((await flip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await flip.click();
  await expect(page.getByAltText("Your scanned card", { exact: true })).toHaveAttribute("src", /\?v=2$/);
  const first = mock.calls.find((call) => call.path.endsWith("/orientation"))!;
  expect(first.body).toEqual({ expected_version: 1, rotation: 0 });
  expect(mock.rows[0].state).toBe(imported ? "COMMITTED" : "NEEDS_REVIEW");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  mock.finish(); await page.reload(); await navigate(page, "Batches");
  await page.getByRole("button", { name: /fifteen-card-test.jpg/ }).click();
  await expect(page.getByAltText("Your scanned card", { exact: true })).toHaveAttribute("src", /\?v=2$/);
  await flip.click();
  await expect(page.getByAltText("Your scanned card", { exact: true })).toHaveAttribute("src", /\?v=3$/);
  expect(mock.calls.filter((call) => call.path.endsWith("/orientation")).at(-1)!.body).toEqual({ expected_version: 2, rotation: 180 });
  expect(mock.calls.filter((call) => call.method !== "GET").map((call) => call.path)).toEqual([base + "/observations/region-0/orientation", base + "/observations/region-0/orientation"]);
});

test("a failed photo flip retries the same request and prevents closing during save", async ({ page }) => {
  await fixture(page, 1);
  const attempts: any[] = [];
  let release = () => {};
  const saving = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/orientation", async (route) => {
    attempts.push({ body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"] });
    if (attempts.length === 1) return route.fulfill({ status: 503, json: { detail: "Temporary orientation failure" } });
    await saving; await route.fallback();
  });
  const flip = page.getByRole("button", { name: "Flip photo 180°", exact: true });
  await flip.click();
  await expect(page.getByRole("alert")).toContainText("Temporary orientation failure");
  await flip.click();
  await expect(flip).toBeDisabled();
  await expect(page.getByRole("button", { name: /Back to batches/ })).toBeDisabled();
  expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(attempts[0].key).toBeTruthy();
  release();
  await expect(flip).toBeEnabled();
  await expect(page.getByAltText("Your scanned card", { exact: true })).toHaveAttribute("src", /\?v=2$/);
});

test("a missed card can be outlined starting at its bottom right corner", async ({ page }) => {
  const mock = await fixture(page, 1);
  await page.getByRole("button", { name: "Add a missed card", exact: true }).click();
  await expect(page.getByText(/starting at any corner/)).toBeVisible();
  const canvas = page.locator(".crop-canvas");
  const box = (await canvas.boundingBox())!;
  const points = [[.9,.9],[.9,.4],[.5,.4],[.5,.9]];
  for (const [x, y] of points) await canvas.click({ position: { x: x * box.width, y: y * box.height } });
  await page.getByRole("button", { name: "Save outline & identify", exact: true }).click();
  await expect(page.getByRole("region", { name: "Card outline editor", exact: true })).toHaveCount(0);
  const saved = mock.calls.find((call) => call.path === base + "/observations" && call.method === "POST")!.body;
  for (let i = 0; i < 4; i++) for (let axis = 0; axis < 2; axis++) expect(saved.polygon[i][axis]).toBeCloseTo(points[i][axis], 2);
});

for (const width of [320, 390, 1280]) {
  test(`batch list opens a reviewable batch and returns with saved approvals at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const mock = await fixture(page, 15, 0, [0]);
    await expect(page.getByRole("heading", { name: "Saved batches", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit batch", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Card 2 · Review suggestion", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve & import", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete batch", exact: true })).toBeVisible();
    await expect(page.getByText("14 cards need approval", { exact: true })).toBeVisible();
    await page.screenshot({ path: `../../artifacts/batch-navigation/overview-${width}-${test.info().project.name}.png`, fullPage: true });
    await page.getByRole("button", { name: /Back to batches/ }).click();
    const row = page.getByRole("button", { name: /fifteen-card-test.jpg/ });
    await expect(row).toBeFocused();
    await expect(row.locator(".batch-mini img")).toHaveCount(6);
    await expect(row.locator(".batch-more:visible")).toHaveText(width <= 480 ? "+11" : "+9");
    await expect(row).toContainText("15 cards · 1 imported");
    await expect(row).toContainText("14 to review");
    await expect(row.locator(".batch-mini img").first()).toHaveJSProperty("complete", true);
    await page.screenshot({ path: `../../artifacts/batch-navigation/list-${width}-${test.info().project.name}.png`, fullPage: true });
    await row.click();
    await page.getByRole("combobox", { name: "Finish", exact: true }).selectOption("nonfoil");
    await expect(page.locator(".batch-save-status")).toContainText("Unsaved edits");
    await page.getByRole("button", { name: "Approve & import", exact: true }).click();
    await expect(page.locator(".batch-save-status")).toHaveText("✓ Saved on server");
    await expect(page.getByRole("heading", { name: "Card 3 · Review suggestion", exact: true })).toBeVisible();
    await expect(page.getByText("13 cards need approval", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close batch", exact: true }).click();
    await expect(row).toContainText("15 cards · 2 imported");
    await row.click();
    await page.getByRole("button", { name: "View card 2: Fixture Card 2", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Card 2 · Imported", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve & import", exact: true })).toHaveCount(0);
    expect(mock.calls.filter((c) => c.path.endsWith("/approve"))).toHaveLength(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("unfinished card choices survive cancelled exits and saved cards survive discarding drafts", async ({ page }) => {
  const mock = await fixture(page, 15, 0, [0]);
  await page.getByRole("combobox", { name: "Finish", exact: true }).selectOption("foil");
  await expect(page.locator(".batch-save-status")).toContainText("Unsaved edits");
  await page.getByRole("button", { name: "Next card", exact: true }).click();
  await expect(page.locator(".batch-save-status")).toContainText("Unsaved edits");
  page.once("dialog", async (dialog) => { expect(dialog.message()).toContain("Discard unfinished edits?"); await dialog.dismiss(); });
  await page.getByRole("button", { name: /Back to batches/ }).click();
  await expect(page.getByRole("region", { name: "Selected batch", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous card", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Finish", exact: true })).toHaveValue("foil");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Close batch", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Finish", exact: true })).toHaveValue("foil");
  page.once("dialog", (dialog) => dialog.accept());
  await navigate(page, "Batches");
  await expect(page.getByRole("heading", { name: "Saved batches", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /fifteen-card-test.jpg/ }).click();
  await expect(page.getByRole("combobox", { name: "Finish", exact: true })).toHaveValue("unknown");
  await expect(page.locator(".scan-match-state.imported")).toHaveCount(1);
  expect(mock.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
});

test("foil and crop drafts warn on exit and block closing during a save", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "Select foil cards", exact: true }).click();
  await page.getByRole("button", { name: "Foil card 1: Fixture Card 1", exact: true }).click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Close batch", exact: true }).click();
  await expect(page.getByText("1 foil card selected", { exact: true })).toBeVisible();
  let release: () => void = () => {};
  const saving = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/finishes", async (route) => { await saving; await route.fallback(); });
  await page.getByRole("button", { name: "Confirm card finishes", exact: true }).click();
  await expect(page.getByRole("button", { name: /Back to batches/ })).toBeDisabled();
  await expect(page.locator(".batch-save-status")).toHaveText("Saving changes…");
  release();
  await expect(page.locator(".batch-save-status")).toHaveText("✓ Saved on server");
  await page.getByRole("button", { name: "Adjust crop", exact: true }).click();
  await page.getByRole("button", { name: /Corner 1;/ }).focus();
  await page.keyboard.press("ArrowRight");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Close batch", exact: true }).click();
  await expect(page.getByRole("region", { name: "Card outline editor", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel outline", exact: true }).click();
  await page.getByRole("button", { name: "Close batch", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Saved batches", exact: true })).toBeVisible();
});

test("qol recovery restores foil choices after reload without approving cards", async ({ page }) => {
  const mock = await fixture(page, 3, 0, [], 0, 2);
  await page.getByRole("button", { name: "Select foil cards", exact: true }).click();
  await page.getByRole("button", { name: "Foil card 1: Fixture Card 1", exact: true }).click();
  await page.getByRole("button", { name: "Foil card 3: Fixture Card 3", exact: true }).click();
  await expect(page.getByText("Unfinished foil choices saved on this device.", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await page.getByRole("button", { name: "Restore foil choices", exact: true }).click();
  await expect(page.getByRole("button", { name: "Foil card 1: Fixture Card 1", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Foil card 3: Fixture Card 3", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(mock.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  await page.getByRole("button", { name: "Confirm card finishes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Change foil cards", exact: true })).toBeVisible();
  const saved = mock.calls.find((call) => call.path.endsWith("/finishes"))!;
  expect(saved.body.foil_ids).toEqual(["region-0", "region-2"]);
  expect(mock.calls.filter((call) => call.path.endsWith("/approve"))).toHaveLength(0);
  expect(await page.evaluate(() => localStorage.getItem("paktrak.draft.foils:scan-review-user:scan-review-fixture"))).toBeNull();
});

test("qol recovery saving foils preserves another card printing and condition draft", async ({ page }) => {
  const mock = await fixture(page, 3);
  await page.getByRole("combobox", { name: "Condition", exact: true }).selectOption("LP");
  await page.getByRole("button", { name: "Edit card / printing", exact: true }).click();
  await page.locator(".printing-picker .printing-choice").click();
  await page.getByRole("button", { name: "Next card", exact: true }).click();
  await page.getByRole("button", { name: "Select foil cards", exact: true }).click();
  await page.getByRole("button", { name: "Foil card 3: Fixture Card 3", exact: true }).click();
  await page.getByRole("button", { name: "Confirm card finishes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Change foil cards", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review card 1: Fixture Card 1", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Condition", exact: true })).toHaveValue("LP");
  await expect(page.locator(".scan-suggested")).toContainText("#99");
  await page.getByRole("button", { name: "Approve & import", exact: true }).click();
  const approved = mock.calls.find((call) => call.path.endsWith("/approve"))!;
  expect(approved.body.condition).toBe("LP");
  expect(approved.body.items[0].printing_id).toBe("alternate-printing");
});

test("qol recovery restores crop corners and allows precise zoomed keyboard adjustment", async ({ page }) => {
  const mock = await fixture(page, 1);
  await page.getByRole("button", { name: "Adjust crop", exact: true }).click();
  await page.getByRole("button", { name: "Corner 1; use arrow keys to adjust", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText("Unfinished corners saved on this device.", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await page.getByRole("button", { name: "Adjust crop", exact: true }).click();
  await page.getByRole("button", { name: "Restore outline", exact: true }).click();
  const corner = page.getByRole("button", { name: "Corner 1; use arrow keys to adjust", exact: true });
  expect(Number(await corner.getAttribute("data-x"))).toBeCloseTo(.052, 5);
  await page.getByRole("button", { name: "+ Zoom in", exact: true }).click();
  const canvas = page.locator(".crop-canvas"), viewport = page.locator(".crop-viewport");
  expect((await canvas.boundingBox())!.width).toBeGreaterThan((await viewport.boundingBox())!.width);
  await corner.focus(); await page.keyboard.press("Shift+ArrowRight");
  await page.getByRole("button", { name: "Save outline & identify", exact: true }).click();
  await expect(page.getByRole("region", { name: "Card outline editor", exact: true })).toHaveCount(0);
  const saved = mock.calls.find((call) => call.path.endsWith("/geometry"))!;
  expect(saved.body.polygon[0][0]).toBeCloseTo(.072, 5);
  expect(saved.body.expected_version).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("crop corners are finger-sized and a magnifier shows a dragged corner away from the pointer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mock = await fixture(page, 1);
  await page.getByRole("button", { name: "Adjust crop", exact: true }).click();
  const corner = page.getByRole("button", { name: "Corner 1; use arrow keys to adjust", exact: true });
  const loupe = page.locator(".crop-loupe");
  await expect(page.locator(".crop-canvas img")).toHaveJSProperty("complete", true);
  // Wait for the editor's scroll into view to settle before using raw pointer positions.
  await corner.hover();
  const handle = (await corner.boundingBox())!;
  expect(handle.width).toBeGreaterThanOrEqual(44); expect(handle.height).toBeGreaterThanOrEqual(44);
  await expect(loupe).toHaveCount(0);
  const canvas = (await page.locator(".crop-canvas").boundingBox())!;
  // Grab below the marker: the corner keeps that offset instead of jumping under the pointer.
  const start = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 + 12 };
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await expect(loupe).toBeVisible();
  await page.mouse.move(start.x + 30, start.y + 20, { steps: 5 });
  const lens = (await loupe.boundingBox())!;
  expect(lens.x).toBeGreaterThan(start.x + 30 + 22);
  // The corner sits near the bottom of the screen here; the magnifier must stay fully visible.
  expect(lens.y).toBeGreaterThanOrEqual(0); expect(lens.y + lens.height).toBeLessThanOrEqual(844);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `../../artifacts/crop-magnifier/drag-${test.info().project.name}.png` });
  expect(lens.width).toBeGreaterThanOrEqual(120);
  await page.mouse.up();
  await expect(loupe).toHaveCount(0);
  expect(Math.abs(Number(await corner.getAttribute("data-x")) * canvas.width - (.05 * canvas.width + 30))).toBeLessThan(2);
  expect(Math.abs(Number(await corner.getAttribute("data-y")) * canvas.height - (.05 * canvas.height + 20))).toBeLessThan(2);
  // A corner on the right half puts the magnifier on the left.
  const right = (await page.getByRole("button", { name: "Corner 2; use arrow keys to adjust", exact: true }).boundingBox())!;
  await page.mouse.move(right.x + right.width / 2, right.y + right.height / 2); await page.mouse.down();
  await page.mouse.move(right.x + right.width / 2 + 120, right.y + right.height / 2, { steps: 3 });
  expect((await loupe.boundingBox())!.x + 136).toBeLessThan(right.x + 120);
  await page.mouse.up();
  await corner.focus(); await page.keyboard.press("ArrowDown");
  await expect(loupe).toBeVisible();
  await page.getByRole("button", { name: "+ Zoom in", exact: true }).focus();
  await expect(loupe).toHaveCount(0);
  await page.getByRole("button", { name: "Save outline & identify", exact: true }).click();
  const saved = mock.calls.find((call) => call.path.endsWith("/geometry"))!.body.polygon;
  expect(saved[0][1]).toBeCloseTo(.05 + 20 / canvas.height + .002, 2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("qol recovery scan filters retain physical numbers and image viewer fits on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const mock = await fixture(page, 4, 0, [0]);
  mock.rows[3].candidates = [];
  mock.rows[3].recognition = { status: "NO_MATCH", reason: "No printing found." };
  const gallery = page.getByLabel("Scanned cards", { exact: true });
  await page.getByRole("button", { name: "Needs review 3", exact: true }).click();
  await expect(gallery.locator(".scan-tile-number")).toHaveText(["2", "3", "4"]);
  await page.getByRole("button", { name: "No match 1", exact: true }).click();
  await expect(gallery.locator(".scan-tile-number")).toHaveText(["4"]);
  await page.getByRole("button", { name: "All cards 4", exact: true }).click();
  await page.getByRole("combobox", { name: "Card order", exact: true }).selectOption("strength");
  await expect(gallery.locator(".scan-tile-number")).toHaveText(["4", "2", "3", "1"]);
  await page.getByRole("button", { name: "Enlarge your scanned card", exact: true }).click();
  const viewer = page.getByRole("dialog");
  await expect(viewer.locator(".scan-viewer-viewport")).toHaveAttribute("data-fit", "true");
  await viewer.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(viewer.locator(".scan-viewer-viewport")).not.toHaveAttribute("data-fit", "true");
  await viewer.getByRole("button", { name: "Fit image", exact: true }).click();
  await expect(viewer.locator(".scan-viewer-viewport")).toHaveAttribute("data-fit", "true");
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Enlarge your scanned card", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("batch rows show distinct processing, review and empty states with pagination", async ({ page }) => {
  const mock = await fixture(page, 12, 3, []);
  const source = mock.scan();
  await page.route("**/api/v1/scans?*", (route) => route.fulfill({ json: {
    items: new URL(route.request().url()).searchParams.get("offset") === "20" ? [{ ...source, id: "older", filename: "older.jpg", state: "EXPIRED", thumbnail_url: null, preview_cards: [], job: null, summary: { ...source.summary, cards: 0, needs_review: 0, value_min: null } }] : [source, { ...source, id: "reviewed", filename: "reviewed.jpg", state: "PHOTO_READY", finishes_confirmed: true, job: null, summary: { ...source.summary, imported: 12, needs_review: 0 } }],
    next_offset: new URL(route.request().url()).searchParams.get("offset") === "20" ? null : 20,
  } }));
  await page.getByRole("button", { name: "Close batch", exact: true }).click();
  await expect(page.locator(".batch-list > li")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /fifteen-card-test.jpg/ })).toContainText("Identifying cards");
  await expect(page.getByRole("button", { name: /reviewed.jpg/ })).toContainText("Reviewed");
  await page.getByRole("button", { name: "Older batches", exact: true }).click();
  await expect(page.getByRole("button", { name: /older.jpg/ })).toContainText("Photo expired");
  await page.getByRole("button", { name: "Newer batches", exact: true }).click();
  await expect(page.locator(".batch-list > li")).toHaveCount(2);
  await page.getByRole("button", { name: "New scan", exact: true }).click();
  await expect(page.getByRole("button", { name: "Choose photo", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Selected batch", exact: true })).toHaveCount(0);
});

test("failed corrections remain unsaved until retry succeeds", async ({ page }) => {
  await fixture(page, 15, 0, [0]);
  await page.getByRole("button", { name: "View card 1: Fixture Card 1", exact: true }).click();
  await page.getByRole("button", { name: "Edit card / printing", exact: true }).click();
  await page.getByRole("combobox", { name: "Finish", exact: true }).selectOption("foil");
  await page.route("**/api/v1/collection/*/details", (route) => route.fulfill({ status: 503, json: { detail: "Could not save the correction. Try again." } }), { times: 1 });
  await page.getByRole("button", { name: "Save card correction", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not save the correction");
  await expect(page.locator(".batch-save-status")).toContainText("Unsaved edits");
  await expect(page.getByRole("combobox", { name: "Finish", exact: true })).toHaveValue("foil");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Close batch", exact: true }).click();
  await page.getByRole("button", { name: "Save card correction", exact: true }).click();
  await expect(page.locator(".batch-save-status")).toHaveText("✓ Saved on server");
  await page.getByRole("button", { name: "View card 1: Fixture Card 1", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Card 1 · Imported", exact: true })).toBeVisible();
});

for (const width of [320, 390, 1280]) {
  test(`scan gallery approves, corrects and deletes source copies at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    const mock = await fixture(page);
    await expect(page.locator(".scan-tile")).toHaveCount(15);
    await expect(page.getByText("$30.00–$60.00", { exact: true })).toBeVisible();
    await expect(page.getByText("97% match strength", { exact: true })).toBeVisible();
    expect(mock.calls.filter((c) => c.path.endsWith("/approve"))).toHaveLength(0);
    await page.screenshot({ path: `../../artifacts/scan-88-review/review-${width}-${test.info().project.name}.png`, fullPage: true });
    await page.getByRole("combobox", { name: "Finish", exact: true }).selectOption("nonfoil");
    await page.getByRole("combobox", { name: "Storage location", exact: true }).fill("Red binder");
    await page.getByRole("button", { name: "Approve & import", exact: true }).click();
    await expect(page.locator(".scan-match-state.imported")).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Card 2 · Review suggestion", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Previous card", exact: true }).click();
    await page.getByRole("button", { name: "Edit card / printing", exact: true }).click();
    await page.locator(".printing-choice").first().click();
    await expect(page.locator(".scan-suggested")).not.toContainText("$2.00–$4.00");
    await page.getByRole("combobox", { name: "Finish", exact: true }).selectOption("foil");
    await page.getByRole("button", { name: "Save card correction", exact: true }).click();
    await expect(page.locator(".scan-suggested")).toContainText("#99");
    await page.getByRole("button", { name: "Select suggestions", exact: true }).click();
    await page.getByRole("button", { name: "Import 14 selected", exact: true }).click();
    await expect(page.locator(".scan-match-state.imported")).toHaveCount(15);
    let warning = "";
    page.once("dialog", async (dialog) => { warning = dialog.message(); await dialog.dismiss(); });
    await page.getByRole("button", { name: "Delete batch", exact: true }).click();
    await expect(page.getByRole("button", { name: "Delete batch", exact: true })).toBeEnabled();
    expect(warning).toContain("remove 15 collection copies");
    expect(warning).toContain("other batches stay");
    expect(mock.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete batch", exact: true }).click();
    await expect(page.getByText("Batch deleted. 15 collection copies removed.", { exact: true })).toBeVisible();
    expect(mock.calls.find((c) => c.method === "DELETE")?.body.confirmed).toBe(true);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("scan progress and crop repair are available on a phone", async ({ page }) => {
  const mock = await fixture(page, 12, 3);
  await expect(page.getByRole("progressbar", { name: "Card identification progress" })).toHaveAttribute("value", "9");
  await expect(page.getByText(/12 of 15 expected cards found/)).toBeVisible();
  await page.getByRole("button", { name: "Adjust crop", exact: true }).click();
  const corner = page.getByRole("button", { name: "Corner 1; use arrow keys to adjust", exact: true });
  await corner.focus(); await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: "Save outline & identify", exact: true }).click();
  await expect(page.getByRole("region", { name: "Card outline editor" })).toHaveCount(0);
  const geometry = mock.calls.find((c) => c.method === "PUT");
  expect(geometry?.body.polygon[0][0]).toBeCloseTo(.052, 5);
  await page.getByRole("button", { name: "Add a missed card", exact: true }).click();
  const canvas = page.locator(".crop-canvas");
  await expect(canvas.locator("img")).toHaveJSProperty("complete", true);
  const bounds = await canvas.boundingBox();
  for (const [x,y] of [[.3,.3],[.65,.3],[.65,.7],[.3,.7]]) await canvas.click({ position: { x: bounds!.width*x, y: bounds!.height*y } });
  await page.getByRole("button", { name: "Save outline & identify", exact: true }).click();
  await expect(page.getByRole("region", { name: "Card outline editor" })).toHaveCount(0);
  expect(mock.calls.find((c) => c.path === base + "/observations" && c.method === "POST")?.body.polygon).toHaveLength(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("review navigation skips imported cards and remembers unfinished edits", async ({ page }) => {
  await fixture(page, 15, 0, [0, 2]);
  const bottomNav = page.getByRole("navigation", { name: "Card review navigation", exact: true });
  expect(await bottomNav.evaluate((element) => element === element.parentElement?.lastElementChild)).toBe(true);
  expect(await bottomNav.evaluate((element) => getComputedStyle(element).top)).toBe("auto");
  await expect(page.getByRole("heading", { name: "Card 2 · Review suggestion", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Finish", exact: true }).selectOption("foil");
  await page.getByRole("button", { name: "Next card", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Card 3 · Imported", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous card", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Finish", exact: true })).toHaveValue("foil");
  // Finish the guided smooth scroll before checking the sticky bar's hit area.
  await bottomNav.evaluate((element) => element.scrollIntoView({ block: "end", behavior: "instant" }));
  await expect.poll(() => bottomNav.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return box.bottom <= innerHeight && box.bottom > innerHeight * 0.6 && element.contains(hit);
  })).toBe(true);
  await page.screenshot({ path: `../../artifacts/deck-buy-lists/scan-bottom-${test.info().project.name}.png` });
  await page.getByRole("button", { name: "Approve & import", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Card 4 · Review suggestion", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review card 15: Fixture Card 15", exact: true }).click();
  await expect(page.getByRole("button", { name: "Next card", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: /Next to review/ }).click();
  await expect(page.getByRole("heading", { name: "Card 4 · Review suggestion", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View card 1: Fixture Card 1", exact: true }).click();
  await expect(page.getByRole("button", { name: "Previous card", exact: true })).toBeDisabled();
  await page.getByText("About prices and matching", { exact: true }).click();
  await expect(page.getByText(/Matches above 88% strength import automatically/)).toBeVisible();
});

test("expected card count can be cleared and replaced without forcing a digit back in", async ({ page }) => {
  await fixture(page, 12);
  const expected = page.getByRole("spinbutton", { name: "Cards in this photo", exact: true });
  await expected.click(); await expected.press("Backspace"); await expected.press("Backspace");
  await expect(expected).toHaveValue("");
  await expect(page.getByText(/expected cards found/)).toHaveCount(0);
  await expected.pressSequentially("15");
  await expect(expected).toHaveValue("15");
  await expect(page.getByText(/12 of 15 expected cards found/)).toBeVisible();
  await expected.press("Tab");
  await expected.click(); await expected.press("Backspace"); await expected.press("Backspace");
  await expected.pressSequentially("12"); await expected.press("Tab");
  await expect(expected).toHaveValue("12");
  await expect(page.getByText(/expected cards found/)).toHaveCount(0);
  await expected.fill(""); await expected.press("Tab");
  await expect(expected).toHaveValue("12");
});

test("zero foils needs no selection and changing the count marks only selected cards foil", async ({ page }) => {
  const mock = await fixture(page, 3, 0, [0], 0, 0);
  const panel = page.getByRole("region", { name: "Foil cards", exact: true });
  await expect(panel.getByRole("heading", { name: "0 foil · 3 nonfoil", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Select foil cards", exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Finish", exact: true })).toHaveValue("nonfoil");
  expect(mock.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  await panel.getByRole("button", { name: "Change foil cards", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "Tap any foil cards", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: /^Foil card / })).toHaveCount(3);
  await panel.getByRole("button", { name: "Foil card 1: Fixture Card 1", exact: true }).click();
  await expect(panel.getByText("1 foil card selected", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Confirm card finishes", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "1 foil · 2 nonfoil", exact: true })).toBeVisible();
  expect(mock.rows.map((row) => row.finish)).toEqual(["foil", "nonfoil", "nonfoil"]);
  expect(mock.rows[0].lot.finish).toBe("foil");
  await panel.screenshot({ path: `../../artifacts/scan-defaults/finishes-${test.info().project.name}.png` });
});

test("unselecting every foil saves every card as nonfoil", async ({ page }) => {
  const mock = await fixture(page, 3, 0, [0], 0, 2);
  const panel = page.getByRole("region", { name: "Foil cards", exact: true });
  await panel.getByRole("button", { name: "Select foil cards", exact: true }).click();
  await panel.getByRole("button", { name: "Foil card 1: Fixture Card 1", exact: true }).click();
  await panel.getByRole("button", { name: "Foil card 3: Fixture Card 3", exact: true }).click();
  await expect(panel.getByText("2 foil cards selected", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Foil card 1: Fixture Card 1", exact: true }).click();
  await panel.getByRole("button", { name: "Foil card 3: Fixture Card 3", exact: true }).click();
  await expect(panel.getByRole("button", { name: /^Foil card /, pressed: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "Confirm card finishes", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "0 foil · 3 nonfoil", exact: true })).toBeVisible();
  expect(mock.calls.find((c) => c.path.endsWith("/finishes"))?.body).toMatchObject({ foil_count: 0, foil_ids: [], etched_ids: [] });
  expect(mock.rows.every((row) => row.finish === "nonfoil")).toBe(true);
  expect(mock.rows[0].lot.finish).toBe("nonfoil");
});

test("foil selection updates auto-imported copies and preserves finishes in bulk approval", async ({ page }) => {
  const mock = await fixture(page, 15, 0, [0]);
  await page.getByRole("button", { name: "Select foil cards", exact: true }).click();
  const panel = page.getByRole("region", { name: "Foil cards", exact: true });
  await panel.getByRole("button", { name: "Foil card 1: Fixture Card 1", exact: true }).click();
  await expect(panel.getByText("1 foil card selected", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Foil card 3: Fixture Card 3", exact: true }).click();
  await expect(panel.getByText("2 foil cards selected", { exact: true })).toBeVisible();
  expect(mock.calls.filter((c) => c.path.endsWith("/finishes"))).toHaveLength(0);
  await page.screenshot({ path: `../../artifacts/scan-88-review/foil-selection-${test.info().project.name}.png`, fullPage: true });
  await panel.getByRole("button", { name: "Confirm card finishes", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "2 foil · 13 nonfoil", exact: true })).toBeVisible();
  expect(mock.rows[0].lot.finish).toBe("foil");
  expect(mock.calls.find((c) => c.path.endsWith("/finishes"))?.body.foil_ids).toEqual(["region-0", "region-2"]);
  await expect(page.getByRole("combobox", { name: "Finish", exact: true })).toHaveValue("nonfoil");
  await page.getByRole("button", { name: "Select suggestions", exact: true }).click();
  await page.getByRole("button", { name: "Import 14 selected", exact: true }).click();
  await expect(page.locator(".scan-match-state.imported")).toHaveCount(15);
  const approval = mock.calls.find((c) => c.path.endsWith("/approve"))!.body.items;
  expect(approval.find((r: any) => r.observation_id === "region-2").finish).toBe("foil");
  expect(approval.filter((r: any) => r.finish === "nonfoil")).toHaveLength(13);
  await expect(page.getByText("✓ All cards reviewed.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});


test("browser history visits batch overview and editing without discarding a cancelled finish change", async ({ page }) => {
  const mock = await fixture(page);
  const finish = page.getByRole("combobox", { name: "Finish", exact: true });
  await finish.selectOption("foil");
  await cancelBrowserBack(page);
  await expect(page).toHaveURL(/#\/batches\/scan-review-fixture$/);
  await expect(finish).toHaveValue("foil");
  page.once("dialog", (dialog) => dialog.accept());
  await page.evaluate(() => history.back());
  await expect(page.getByRole("heading", { name: "Saved batches", exact: true })).toBeVisible();
  await page.evaluate(() => history.forward());
  await expect(page.getByRole("heading", { name: "fifteen-card-test.jpg", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "fifteen-card-test.jpg", exact: true })).toBeVisible();
  await page.goto("/#/batches/scan-review-fixture/edit");
  await expect(page.getByRole("heading", { name: "Card 1 · Review suggestion", exact: true })).toBeVisible();
  expect(mock.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
});

test("strong matches approve in one tap and leave weaker or corrected cards for review", async ({ page }) => {
  const mock = await fixture(page, 4, 0, [], 0, 0);
  mock.rows[3].candidates[0].match_score = .72;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.getByRole("button", { name: "Next card", exact: true }).click();
  await page.getByRole("button", { name: "Edit card / printing", exact: true }).click();
  await page.locator(".printing-picker").getByRole("searchbox", { name: "Find an exact printing", exact: true }).fill("Fixture Card");
  await page.locator(".printing-choice").first().click();
  const strong = page.getByRole("group", { name: "Strong matches", exact: true });
  await expect(strong).toContainText("2 matches are 80% or stronger.");
  await expect(strong).toContainText("imported to Scanned cards as ungraded");
  await strong.getByRole("combobox", { name: "Match strength", exact: true }).selectOption("0.7");
  await expect(strong).toContainText("3 matches are 70% or stronger.");
  await strong.getByRole("button", { name: "Approve 3 strong matches", exact: true }).click();
  const approved = mock.calls.find((call) => call.path.endsWith("/approve"))!.body;
  expect(approved.items.map((item: any) => item.observation_id)).toEqual(["region-0", "region-2", "region-3"]);
  expect(approved.binder).toBe("Scanned cards");
  await expect(page.getByText("3 copies imported into Scanned cards.")).toBeVisible();
  await expect(strong).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Match strength", exact: true })).toHaveCount(0);
});

test("swiping the card comparison moves between cards and does not open the enlarged photo", async ({ page }) => {
  await fixture(page, 3, 0, [], 0, 0);
  const detail = page.getByRole("region", { name: "Review selected card", exact: true });
  await expect(detail.getByRole("heading", { name: "Card 1 · Review suggestion", exact: true })).toBeVisible();
  async function swipe(from: number, to: number) {
    const box = (await page.locator(".scan-comparison").boundingBox())!, y = box.y + box.height / 2;
    await page.locator(".scan-comparison").evaluate((element, points) => {
      const send = (type: string, x: number) => element.querySelector("img")!.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: "touch", isPrimary: true, clientX: x, clientY: points.y }));
      send("pointerdown", points.from); send("pointerup", points.to);
      element.querySelector("img")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }, { from: box.x + from * box.width, to: box.x + to * box.width, y });
  }
  await swipe(.8, .2);
  await expect(detail.getByRole("heading", { name: "Card 2 · Review suggestion", exact: true })).toBeVisible();
  await expect(page.locator(".scan-image-viewer")).toHaveCount(0);
  await swipe(.8, .2);
  await expect(detail.getByRole("heading", { name: "Card 3 · Review suggestion", exact: true })).toBeVisible();
  await swipe(.2, .8);
  await expect(detail.getByRole("heading", { name: "Card 2 · Review suggestion", exact: true })).toBeVisible();
  await swipe(.5, .55);
  await expect(detail.getByRole("heading", { name: "Card 2 · Review suggestion", exact: true })).toBeVisible();
});

test("condition and photo card count are remembered for the next card and batch", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mock = await fixture(page, 3, 0, [], 0, 0);
  await page.getByRole("combobox", { name: "Condition", exact: true }).selectOption("LP");
  await page.getByRole("spinbutton", { name: "Cards in this photo", exact: true }).fill("12");
  await page.getByRole("button", { name: "Approve & import", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Card 2 · Review suggestion", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Condition", exact: true })).toHaveValue("LP");
  expect(mock.calls.find((call) => call.path.endsWith("/approve"))!.body.condition).toBe("LP");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Condition", exact: true })).toHaveValue("LP");
  await expect(page.getByRole("spinbutton", { name: "Cards in this photo", exact: true })).toHaveValue("12");
  await expect(page.locator(".batch-save-status")).not.toContainText("Unsaved edits");
});

test("foil cards can be confirmed with fewer taps than the planned count", async ({ page }) => {
  const mock = await fixture(page, 4, 0, [], 0, 2);
  const panel = page.getByRole("region", { name: "Foil cards", exact: true });
  await panel.getByRole("button", { name: "Select foil cards", exact: true }).click();
  await panel.getByRole("button", { name: "Foil card 2: Fixture Card 2", exact: true }).click();
  await panel.getByRole("button", { name: "Confirm card finishes", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "1 foil · 3 nonfoil", exact: true })).toBeVisible();
  expect(mock.calls.find((call) => call.path.endsWith("/finishes"))!.body).toMatchObject({ foil_count: 1, foil_ids: ["region-1"] });
});

test("adjusting a crop opens enlarged around the card and undoes one corner at a time", async ({ page }) => {
  const mock = await fixture(page, 1);
  await page.getByRole("button", { name: "Adjust crop", exact: true }).click();
  await expect(page.locator(".crop-precision-tools")).toContainText("3×");
  const corner = page.getByRole("button", { name: "Corner 1; use arrow keys to adjust", exact: true });
  await expect.poll(async () => {
    const view = (await page.locator(".crop-viewport").boundingBox())!, box = (await corner.boundingBox())!;
    return box.x >= view.x && box.y >= view.y && box.x <= view.x + view.width && box.y <= view.y + view.height;
  }).toBe(true);
  const undo = page.getByRole("button", { name: "Undo last corner", exact: true });
  await expect(undo).toBeDisabled();
  await corner.focus(); await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: "Corner 3; use arrow keys to adjust", exact: true }).focus(); await page.keyboard.press("ArrowDown");
  await undo.click();
  expect(Number(await page.getByRole("button", { name: "Corner 3; use arrow keys to adjust", exact: true }).getAttribute("data-y"))).toBeCloseTo(.25, 5);
  expect(Number(await corner.getAttribute("data-x"))).toBeCloseTo(.052, 5);
  await undo.click();
  expect(Number(await corner.getAttribute("data-x"))).toBeCloseTo(.05, 5);
  await expect(undo).toBeDisabled();
  expect(mock.calls.filter((call) => call.method !== "GET")).toHaveLength(0);
});

test("cards turn over from the card back as the server identifies them", async ({ page }) => {
  const mock = await fixture(page, 3, 2, [], 0, 0);
  const tiles = page.locator(".scan-gallery .scan-tile-art");
  await expect(tiles.nth(1).locator(".scan-tile-back")).toHaveCount(1);
  await expect(tiles.nth(0).locator(".scan-tile-back")).toHaveCount(0);
  mock.rows[1].recognition = { status: "MATCHED", reason: "Check the collector number." } as any;
  await expect(tiles.nth(1)).toHaveAttribute("data-flip", "true", { timeout: 15000 });
  await expect(tiles.nth(1)).not.toHaveAttribute("data-flip", "true");
  await expect(tiles.nth(1).locator(".scan-tile-back")).toHaveCount(0);
  await expect(tiles.nth(2).locator(".scan-tile-back")).toHaveCount(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(page.locator(".scan-gallery .scan-tile-back")).toHaveCount(0);
});

test("auto-imported cards turn over to the catalog image and others keep the photo", async ({ page }) => {
  const mock = await fixture(page, 4, 2, [0], 0, 0);
  const tiles = page.locator(".scan-gallery .scan-tile-art");
  await expect(tiles.nth(0).locator("img")).toHaveAttribute("src", base + "/reference/printing-0/image");
  await expect(tiles.nth(1).locator("img")).toHaveAttribute("src", base + "/observations/region-1/image");
  // One card auto-imports as it is identified, the other waits for review.
  Object.assign(mock.rows[2], { state: "COMMITTED", recognition: { status: "MATCHED", reason: "Check the collector number.", auto_imported: true }, candidates: [{ printing_id: "printing-2", printing: printing(2), match_score: .95, evidence: [] }], lot: { id: "lot-region-2", version: 1, printing: printing(2), finish: "nonfoil", condition: "ungraded", quantity: 1, binder: "Scanned cards" } });
  Object.assign(mock.rows[3], { recognition: { status: "MATCHED", reason: "Check the collector number." }, candidates: [{ printing_id: "printing-3", printing: printing(3), match_score: .7, evidence: [] }] });
  await expect(tiles.nth(2)).toHaveAttribute("data-flip", "true", { timeout: 15000 });
  await expect(tiles.nth(2).locator("img:not(.scan-tile-back)")).toHaveAttribute("src", base + "/reference/printing-2/image");
  await expect(tiles.nth(3).locator("img:not(.scan-tile-back)")).toHaveAttribute("src", base + "/observations/region-3/image");
  // Picking foils always shows your own photo, since foil shine only shows there.
  mock.finish();
  await page.getByRole("button", { name: "Change foil cards", exact: true }).click({ timeout: 20000 });
  await expect(page.locator(".foil-gallery .scan-tile img").first()).toHaveAttribute("src", base + "/observations/region-0/image");
  if (process.env.SCANNER_E2E_SHOTS) await page.locator(".scan-gallery").first().screenshot({ path: process.env.SCANNER_E2E_SHOTS + "/batch-tiles.png" });
});

test("the approve button lines up with the arrows in the review bar", async ({ page }) => {
  await fixture(page, 3, 0, [], 0, 0);
  const bar = page.getByRole("navigation", { name: "Card review navigation", exact: true });
  const approve = await bar.getByRole("button", { name: "Approve & import", exact: true }).boundingBox();
  const previous = await bar.getByRole("button", { name: "Previous card", exact: true }).boundingBox();
  const next = await bar.getByRole("button", { name: "Next card", exact: true }).boundingBox();
  for (const arrow of [previous!, next!]) {
    expect(Math.abs(arrow.y - approve!.y)).toBeLessThan(1);
    expect(Math.abs(arrow.height - approve!.height)).toBeLessThan(1);
  }
  const counter = await bar.getByText("1 / 3", { exact: true }).boundingBox();
  expect(counter!.y).toBeGreaterThanOrEqual(approve!.y + approve!.height);
  const storage = await page.getByLabel("Storage location").boundingBox();
  const box = await bar.boundingBox();
  expect(Math.abs(box!.x - storage!.x)).toBeLessThan(1);
  expect(Math.abs(box!.x + box!.width - storage!.x - storage!.width)).toBeLessThan(1);
  if (process.env.SCANNER_E2E_SHOTS) await bar.screenshot({ path: process.env.SCANNER_E2E_SHOTS + "/review-bar.png" });
});

test("the upload page starts with the photo controls on a phone", async ({ page }) => {
  await fixture(page, 1, 0, [], 0, 0);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Take photo", exact: true })).toBeVisible();
  await expect(page.locator(".hero")).toBeHidden();
  expect((await page.getByRole("button", { name: "Take photo", exact: true }).boundingBox())!.y).toBeLessThan(844);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator(".hero")).toBeVisible();
});

test("a just-approved card can be put back into review with Undo", async ({ page }) => {
  const mock = await fixture(page, 3, 0, [], 0, 0);
  await page.getByRole("button", { name: "Approve & import", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Card 2 · Review suggestion", exact: true })).toBeVisible();
  await expect(page.getByText("1 copy imported into Scanned cards.")).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByText("Approval undone. The card is back in review.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Card 1 · Review suggestion", exact: true })).toBeVisible();
  expect(mock.calls.filter((call) => call.path.endsWith("/undo-approval"))).toHaveLength(1);
  expect(mock.rows[0].state).toBe("NEEDS_REVIEW");
});

test("the phone tab bar shows batches waiting for review and hides inside a batch", async ({ page }) => {
  await fixture(page, 3, 0, [], 0, 0);
  const tabs = page.getByRole("navigation", { name: "Quick navigation", exact: true });
  await expect(tabs).toHaveCount(0);
  await page.getByRole("button", { name: /Back to batches/ }).click();
  await expect(tabs.getByRole("button", { name: "Batches, 1 to review", exact: true })).toHaveAttribute("aria-current", "page");
  await tabs.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page.getByRole("button", { name: "Take photo", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(tabs).toBeHidden();
});

test("the phone tab bar keeps its buttons clear of the bottom edge", async ({ page }) => {
  await fixture(page, 3, 0, [], 0, 0);
  await page.getByRole("button", { name: /Back to batches/ }).click();
  const tabs = page.getByRole("navigation", { name: "Quick navigation", exact: true });
  const upload = tabs.getByRole("button", { name: "Upload", exact: true });
  await expect(upload).toBeVisible();
  const box = await upload.boundingBox();
  const viewport = page.viewportSize();
  expect(box!.height).toBeGreaterThanOrEqual(58);
  // iPhones add their home indicator inset on top of this; other screens keep a small gap.
  expect(viewport!.height - (box!.y + box!.height)).toBeGreaterThanOrEqual(10);
  if (process.env.SCANNER_E2E_SHOTS) await page.screenshot({ path: process.env.SCANNER_E2E_SHOTS + "/tab-bar.png" });
});
