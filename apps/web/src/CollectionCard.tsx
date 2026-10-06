import ErrorNotice from "./ErrorNotice";
import { useEffect, useState } from "react";
import { mutation, request, type CollectionCard as Card, type Location, type Lot, type Session } from "./api";
import { MoveCards } from "./Locations";
import CardEditor from "./CardEditor";

const finishes: Record<string, string> = { unknown: "Unknown finish", nonfoil: "Nonfoil", foil: "Foil", etched: "Etched foil" };

export default function CollectionCard({ card, binder, locations, session, onSaved, onCorrected = onSaved }: { card: Card; binder: string; locations: Location[]; session: Session; onSaved: () => Promise<void>; onCorrected?: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [lots, setLots] = useState<Lot[]>([]);
  const [offset, setOffset] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | string>("");

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    setLoading(true);
    request<{ items: Lot[]; next_offset: number | null }>("/api/v1/collection?printing_id=" + card.printing.id + "&offset=" + offset + (binder ? "&binder_id=" + binder : ""))
      .then((data) => { if (!stopped) { setLots(data.items); setNext(data.next_offset); } })
      .catch((e: Error) => { if (!stopped) setError(e); })
      .finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [open, card, binder, offset]);

  async function removeCopies(lot: Lot, quantity: number) {
    setBusy(true); setError("");
    try {
      await request("/api/v1/collection/" + lot.id + "/quantity", mutation(session, {
        quantity, expected_version: lot.version,
      }));
      await onSaved();
    } catch (e) { setError(e as Error); }
    finally { setBusy(false); }
  }

  return <li className="owned-card">
    <div className="holding-title"><strong>{card.printing.name}</strong><span className="quantity-badge" aria-label={card.quantity.toLocaleString() + " copies owned"}>×{card.quantity.toLocaleString()}</span></div>
    <p className="fine">{card.printing.set_code.toUpperCase()} · #{card.printing.collector_number} · {card.printing.language.toUpperCase()}</p>
    <div className="card-locations">{card.locations.map((location) => <p className="card-location" key={location.id}><strong>Find it: {location.name}</strong><span>{location.quantity.toLocaleString()} {location.quantity === 1 ? "copy" : "copies"}</span></p>)}</div>
    {card.location_count > card.locations.length && <p className="fine">Also in {card.location_count - card.locations.length} more {card.location_count - card.locations.length === 1 ? "location" : "locations"}. Open Manage copies to see them.</p>}
    <details className="copy-details" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Manage copies</summary>
      {open && <>
        <p className="fine">Choose the copies below to correct their set, rarity or finish, move them or update how many you own.</p>
        {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
        {loading && lots.length === 0 ? <p role="status">Loading your copies…</p> : lots.length === 0 ? <p>No remaining copies on this page.</p> : <ul className="plain-list copy-groups">{lots.map((lot) => <li key={lot.id + ":" + lot.version}>
          <div className="holding-title"><strong>{lot.binder}</strong><span className="badge">{lot.quantity.toLocaleString()} {lot.quantity === 1 ? "copy" : "copies"}</span></div>
          <p className="fine">{finishes[lot.finish] || lot.finish} · {lot.condition === "ungraded" ? "Ungraded" : lot.condition}</p>
          {lot.notes && <p className="fine">{lot.notes}</p>}
          <CardEditor lot={lot} session={session} onSaved={onCorrected} />
          <MoveCards lot={lot} locations={locations} session={session} onSaved={onSaved} />
          <button type="button" className="text-button" disabled={busy || lot.quantity < 1} onClick={() => { if (window.confirm(`Remove 1 copy of ${card.printing.name} from ${lot.binder}?`)) void removeCopies(lot, lot.quantity - 1); }}>Remove 1 copy</button>
          <details><summary>Remove copies</summary><form onSubmit={(e) => { e.preventDefault(); void removeCopies(lot, Number(new FormData(e.currentTarget).get("quantity"))); }}><label>Copies to keep<input name="quantity" type="number" min={0} max={lot.quantity} defaultValue={lot.quantity} required /></label><button className="button secondary" disabled={busy}>Save remaining quantity</button></form></details>
        </li>)}</ul>}
        <div className="pagination">{offset > 0 && <button className="text-button" disabled={loading} onClick={() => { setLots([]); setOffset(Math.max(0, offset - 40)); }}>Previous copies</button>}{next !== null && <button className="text-button" disabled={loading} onClick={() => { setLots([]); setOffset(next); }}>More copies</button>}</div>
      </>}
    </details>
  </li>;
}
