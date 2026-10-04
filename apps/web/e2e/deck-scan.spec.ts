import { expect, test, type Page } from "@playwright/test";
import { installCamera, openCamera, takePhoto } from "./camera-fixture";
import { cancelBrowserBack, navigate } from "./navigation";

const art = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="336"><rect width="240" height="336" rx="12" fill="#244d46"/><rect x="10" y="10" width="220" height="316" rx="8" fill="#f2e7d3"/><rect x="20" y="60" width="200" height="170" fill="#7a9b93"/><text x="20" y="42" font-size="18">Sample card</text></svg>';
const printing = (i: number) => ({ id: "printing-" + i, name: ["Sample Captain", "Sample Island", "Sample Shield"][i], set_code: "tst", collector_number: String(i + 1), language: "en", finishes: ["nonfoil", "foil"], image_url: `/api/v1/card-images/printing-${i}/0/grid` });
async function fixture(page: Page) {
  const saved: any = { id: "saved-deck", name: "My blue deck", format: "commander", match_mode: "any", notes: "Sleeved in blue", version: 1, cards: [] };
  const decks = [saved], calls: any[] = [], added = new Set<string>(), receipts = new Map<string, string>();
  let loseResponse = false, processing = false, upload: any;
  const rows: any[] = [0, 1, 1, 2].map((p, i) => ({ id: "observation-" + i, scan_id: i < 2 ? "photo-one" : "photo-two", region_index: i % 2, version: 1, state: "COMMITTED", finish: "nonfoil", rotation: 0, polygon: [[.1,.1],[.4,.1],[.4,.7],[.1,.7]], crop_url: "/api/v1/scans/photo-one/image", recognition: { status: "MATCHED", auto_confirmed: true }, candidates: [{ printing_id: printing(p).id, printing: printing(p), match_score: .98, evidence: ["Name and edition match"] }], confirmed_printing: printing(p), lot: null }));
  function summary(scanId: string) { const cards = rows.filter(r => r.scan_id === scanId && r.state !== "IGNORED"); return { regions: cards.length, cards: cards.length, identified: cards.length, checked: cards.length, imported: 0, confirmed: cards.filter(r => r.state === "COMMITTED").length, needs_review: cards.filter(r => r.state === "NEEDS_REVIEW").length, value_min: "2.00", value_max: "2.00", priced_cards: cards.length, unpriced_cards: 0, unknown_finish: 0, provider: "tcgplayer", prices_updated_at: null, auto_add_enabled: true, auto_add_threshold: .88 }; }
  function scan(id: string) { return { id, filename: id + ".jpg", add_to_collection: false, target_deck: { id: saved.id, name: saved.name, archived: false }, state: processing ? "PROCESSING" : "PHOTO_READY", uploaded: true, accepted_at: "2026-09-22T12:00:00Z", created_at: "2026-09-22T12:00:00Z", expires_at: null, width: 1200, height: 1600, thumbnail_url: `/api/v1/scans/${id}/image`, duplicate_scan_id: null, summary: summary(id), finishes_confirmed: true, preview_cards: [], job: { id: "job-" + id, state: processing ? "RUNNING" : "SUCCEEDED", stage: "Checking cards", attempts: 1, error_message: null } }; }
  function detail(deck: any) {
    const cards = deck.cards.map((c: any) => ({ ...c, printing: [0, 1, 2].map(printing).find(p => p.id === c.printing_id), owned: c.quantity, needed_in_deck: c.quantity, available: c.quantity, missing: 0, locations: [] }));
    const copies = cards.reduce((sum: number, c: any) => sum + c.quantity, 0);
    const previews = cards.map((c: any) => ({ ...c.printing, section: c.section, art_url: c.printing.image_url }));
    return { ...deck, cards, copies, owned_copies: copies, missing_copies: 0, missing_cards: [], preview_cards: previews, cover_cards: previews.filter((c: any) => c.section === "commander"), colors: ["U"], colors_known: true, updated_at: "2026-09-22T12:00:00Z" };
  }
  await page.route("**/api/**", async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname, method = req.method();
    if (path.includes("/card-images/") || path.endsWith("/image")) return route.fulfill({ contentType: "image/svg+xml", body: art });
    const body = req.postData() && !path.endsWith("/upload") ? req.postDataJSON() : null;
    const key = req.headers()["idempotency-key"]; calls.push({ path, method, body, key });
    let json: any = {}, status = 200;
    if (path === "/api/auth/session") json = { owner_id: "deck-scan-fixture", display_name: "Deck collector", role: "member", csrf_token: "deck-csrf", tour_dismissed: true, scan_cards_used: 4, scan_card_limit: null, scan_cards_remaining: null, preferred_price_source: "tcgplayer" };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/binders") json = { items: [] };
    else if (path === "/api/v1/decks" && method === "GET") json = { items: decks.map(detail), next_offset: null };
    else if (path === "/api/v1/decks" && method === "POST") { const value = { ...body, id: "created-deck", version: 1, cards: [] }; decks.push(value); json = detail(value); status = 201; }
    else if (path === "/api/v1/decks/tokens") json = { items: [], missing_details: 0 };
    else if (path === "/api/v1/decks/legality") json = { format: body.format, status: "not_checked", issues: [], counts: { main: 0, sideboard: 0, commander: 0 }, catalog_updated_at: null, checked_at: "2026-09-22T12:00:00Z", rules_version: "fixture", checks: [], limitations: [] };
    else if (path.startsWith("/api/v1/decks/") && method === "GET") json = detail(decks.find(d => d.id === path.split("/").at(-1)));
    else if (path === "/api/v1/deck-scans/batches") json = { items: ["photo-one", "photo-two"].map(id => ({ ...scan(id), cards: 2, already_added: rows.filter(r => r.scan_id === id && added.has(r.id)).length })), next_offset: null };
    else if (path === "/api/v1/deck-scans/preview") json = { items: rows.filter(r => body.scan_ids.includes(r.scan_id) && r.state === "COMMITTED" && !added.has(r.id)).map(r => ({ observation_id: r.id, scan_id: r.scan_id, printing: r.confirmed_printing, section: "main" })), batches: body.scan_ids.map((id: string) => ({ id, filename: id + ".jpg", ready: 2, pending: rows.filter(r => r.scan_id === id && r.state === "NEEDS_REVIEW").length, already_added: rows.filter(r => r.scan_id === id && added.has(r.id)).length, processing })), token: "a".repeat(64), deck_version: saved.version };
    else if (path === "/api/v1/deck-scans/save") {
      expect(req.headers()["x-csrf-token"]).toBe("deck-csrf");
      if (receipts.has(key!)) expect(receipts.get(key!)).toBe(JSON.stringify(body));
      else { receipts.set(key!, JSON.stringify(body)); for (const item of body.items) { expect(added.has(item.observation_id)).toBe(false); added.add(item.observation_id); const printing_id = rows.find(r => r.id === item.observation_id).confirmed_printing.id; const existing = saved.cards.find((c: any) => c.printing_id === printing_id && c.section === item.section); if (existing) existing.quantity++; else saved.cards.push({ printing_id, section: item.section, quantity: 1 }); } saved.version++; }
      json = detail(saved);
      if (loseResponse) { loseResponse = false; status = 503; json = { detail: "Response interrupted. Retry your save." }; }
    } else if (path === "/api/v1/scans" && method === "GET") json = { items: [...(upload ? [upload] : []), scan("photo-one"), scan("photo-two")], next_offset: null };
    else if (path === "/api/v1/scans" && method === "POST") { const target = decks.find(d => d.id === body.target_deck_id); upload = { ...scan("upload-photo"), filename: body.filename, target_deck: { id: target.id, name: target.name }, add_to_collection: body.add_to_collection, state: "UPLOADING", accepted_at: null, uploaded: false, width: null, height: null, job: null }; json = upload; status = 201; }
    else if (path.endsWith("/upload")) { upload.uploaded = true; json = { uploaded: true }; }
    else if (path.endsWith("/finalize")) { upload.accepted_at = "2026-09-22T12:00:00Z"; upload.state = "QUEUED"; upload.job = { id: "upload-job", state: "QUEUED", stage: "Preparing photo", attempts: 0 }; status = 202; json = { scan_id: upload.id, safe_to_disconnect: true }; }
    else if (path.endsWith("/observations")) { const id = path.split("/")[4], cards = rows.filter(r => r.scan_id === id); json = { add_to_collection: false, items: cards, summary: summary(id), finishes: { foil_count: 0, foil_ids: [], etched_ids: [], confirmed: true, token: "f".repeat(64) } }; }
    else if (path.endsWith("/approve")) { for (const item of body.items) { const row = rows.find(r => r.id === item.observation_id); row.state = "COMMITTED"; row.confirmed_printing = row.candidates[0].printing; row.version++; row.recognition.auto_confirmed = false; } json = { confirmed: body.items.length }; }
    else if (path.startsWith("/api/v1/scans/") && method === "GET") json = path.endsWith("/upload-photo") ? upload : scan(path.split("/")[4]);
    else { status = 500; json = { detail: "Unexpected fixture request: " + path }; }
    await route.fulfill({ status, json });
  });
  await page.goto("/"); await navigate(page, "Decks");
  return { saved, rows, calls, added, processing: (value: boolean) => { processing = value; }, loseNextResponse: () => { loseResponse = true; } };
}
async function openBuilder(page: Page) { await page.getByRole("button", { name: /My blue deck/ }).click(); await page.getByRole("button", { name: "Scan cards", exact: true }).click(); }
async function selectBoth(page: Page) { await page.getByRole("checkbox", { name: /photo-one.jpg/ }).check(); await page.getByRole("checkbox", { name: /photo-two.jpg/ }).check(); await page.getByRole("button", { name: "Preview scanned cards", exact: true }).click(); }

