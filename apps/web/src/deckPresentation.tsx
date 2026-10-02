import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Deck, DeckCard, DeckCover, DeckSummary } from "./deckTypes";

export type CaseFinish = "automatic" | "obsidian" | "forest" | "midnight" | "oxblood" | "champagne" | "ivory" | "copper" | "amethyst" | "sapphire" | "jade" | "slate" | "pearl";
export type CaseEmblem = "automatic" | "cards" | "crown" | "compass" | "spark" | "leaf" | "crescent" | "sun" | "sword" | "wing" | "crystal" | "hourglass" | "none";
export type DeckPresentation = { featuredCard: DeckCover | null; finish: CaseFinish; emblem: CaseEmblem };

export const caseFinishes: Record<CaseFinish, { label: string; paint: string | null; accent: string | null }> = {
  automatic: { label: "Original", paint: null, accent: null },
  obsidian: { label: "Obsidian", paint: "#202429", accent: "#ced4d6" },
  forest: { label: "Forest", paint: "#19382d", accent: "#bacdb2" },
  midnight: { label: "Midnight", paint: "#172b41", accent: "#b5c6d9" },
  oxblood: { label: "Oxblood", paint: "#41242a", accent: "#dcc4a7" },
  champagne: { label: "Champagne", paint: "#655b48", accent: "#eee0b9" },
  ivory: { label: "Ivory", paint: "#c8bda4", accent: "#473f31" },
  copper: { label: "Copper", paint: "#6b4235", accent: "#eac3a0" },
  amethyst: { label: "Amethyst", paint: "#392847", accent: "#d9bedf" },
  sapphire: { label: "Sapphire", paint: "#173f57", accent: "#bcdcea" },
  jade: { label: "Jade", paint: "#2e5147", accent: "#c5ddcb" },
  slate: { label: "Slate", paint: "#48515b", accent: "#dee4eb" },
  pearl: { label: "Pearl", paint: "#d8d6cf", accent: "#50575b" },
};
export const caseEmblems: Record<CaseEmblem, string> = {
  automatic: "Original",
  cards: "Cards",
  crown: "Crown",
  compass: "Compass",
  spark: "Spark",
  leaf: "Leaf",
  crescent: "Crescent",
  sun: "Sun",
  sword: "Sword",
  wing: "Wing",
  crystal: "Crystal",
  hourglass: "Hourglass",
  none: "No emblem",
};
export const defaultPresentation: DeckPresentation = { featuredCard: null, finish: "automatic", emblem: "automatic" };
const changeEvent = "paktrak:deck-presentation";

export function deckPresentationKey(ownerId: string, deckId: string) {
  return `paktrak:deck-presentation:v1:${encodeURIComponent(ownerId)}:${encodeURIComponent(deckId)}`;
}

export function cardCover(card: DeckCard): DeckCover {
  const image = card.printing.image_url || null;
  return { id: card.printing.id, name: card.printing.display_name || card.printing.name, image_url: image, art_url: image?.startsWith("/api/v1/card-images/") && image.endsWith("/grid") ? image.slice(0, -4) + "art" : null, section: card.section };
}

function parsePresentation(raw: string | null): DeckPresentation {
  if (!raw) return defaultPresentation;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return defaultPresentation;
    const saved = value as Partial<DeckPresentation>;
    const feature = saved.featuredCard;
    const text = (value: unknown, maximum: number) => typeof value === "string" && value.length <= maximum ? value : null;
    const featuredCard = feature && typeof feature === "object" && text(feature.id, 200) && text(feature.name, 256)
      ? { id: feature.id, name: feature.name, image_url: text(feature.image_url, 2048), art_url: text(feature.art_url, 2048) } : null;
    return { featuredCard, finish: saved.finish && Object.hasOwn(caseFinishes, saved.finish) ? saved.finish : "automatic", emblem: saved.emblem && Object.hasOwn(caseEmblems, saved.emblem) ? saved.emblem : "automatic" };
  } catch { return defaultPresentation; }
}

