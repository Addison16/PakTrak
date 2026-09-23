import { expect, test, type Page } from "@playwright/test";
import { cancelBrowserBack, navigate } from "./navigation";

const printings = Array.from({ length: 7 }, (_, index) => ({ id: `deck-card-${index}`, name: `Fixture Card ${index + 1}`, set_code: "tst", collector_number: String(index + 1), language: "en", finishes: ["nonfoil", "foil"], image_url: `/api/v1/card-images/deck-card-${index}/0/grid` }));

async function fixture(page: Page, boxes = false) {
  const saved: any = { id: "saved-deck", name: "Friday night", notes: "Bring blue sleeves", format: "commander", match_mode: "exact", version: 1,
    cards: [{ printing_id: printings[0].id, quantity: 4, section: "main" }, { printing_id: printings[1].id, quantity: 1, section: "commander" }, { printing_id: printings[2].id, quantity: 1, section: "sideboard" }] };
  const empty: any = { ...saved, id: "empty-deck", name: "Next idea", cards: [], notes: "" };
  const decks = [saved, empty];
  if (boxes) decks.splice(0, 2,
    { ...saved, colors: ["W", "U"] },
    { ...saved, id: "partners", name: "Partners in adventure", colors: ["W", "U", "B", "R", "G"], cards: [{ printing_id: printings[3].id, quantity: 1, section: "commander" }, { printing_id: printings[4].id, quantity: 1, section: "commander" }, { printing_id: printings[5].id, quantity: 98, section: "main" }] },
    { ...saved, id: "red-deck", name: "Red hot spells", format: "modern", colors: ["R"], cards: [{ printing_id: printings[0].id, quantity: 60, section: "main" }] },
    empty,
    { ...saved, id: "no-commander", name: "Still brewing", colors: ["G"], cards: [{ printing_id: printings[5].id, quantity: 20, section: "main" }] },
    { ...saved, id: "long-name", name: "A very long green deck name with Supercalifragilisticexpialidocious", format: "casual", colors: ["G"], cards: [{ printing_id: printings[6].id, quantity: 40, section: "main" }] },
  );
  const calls: { method: string; path: string; body: any; key: string | undefined }[] = [];
  const receipts = new Map<string, string>();
  let loseResponse = false;
  function detail(deck: any) {
    const remaining: Record<string, number> = { [printings[0].id]: 2 };
    const cards = deck.cards.map((card: any) => {
      const printing = printings.find((p) => p.id === card.printing_id)!;
      const available = Math.min(card.quantity, remaining[printing.id] || 0);
      remaining[printing.id] = (remaining[printing.id] || 0) - available;
      return { ...card, printing, owned: printing.id === printings[0].id ? 2 : 0, available, missing: card.quantity - available, locations: printing.id === printings[0].id ? [{ id: "red", name: "Red binder", quantity: 2 }] : [] };
    });
    const previews = [...new Set<string>(deck.cards.map((card: any) => card.printing_id))].map((id) => ({ ...printings.find((p) => p.id === id)!, section: deck.cards.find((card: any) => card.printing_id === id).section, art_url: `/api/v1/card-images/${id}/0/art` }));
    const covers = deck.format === "commander" ? previews.filter((card) => card.section === "commander").slice(0, 2) : previews.filter((card) => card.section === "main").slice(0, 1);
    return { ...deck, cards, colors: deck.colors || (deck.cards.length ? ["U"] : []), colors_known: true, cover_cards: covers, copies: cards.reduce((sum: number, card: any) => sum + card.quantity, 0), owned_copies: cards.reduce((sum: number, card: any) => sum + card.available, 0), missing_copies: cards.reduce((sum: number, card: any) => sum + card.missing, 0), missing_cards: cards.filter((card: any) => card.missing > 0).map((card: any) => ({ printing: card.printing, quantity: card.missing })), preview_cards: previews.slice(0, 6), unique_printings: previews.length, updated_at: "2026-09-19T12:00:00Z" };
  }
  await page.route("**/api/**", async (route) => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname, method = req.method();
    const body = req.postData() ? JSON.parse(req.postData()!) : null;
    const key = req.headers()["idempotency-key"];
    calls.push({ method, path, body, key });
    if (path.startsWith("/api/v1/card-images/")) return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="336"><rect width="240" height="336" rx="12" fill="#244d46"/><rect x="10" y="10" width="220" height="316" rx="8" fill="#f2e7d3"/><rect x="20" y="60" width="200" height="170" fill="#7a9b93"/><text x="20" y="42" font-size="18">Fixture card</text></svg>' });
    let json: any = {}, status = 200;
    if (path === "/api/auth/session") json = { owner_id: "deck-fixture", display_name: "Deck collector", csrf_token: "deck-csrf", role: "member", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/scans") json = { items: [], next_offset: null };
    else if (path === "/api/v1/decks" && method === "GET") json = { items: (url.searchParams.get("offset") === "20" ? [empty] : decks).map(detail), next_offset: url.searchParams.get("offset") === "20" ? null : 20 };
    else if (path === "/api/v1/decks" && method === "POST") { const deck = { ...body, id: "created-deck", version: 1, cards: body.cards || [] }; decks.unshift(deck); json = detail(deck); }
    else if (path === "/api/v1/decks/import-preview") {
      json = { items: body.content.split("\n").filter(Boolean).map((line: string, index: number) => {
        const [quantity, id, section = "main"] = line.split(" ");
        const printing = printings.find((p) => p.id === id) || null;
        return { line: index + 1, name: id, quantity: Number(quantity), section, printing, error: printing ? null : "Card not found.", can_choose: true };
      }) };
    } else if (path === "/api/v1/decks/tokens") {
      json = { items: [], missing_details: 0 };
    } else if (path === "/api/v1/decks/legality") {
      json = { format: body.format, status: "not_checked", issues: [], counts: { commander: 0, main: 0, sideboard: 0 }, catalog_updated_at: null, checked_at: "2026-09-20T12:00:00Z", rules_version: "fixture", checks: [], limitations: [] };
    } else if (path.startsWith("/api/v1/decks/")) {
      const deck = decks.find((item) => path === "/api/v1/decks/" + item.id);
      if (!deck) { status = 404; json = { detail: "Deck not found" }; }
      else if (method === "GET") json = detail(deck);
      else {
        expect(req.headers()["x-csrf-token"]).toBe("deck-csrf");
        if (receipts.has(key!)) { expect(receipts.get(key!)).toBe(JSON.stringify(body)); json = detail(deck); }
        else if (body.expected_version !== deck.version) { status = 409; json = { detail: "This deck changed. Reload it before saving." }; }
        else {
          receipts.set(key!, JSON.stringify(body)); Object.assign(deck, body, { version: deck.version + 1 }); json = detail(deck);
          if (loseResponse) { loseResponse = false; status = 503; json = { detail: "Response interrupted. Retry your save." }; }
        }
      }
    } else if (path === "/api/v1/catalog/search") json = { items: printings, next_offset: null, filters: { sets: [], rarities: [], languages: [] } };
    else { status = 500; json = { detail: "Unexpected fixture request: " + path }; }
    await route.fulfill({ status, json });
  });
  await page.goto("/"); await navigate(page, "Decks");
  return { calls, saved, decks, loseNextResponse: () => { loseResponse = true; } };
}

