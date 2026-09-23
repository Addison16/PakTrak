import { expect, test, type Page } from "@playwright/test";
import { navigate } from "./navigation";

const printings = ["Grovekeeper", "Trail Captain", "Ember Sage"].map((name, index) => ({ id: `source-${index}`, name, set_code: "tst", collector_number: String(index), language: "en", finishes: ["nonfoil"], image_url: `/api/v1/card-images/source-${index}/0/grid` }));
const tokens = [
  { id: "beast", name: "Beast", power: "3", toughness: "3", colors: ["G"], type_line: "Token Creature — Beast", oracle_text: "", sources: [0, 1] },
  { id: "white-soldier", name: "Soldier", power: "1", toughness: "1", colors: ["W"], type_line: "Token Creature — Soldier", oracle_text: "Vigilance", sources: [0] },
  { id: "red-soldier", name: "Soldier", power: "2", toughness: "2", colors: ["R"], type_line: "Token Creature — Soldier", oracle_text: "Haste", sources: [1] },
  { id: "emblem", name: "Ember Sage Emblem", power: null, toughness: null, colors: null, type_line: "Emblem — Sage", oracle_text: "Creatures you control have vigilance.", sources: [2] },
];

async function fixture(page: Page) {
  const state = { cards: [{ printing_id: printings[0].id, quantity: 4, section: "main" }, { printing_id: printings[1].id, quantity: 1, section: "commander" }, { printing_id: printings[2].id, quantity: 1, section: "sideboard" }], format: "commander", version: 1,
    tokenCalls: [] as any[], saves: 0, failTokens: false, failImages: false, errors: [] as string[], unexpected: [] as string[] };
  function report(cards: typeof state.cards) {
    const items = tokens.flatMap((token) => {
      const sources = token.sources.flatMap((index) => {
        const matching = cards.filter((card) => card.printing_id === printings[index].id);
        return matching.length ? [{ printing_id: printings[index].id, name: printings[index].name, sections: matching.map((card) => card.section) }] : [];
      });
      return sources.length ? [{ id: token.id, name: token.name, kind: token.id === "emblem" ? "emblem" : "token", details_available: true, sideboard_only: sources.every((source) => source.sections.every((section) => section === "sideboard")), sources, faces: [{ ...token, image_url: `/api/v1/card-images/related/${sources[0].printing_id}/${token.id}/0/grid`, detail_image_url: `/api/v1/card-images/related/${sources[0].printing_id}/${token.id}/0/detail` }] }] : [];
    });
    return { items, missing_details: 0 };
  }
  function deck() {
    return { id: "token-deck", name: "Token parade", format: state.format, notes: "", match_mode: "any", version: state.version, copies: state.cards.reduce((sum, card) => sum + card.quantity, 0), owned_copies: 0, missing_copies: 6,
      cards: state.cards.map((card) => ({ ...card, printing: printings.find((printing) => printing.id === card.printing_id), owned: 0, available: 0, missing: card.quantity, locations: [] })), missing_cards: [], tokens: report(state.cards) };
  }
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (path.startsWith("/api/v1/card-images/")) return state.failImages ? route.fulfill({ status: 503, body: "Artwork unavailable" }) : route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="336"><rect width="240" height="336" rx="14" fill="#244d46"/><rect x="12" y="12" width="216" height="312" rx="8" fill="#f2e7d3"/><circle cx="120" cy="160" r="70" fill="#85a791"/><text x="30" y="45" font-size="22">Token fixture</text></svg>' });
    if (path === "/api/auth/status") return reply({ setup_required: false, guest_signup_enabled: true });
    if (path === "/api/auth/session") return reply({ owner_id: "token-fixture", display_name: "Token collector", csrf_token: "token-csrf", role: "member", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0 });
    if (path === "/api/v1/capabilities") return reply({ max_upload_bytes: 104857600 });
    if (path === "/api/v1/scans") return reply({ items: [], next_offset: null });
    if (path === "/api/v1/decks") return reply({ items: [deck()], next_offset: null });
    if (path === "/api/v1/decks/token-deck") {
      if (req.method() === "POST") {
        const body = req.postDataJSON(); state.cards = body.cards; state.format = body.format; state.version++; state.saves++;
      }
      return reply(deck());
    }
    if (path === "/api/v1/decks/tokens") {
      expect(req.headers()["x-csrf-token"]).toBe("token-csrf");
      const body = req.postDataJSON(); state.tokenCalls.push(body);
      return state.failTokens ? reply({ detail: "Temporarily unavailable" }, 503) : reply(report(body.cards));
    }
    if (path === "/api/v1/decks/legality") return reply({ format: state.format, status: "not_checked", issues: [], counts: { main: 0, sideboard: 0, commander: 0 }, checked_at: "2026-09-21T00:00:00Z", catalog_updated_at: null, checks: [], limitations: [] });
    state.unexpected.push(path); return reply({ detail: "Unexpected test request" }, 500);
  });
  await page.goto("/"); await navigate(page, "Decks");
  await page.getByRole("button", { name: /Token parade/ }).click();
  await expect(page.getByRole("region", { name: "Tokens for this deck", exact: true })).toBeVisible();
  return { state, report };
}