function read(key: string | null) {
  try { return key ? localStorage.getItem(key) : null; } catch { return null; }
}

function signal(key: string) { window.dispatchEvent(new CustomEvent(changeEvent, { detail: { key } })); }

export function presentationCovers(deck: DeckSummary | Deck, presentation: DeckPresentation): DeckCover[] {
  if (presentation.featuredCard) return [presentation.featuredCard];
  const cards = "cards" in deck ? deck.cards.filter(card => card.quantity > 0) : null;
  if (deck.format === "commander" && cards) {
    return cards.filter(card => card.section === "commander").slice(0, 2).map(card => {
      const cover = cardCover(card);
      const preview = [...(deck.cover_cards || []), ...(deck.preview_cards || [])].find(preview => preview.id === card.printing.id);
      return preview?.art_url ? { ...cover, art_url: preview.art_url } : cover;
    });
  }
  if (deck.cover_cards?.length) return deck.cover_cards;
  const previews = deck.preview_cards || [];
  if (deck.format === "commander") return previews.filter(card => card.section === "commander").slice(0, 2);
  const mainPreviews = previews.filter(card => card.section === "main");
  if (previews.length) return (mainPreviews.length ? mainPreviews : previews).slice(0, 1);
  const mainCards = cards?.filter(card => card.section === "main") || [];
  return (mainCards.length ? mainCards : cards || []).slice(0, 1).map(cardCover);
}

const originalCaseColors: Record<string, { paint: string; accent: string }> = {
  W: { paint: "#454034", accent: "#e6d8b3" },
  U: { paint: "#1c2d3c", accent: "#afccdf" },
  B: { paint: "#24212f", accent: "#c2b6d0" },
  R: { paint: "#3c2424", accent: "#dfab99" },
  G: { paint: "#1d322c", accent: "#b0cfb7" },
};

export function caseAppearance(deck: DeckSummary, presentation: DeckPresentation) {
  const finish = caseFinishes[presentation.finish];
  const colors = ["W", "U", "B", "R", "G"].filter(color => deck.colors?.includes(color));
  const original = colors.length === 1 ? originalCaseColors[colors[0]] : { paint: "#282e32", accent: "#c7b991" };
  return { paint: finish.paint || original.paint, accent: finish.accent || original.accent };
}

export function useDeckPresentation(ownerId: string, deck: DeckSummary | Deck | null) {
  const key = ownerId && deck ? deckPresentationKey(ownerId, deck.id) : null;
  const subscribe = useCallback((listener: () => void) => {
    const local = (event: Event) => { if ((event as CustomEvent<{ key: string }>).detail?.key === key) listener(); };
    const external = (event: StorageEvent) => { if (!event.key || event.key === key) listener(); };
    window.addEventListener(changeEvent, local);
    window.addEventListener("storage", external);
    return () => { window.removeEventListener(changeEvent, local); window.removeEventListener("storage", external); };
  }, [key]);
  const snapshot = useCallback(() => read(key), [key]);
  const raw = useSyncExternalStore(subscribe, snapshot, () => null);
  const saved = useMemo(() => parsePresentation(raw), [raw]);
  const fullDeck = deck && "cards" in deck ? deck as Deck : null;
  const currentCard = saved.featuredCard && fullDeck ? fullDeck.cards.find((card) => card.printing.id === saved.featuredCard!.id && card.quantity > 0) : null;
  const missingCard = !!(saved.featuredCard && fullDeck && !currentCard);
  const presentation = useMemo(() => saved.featuredCard && fullDeck ? { ...saved, featuredCard: currentCard ? cardCover(currentCard) : null } : saved, [saved, fullDeck, currentCard]);
  const [storageAvailable, setStorageAvailable] = useState(() => { try { return typeof localStorage !== "undefined"; } catch { return false; } });

  const savePresentation = useCallback((next: DeckPresentation) => {
    if (!key) return false;
    try { localStorage.setItem(key, JSON.stringify(parsePresentation(JSON.stringify(next)))); setStorageAvailable(true); signal(key); return true; }
    catch { setStorageAvailable(false); return false; }
  }, [key]);
  const resetPresentation = useCallback(() => {
    if (!key) return false;
    try { localStorage.removeItem(key); setStorageAvailable(true); signal(key); return true; }
    catch { setStorageAvailable(false); return false; }
  }, [key]);

  useEffect(() => {
    if (missingCard && key && read(key) === raw) savePresentation({ ...saved, featuredCard: null });
  }, [missingCard, key, raw, saved, savePresentation]);

  return { presentation, savePresentation, resetPresentation, storageAvailable };
}