for (const collect of [false, true]) test(`creates a named deck and uploads camera photos with collection option ${collect}`, async ({ page }) => {
  await installCamera(page); const mock = await fixture(page);
  await page.getByRole("button", { name: "Scan a deck", exact: true }).click();
  await page.getByRole("textbox", { name: "Deck name", exact: true }).fill("Photographed Commander");
  await page.getByRole("combobox", { name: "Deck format", exact: true }).selectOption("commander");
  await page.getByRole("button", { name: "Create deck for scanning", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scan cards for Photographed Commander", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Take deck photos", exact: true }).click();
  const option = page.getByRole("checkbox", { name: "Also add scanned copies to my collection", exact: true });
  await expect(option).not.toBeChecked(); if (collect) await option.check();
  await openCamera(page); await takePhoto(page); await page.getByRole("button", { name: "Upload & scan", exact: true }).click();
  await expect(page.getByRole("button", { name: "Continue building deck", exact: true })).toBeVisible();
  expect(mock.calls.find(c => c.method === "POST" && c.path === "/api/v1/scans").body).toMatchObject({ target_deck_id: "created-deck", add_to_collection: collect, content_type: "image/jpeg", foil_count: 0 });
  await page.getByRole("button", { name: "Scan next deck photo", exact: true }).click();
  await expect(option).toBeChecked({ checked: collect });
  await expect(page.locator(".scan-deck-target h3")).toHaveText("Photographed Commander");
  await page.reload(); await expect(option).toBeChecked({ checked: collect });
});

