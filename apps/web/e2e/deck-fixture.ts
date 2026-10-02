import { expect, type Page } from "@playwright/test";
import { navigate } from "./navigation";

export const printings = Array.from({ length: 7 }, (_, index) => ({ id: `deck-card-${index}`, name: `Fixture Card ${index + 1}`, set_code: "tst", collector_number: String(index + 1), language: "en", finishes: ["nonfoil", "foil"], image_url: `/api/v1/card-images/deck-card-${index}/0/grid` }));

export async function fixture(page: Page, boxes = false) {
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
    } else if (path === "/api/v1/decks/collection-preview") {
      json = detail({ ...saved, ...body });
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
