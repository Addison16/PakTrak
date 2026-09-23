import ErrorNotice from "./ErrorNotice";
import { useState } from "react";
import { mutation, request, type Location, type Lot, type Session } from "./api";

function LocationForm({ location, session, onSaved }: { location?: Location; session: Session; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(location?.name || "");
  const [kind, setKind] = useState(location?.kind || "binder");
  const [notes, setNotes] = useState(location?.notes || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | string>("");
  async function save() {
    setBusy(true); setError("");
    try {
      await request("/api/v1/binders" + (location ? "/" + location.id : ""), mutation(session, { name: name.trim(), kind, notes, ...(location ? { expected_version: location.version } : {}) }));
      await onSaved();
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | string>("");
  async function move() {
    setBusy(true); setError("");
    try {
      await request("/api/v1/collection/" + lot.id + "/move", mutation(session, { binder_id: destination, expected_version: lot.version }));
      await onSaved();
    } catch (e) { setError(e as Error); }
    finally { setBusy(false); }
  }
  return <details><summary>Move to another location</summary><p>This moves all {lot.quantity} copies in this group.</p>
    <label>Destination<select value={destination} onChange={(e) => setDestination(e.target.value)}>{locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <button className="button secondary" disabled={busy || destination === lot.binder_id} onClick={() => void move()}>Move {lot.quantity} copies</button>
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
  </details>;
}
