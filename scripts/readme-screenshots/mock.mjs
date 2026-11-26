// Answers every /api request the screenshot pages make, from the invented data in data.mjs.
import { artSvg, cardSvg } from "./art.mjs";
import { anyByName, anyCard, byName, cards, extras, locations, printing, sets } from "./data.mjs";

const day = (offset) => new Date(Date.UTC(2026, 10, 26) - offset * 86400000).toISOString().slice(0, 10);
const money = (n) => n.toFixed(2);
const feed = { name: "TCGplayer prices", state: "ready", progress: {}, updated_at: "2026-11-26T06:10:00Z", source_time: "2026-11-26T05:00:00Z", next_at: "2026-11-27T06:00:00Z", stale: false };
const collectionCard = (card) => ({
  printing: printing(card), quantity: card.qty, location_count: 1,
  locations: [{ ...locations.find((l) => l.id === card.loc), quantity: card.qty }],
  value: money(Number(card.price) * card.qty), price_min: card.price, price_max: card.price, priced_copies: card.qty,
  finish_counts: card.name === "Emberclaw Wyrm" ? { nonfoil: 3, foil: 1 } : { nonfoil: card.qty },
});
const total = cards.reduce((sum, card) => sum + Number(card.price) * card.qty, 0);
const copies = cards.reduce((sum, card) => sum + card.qty, 0);

function history(card, days = 90) {
  const base = Number(card.price);
  const points = Array.from({ length: days }, (_, i) => {
    const t = i / (days - 1);
    const wave = Math.sin(i / 6) * 0.04 + Math.sin(i / 17) * 0.06;
    return { day: day(days - 1 - i), amount: money(base * (0.72 + 0.28 * t + wave * (1 - t * 0.5))) };
  });
  points[points.length - 1].amount = card.price;
  const first = Number(points[points.length - 31].amount);
  return { provider: "tcgplayer", finishes: { nonfoil: { points, change: { amount: money(base - first), percent: Math.round((base - first) / first * 1000) / 10, since: points[points.length - 31].day } },
    foil: { points: points.map((p) => ({ day: p.day, amount: money(Number(p.amount) * 1.8) })), change: { amount: money((base - first) * 1.8), percent: Math.round((base - first) / first * 1000) / 10, since: points[points.length - 31].day } } } };
}

export const decks = [
  { id: "archon", name: "Archon of the Rift", format: "commander", colors: ["W", "U", "B"], notes: "Sleeves: midnight blue",
    list: [["Riftborn Archon", 1, "commander"], ["Tidecaller Adept", 1, "main"], ["Sunforged Paladin", 1, "main"], ["Duskmire Revenant", 1, "main"], ["Stormglass Sage", 1, "main"], ["Pale Moon Vigil", 1, "main"], ["Saltmarsh Pact", 1, "main"], ["Lantern of the Vale", 1, "main"], ["Gilded Compass", 1, "main"], ["Glimmerfen Crossing", 1, "main"], ["Hushwood Ravine", 1, "main"]] },
  { id: "embers", name: "Embers and Ash", format: "modern", colors: ["B", "R"],
    list: [["Cinder Courier", 4, "main"], ["Gilded Compass", 4, "main"], ["Ashen Cartographer", 4, "main"], ["Saltmarsh Pact", 4, "main"], ["Lantern of the Vale", 4, "main"], ["Duskmire Revenant", 4, "main"], ["Veilwalker Assassin", 4, "main"], ["Emberclaw Wyrm", 4, "main"], ["Glimmerfen Crossing", 14, "main"], ["Hushwood Ravine", 14, "main"], ["Pale Moon Vigil", 2, "sideboard"]] },
  { id: "grove", name: "Grove tribal", format: "commander", colors: ["G"],
    list: [["Thornveil Druid", 1, "commander"], ["Grovewarden Elk", 1, "main"], ["Hushwood Ravine", 1, "main"], ["Gilded Compass", 1, "main"]] },
  { id: "skyreach", name: "Skyreach tempo", format: "pioneer", colors: ["U", "W"],
    list: [["Stormglass Sage", 4, "main"], ["Tidecaller Adept", 4, "main"], ["Pale Moon Vigil", 4, "main"], ["Sunforged Paladin", 4, "main"], ["Glimmerfen Crossing", 24, "main"]] },
];