async function openSaved(page: Page) { await page.getByRole("button", { name: /Friday night/ }).click(); }

for (const mode of ["light", "dark"] as const) for (const width of [320, 390, 1280]) {
  test(`${mode} deck boxes keep three columns and commander covers at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ colorScheme: mode });
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await fixture(page, true);
    const boxes = page.getByRole("list", { name: "Saved deck boxes" }).locator(".deck-box-button");
    await expect(boxes).toHaveCount(6);
    const rectangles = await boxes.locator(".deck-box").evaluateAll((elements) => elements.map((el) => {
      const { x, y, width, height } = el.getBoundingClientRect(); return { x, y, width, height };
    }));
    expect(Math.abs(rectangles[0].y - rectangles[2].y)).toBeLessThan(1);
    expect(Math.abs(rectangles[3].y - rectangles[5].y)).toBeLessThan(1);
    expect(rectangles[3].y).toBeGreaterThan(rectangles[0].y + rectangles[0].height);
    expect(rectangles[1].x).toBeGreaterThan(rectangles[0].x + rectangles[0].width);
    expect(rectangles[2].x).toBeGreaterThan(rectangles[1].x + rectangles[1].width);
    expect(rectangles[0].width).toBeGreaterThan(70);
    const commander = page.getByRole("button", { name: /Friday night.*Commander: Fixture Card 2/ });
    await expect(commander).toHaveAttribute("data-deck-colors", "WU");
    await expect(commander.locator("img")).toHaveAttribute("src", "/api/v1/card-images/deck-card-1/0/art");
    const partners = page.getByRole("button", { name: /Partners in adventure/ });
    await expect(partners.locator("img")).toHaveCount(2);
    await expect(partners.locator(".deck-mana-pip")).toHaveCount(5);
    expect(await partners.locator(".deck-box-front").evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("linear-gradient");
    const modern = page.getByRole("button", { name: /Red hot spells.*Featured card: Fixture Card 1/ });
    await expect(modern).toHaveAttribute("data-deck-colors", "R");
    await expect(modern.locator("img")).toHaveCount(1);
    await expect(page.getByRole("button", { name: /Next idea.*Colorless/ }).locator("img")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Still brewing.*Commander not set/ }).locator("img")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `../../artifacts/deck-boxes/shelf-${mode}-${width}-${test.info().project.name}.png`, fullPage: true });
    await modern.click();
    await expect(page.getByRole("heading", { name: "Red hot spells", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close deck", exact: true }).click();
    await expect(modern).toBeFocused();
    expect(errors).toEqual([]);
  });
}

test("deck box remains named and keyboard accessible when artwork fails", async ({ page }) => {
  await fixture(page);
  await page.route("**/api/v1/card-images/deck-card-1/0/art", (route) => route.fulfill({ status: 503, body: "Temporary fixture outage" }));
  await page.reload(); await navigate(page, "Decks");
  const box = page.getByRole("button", { name: /Friday night.*Commander: Fixture Card 2/ });
  await expect(box.locator("img")).toHaveCount(0);
  await expect(box.locator(".deck-box-mark")).toBeVisible();
  await box.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Friday night", exact: true })).toBeVisible();
});

test("deck quantities can be cleared, replaced with 30 and retried without adding copies twice", async ({ page }) => {
  const mock = await fixture(page); await openSaved(page);
  await page.getByRole("button", { name: "Edit deck", exact: true }).click();
  const row = page.locator(".deck-card-row").filter({ hasText: "Fixture Card 1" });
  const quantity = row.getByRole("spinbutton", { name: "Copies in deck", exact: true });
  await quantity.fill("");
  await expect(quantity).toHaveValue("");
  await expect(page.getByRole("button", { name: "Save deck", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save & done", exact: true }).first()).toBeDisabled();
  await expect(row).toContainText("Enter a quantity");
  await quantity.fill("0");
  await expect(quantity).toHaveValue("0");
  await expect(row).toContainText("Removed from this deck when you save");
  await quantity.fill(""); await quantity.pressSequentially("30"); await quantity.press("Tab");
  await expect(quantity).toHaveValue("30");
  expect(mock.saved.cards[0].quantity).toBe(4);
  mock.loseNextResponse();
  await page.getByRole("button", { name: "Save & done", exact: true }).first().click();
  await expect(page.getByRole("alert")).toContainText("Response interrupted");
  await expect(quantity).toHaveValue("30");
  await page.getByRole("button", { name: "Save & done", exact: true }).first().click();
  await expect(page.getByRole("region", { name: "Deck overview", exact: true })).toBeVisible();
  const saves = mock.calls.filter((call) => call.method === "POST" && call.path === "/api/v1/decks/saved-deck");
  expect(saves).toHaveLength(2); expect(saves[0].key).toBe(saves[1].key);
  expect(mock.saved.cards[0].quantity).toBe(30);
  expect(saves[0].body.cards[0].quantity).toBe(30);
  await page.getByRole("button", { name: "Close deck", exact: true }).click(); await openSaved(page);
  await expect(page.locator(".deck-card-row").filter({ hasText: "Fixture Card 1" })).toContainText("×30");
});

test("zero deck quantity keeps the row until save and removes only that deck entry", async ({ page }) => {
  const mock = await fixture(page); await openSaved(page);
  await page.getByRole("button", { name: "Edit deck", exact: true }).click();
  const row = page.locator(".deck-card-row").filter({ hasText: "Fixture Card 1" });
  const quantity = row.getByRole("spinbutton", { name: "Copies in deck", exact: true });
  await quantity.fill("0"); await quantity.press("Tab");
  await expect(quantity).toHaveValue("0");
  await expect(row).toContainText("Removed from this deck when you save");
  await expect(page.locator(".deck-card-row")).toHaveCount(3);
  expect(mock.saved.cards).toHaveLength(3);
  await expect.poll(() => mock.calls.filter((call) => call.path === "/api/v1/decks/legality").length).toBeGreaterThan(0);
  expect(mock.calls.filter((call) => call.path === "/api/v1/decks/legality").at(-1)!.body.cards.every((card: any) => card.quantity > 0)).toBe(true);
  await page.getByRole("button", { name: "Save deck", exact: true }).click();
  await expect(page.locator(".deck-card-row")).toHaveCount(2);
  expect(mock.saved.cards.map((card: any) => card.printing_id)).toEqual([printings[1].id, printings[2].id]);
  expect(mock.calls.some((call) => call.method !== "GET" && call.path.startsWith("/api/v1/collection"))).toBe(false);
});

test("deck quantity validation preserves unfinished input and normalizes leading zeros after editing", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await fixture(page); await openSaved(page);
  await page.getByRole("button", { name: "Edit deck", exact: true }).click();
  const row = page.locator(".deck-card-row").filter({ hasText: "Fixture Card 1" });
  const quantity = row.getByRole("spinbutton", { name: "Copies in deck", exact: true });
  for (const value of ["", "-1", "3.5", "100001"]) {
    await quantity.fill(value);
    await expect(quantity).toHaveValue(value);
    await expect(quantity).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("button", { name: "Save deck", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save & done", exact: true }).last()).toBeDisabled();
  }
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Close deck", exact: true }).click();
  await expect(quantity).toHaveValue("100001");
  await quantity.fill("030"); await quantity.press("Tab");
  await expect(quantity).toHaveValue("30");
  await expect(quantity).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("button", { name: "Save deck", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("deck quantity edits combine correctly when moving matching cards into the same section", async ({ page }) => {
  const mock = await fixture(page);
  mock.saved.cards.push({ printing_id: printings[0].id, section: "sideboard", quantity: 2 });
  await openSaved(page); await page.getByRole("button", { name: "Edit deck", exact: true }).click();
  const main = page.getByRole("region", { name: "Mainboard", exact: true }).locator(".deck-card-row").filter({ hasText: "Fixture Card 1" });
  const side = page.getByRole("region", { name: "Sideboard", exact: true }).locator(".deck-card-row").filter({ hasText: "Fixture Card 1" });
  await side.getByRole("spinbutton", { name: "Copies in deck", exact: true }).fill("3");
  await main.getByRole("spinbutton", { name: "Copies in deck", exact: true }).fill("");
  await main.getByRole("spinbutton", { name: "Copies in deck", exact: true }).pressSequentially("30");
  await main.getByRole("combobox", { name: "Deck section", exact: true }).selectOption("sideboard");
  await expect(main).toHaveCount(0);
  await expect(side.getByRole("spinbutton", { name: "Copies in deck", exact: true })).toHaveValue("33");
  await page.getByRole("button", { name: "Save deck", exact: true }).click();
  expect(mock.saved.cards.find((card: any) => card.printing_id === printings[0].id)).toMatchObject({ section: "sideboard", quantity: 33 });
});

test("collector-number shortcuts work in saved decks and the picker without an initial printing", async ({ page }) => {
  await fixture(page); await openSaved(page);
  const filter = page.getByRole("searchbox", { name: "Find a card in this deck", exact: true });
  await filter.fill("Fixture Card 1 #1");
  await expect(page.locator(".deck-cards > li")).toHaveCount(1);
  await filter.fill("Fixture Card 1 #11");
  await expect(page.locator(".deck-cards > li")).toHaveCount(0);
  await filter.fill("#2");
  await expect(page.locator(".deck-cards > li")).toHaveCount(1);
  await expect(page.locator(".deck-cards")).toContainText("Fixture Card 2");
  await filter.fill("");
  await page.getByRole("button", { name: "Edit deck", exact: true }).click();
  await page.getByText("Add any card, including cards you need", { exact: true }).click();
  const queries: URLSearchParams[] = [];
  await page.route("**/api/v1/catalog/search?*", (route) => {
    const params = new URL(route.request().url()).searchParams; queries.push(params);
    return route.fulfill({ json: { items: [printings[0]], next_offset: null, filters: { sets: [{ code: "tst", name: "Fixture edition" }], rarities: ["rare"], languages: ["en"] } } });
  });
  const picker = page.locator(".printing-picker");
  await picker.getByRole("searchbox", { name: "Find an exact printing", exact: true }).fill("Fixture Card 1 #1");
  await expect(picker.getByRole("textbox", { name: "Collector number", exact: true })).toHaveValue("1");
  await expect(picker.getByRole("combobox", { name: "Set / expansion", exact: true }).locator('option[value="tst"]')).toBeAttached();
  await picker.getByRole("combobox", { name: "Set / expansion", exact: true }).selectOption("tst");
  await expect(picker.getByRole("list", { name: "Matching printings", exact: true })).toHaveAttribute("aria-busy", "false");
  expect(queries.at(-1)!.get("q")).toBe("Fixture Card 1 #1");
  expect(queries.at(-1)!.get("set_code")).toBe("tst");
  expect(queries.at(-1)!.get("facets")).toBe("true");
  expect(queries.at(-1)!.get("exact_name")).toBe("false");
});

test("TCGplayer buy lists include only missing copies and link to Mass Entry", async ({ page }) => {
  const mock = await fixture(page); await openSaved(page);
  await page.locator(".deck-shopping > summary").click();
  const panel = page.getByRole("region", { name: "Missing cards buy list", exact: true });
  await panel.getByRole("combobox", { name: "Buy list format", exact: true }).selectOption("tcgplayer");
  await expect(panel.getByRole("textbox", { name: "Missing cards to copy", exact: true })).toHaveValue("2 Fixture Card 1 [TST] 1\n1 Fixture Card 2 [TST] 2\n1 Fixture Card 3 [TST] 3");
  await expect(panel.getByRole("link", { name: "Download buy list", exact: true })).toHaveAttribute("href", "/api/v1/decks/saved-deck/buy-list?format=tcgplayer");
  const destination = panel.getByRole("link", { name: "TCGplayer’s Mass Entry", exact: true });
  await expect(destination).toHaveAttribute("href", "https://www.tcgplayer.com/massentry");
  await expect(destination).toHaveAttribute("target", "_blank");
  await expect(panel).toContainText("Set codes and collector numbers are included");
  mock.saved.match_mode = "any";
  await panel.getByRole("button", { name: "Refresh collection comparison", exact: true }).click();
  await expect(panel.getByRole("textbox", { name: "Missing cards to copy", exact: true })).toHaveValue("2 Fixture Card 1\n1 Fixture Card 2\n1 Fixture Card 3");
  await expect(panel).toContainText("Choose your preferred printings in the store");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `../../artifacts/adjacent-cards/tcgplayer-${test.info().project.name}.png`, fullPage: true });
});

for (const mode of ["light", "dark"] as const) for (const width of [320, 390, 1280]) {
  test(`${mode} deck list, overview and editor at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ colorScheme: mode });
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await fixture(page);
    const row = page.getByRole("button", { name: /Friday night/ });
    await expect(page.locator(".deck-list-rows > li")).toHaveCount(2);
    await expect(row).toContainText("6 cards"); await expect(row.locator("img")).toHaveCount(1);
    await expect(row.locator("img")).toHaveAttribute("src", "/api/v1/card-images/deck-card-1/0/art");
    await page.screenshot({ path: `../../artifacts/deck-navigation/list-${mode}-${width}-${test.info().project.name}.png`, fullPage: true });
    await openSaved(page);
    await expect(page.getByRole("heading", { name: "Your decks", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Deck name", exact: true })).toHaveCount(0);
    await expect(page.locator(".deck-cards > li")).toHaveCount(3);
    await expect(page.getByRole("button", { name: "Gallery", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".deck-gallery .deck-art-button")).toHaveCount(3);
    const artBox = await page.locator(".deck-gallery .deck-art-button").first().boundingBox();
    expect(artBox!.width).toBeGreaterThan(90); expect(artBox!.height).toBeGreaterThan(125);
    await expect(page.getByText("Bring blue sleeves", { exact: true })).toBeVisible();
    await page.getByRole("searchbox", { name: "Find a card in this deck", exact: true }).fill("Fixture Card 1");
    await expect(page.locator(".deck-cards > li")).toHaveCount(1);
    await expect(page.locator(".deck-cards")).toContainText("Red binder (2)");
    await page.getByRole("searchbox", { name: "Find a card in this deck", exact: true }).fill("");
    await page.screenshot({ path: `../../artifacts/deck-navigation/overview-${mode}-${width}-${test.info().project.name}.png`, fullPage: true });
    await page.getByRole("button", { name: "Edit deck", exact: true }).click();
    await page.getByRole("textbox", { name: "Deck notes", exact: true }).fill("Updated sleeves");
    await expect(page.getByRole("button", { name: "Import deck list", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Save & done", exact: true }).first().click();
    await expect(page.getByRole("region", { name: "Deck overview", exact: true })).toBeVisible();
    await expect(page.getByText("Updated sleeves", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close deck", exact: true }).click();
    await expect(row).toBeFocused();
    await openSaved(page);
    await page.getByRole("button", { name: /Back to decks/ }).click();
    await expect(page.getByRole("heading", { name: "Your decks", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test("replace and add imports use owned editions, preserve deck details and merge section quantities", async ({ page }) => {
  const mock = await fixture(page); await openSaved(page);
  await page.getByRole("button", { name: "Import deck list", exact: true }).click();
  await expect(page.getByRole("region", { name: "Deck overview", exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Paste deck list", exact: true }).fill("2 deck-card-0 main\n1 deck-card-0 main\n1 deck-card-0 sideboard\n1 Unknown main");
  await page.getByRole("button", { name: "Preview deck list", exact: true }).click();
  await expect(page.getByRole("button", { name: "Replace deck list", exact: true })).toBeDisabled();
  await page.locator(".deck-import-rows > li").filter({ hasText: "Unknown" }).getByRole("button", { name: "Exclude row", exact: true }).click();
  await expect(page.locator(".deck-import-impact")).toContainText("6 → 4 cards");
  await expect(page.locator(".deck-import-impact")).toContainText("1 copy added · 3 copies removed");
  expect(mock.saved.cards).toHaveLength(3);
  await page.screenshot({ path: `../../artifacts/deck-navigation/import-${test.info().project.name}.png`, fullPage: true });
  await page.getByRole("button", { name: "Replace deck list", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Friday night", exact: true })).toBeVisible();
  expect(mock.saved.cards).toEqual([{ printing_id: "deck-card-0", section: "main", quantity: 3 }, { printing_id: "deck-card-0", section: "sideboard", quantity: 1 }]);
  expect(mock.saved).toMatchObject({ notes: "Bring blue sleeves", format: "commander", match_mode: "any", use_collection_versions: true });
  await page.getByRole("button", { name: "Import deck list", exact: true }).click();
  await page.getByRole("radio", { name: /^Add to current list/ }).check();
  await page.getByLabel("Deck list file", { exact: true }).setInputFiles({ name: "extra-cards.txt", mimeType: "text/plain", buffer: Buffer.from("2 deck-card-0 main\n1 deck-card-1 commander") });
  await page.getByRole("button", { name: "Preview deck list", exact: true }).click();
  await expect(page.locator(".deck-import-impact")).toContainText("4 → 7 cards");
  await page.getByRole("button", { name: "Add cards to deck", exact: true }).click();
  await expect(page.getByRole("region", { name: "Deck overview", exact: true })).toBeVisible();
  expect(mock.saved.cards.find((card: any) => card.printing_id === "deck-card-0" && card.section === "main").quantity).toBe(5);
  expect(mock.decks).toHaveLength(2);
  expect(mock.calls.filter((call) => call.method !== "GET" && call.path !== "/api/v1/decks/legality").map((call) => call.path)).toEqual(["/api/v1/decks/import-preview", "/api/v1/decks/saved-deck", "/api/v1/decks/import-preview", "/api/v1/decks/saved-deck"]);
});

test("cancelled exits retain edits and import previews; confirmed exits leave the saved deck alone", async ({ page }) => {
  const mock = await fixture(page); await openSaved(page);
  await page.getByRole("button", { name: "Edit deck", exact: true }).click();
  await page.getByRole("textbox", { name: "Deck notes", exact: true }).fill("Unfinished notes");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: /Back to decks/ }).click();
  await expect(page.getByRole("textbox", { name: "Deck notes", exact: true })).toHaveValue("Unfinished notes");
  page.once("dialog", (dialog) => dialog.accept()); await navigate(page, "Decks");
  await openSaved(page); await expect(page.getByText("Bring blue sleeves", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Import deck list", exact: true }).click();
  await page.getByRole("textbox", { name: "Paste deck list", exact: true }).fill("1 deck-card-0 main");
  await page.getByRole("button", { name: "Preview deck list", exact: true }).click();
  page.once("dialog", (dialog) => dialog.dismiss()); await page.getByRole("button", { name: "Cancel import", exact: true }).click();
  await expect(page.locator(".deck-import-impact")).toContainText("6 → 1 cards");
  page.once("dialog", (dialog) => dialog.accept()); await page.getByRole("button", { name: /Back to deck$/, exact: false }).click();
  await expect(page.getByRole("heading", { name: "Friday night", exact: true })).toBeVisible();
  expect(mock.saved.version).toBe(1);
});

test("stale import requires reloading and reviewing the newer deck before applying", async ({ page }) => {
  const mock = await fixture(page); await openSaved(page);
  await page.getByRole("button", { name: "Import deck list", exact: true }).click();
  await page.getByRole("radio", { name: /^Add to current list/ }).check();
  await page.getByRole("textbox", { name: "Paste deck list", exact: true }).fill("2 deck-card-0 main");
  await page.getByRole("button", { name: "Preview deck list", exact: true }).click();
  mock.saved.version++; mock.saved.notes = "Updated in another tab"; mock.saved.cards[0].quantity = 5;
  await page.getByRole("button", { name: "Add cards to deck", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("This deck changed");
  expect(mock.saved.cards[0].quantity).toBe(5);
  await page.getByRole("button", { name: "Reload saved deck", exact: true }).click();
  await expect(page.locator(".deck-import-impact")).toContainText("7 → 9 cards");
  await page.getByRole("button", { name: "Add cards to deck", exact: true }).click();
  await expect(page.getByText("Updated in another tab", { exact: true })).toBeVisible();
  expect(mock.saved.cards[0].quantity).toBe(7);
});

test("retry after a lost import response does not add copies twice", async ({ page }) => {
  const mock = await fixture(page); await openSaved(page);
  await page.getByRole("button", { name: "Import deck list", exact: true }).click();
  await page.getByRole("radio", { name: /^Add to current list/ }).check();
  await page.getByRole("textbox", { name: "Paste deck list", exact: true }).fill("2 deck-card-0 main");
  await page.getByRole("button", { name: "Preview deck list", exact: true }).click();
  mock.loseNextResponse();
  await page.getByRole("button", { name: "Add cards to deck", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Response interrupted");
  await expect(page.getByRole("button", { name: "Reload saved deck", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Add cards to deck", exact: true }).click();
  await expect(page.getByRole("region", { name: "Deck overview", exact: true })).toBeVisible();
  expect(mock.saved.cards[0].quantity).toBe(6); expect(mock.saved.version).toBe(2);
  const saves = mock.calls.filter((call) => call.path === "/api/v1/decks/saved-deck" && call.method === "POST");
  expect(saves).toHaveLength(2); expect(saves[0].key).toBe(saves[1].key);
});

test("new empty decks can import immediately and pagination returns to the same list", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "More decks", exact: true }).click();
  await expect(page.locator(".deck-list-rows > li")).toHaveCount(1);
  await page.getByRole("button", { name: /Next idea/ }).click();
  await page.getByRole("button", { name: "Close deck", exact: true }).click();
  await expect(page.getByRole("button", { name: "Previous decks", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New deck", exact: true }).click();
  await page.getByRole("textbox", { name: "New deck name", exact: true }).fill("Fresh deck");
  await page.getByRole("button", { name: "Create deck", exact: true }).click();
  await page.getByRole("button", { name: "Import deck list", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Import into Fresh deck", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Paste deck list", exact: true }).fill("1 deck-card-1 commander");
  await page.getByRole("button", { name: "Preview deck list", exact: true }).click();
  await page.getByRole("button", { name: "Replace deck list", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Fresh deck", exact: true })).toBeVisible();
});

test("oversized additions are blocked and navigation waits for the import save", async ({ page }) => {
  const mock = await fixture(page); await openSaved(page);
  await page.getByRole("button", { name: "Import deck list", exact: true }).click();
  await page.getByRole("radio", { name: /^Add to current list/ }).check();
  await page.getByRole("textbox", { name: "Paste deck list", exact: true }).fill("100000 deck-card-0 main");
  await page.getByRole("button", { name: "Preview deck list", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add cards to deck", exact: true })).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("exceeds 100,000");
  await page.getByRole("textbox", { name: "Paste deck list", exact: true }).fill("1 deck-card-0 main");
  await page.getByRole("button", { name: "Preview deck list", exact: true }).click();
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/decks/saved-deck", async (route) => { if (route.request().method() === "POST") await pending; await route.fallback(); });
  await page.getByRole("button", { name: "Add cards to deck", exact: true }).click();
  await expect(page.getByRole("button", { name: /Back to deck$/ })).toBeDisabled();
  await navigate(page, "Batches");
  await expect(page.getByRole("heading", { name: "Import into Friday night", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Wait for the current save");
  expect(mock.saved.version).toBe(1);
  release();
  await expect(page.getByRole("region", { name: "Deck overview", exact: true })).toBeVisible();
  expect(mock.saved.version).toBe(2);
});

test.describe("phone editor", () => {
  test.use({ isMobile: true, hasTouch: true });
  test("editing fields fit the phone viewport", async ({ page }) => {
    const mock = await fixture(page); mock.saved.match_mode = "any"; await openSaved(page);
    await page.getByRole("button", { name: "Edit deck", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Compare with my collection", exact: true })).toHaveValue("any");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `../../artifacts/deck-navigation/editor-${test.info().project.name}.png`, fullPage: true });
    const overflowing = await page.evaluate(() => [...document.querySelectorAll("main *")].filter((element) => {
      const box = element.getBoundingClientRect(); return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1);
    }).map((element) => ({ tag: element.tagName, class: element.className, width: element.getBoundingClientRect().width })));
    expect(overflowing).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

for (const theme of ["light", "dark"] as const) test(`${theme} gallery opens readable previews with bottom navigation and a list option`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: theme });
  await fixture(page); await openSaved(page);
  const opener = page.locator(".deck-art-button").first();
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Fixture Card 2", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Previous/ })).toBeDisabled();
  await dialog.getByRole("button", { name: /Next/ }).click();
  await expect(page.locator("#deck-preview-title")).toHaveText("Fixture Card 1");
  await expect(page.locator(".deck-preview-dialog")).toContainText("Need 4 · Have 2 · Missing 2");
  await expect(page.locator(".deck-preview-dialog")).toContainText("Red binder (2)");
  const image = page.locator(".deck-preview-art img");
  await expect(image).toHaveJSProperty("complete", true);
  expect(await image.evaluate((item) => (item as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: `../../artifacts/deck-collection/preview-${theme}-${test.info().project.name}.png`, fullPage: true });
  await page.getByRole("button", { name: /Next/ }).click();
  await expect(page.locator("#deck-preview-title")).toHaveText("Fixture Card 3");
  await expect(page.getByRole("button", { name: /Next/ })).toBeDisabled();
  await page.getByRole("button", { name: /Previous/ }).click();
  await expect(page.locator("#deck-preview-title")).toHaveText("Fixture Card 1");
  await page.getByRole("button", { name: "Close deck card preview", exact: true }).click();
  await expect(opener).toBeFocused();
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator(".deck-gallery")).toHaveCount(0);
  await expect(page.locator(".deck-cards > li")).toHaveCount(3);
  await page.getByRole("button", { name: "Gallery", exact: true }).click();
  await expect(page.locator(".deck-gallery .deck-art-button")).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("importing into an exact deck defaults to owned versions and opens their gallery", async ({ page }) => {
  const mock = await fixture(page); await openSaved(page);
  await page.route("**/api/v1/decks/import-preview", (route) => {
    expect(route.request().postDataJSON().match_mode).toBe("any");
    return route.fulfill({ json: { items: [{ line: 1, name: printings[0].name, quantity: 2, section: "main", printing: printings[0], collection_match: true, owned: 2, error: null, can_choose: true }] } });
  });
  await page.getByRole("button", { name: "Import deck list", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Collection matching", exact: true })).toHaveValue("any");
  await page.getByRole("textbox", { name: "Paste deck list", exact: true }).fill("2 Fixture Card 1 (ALT) 27");
  await page.getByRole("button", { name: "Preview deck list", exact: true }).click();
  await expect(page.locator(".deck-import-preview")).toContainText("Using an edition you own");
  await expect(page.locator(".deck-import-rows")).toContainText("TST #1");
  await page.getByRole("button", { name: "Replace deck list", exact: true }).click();
  await expect(page.locator(".deck-gallery .deck-art-button")).toHaveCount(1);
  await expect(page.locator(".deck-card-copy")).toContainText("Need 2 · Have 2 · Missing 0");
  expect(mock.saved.match_mode).toBe("any"); expect(mock.saved.use_collection_versions).toBe(true);
  expect(mock.saved.cards).toEqual([{ printing_id: printings[0].id, section: "main", quantity: 2 }]);
  await page.screenshot({ path: `../../artifacts/deck-collection/imported-gallery-${test.info().project.name}.png`, fullPage: true });
});

test("changing import matching clears the old preview and exact matching remains explicit", async ({ page }) => {
  const mock = await fixture(page); await openSaved(page);
  await page.getByRole("button", { name: "Import deck list", exact: true }).click();
  await page.getByRole("textbox", { name: "Paste deck list", exact: true }).fill("2 deck-card-0 main");
  await page.getByRole("button", { name: "Preview deck list", exact: true }).click();
  await page.getByRole("combobox", { name: "Collection matching", exact: true }).selectOption("exact");
  await expect(page.getByRole("button", { name: "Replace deck list", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Preview deck list", exact: true }).click();
  await page.getByRole("button", { name: "Replace deck list", exact: true }).click();
  expect(mock.saved.match_mode).toBe("exact"); expect(mock.saved.use_collection_versions).toBe(false);
});

test("changing editions does not report cards added or removed in a name-matched import", async ({ page }) => {
  const mock = await fixture(page);
  mock.saved.cards = [{ printing_id: printings[0].id, quantity: 4, section: "main" }];
  await openSaved(page);
  await page.route("**/api/v1/decks/import-preview", (route) => route.fulfill({ json: { items: [{ line: 1, name: printings[0].name, quantity: 4, section: "main", printing: { ...printings[3], name: printings[0].name }, error: null, can_choose: true }] } }));
  await page.getByRole("button", { name: "Import deck list", exact: true }).click();
  await page.getByRole("textbox", { name: "Paste deck list", exact: true }).fill("4 Fixture Card 1 (ALT) 4");
  await page.getByRole("button", { name: "Preview deck list", exact: true }).click();
  await expect(page.locator(".deck-import-impact")).toContainText("4 → 4 cards");
  await expect(page.locator(".deck-import-impact")).toContainText("0 copies added · 0 copies removed");
});

function legality(format = "commander", issues: any[] = []) {
  return { format, status: issues.length ? "issues" : "legal", issues, counts: { commander: format === "commander" ? 1 : 0, main: format === "commander" ? 99 : 60, sideboard: 0 }, catalog_updated_at: "2026-09-20T12:00:00Z", checked_at: "2026-09-20T13:00:00Z", rules_version: "2026-09-20", checks: ["Deck and sideboard size", "Card eligibility", "Color identity"], limitations: ["Companion declarations, Commander brackets and event-specific house rules are not checked."] };
}

for (const theme of ["light", "dark"] as const) test(`${theme} legality issues are readable on a narrow phone and open the affected card`, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 }); await page.emulateMedia({ colorScheme: theme });
  const mock = await fixture(page);
  mock.saved.legality = legality("commander", [{ code: "color_identity", severity: "error", message: "Fixture Card 1 includes blue outside the commander color identity.", printing_ids: ["deck-card-0"] }]);
  await openSaved(page);
  const panel = page.getByRole("region", { name: "Deck legality", exact: true });
  await expect(panel).toContainText("1 issue to fix for Commander");
  await expect(panel).toContainText("outside the commander color identity");
  await expect(panel).toContainText("Card data updated");
  await panel.screenshot({ path: `../../artifacts/deck-legality/legality-${theme}-${test.info().project.name}.png` });
  await page.getByRole("searchbox", { name: "Find a card in this deck", exact: true }).fill("Fixture Card 2");
  await panel.getByRole("button", { name: "View card", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Fixture Card 1", exact: true })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Close deck card preview", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("draft legality follows format changes and discards an outdated reply", async ({ page }) => {
  await fixture(page); await openSaved(page); await page.getByRole("button", { name: "Edit deck", exact: true }).click();
  let oldStarted = false;
  let releaseOld: () => void = () => {};
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
  await page.route("**/api/v1/decks/legality", async (route) => {
    const body = route.request().postDataJSON();
    if (body.format === "modern") { oldStarted = true; await oldGate; }
    await route.fulfill({ json: legality(body.format, body.format === "modern" ? [{ code: "card_legality", severity: "error", message: "Old Modern result", printing_ids: [] }] : []) }).catch(() => {});
  });
  await page.getByRole("combobox", { name: "Deck format", exact: true }).selectOption("modern");
  await expect.poll(() => oldStarted).toBe(true);
  await page.getByRole("combobox", { name: "Deck format", exact: true }).selectOption("legacy");
  const panel = page.getByRole("region", { name: "Deck legality", exact: true });
  await expect(panel).toContainText("Passes Legacy checks");
  releaseOld();
  await expect(panel).not.toContainText("Old Modern result");
  await expect(panel).toContainText("Unsaved list");
  await expect(page.getByRole("button", { name: "Save deck", exact: true })).toBeEnabled();
});

test("a failed legality check can retry without losing deck edits", async ({ page }) => {
  await fixture(page); await openSaved(page); await page.getByRole("button", { name: "Edit deck", exact: true }).click();
  let attempts = 0;
  await page.route("**/api/v1/decks/legality", (route) => {
    attempts += 1;
    return attempts === 1 ? route.fulfill({ status: 503, json: { detail: "Temporarily unavailable" } }) : route.fulfill({ json: legality("standard") });
  });
  await page.getByRole("combobox", { name: "Deck format", exact: true }).selectOption("standard");
  const panel = page.getByRole("region", { name: "Deck legality", exact: true });
  await expect(panel).toContainText("Legality check unavailable");
  await expect(page.getByRole("button", { name: "Save deck", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(panel).toContainText("Passes Standard checks");
  await expect(page.getByRole("combobox", { name: "Deck format", exact: true })).toHaveValue("standard");
});

test("Commander imports arrange copies, allow two commanders, and invalidate changed previews", async ({ page }) => {
  const mock = await fixture(page);
  const requests: any[] = [];
  await page.route("**/api/v1/decks/import-preview", (route) => {
    const body = route.request().postDataJSON(); requests.push(body);
    const two = body.section_mode === "two_commanders";
    const items = [
      { line: 1, name: printings[0].name, quantity: 1, section: "commander", printing: printings[0], error: null, can_choose: true },
      { line: 2, name: printings[1].name, quantity: 1, section: two ? "commander" : "main", printing: printings[1], error: null, can_choose: true },
      { line: 3, name: printings[2].name, quantity: 98, section: "main", printing: printings[2], error: null, can_choose: true },
      { line: 3, name: printings[2].name, quantity: 2, section: "sideboard", printing: printings[2], error: null, can_choose: true },
    ];
    return route.fulfill({ json: { items, layout: { applied: true, reason: "commander_order", counts: { commander: two ? 2 : 1, main: two ? 98 : 99, sideboard: 2 } } } });
  });
  await page.getByRole("button", { name: "Import deck list", exact: true }).click();
  await page.getByRole("textbox", { name: "Import deck name", exact: true }).fill("Commanders");
  await page.getByRole("combobox", { name: "Import deck format", exact: true }).selectOption("commander");
  await expect(page.getByRole("combobox", { name: "Commander import layout", exact: true })).toHaveValue("auto");
  await page.getByRole("textbox", { name: "Paste deck list", exact: true }).fill("1 First\n1 Second\n100 Lands");
  await page.getByRole("button", { name: "Preview deck list", exact: true }).click();
  await expect(page.locator(".deck-import-preview")).toContainText("1 commander · 99 mainboard · 2 extras");
  expect(requests[0]).toMatchObject({ deck_format: "commander", section_mode: "auto" });
  await page.getByRole("combobox", { name: "Import deck format", exact: true }).selectOption("modern");
  await expect(page.locator(".deck-import-preview")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Import deck format", exact: true }).selectOption("commander");
  await page.getByRole("combobox", { name: "Commander import layout", exact: true }).selectOption("two_commanders");
  await page.getByRole("button", { name: "Preview deck list", exact: true }).click();
  await expect(page.locator(".deck-import-preview")).toContainText("2 commander · 98 mainboard · 2 extras");
  await page.getByRole("button", { name: "Import deck", exact: true }).click();
  const deck = mock.decks.find((item) => item.id === "created-deck");
  expect(deck.format).toBe("commander");
  expect(deck.cards.filter((c: any) => c.section === "commander")).toHaveLength(2);
  expect(deck.cards.find((c: any) => c.section === "sideboard").quantity).toBe(2);
});

test("adding to a Commander deck preserves its leaders and requests listed sections", async ({ page }) => {
  const mock = await fixture(page); await openSaved(page);
  await page.getByRole("button", { name: "Import deck list", exact: true }).click();
  await page.getByRole("textbox", { name: "Paste deck list", exact: true }).fill("2 deck-card-0 main");
  await page.getByRole("button", { name: "Preview deck list", exact: true }).click();
  await expect(page.locator(".deck-import-preview")).toBeVisible();
  await page.getByRole("radio", { name: /^Add to current list/ }).check();
  await expect(page.locator(".deck-import-preview")).toHaveCount(0);
  await expect(page.getByText(/Adding cards keeps your current commander/)).toBeVisible();
  await page.getByRole("button", { name: "Preview deck list", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add cards to deck", exact: true })).toBeEnabled();
  expect(mock.calls.filter((call) => call.path === "/api/v1/decks/import-preview").at(-1)?.body).toMatchObject({ deck_format: "commander", section_mode: "listed" });
  await page.getByRole("button", { name: "Add cards to deck", exact: true }).click();
  expect(mock.saved.cards.filter((c: any) => c.section === "commander")).toEqual([{ printing_id: "deck-card-1", quantity: 1, section: "commander" }]);
});


test("browser history restores deck screens and preserves cancelled edits", async ({ page }) => {
  const mock = await fixture(page);
  await openSaved(page);
  await page.getByRole("button", { name: "Edit deck", exact: true }).click();
  await page.getByRole("textbox", { name: "Deck name", exact: true }).fill("Do not lose this draft");
  await cancelBrowserBack(page);
  await expect(page).toHaveURL(/#\/decks\/saved-deck\/edit$/);
  await expect(page.getByRole("textbox", { name: "Deck name", exact: true })).toHaveValue("Do not lose this draft");
  page.once("dialog", (dialog) => dialog.accept());
  await page.evaluate(() => history.back());
  await expect(page.getByRole("region", { name: "Deck overview", exact: true })).toBeVisible();
  await page.evaluate(() => history.forward());
  await expect(page.getByRole("textbox", { name: "Deck name", exact: true })).toHaveValue("Friday night");
  await page.getByRole("button", { name: "Done editing", exact: true }).first().click();
  await expect(page).toHaveURL(/#\/decks\/saved-deck$/);
  await page.getByRole("button", { name: /Preview Fixture Card 1/ }).click();
  await page.evaluate(() => history.back());
  await expect(page.getByRole("dialog", { name: "Fixture Card 1", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Deck overview", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Back to decks/ }).click();
  await expect(page).toHaveURL(/#\/decks$/);
  await page.evaluate(() => history.forward());
  await expect(page.getByRole("heading", { name: "Friday night", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Friday night", exact: true })).toBeVisible();
  expect(mock.calls.filter((call) => call.method !== "GET" && call.path !== "/api/v1/decks/legality" && call.path !== "/api/v1/decks/tokens")).toHaveLength(0);
});

test("browser history protects import text and recovers from a missing saved deck", async ({ page }) => {
  await fixture(page);
  await openSaved(page);
  await page.getByRole("button", { name: "Import deck list", exact: true }).click();
  const list = page.getByRole("textbox", { name: "Paste deck list", exact: true });
  await list.fill("4 deck-card-0");
  await cancelBrowserBack(page);
  await expect(list).toHaveValue("4 deck-card-0");
  await expect(page).toHaveURL(/\/import$/);
  page.once("dialog", (dialog) => dialog.accept());
  await page.evaluate(() => history.back());
  await expect(page.getByRole("region", { name: "Deck overview", exact: true })).toBeVisible();
  await page.goto("/#/decks/deleted-deck");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: /Back to decks/ }).click();
  await expect(page.getByRole("heading", { name: "Your decks", exact: true })).toBeVisible();
});
