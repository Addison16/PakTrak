import type { Printing } from "./api";

export type Store = "tcgplayer" | "cardkingdom" | "manapool";
export type StoreLinks = Partial<Record<Store, string | null>>;
export type StoreLine = { printing: Printing; quantity: number };

export const storeNames: Record<Store, string> = { tcgplayer: "TCGplayer", cardkingdom: "Card Kingdom", manapool: "ManaPool" };
const entryPages: Record<Store, string> = {
  tcgplayer: "https://www.tcgplayer.com/massentry?productline=Magic",
  cardkingdom: "https://www.cardkingdom.com/builder",
  manapool: "https://manapool.com/add-deck",
};
// A plain referral code is added to the store's own link with these parameters.
const codeParameters: Record<Store, string> = { tcgplayer: "partner", cardkingdom: "partner", manapool: "ref" };
// Store pages stop reading very long prefilled lists, so longer lists are pasted instead.
const maxPrefillLength = 7500;

/** Adds the server's referral code or tracking link to a store link. */
export function withReferral(store: Store, destination: string, links?: StoreLinks) {
  const setting = links?.[store]?.trim();
  if (!setting) return destination;
  try {
    if (setting.startsWith("https://")) {
      if (setting.includes("{url}")) return setting.split("{url}").join(encodeURIComponent(destination));
      const link = new URL(setting);
      link.searchParams.set("u", destination);
      return link.toString();
    }
    const link = new URL(destination);
    link.searchParams.set(codeParameters[store], setting);
    return link.toString();
  } catch {
    return destination;
  }
}

export function hasReferral(links?: StoreLinks) {
  return Object.values(links || {}).some((value) => !!value?.trim());
}

/** The list in each store's text-entry format, combining copies of the same card. */
export function storeList(format: string, cards: StoreLine[], exact: boolean) {
  if ((format === "manapool" || format === "tcgplayer") && exact) {
    const lines = new Map<string, number>();
    for (const item of cards) {
      const set = item.printing.set_code.toUpperCase();
      const line = `${item.printing.name} ${format === "tcgplayer" ? `[${set}]` : `(${set})`} ${item.printing.collector_number}`;
      lines.set(line, (lines.get(line) || 0) + item.quantity);
    }
    return [...lines].map(([line, quantity]) => `${quantity} ${line}`).join("\n");
  }
  const names = new Map<string, number>();
  for (const item of cards) names.set(item.printing.name, (names.get(item.printing.name) || 0) + item.quantity);
  return [...names].sort(([a], [b]) => a.localeCompare(b)).map(([name, quantity]) => `${quantity} ${name}`).join("\n");
}

function base64(text: string) {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A link that opens the store's list entry page, with the list filled in when the store supports it. */
export function storeEntryLink(store: Store, list: string, links?: StoreLinks) {
  let prefilled: string | null = null;
  if (store === "tcgplayer") prefilled = `${entryPages.tcgplayer}&c=${list.split("\n").map(encodeURIComponent).join("||")}`;
  if (store === "manapool") prefilled = `${entryPages.manapool}?deck=${encodeURIComponent(base64(list))}`;
  const url = prefilled && prefilled.length <= maxPrefillLength ? prefilled : entryPages[store];
  return { url: withReferral(store, url, links), prefilled: url === prefilled };
}
