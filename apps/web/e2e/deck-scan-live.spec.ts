import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createCollector } from "./account";
import { navigate, skipWelcomeTour } from "./navigation";

for (const collect of [false, true]) test(`physical deck photos finish on the server and save a deck with collection option ${collect}`, async ({ browser, request }, info) => {
  mkdirSync("../../artifacts/deck-scanning", { recursive: true, mode: 0o700 });
  const account = await createCollector(request);
  // Record only identifiers needed to remove this disposable fixture afterwards.
  writeFileSync(`../../artifacts/deck-scanning/account-${account.subject}.json`, JSON.stringify({ subject: account.subject, username: account.username }));
  let context = await browser.newContext({ baseURL: account.baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    let page = await context.newPage();
    await page.goto("/"); await page.getByRole("link", { name: "Sign in", exact: true }).click();
    await page.locator("#username").fill(account.username); await page.locator("#password").fill(account.password); await page.locator("#kc-login").click();
    await skipWelcomeTour(page); await navigate(page, "Decks");
    await page.getByRole("button", { name: "Scan a deck", exact: true }).click();
    await page.getByRole("textbox", { name: "Deck name", exact: true }).fill("Physical deck fixture");
    await page.getByRole("combobox", { name: "Deck format", exact: true }).selectOption("commander");
    await page.getByRole("button", { name: "Create deck for scanning", exact: true }).click();
    await page.getByRole("button", { name: "Take deck photos", exact: true }).click();
    const scans: string[] = [];
    for (const number of [1, 2]) {
      await page.getByRole("checkbox", { name: "Also add scanned copies to my collection", exact: true }).setChecked(collect);
      const accepted = page.waitForResponse(r => r.url().endsWith("/finalize") && r.status() === 202);
      await page.getByTestId("photo-input").setInputFiles({ name: `deck-${number}.jpg`, mimeType: "image/jpeg", buffer: readFileSync(`../../tests/fixtures/deck-${number}.jpg`) });
      const receipt = await (await accepted).json(); expect(receipt.safe_to_disconnect).toBe(true); scans.push(receipt.scan_id);
      if (number === 1) await page.getByRole("button", { name: "Scan next deck photo", exact: true }).click();
    }
    const state = await context.storageState(); await context.close();
    context = await browser.newContext({ baseURL: account.baseURL, storageState: state, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    // No browser page remains open while Docker finishes identification.
    for (const scanId of scans) await expect.poll(async () => (await (await context.request.get(`/api/v1/scans/${scanId}`)).json()).state, { timeout: 90000 }).toBe("PHOTO_READY");
    const session = await (await context.request.get("/api/auth/session")).json();
    expect(session.scan_cards_used).toBe(4);
    const printing = (await (await context.request.get("/api/v1/catalog/search?q=Island&exact_name=true&language=en")).json()).items.find((p: any) => p.finishes.includes("nonfoil"));
    expect(printing).toBeTruthy();
    // These are synthetic rectangles, not an identification-accuracy fixture.
    // Explicit matches exercise the real review/save pipeline and inventory rules.
    for (const scanId of scans) {
      const scan = await (await context.request.get(`/api/v1/scans/${scanId}`)).json(); expect(scan.add_to_collection).toBe(collect);
      const rows = (await (await context.request.get(`/api/v1/scans/${scanId}/observations`)).json()).items;
      expect(rows).toHaveLength(2);
      const approved = await context.request.post(`/api/v1/scans/${scanId}/approve`, { headers: { "X-CSRF-Token": session.csrf_token, Origin: account.baseURL, "Idempotency-Key": crypto.randomUUID() }, data: { items: rows.map((row: any) => ({ observation_id: row.id, expected_version: row.version, printing_id: printing.id, finish: "nonfoil" })), condition: "ungraded", binder: "Deck fixture" } });
      expect(approved.status()).toBe(200);
    }
    const deck = (await (await context.request.get("/api/v1/decks")).json()).items[0];
    page = await context.newPage(); await page.goto(`/#/decks/${deck.id}/scan`);
    for (const number of [1, 2]) await page.getByRole("checkbox", { name: new RegExp(`deck-${number}\\.jpg`) }).check();
    await page.getByRole("button", { name: "Preview scanned cards", exact: true }).click();
    await expect(page.locator(".deck-scan-cards > li")).toHaveCount(4);
    const previewArt = page.locator(".deck-scan-cards img").first(); await previewArt.scrollIntoViewIfNeeded();
    await expect.poll(() => previewArt.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await page.locator(".deck-scan-cards select").first().selectOption("commander");
    const saveRequest = page.waitForRequest(req => req.url().endsWith("/deck-scans/save"));
    await page.getByRole("button", { name: "Add 4 scanned cards to deck", exact: true }).click();
    const savedRequest = await saveRequest;
    await expect(page.getByRole("region", { name: "Deck overview", exact: true })).toBeVisible();
    const saved = await (await context.request.get(`/api/v1/decks/${deck.id}`)).json();
    expect(saved.copies).toBe(4); expect(saved.cards.map((card: any) => card.quantity).sort()).toEqual([1, 3]);
    const listed = (await (await context.request.get("/api/v1/decks")).json()).items.find((item: any) => item.id === deck.id);
    expect(listed.cover_cards[0].name).toBe("Island");
    const retry = await context.request.post("/api/v1/deck-scans/save", { data: savedRequest.postDataJSON(), headers: { "X-CSRF-Token": session.csrf_token, Origin: account.baseURL, "Idempotency-Key": savedRequest.headers()["idempotency-key"] } });
    expect(retry.status()).toBe(200); expect((await retry.json()).copies).toBe(4);
    expect((await (await context.request.get("/api/v1/collection")).json()).copies).toBe(collect ? 4 : 0);
    expect((await (await context.request.get("/api/auth/session")).json()).scan_cards_used).toBe(4);
    await page.reload(); await expect(page.getByRole("heading", { name: "Physical deck fixture", exact: true })).toBeVisible();
    const savedArt = page.locator(".deck-cards .deck-card-art img").first(); await savedArt.scrollIntoViewIfNeeded();
    await expect.poll(() => savedArt.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await page.screenshot({ path: `../../artifacts/deck-scanning/live-${collect}-${info.project.name}.png`, fullPage: true });
  } finally { await context.close().catch(() => {}); await account.remove(); }
});
