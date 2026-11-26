import { useEffect, useRef, useState } from "react";
import { foilName, mutation, priceInput, request, type Location, type Printing, type Session } from "./api";
import ErrorNotice from "./ErrorNotice";
import PrintingPicker from "./PrintingPicker";
import { useConnection } from "./offline";
import "./trade-value.css";
import { randomId } from "./randomId";

const NEW_LOCATION = "new";
const conditions = ["ungraded", "NM", "LP", "MP", "HP", "damaged"];
const finishLabel = (printing: Printing, finish: string) => finish === "foil" ? foilName(printing) : finish === "etched" ? "Etched foil" : "Nonfoil";
function lastLocation(key: string) { try { return localStorage.getItem(key) || ""; } catch { return ""; } }

/** Add copies to the collection by searching the catalog: no photo and no import file. */
export default function AddCard({ session, locations: saved, preferredLocation, onAdded }: { session: Session; locations: Location[]; preferredLocation?: string; onAdded: () => void }) {
  // A location made here is offered right away, before the collection reloads its list.
  const [created, setCreated] = useState<{ id: string; name: string }[]>([]);
  const locations = [...saved, ...created.filter((item) => !saved.some((known) => known.id === item.id))];
  const locationKey = `paktrak.add-card.location.${session.owner_id}`;
  const [printing, setPrinting] = useState<Printing | null>(null);
  const [finish, setFinish] = useState("nonfoil");
  const [quantity, setQuantity] = useState(1);
  const [condition, setCondition] = useState("ungraded");
  const [location, setLocation] = useState(() => preferredLocation || lastLocation(locationKey));
  const [newLocation, setNewLocation] = useState("");
  const [paid, setPaid] = useState("");
  const price = priceInput(paid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | string>("");
  const [notice, setNotice] = useState("");
  const [round, setRound] = useState(0);
  // One key per card being added, so a retry after a dropped connection can't add it twice.
  const requestKey = useRef(randomId());
  const chosen = useRef<HTMLDivElement>(null);
  const { reachable } = useConnection();

  const known = locations.some((item) => item.id === location);
  const destination = locations.length === 0 ? NEW_LOCATION : known || location === NEW_LOCATION ? location : locations[0].id;
  const naming = destination === NEW_LOCATION;
  useEffect(() => { if (printing) chosen.current?.focus(); }, [printing]);

  function choose(card: Printing) {
    setPrinting(card); setQuantity(1); setCondition("ungraded"); setPaid(""); setError(""); setNotice("");
    setFinish(card.finishes.includes("nonfoil") ? "nonfoil" : card.finishes[0] || "unknown");
    requestKey.current = randomId();
  }

  async function add() {
    if (!printing || busy) return;
    const name = newLocation.trim();
    if (naming && !name) { setError("Name the storage location for this card."); return; }
    if (price === null) { setError("Enter what you paid for one copy in dollars, like 3.50, or leave it empty."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      let binderId = destination, binderName = locations.find((item) => item.id === destination)?.name || name;
      if (naming) {
        const existing = locations.find((item) => item.name.toLowerCase() === name.toLowerCase());
        binderId = existing ? existing.id : (await request<{ id: string }>("/api/v1/binders", { ...mutation(session, { name }), action: "Create storage location" })).id;
        binderName = existing?.name || name;
        if (!existing) setCreated((current) => [...current, { id: binderId, name }]);
        setLocation(binderId); setNewLocation("");
      }
      await request("/api/v1/collection/add", { ...mutation(session, { printing_id: printing.id, binder_id: binderId, quantity, finish, condition, ...(price ? { purchase_price: price } : {}) }, requestKey.current), action: "Add card to collection" });
      try { localStorage.setItem(locationKey, binderId); } catch { /* The choice is only a convenience. */ }
      const kind = finish === "nonfoil" ? "" : ` ${finishLabel(printing, finish).toLowerCase()}`;
      setNotice(`Added ${quantity}${kind} ${quantity === 1 ? "copy" : "copies"} of ${printing.display_name || printing.name} to ${binderName}.`);
      setPrinting(null); setRound((value) => value + 1);
      onAdded();
    } catch (reason) { setError(reason as Error); }
    finally { setBusy(false); }
  }

  return <section className="add-card" aria-labelledby="add-card-title">
    <h3 id="add-card-title">Add a card</h3>
    {!reachable && <p className="fine">Adding cards needs a connection to your PakTrak server.</p>}
    {notice && <p className="message success" role="status">{notice}</p>}
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
    {!printing ? <PrintingPicker key={round} onSelect={choose} /> : <form onSubmit={(event) => { event.preventDefault(); void add(); }}>
      <div className="trade-card add-card-chosen" ref={chosen} tabIndex={-1}>
        {printing.image_url ? <img src={printing.image_url} alt="" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} /> : <span className="printing-art-placeholder" aria-hidden="true" />}
        <div className="trade-card-body">
          <strong>{printing.display_name || printing.name}</strong>
          <small>{printing.set_name ? `${printing.set_name} · ` : ""}{printing.set_code.toUpperCase()} #{printing.collector_number} · {printing.language.toUpperCase()}</small>
          <button type="button" className="text-button" disabled={busy} onClick={() => setPrinting(null)}>Choose a different card</button>
        </div>
      </div>
      <div className="form-grid add-card-fields">
        <label>Finish<select value={finish} disabled={busy || printing.finishes.length < 2} onChange={(event) => setFinish(event.target.value)}>{(printing.finishes.length ? printing.finishes : ["unknown"]).map((value) => <option key={value} value={value}>{value === "unknown" ? "Unknown" : finishLabel(printing, value)}</option>)}</select></label>
        <label>Condition<select value={condition} disabled={busy} onChange={(event) => setCondition(event.target.value)}>{conditions.map((value) => <option key={value} value={value}>{value === "ungraded" ? "Ungraded" : value === "damaged" ? "Damaged" : value}</option>)}</select></label>
        {locations.length > 0 && <label>Storage location<select value={destination} disabled={busy} onChange={(event) => setLocation(event.target.value)}>{locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}<option value={NEW_LOCATION}>New location…</option></select></label>}
        {naming && <label>{locations.length ? "New location name" : "Storage location"}<input value={newLocation} maxLength={255} disabled={busy} placeholder="e.g. Binder A" onChange={(event) => setNewLocation(event.target.value)} /></label>}
        <label>Paid per copy (optional)<input inputMode="decimal" maxLength={12} placeholder="e.g. 3.50" value={paid} disabled={busy} aria-invalid={price === null} onChange={(event) => setPaid(event.target.value)} /></label>
      </div>
      <div className="add-card-submit">
        <div className="trade-quantity" role="group" aria-label="Copies to add">
          <button type="button" disabled={busy || quantity <= 1} aria-label="One fewer copy" onClick={() => setQuantity(quantity - 1)}>−</button>
          <span>{quantity}</span>
          <button type="button" disabled={busy || quantity >= 999} aria-label="One more copy" onClick={() => setQuantity(quantity + 1)}>+</button>
        </div>
        <button className="button primary" disabled={busy || !reachable}>{busy ? "Adding…" : quantity === 1 ? "Add to collection" : `Add ${quantity} copies`}</button>
      </div>
    </form>}
  </section>;
}
