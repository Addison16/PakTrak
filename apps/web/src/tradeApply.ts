import { mutation, request, type Finish, type Lot, type Printing, type Session } from "./api";

// Shared by Trade value and accepted trade offers: each person's app changes only their own collection.
export type PickedLot = { id: string; binder: string; quantity: number };
export type TradeLine = { printing: Printing; finish: Finish; quantity: number; lots?: PickedLot[] };
type ImportBatch = { id: string; state: string; revision: number; error?: string | null; summary: { ready_copies: number; committed_copies: number; unresolved_rows: number } | null };
export type Removal<T extends TradeLine> = { card: T; lot: Lot; take: number };

export const TRADE_BINDER = "Trades";
export const finishNames: Record<Finish, string> = { nonfoil: "Nonfoil", foil: "Foil", etched: "Etched foil" };
const pause = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
const csvCell = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
export const plural = (n: number) => `${n} ${n === 1 ? "copy" : "copies"}`;

/** Find collection copies for every card given, preferring the copies it was picked from. */
export async function planRemovals<T extends TradeLine>(give: T[]): Promise<Removal<T>[]> {
  const removals: Removal<T>[] = [], used = new Map<string, number>();
  for (const card of give) {
    const lots: Lot[] = [];
    for (let offset: number | null = 0; offset !== null;) {
      const page: { items: Lot[]; next_offset: number | null } = await request(`/api/v1/collection?printing_id=${card.printing.id}&offset=${offset}`);
      lots.push(...page.items); offset = page.next_offset;
    }
    const picked = new Set(card.lots?.map((lot) => lot.id));
    const matching = lots.filter((lot) => lot.finish === card.finish || lot.finish === "unknown")
      .sort((a, b) => Number(picked.has(b.id)) - Number(picked.has(a.id)) || Number(b.finish === card.finish) - Number(a.finish === card.finish));
    let needed = card.quantity;
    for (const lot of matching) {
      const take = Math.min(needed, lot.quantity - (used.get(lot.id) || 0));
      if (take < 1) continue;
      used.set(lot.id, (used.get(lot.id) || 0) + take); removals.push({ card, lot, take }); needed -= take;
      if (!needed) break;
    }
    if (needed) {
      const have = card.quantity - needed;
      throw new Error(`Your collection has ${have} ${finishNames[card.finish].toLowerCase()} ${have === 1 ? "copy" : "copies"} of ${card.printing.name}, but this trade gives ${card.quantity}. Change the copies or finish, then accept again.`);
    }
  }
  return removals;
}

/** Received cards enter the collection as an ordinary import, so they keep a source and can be undone. */
export async function addReceived(session: Session, get: TradeLine[], note: string, receipt?: { key: string; day: string }) {
  const lines = get.map((card) => [card.printing.id, card.printing.name, card.printing.set_code, card.printing.collector_number, card.printing.language, card.quantity, card.finish, TRADE_BINDER, note].map(csvCell).join(","));
  const body = ["Scryfall ID,Name,Set Code,Collector Number,Language,Quantity,Finish,Binder Name,Notes", ...lines].join("\r\n") + "\r\n";
  // With a receipt, a retry sends the same file and key, so the server returns the first import instead of adding the cards again.
  let batch = await request<ImportBatch>(`/api/v1/imports?filename=${encodeURIComponent(`trade-${receipt?.day || new Date().toISOString().slice(0, 10)}.csv`)}&format=generic&repeat=true`, {
    method: "POST", body, headers: { "Content-Type": "text/csv", "X-CSRF-Token": session.csrf_token, "Idempotency-Key": receipt?.key || crypto.randomUUID() }, action: "Add traded cards" });
  // The server previews, then adds, imported copies in the background; follow it until both finish.
  for (let attempt = 0; ; attempt++) {
    if (batch.state === "REVIEW") {
      if (batch.summary?.unresolved_rows) throw new Error("Some cards you get couldn’t be matched to this server’s catalog. Open Import / export to review that import.");
      batch = await request<ImportBatch>(`/api/v1/imports/${batch.id}/confirm`, { ...mutation(session, { expected_revision: batch.revision, owned_cards: true }), action: "Add traded cards" });
    }
    if (batch.state === "COMPLETED") return batch.summary?.committed_copies ?? get.reduce((sum, card) => sum + card.quantity, 0);
    if (batch.state === "FAILED") throw new Error(batch.error || "Adding the cards you get failed. Open Import / export to retry that import.");
    if (attempt > 240) throw new Error("Adding the cards you get is still running. Check Import / export in a moment.");
    await pause(1000);
    batch = await request<ImportBatch>(`/api/v1/imports/${batch.id}`, { action: "Add traded cards" });
  }
}

/**
 * Check every card given first, add the cards received, then remove the cards given.
 * The callbacks let the caller drop finished parts so a retry never repeats them.
 */
export async function applyTrade<T extends TradeLine>(session: Session, give: T[], get: T[], options: {
  note: string; receipt?: { key: string; day: string }; onStep?: (label: string) => void; onReceived?: () => void; onRemoved?: (card: T, take: number) => void;
}) {
  let added = 0, removed = 0;
  try {
    options.onStep?.("Checking your collection…");
    const removals = await planRemovals(give);
    if (get.length) {
      options.onStep?.("Adding the cards you get…");
      added = await addReceived(session, get, options.note, options.receipt);
      options.onReceived?.();
    }
    options.onStep?.("Removing the cards you give…");
    // One lot can cover several lines, so each lot is changed once; a second request would carry a stale version.
    const perLot = new Map<string, Removal<T>[]>();
    for (const removal of removals) perLot.set(removal.lot.id, [...(perLot.get(removal.lot.id) || []), removal]);
    for (const parts of perLot.values()) {
      const lot = parts[0].lot, taken = parts.reduce((sum, part) => sum + part.take, 0);
      await request(`/api/v1/collection/${lot.id}/quantity`, { ...mutation(session, { expected_version: lot.version, quantity: lot.quantity - taken }), action: "Remove traded cards" });
      removed += taken;
      for (const { card, take } of parts) options.onRemoved?.(card, take);
    }
    return { added, removed };
  } catch (reason) {
    const done = [added && `added ${plural(added)} you get`, removed && `removed ${plural(removed)} you give`].filter(Boolean).join(" and ");
    throw done ? new Error(`The trade was only partly saved: PakTrak ${done}. What’s left is still listed. ${(reason as Error).message}`) : reason;
  }
}

export function appliedMessage(added: number, removed: number) {
  return `Trade accepted. ${[added && `Added ${plural(added)} to “${TRADE_BINDER}”`, removed && `${added ? "removed" : "Removed"} ${plural(removed)} from your collection`].filter(Boolean).join(" and ")}.`;
}