export function DeckEmblem({ emblem = "automatic", commander = false }: { emblem?: CaseEmblem; commander?: boolean }) {
  const mark = emblem === "automatic" ? commander ? "crown" : "cards" : emblem;
  if (mark === "none") return null;
  return <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {mark === "crown" && <><path d="m12 22 10 9 10-17 10 17 10-9-6 24H18Z" /><path d="M18 51h28M26 40h12" /></>}
    {mark === "cards" && <><rect x="19" y="12" width="31" height="42" rx="4" /><path d="M14 18h-1a4 4 0 0 0-4 4v31a5 5 0 0 0 5 5h25" /><path d="m34 24 7 9-7 9-7-9Z" /></>}
    {mark === "compass" && <><circle cx="32" cy="32" r="21" /><path d="m24 40 4-12 12-4-4 12-12 4ZM32 6v9m0 34v9M6 32h9m34 0h9" /></>}
    {mark === "spark" && <><path d="m32 8 6 18 18 6-18 6-6 18-6-18-18-6 18-6 6-18Z" /><path d="m48 9 2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6Z" /></>}
    {mark === "leaf" && <><path d="M52 12C30 8 12 20 14 35c2 14 16 19 26 10 8-7 10-16 12-33Z" /><path d="M12 53 42 23m-16 16V26m0 13h13" /></>}
    {mark === "crescent" && <><path d="M39 9a23 23 0 1 0 15 33A22 22 0 0 1 39 9Z" /><path d="m48 11 2 5 5 2-5 2-2 5-2-5-5-2 5-2 2-5Z" /></>}
    {mark === "sun" && <><circle cx="32" cy="32" r="12" /><circle cx="32" cy="32" r="5" /><path d="M32 7v7m0 36v7M7 32h7m36 0h7M14 14l5 5m26 26 5 5M14 50l5-5m26-26 5-5" /></>}
    {mark === "sword" && <><path d="m32 7 7 10-3 22h-8l-3-22 7-10Zm0 0v32M20 39h24m-20 0-3 5m19-5 3 5" /><rect x="28" y="39" width="8" height="12" rx="2" /><path d="M27 56h10m-5-5v5" /></>}
    {mark === "wing" && <><path d="M12 52C13 35 24 20 52 10c-1 10-5 18-12 24-7 7-17 11-28 18Z" /><path d="M12 52c11-19 22-30 40-42M19 40l16-2m-7-10 17-2M12 52l19-5" /></>}
    {mark === "crystal" && <><path d="m32 7 16 13v24L32 57 16 44V20L32 7Z" /><path d="m32 7 8 18-8 32-8-32 8-18ZM16 20l8 5h16l8-5M16 44l11-8m21 8-11-8" /></>}
    {mark === "hourglass" && <><path d="M18 9h28M18 55h28M21 9v8c0 7 5 10 11 15-6 5-11 8-11 15v8m22-46v8c0 7-5 10-11 15 6 5 11 8 11 15v8" /><path d="m25 19 7 7 7-7M24 49l8-8 8 8H24Z" /></>}
  </svg>;
}