for (const mode of ["light", "dark"] as const) test(`combines batches, chooses sections and saves the deck gallery in ${mode} mode`, async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: mode }); await page.setViewportSize({ width: 320, height: 844 });
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  const mock = await fixture(page); await openBuilder(page); await selectBoth(page);
  await expect(page.locator(".deck-scan-cards > li")).toHaveCount(4);
  await page.getByRole("combobox", { name: "Section for Sample Captain, card 1", exact: true }).selectOption("commander");
  await page.getByRole("combobox", { name: "Section for Sample Shield, card 4", exact: true }).selectOption("sideboard");
  await expect(page.getByRole("region", { name: "Scanned deck preview", exact: true })).toContainText("4 cards to add · 1 commander · 2 mainboard · 1 sideboard");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `../../artifacts/deck-scanning/preview-${mode}-${info.project.name}.png`, fullPage: true });
  await page.getByRole("button", { name: "Add 4 scanned cards to deck", exact: true }).click();
  await expect(page.getByRole("region", { name: "Deck overview", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Gallery", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(mock.saved.cards).toEqual([{ printing_id: "printing-0", section: "commander", quantity: 1 }, { printing_id: "printing-1", section: "main", quantity: 2 }, { printing_id: "printing-2", section: "sideboard", quantity: 1 }]);
  await page.getByRole("button", { name: "Scan cards", exact: true }).click(); await selectBoth(page);
  await expect(page.getByText("No new reviewed cards to add.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add 0 scanned cards to deck", exact: true })).toBeDisabled();
  expect(mock.calls.some(c => c.method !== "GET" && c.path.startsWith("/api/v1/collection"))).toBe(false); expect(errors).toEqual([]);
});

