import { request, type CollectionCard, type Lot, type Session } from "./api";
import type { Deck, DeckSummary } from "./deckTypes";
import { addOfflineFallback, connection, savedResponses } from "./offline";
import { imageLimit, offlineImagesReady } from "./serviceWorker";

// Saves the whole collection and every deck so they open offline. The URLs
// match what the Collection and Decks screens ask for, so their saved copies
// are found later. Runs on its own about once a day; the Queued actions page
// can also run it with card pictures.
const pageLimit = 250;
const dailyKey = (owner: string) => "paktrak:offline-saved:" + owner;

export async function saveForOffline(session: Session, options: { images: boolean; progress?: (message: string) => void }) {
  const progress = options.progress || (() => {});
  const provider = session.preferred_price_source || "tcgplayer";
  const images = new Set<string>();
  let offset: number | null = 0, cards = 0;
  for (let page = 0; offset !== null && page < pageLimit; page++) {
    const result: { items: CollectionCard[]; next_offset: number | null } = await request("/api/v1/collection/cards?" + new URLSearchParams({ offset: String(offset), provider, sort: "name" }), { quiet: true });
    cards += result.items.length;
    for (const item of result.items) if (item.printing.image_url) images.add(item.printing.image_url);
    offset = result.next_offset;
    progress(`Saving your collection… ${cards.toLocaleString()} cards so far`);
  }
  // Every copy, so Manage copies opens for any card (see the fallback below).
  for (let lotOffset: number | null = 0, page = 0; lotOffset !== null && page < pageLimit; page++) {
    const result: { next_offset: number | null } = await request("/api/v1/collection?offset=" + lotOffset, { quiet: true });
    lotOffset = result.next_offset;
  }
  await Promise.all([request("/api/v1/binders", { quiet: true }), request("/api/v1/collection/filters", { quiet: true }), request("/api/v1/scans?offset=0", { quiet: true })]);
  let deckOffset: number | null = 0, decks = 0;
  while (deckOffset !== null) {
    const list: { items: DeckSummary[]; next_offset: number | null } = await request("/api/v1/decks?offset=" + deckOffset, { quiet: true });
    for (const summary of list.items) {
      const deck = await request<Deck>("/api/v1/decks/" + summary.id, { quiet: true }); decks++;
      for (const card of deck.cards) if (card.printing.image_url) images.add(card.printing.image_url);
      progress(`Saving your decks… ${decks.toLocaleString()} so far`);
    }
    deckOffset = list.next_offset;
  }
  let pictures = 0;
  const wanted = options.images && offlineImagesReady() ? [...images].slice(0, imageLimit) : [];
  for (let i = 0; i < wanted.length; i += 6) {
    await Promise.all(wanted.slice(i, i + 6).map((url) => fetch(url, { credentials: "same-origin" }).then((response) => { if (response.ok) pictures++; }).catch(() => {})));
    progress(`Saving card pictures… ${Math.min(i + 6, wanted.length).toLocaleString()} of ${wanted.length.toLocaleString()}`);
  }
  try { localStorage.setItem(dailyKey(session.owner_id), String(Date.now())); } catch { /* Runs again next time. */ }
  return `Saved ${cards.toLocaleString()} ${cards === 1 ? "card" : "cards"} and ${decks.toLocaleString()} ${decks === 1 ? "deck" : "decks"}` +
    (wanted.length ? ` with ${pictures.toLocaleString()} card pictures${images.size > imageLimit ? ` (the first ${imageLimit.toLocaleString()}; the rest show when you’re connected)` : ""}.` : ".");
}

let automatic = false;
/** Keeps the saved copies fresh without anyone asking, at most once a day. */
export function saveDaily(session: Session) {
  let last = 0;
  try { last = Number(localStorage.getItem(dailyKey(session.owner_id))) || 0; } catch { return; }
  if (automatic || Date.now() - last < 24 * 60 * 60 * 1000 || !connection().reachable) return;
  automatic = true;
  void saveForOffline(session, { images: false }).catch(() => {}).finally(() => { automatic = false; });
}

// One card's copies, from the saved pages of every copy.
addOfflineFallback(/^\/api\/v1\/collection$/, async (path) => {
  const params = new URLSearchParams(path.split("?")[1] || "");
  const printing = params.get("printing_id");
  if (!printing || params.get("q") || Number(params.get("offset") || 0) > 0) return;
  const pages = await savedResponses<{ items: Lot[]; next_offset: number | null }>("/api/v1/collection?offset=");
  if (!pages.length) return;
  const binder = params.get("binder_id");
  const seen = new Set<string>();
  const items = pages.flatMap((page) => page.data.items).filter((lot) => lot.printing.id === printing && (!binder || lot.binder_id === binder) && !seen.has(lot.id) && seen.add(lot.id));
  return { copies: items.reduce((sum, lot) => sum + lot.quantity, 0), items, next_offset: null };
});