for (const theme of ["light", "dark"] as const) test(`tokens appear below the deck with distinct stats, sources and artwork in ${theme} mode`, async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 740 }); await page.emulateMedia({ colorScheme: theme });
  const { state } = await fixture(page);
  const panel = page.getByRole("region", { name: "Tokens for this deck", exact: true });
  await expect(panel.locator(".token-row")).toHaveCount(4);
  await expect(panel).toContainText("4 types");
  await expect(panel).toContainText("1/1 · White"); await expect(panel).toContainText("2/2 · Red");
  await expect(panel).toContainText("Extras only");
  expect(await panel.evaluate((element) => { const sections = [...document.querySelectorAll(".deck-card-section")]; return sections.every((section) => !!(section.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)); })).toBe(true);
  const beast = panel.locator(".token-row").filter({ has: page.getByRole("heading", { name: "Beast", exact: true }) });
  await expect(beast.getByRole("button", { name: "View Grovekeeper in deck", exact: true })).toBeVisible();
  await expect(beast.getByRole("button", { name: "View Trail Captain in deck", exact: true })).toBeVisible();
  await beast.scrollIntoViewIfNeeded();
  await expect.poll(() => beast.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await beast.getByRole("button", { name: "Preview Beast token", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Beast", exact: true });
  await expect(dialog).toBeVisible(); await expect(dialog).toContainText("3/3 · Green");
  await dialog.getByRole("button", { name: "Back to token list" }).click(); await expect(dialog).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Find a card in this deck" }).fill("Ember");
  await expect(panel.locator(".token-row")).toHaveCount(4);
  await beast.getByRole("button", { name: "View Grovekeeper in deck", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Grovekeeper", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close deck card preview" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: `../../artifacts/deck-tokens/tokens-${theme}-${info.project.name}.png` });
  expect(state.tokenCalls).toHaveLength(0); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("token drafts follow quantity changes, keep shared tokens and persist after saving", async ({ page }) => {
  const { state } = await fixture(page);
  await page.getByRole("button", { name: "Edit deck", exact: true }).click();
  const panel = page.getByRole("region", { name: "Tokens for this deck", exact: true });
  const quantity = page.locator(".deck-card-row").filter({ hasText: "Grovekeeper" }).getByRole("spinbutton", { name: "Copies in deck" });
  await quantity.fill(""); await expect(panel).toContainText("Finish entering card quantities");
  expect(state.tokenCalls).toHaveLength(0);
  await quantity.fill("0");
  await expect(panel).toContainText("3 types");
  await expect(panel).not.toContainText("1/1 · White"); await expect(panel).toContainText("Beast");
  await expect(panel).not.toContainText("Grovekeeper");
  expect(state.tokenCalls.at(-1).cards.every((card: any) => card.quantity > 0)).toBe(true);
  await page.getByRole("combobox", { name: "Deck format", exact: true }).selectOption("standard");
  await expect(panel).toContainText("Sideboard only");
  await page.getByRole("button", { name: "Save deck", exact: true }).click();
  await expect(panel).not.toContainText("unsaved deck");
  expect(state.saves).toBe(1);
  await page.getByRole("button", { name: "Close deck", exact: true }).click();
  await page.getByRole("button", { name: /Token parade/ }).click();
  await expect(panel).toContainText("3 types");
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("token lookups retry without discarding edits and unavailable artwork keeps card information", async ({ page }) => {
  const { state } = await fixture(page); state.failTokens = true; state.failImages = true;
  await page.getByRole("button", { name: "Edit deck", exact: true }).click();
  await page.getByLabel("Deck name", { exact: true }).fill("Token parade revised");
  const panel = page.getByRole("region", { name: "Tokens for this deck", exact: true });
  await expect(panel).toContainText("Token list unavailable");
  state.failTokens = false;
  await panel.getByRole("button", { name: "Retry token list" }).click();
  await expect(panel).toContainText("4 types");
  await panel.getByRole("button", { name: "Preview Beast token" }).click();
  const dialog = page.getByRole("dialog", { name: "Beast", exact: true });
  await expect(dialog).toContainText("Artwork unavailable"); await expect(dialog).toContainText("3/3 · Green");
  await dialog.getByRole("button", { name: "Close token preview" }).click();
  await expect(page.getByLabel("Deck name", { exact: true })).toHaveValue("Token parade revised");
  expect(state.saves).toBe(0); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("outdated token replies cannot restore tokens removed from the current draft", async ({ page }) => {
  const { report } = await fixture(page);
  await page.getByRole("button", { name: "Edit deck", exact: true }).click();
  let started = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/decks/tokens", async (route) => {
    const body = route.request().postDataJSON();
    if (body.cards.length === 2) { started = true; await gate; }
    await route.fulfill({ json: report(body.cards) }).catch(() => {});
  });
  const rows = page.locator(".deck-card-row");
  await rows.filter({ hasText: "Ember Sage" }).getByRole("button", { name: "Remove from deck" }).click();
  await expect.poll(() => started).toBe(true);
  await rows.filter({ hasText: "Grovekeeper" }).getByRole("button", { name: "Remove from deck" }).click();
  await rows.filter({ hasText: "Trail Captain" }).getByRole("button", { name: "Remove from deck" }).click();
  const panel = page.getByRole("region", { name: "Tokens for this deck", exact: true });
  await expect(panel).toContainText("Add cards to see which tokens this deck uses");
  release();
  await expect(panel).toContainText("0 types"); await expect(panel.locator(".token-row")).toHaveCount(0);
});