function deckDetail(deck) {
  const used = {};
  const rows = deck.list.map(([name, quantity, section]) => {
    const card = anyByName(name);
    const free = Math.max(0, card.qty - (used[card.id] || 0));
    const available = Math.min(quantity, free);
    used[card.id] = (used[card.id] || 0) + available;
    return { printing: printing(card), section, quantity, owned: card.qty, needed_in_deck: quantity, available, missing: quantity - available,
      locations: available && card.loc ? [{ id: card.loc, name: locations.find((l) => l.id === card.loc).name, quantity: available }] : [] };
  });
  const cover = (row) => ({ ...row.printing, section: row.section, art_url: `/api/v1/card-images/${row.printing.id}/0/art` });
  const commanders = rows.filter((r) => r.section === "commander");
  return { id: deck.id, name: deck.name, format: deck.format, match_mode: "any", notes: deck.notes || "", version: 3, updated_at: "2026-11-20T18:00:00Z",
    colors: deck.colors, colors_known: true, cards: rows,
    cover_cards: (commanders.length ? commanders : rows.slice(0, 1)).map(cover), preview_cards: rows.slice(0, 6).map(cover), unique_printings: rows.length,
    copies: rows.reduce((s, r) => s + r.quantity, 0), owned_copies: rows.reduce((s, r) => s + r.available, 0), missing_copies: rows.reduce((s, r) => s + r.missing, 0),
    missing_cards: rows.filter((r) => r.missing).map((r) => ({ printing: r.printing, quantity: r.missing })) };
}