test("pending matches stay out, processing blocks saving and retries retain choices and their receipt", async ({ page }) => {
  const mock = await fixture(page); mock.rows[3].state = "NEEDS_REVIEW"; mock.rows[3].confirmed_printing = null; mock.processing(true);
  await openBuilder(page); await selectBoth(page);
  await expect(page.getByText(/1 cards still need a match approved/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Add 3 scanned cards to deck", exact: true })).toBeDisabled();
  mock.processing(false); await page.getByRole("button", { name: "Refresh preview", exact: true }).click();
  await page.getByRole("combobox", { name: "Section for Sample Captain, card 1", exact: true }).selectOption("commander");
  await page.getByRole("button", { name: "Refresh preview", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add 3 scanned cards to deck", exact: true })).toBeEnabled();
  await cancelBrowserBack(page);
  await expect(page.getByRole("combobox", { name: "Section for Sample Captain, card 1", exact: true })).toHaveValue("commander");
  mock.loseNextResponse(); await page.getByRole("button", { name: "Add 3 scanned cards to deck", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Response interrupted");
  await page.getByRole("button", { name: "Add 3 scanned cards to deck", exact: true }).click();
  await expect(page.getByRole("region", { name: "Deck overview", exact: true })).toBeVisible();
  const saves = mock.calls.filter(c => c.path.endsWith("/deck-scans/save")); expect(saves).toHaveLength(2); expect(saves[0].key).toBe(saves[1].key); expect(saves[0].body).toEqual(saves[1].body); expect(mock.added.size).toBe(3);
});

test("deck batch review approves a match without collection controls and carries the batch into its deck", async ({ page }) => {
  const mock = await fixture(page); mock.rows[1].state = "NEEDS_REVIEW"; mock.rows[1].confirmed_printing = null;
  await navigate(page, "Batches"); await page.getByRole("button", { name: /photo-one.jpg/ }).click();
  await expect(page.getByText("✓ Auto-matched", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Review card 2: Sample Island", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Condition", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Approve match", exact: true }).click();
  await expect(page.getByText(/card matches saved for your deck/)).toBeVisible();
  await page.getByRole("button", { name: "Continue building deck", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /photo-one.jpg/ })).toBeChecked();
  await page.getByRole("button", { name: "Preview scanned cards", exact: true }).click();
  await expect(page.locator(".deck-scan-cards > li")).toHaveCount(2);
  expect(mock.rows.every(r => r.lot === null)).toBe(true);
});
