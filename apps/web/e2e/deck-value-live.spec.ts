import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createCollector } from "./account";
import { skipWelcomeTour } from "./navigation";

test("a saved deck displays real cached values from all three sources without changing the collection", async ({ browser, request }, info) => {
  mkdirSync("../../artifacts/deck-value", { recursive: true, mode: 0o700 });
  const account = await createCollector(request);
  writeFileSync(`../../artifacts/deck-value/account-${account.subject}.json`, JSON.stringify({ subject: account.subject, username: account.username }));
  const context = await browser.newContext({ baseURL: account.baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await page.goto("/"); await page.getByRole("link", { name: "Sign in", exact: true }).click();
    await page.locator("#username").fill(account.username); await page.locator("#password").fill(account.password); await page.locator("#kc-login").click();
    await skipWelcomeTour(page);
    const session = await (await context.request.get("/api/auth/session")).json();
    const headers = { "X-CSRF-Token": session.csrf_token, Origin: account.baseURL, "Idempotency-Key": crypto.randomUUID() };
    const candidates = (await (await context.request.get("/api/v1/catalog/search?q=Island&exact_name=true&language=en")).json()).items.filter((card: any) => card.finishes.includes("nonfoil"));
    expect(candidates.length).toBeGreaterThan(1);
    const available: string[][] = [];
    for (const provider of ["tcgplayer", "cardkingdom", "manapool"]) {
      const response = await context.request.post("/api/v1/decks/value", { headers, data: { provider, cards: candidates.map((card: any) => ({ printing_id: card.id, quantity: 1, section: "main" })) } });
      expect(response.status()).toBe(200); available.push((await response.json()).items.filter((item: any) => item.amount !== null).map((item: any) => item.printing_id));
    }
    const common = available[0].filter(id => available.every(list => list.includes(id))); expect(common.length).toBeGreaterThan(1);
    const cards = [{ printing_id: common[0], quantity: 4, section: "main" }, { printing_id: common[1], quantity: 2, section: "sideboard" }];
    const creation = await context.request.post("/api/v1/decks", { headers, data: { name: "Value fixture", format: "casual", cards } }); expect(creation.status()).toBe(201);
    const deck = await creation.json();
    await page.goto(`/#/decks/${deck.id}`);
    const panel = page.getByRole("region", { name: "Deck value", exact: true });
    for (const provider of ["tcgplayer", "cardkingdom", "manapool"]) {
      await panel.getByRole("combobox", { name: "Deck price source", exact: true }).selectOption(provider);
      await expect(panel.getByRole("combobox", { name: "Deck price source", exact: true })).toBeEnabled();
      const report = await (await context.request.post("/api/v1/decks/value", { headers, data: { provider, cards } })).json();
      const expected = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(report.amount));
      expect(report.priced_copies).toBe(6); expect(report.unpriced_copies).toBe(0);
      await expect(panel.getByLabel("Estimated deck value", { exact: true })).toHaveText(expected);
      await expect(panel).toContainText("6 of 6 copies priced");
      expect((await (await context.request.get("/api/auth/session")).json()).preferred_price_source).toBe(provider);
    }
    await panel.locator("summary").click(); await expect(panel.locator("li")).toHaveCount(2);
    await page.screenshot({ path: `../../artifacts/deck-value/live-${info.project.name}.png`, fullPage: true });
    await page.reload(); await expect(panel.getByRole("combobox", { name: "Deck price source", exact: true })).toHaveValue("manapool");
    const latest = await (await context.request.get(`/api/v1/decks/${deck.id}`)).json();
    expect(latest.version).toBe(deck.version); expect(latest.copies).toBe(6); expect(latest.valuation.provider).toBe("manapool");
    expect((await (await context.request.get("/api/v1/collection")).json()).copies).toBe(0);
    expect((await (await context.request.get("/api/auth/session")).json()).scan_cards_used).toBe(0);
  } finally { await context.close().catch(() => {}); await account.remove(); }
});