export function route(handlers = {}) {
  return async (route) => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname, method = req.method();
    const body = req.postData() ? (() => { try { return JSON.parse(req.postData()); } catch { return null; } })() : null;
    if (path.startsWith("/api/v1/card-images/")) {
      const [, , , , id, , kind] = path.split("/");
      const card = anyCard(id);
      if (!card) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ contentType: "image/svg+xml", body: kind === "art" ? artSvg(card) : cardSvg(card) });
    }
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (path === pattern || (pattern.endsWith("*") && path.startsWith(pattern.slice(0, -1)))) {
        const answer = await handler({ path, url, method, body, req });
        if (answer !== undefined) return route.fulfill(answer.status ? answer : { json: answer });
      }
    }
    let json;
    const collectionCardId = path.match(/^\/api\/v1\/collection\/cards\/([^/]+)$/)?.[1];
    const printingId = path.match(/^\/api\/v1\/collection\/printings\/([^/]+)/)?.[1];
    if (path === "/api/auth/session") json = { owner_id: "demo-owner", display_name: "Sam", role: "member", csrf_token: "demo", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 412, scan_card_limit: null, scan_cards_remaining: null, membership_welcome: false, store_links: {} };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/price-alerts" && method === "GET") json = { settings: { enabled: true, percent: 20, amount: "1.00" }, provider: "tcgplayer", currency: "USD", feed, rises: [], drops: [], rise_count: 0, drop_count: 0 };
    else if (path === "/api/v1/data/status") json = { feeds: [feed] };
    else if (path === "/api/v1/catalog/status") json = { printings: 98000 };
    else if (path === "/api/v1/binders") json = { items: locations };
    else if (path === "/api/v1/collection/filters") json = { sets: Object.entries(sets).map(([code, name]) => ({ code, name })), foil_types: [] };
    else if (path === "/api/v1/collection/cards") {
      const items = cards.map(collectionCard);
      json = { copies, cards: cards.length, items, next_offset: null, valuation: { provider: "tcgplayer", amount: money(total), priced_copies: copies, unpriced_copies: 0, feed } };
    } else if (collectionCardId) json = collectionCard(cards.find((c) => c.id === collectionCardId));
    else if (printingId && path.endsWith("/price-history")) json = history(cards.find((c) => c.id === printingId), Number(url.searchParams.get("days")) || 90);
    else if (printingId && path.endsWith("/decks")) { const card = cards.find((c) => c.id === printingId); json = { name: card.name, owned: card.qty, used: 1, free: card.qty - 1, decks: [{ id: "embers", name: "Embers and Ash", quantity: 1 }] }; }
    else if (printingId) {
      const card = cards.find((c) => c.id === printingId);
      json = { printing: printing(card), faces: [{ name: card.name, type_line: card.type, oracle_text: "Flying\nWhen this creature enters, it deals 2 damage to any target.", flavor_text: "The mountains remember every fire.", artist: "Sample Artist", power: "5", toughness: "5", image_url: printing(card).image_url }],
        released_at: "2026-02-06", scryfall_url: null,
        prices: [["tcgplayer", "TCGplayer", "Market", 1], ["cardkingdom", "Card Kingdom", "Retail", 1.12], ["manapool", "ManaPool", "Low", 0.96]].map(([provider, name, kind, k]) => ({ provider, name, kind, feed: { ...feed, name }, finishes: [{ finish: "nonfoil", amount: money(Number(card.price) * k), available: true, url: null }, { finish: "foil", amount: money(Number(card.price) * k * 1.8), available: true, url: null }] })) };
    } else if (/^\/api\/v1\/catalog\/printings\/[^/]+\/rulings$/.test(path)) json = {
      legalities: { standard: "legal", pioneer: "legal", modern: "legal", legacy: "legal", vintage: "legal", commander: "legal", oathbreaker: "legal", pauper: "not_legal", paupercommander: "not_legal", premodern: "not_legal", duel: "legal", brawl: "legal" },
      rulings: [{ source: "wotc", published_at: "2026-02-06", comment: "The damage is dealt as the creature enters, before players can respond to it." }, { source: "wotc", published_at: "2026-02-06", comment: "If the target is illegal when the ability resolves, the ability does nothing." }], rulings_saved: true };
    else if (path === "/api/v1/collection") {
      const id = url.searchParams.get("printing_id"); const card = cards.find((c) => c.id === id) || cards[0];
      const lot = (n, finish, extra = {}) => ({ id: `${card.id}-lot-${n}`, version: 1, printing: printing(card), quantity: 1, finish, condition: "near_mint", binder: locations.find((l) => l.id === card.loc).name, binder_id: card.loc, binder_kind: "binder", notes: "", ...extra });
      json = { items: card.qty > 1 ? [lot(1, "foil", { purchase_price: money(Number(card.price) * 0.7), purchase_currency: "USD", labels: ["Showcase"] }), lot(2, "nonfoil", { quantity: card.qty - 1, for_trade: true })] : [lot(1, "nonfoil")], next_offset: null };
    }
    else if (path === "/api/v1/collection/value-history") {
      const days = Number(url.searchParams.get("days")) || 90;
      const points = Array.from({ length: days }, (_, i) => { const t = i / (days - 1); return { day: day(days - 1 - i), amount: money(total * (0.8 + 0.2 * t + Math.sin(i / 5) * 0.012 + Math.sin(i / 13) * 0.02)) }; });
      points[points.length - 1].amount = money(total);
      const first = Number(points[0].amount);
      json = { points, change: { amount: money(total - first), percent: Math.round((total - first) / first * 1000) / 10, since: points[0].day } };
    } else if (path === "/api/v1/collection/breakdown") {
      const group = (key) => { const map = new Map(); for (const card of cards) { const k = key(card); const g = map.get(k) || { key: k, label: k, copies: 0, value: 0 }; g.copies += card.qty; g.value += Number(card.price) * card.qty; map.set(k, g); } return [...map.values()].sort((a, b) => b.value - a.value).map((g) => ({ ...g, value: money(g.value) })); };
      const colorName = { R: "Red", U: "Blue", G: "Green", W: "White", B: "Black", M: "Multicolor", C: "Colorless", L: "Colorless" };
      json = { provider: "tcgplayer", copies, value: money(total), colors: group((c) => colorName[c.color]), rarities: group((c) => c.rarity[0].toUpperCase() + c.rarity.slice(1)).map((g) => ({ ...g, key: g.key.toLowerCase() })),
        types: group((c) => c.type.includes("Creature") ? "Creature" : c.type.split(" ")[0]), sets: group((c) => sets[c.set]), locations: group((c) => locations.find((l) => l.id === c.loc).name),
        top_cards: [...cards].sort((a, b) => b.price * b.qty - a.price * a.qty).slice(0, 5).map((c) => ({ printing: printing(c), finish: c.name === "Emberclaw Wyrm" ? "foil" : "nonfoil", quantity: c.qty, amount: money(Number(c.price) * c.qty) })),
        paid: { copies: 18, unpriced_copies: 0, paid: "142.50", value: "211.35", change: "68.85" } };
    } else if (path === "/api/v1/collection/sets") json = { items: Object.entries(sets).map(([code, name], i) => { const owned = cards.filter((c) => c.set === code); return { code, name, released_at: ["2026-02-06", "2025-11-14", "2025-09-19"][i], set_type: "expansion", owned: [212, 148, 87][i], total: [276, 271, 286][i], copies: [341, 220, 119][i] }; }) };
    else if (path.startsWith("/api/v1/collection/sets/")) {
      const code = path.split("/").pop(); const list = [...cards, ...extras].filter((c) => c.set === code).sort((a, b) => a.number - b.number);
      json = { code, name: sets[code], released_at: "2026-02-06", provider: "tcgplayer", owned: 212, total: 276, cost_to_finish: "318.45", missing_unpriced: 2,
        cards: list.map((c) => ({ printing: printing(c), owned: c.qty, price_finish: "nonfoil", unit_amount: c.price })) };
    } else if (path === "/api/v1/wishlist") {
      const want = [["Starfall Herald", 1, "any", "22.00"], ["Tempest Archive", 1, "foil", null], ["Veilwalker Assassin", 2, "nonfoil", "9.00"], ["Mossback Colossus", 1, "any", null], ["Mirrorlake Seer", 4, "nonfoil", "1.00"]];
      const items = want.map(([name, quantity, finish, target], i) => { const c = anyByName(name); const unit = finish === "foil" ? money(Number(c.price) * 1.8) : c.price; return { id: "want-" + i, printing: printing(c), finish, quantity, notes: "", price_finish: finish === "foil" ? "foil" : "nonfoil", unit_amount: unit, target_price: target, at_target: target !== null && Number(unit) <= Number(target), owned: 0 }; });
      json = { provider: "tcgplayer", items, copies: items.reduce((s, i) => s + i.quantity, 0), priced_copies: items.reduce((s, i) => s + i.quantity, 0), amount: money(items.reduce((s, i) => s + Number(i.unit_amount) * i.quantity, 0)), at_target: items.filter((i) => i.at_target).length };
    } else if (path === "/api/v1/decks/value") {
      json = { items: (body?.cards || []).map((c) => { const card = anyCard(c.printing_id); return { printing_id: c.printing_id, unit_amount: card ? money(Number(card.price) * (body.finish_preference === "foil" ? 1.8 : 1)) : null, finish: body.finish_preference }; }), feed, price_kind: "Market" };
    } else if (path === "/api/v1/decks/legality") json = { format: body?.format || "commander", status: "legal", issues: [], counts: { commander: 1, main: 10, sideboard: 0 }, catalog_updated_at: "2026-11-26T06:10:00Z", checked_at: "2026-11-26T19:00:00Z", rules_version: "demo", checks: ["Deck size", "Card legality", "Color identity", "Singleton"], limitations: [] };
    else if (path === "/api/v1/decks/tokens") json = { items: [], missing_details: 0 };
    else if (path === "/api/v1/decks" && method === "GET") json = { items: decks.map(deckDetail), next_offset: null };
    else if (/^\/api\/v1\/decks\/[^/]+$/.test(path) && method === "GET") json = deckDetail(decks.find((d) => d.id === path.split("/").pop()));
    else if (["/api/v1/scans", "/api/v1/imports", "/api/v1/exports", "/api/v1/trade-offers", "/api/v1/shares"].includes(path)) json = { items: [], next_offset: null, attention: 0 };
    else if (path === "/api/v1/friends") json = { code: "QX7-PLM-42", share_collection: true, share_wishlist: true, friends: [], incoming: [], outgoing: [] };
    if (json === undefined) { console.log("UNHANDLED", method, path + url.search); return route.fulfill({ status: 404, json: { detail: "Not in the screenshot data: " + path } }); }
    return route.fulfill({ json });
  };
}
export { cards, deckDetail, history, collectionCard, money, feed, day, total, copies };
