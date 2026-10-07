import ErrorNotice from "./ErrorNotice";
import { useRef, useState } from "react";
import { isQueued, mutation, queuedNotice, request, send, type Location, type Lot, type Session } from "./api";

function LocationForm({ location, session, onSaved }: { location?: Location; session: Session; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(location?.name || "");
  const [kind, setKind] = useState(location?.kind || "binder");
  const [notes, setNotes] = useState(location?.notes || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | string>("");
  const [notice, setNotice] = useState("");
  async function save() {
    setBusy(true); setError(""); setNotice("");
    try {
      const body = { name: name.trim(), kind, notes, ...(location ? { expected_version: location.version } : {}) };
      // Creating by name is safe to send again, so it can wait offline. The server
      // doesn't recognize a repeated edit, so edits need a connection.
      const result = location ? await request("/api/v1/binders/" + location.id, mutation(session, body))
        : await send(session, "/api/v1/binders", mutation(session, body), { label: `Create storage location ${name.trim()}` });
      if (isQueued(result)) setNotice(queuedNotice); else await onSaved();
      if (!location) { setName(""); setNotes(""); }
    } catch (e) { setError(e as Error); }
    finally { setBusy(false); }
  }
  return <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
    <label>Location name<input value={name} maxLength={255} required placeholder="Red binder or Box 4" onChange={(e) => setName(e.target.value)} /></label>
    <label>Location type<select value={kind} onChange={(e) => setKind(e.target.value as Location["kind"])}><option value="binder">Binder</option><option value="box">Box</option><option value="other">Other storage</option></select></label>
    <label>Location notes<input value={notes} maxLength={1024} placeholder="Office shelf, top row" onChange={(e) => setNotes(e.target.value)} /></label>
    <button className="button secondary" disabled={busy || !name.trim()}>{location ? "Save location" : "Create location"}</button>
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
    {notice && <p className="message success" role="status">{notice}</p>}
  </form>;
}

export default function Locations({ locations, session, onSaved }: { locations: Location[]; session: Session; onSaved: () => Promise<void> }) {
  return <details className="locations"><summary>Manage storage locations</summary>
    <p>Give each physical binder or box a name. Use that same label on your shelf to find cards quickly.</p>
    <LocationForm session={session} onSaved={onSaved} />
    <ul className="plain-list">{locations.map((location) => <li key={location.id}>
      <details><summary>{location.name} <span className="fine">· {location.kind} · {location.copies} copies</span></summary>
        <LocationForm key={location.version} location={location} session={session} onSaved={onSaved} />
      </details>
    </li>)}</ul>
  </details>;
}

export function MoveCards({ lot, locations, session, onSaved }: { lot: Lot; locations: Location[]; session: Session; onSaved: () => Promise<void> }) {
  const [destination, setDestination] = useState(lot.binder_id);
  const [quantity, setQuantity] = useState(String(lot.quantity));
  const count = Number(quantity);
  const valid = quantity.trim() && Number.isInteger(count) && count >= 1 && count <= lot.quantity;
  const receipt = useRef<{ body: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | string>("");
  const [queued, setQueued] = useState(false);
  async function move() {
    setBusy(true); setError("");
    try {
      const body = { binder_id: destination, quantity: count, expected_version: lot.version };
      const encoded = JSON.stringify(body);
      if (receipt.current?.body !== encoded) receipt.current = { body: encoded, key: crypto.randomUUID() };
      const result = await send(session, "/api/v1/collection/" + lot.id + "/move", mutation(session, body, receipt.current.key),
        { label: `Move ${count} ${count === 1 ? "copy" : "copies"} of ${lot.printing.name}`, detail: `${lot.binder} to ${locations.find((item) => item.id === destination)?.name || "another location"}`, resource: "lot:" + lot.id });
      if (isQueued(result)) setQueued(true); else await onSaved();
    } catch (e) { setError(e as Error); }
    finally { setBusy(false); }
  }
  return <details><summary>Move to another location</summary><p>Choose how many of your {lot.quantity} copies to move. Their import history and notes stay attached.</p>
    <label>Copies to move<input type="number" inputMode="numeric" min={1} max={lot.quantity} value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>
    <label>Destination<select value={destination} onChange={(e) => setDestination(e.target.value)}>{locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <button className="button secondary" disabled={busy || queued || !valid || destination === lot.binder_id} onClick={() => void move()}>Move {valid ? count : "selected"} {count === 1 ? "copy" : "copies"}</button>
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
    {queued && <p className="message success" role="status">{queuedNotice}</p>}
  </details>;
}
