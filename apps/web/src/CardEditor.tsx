import ErrorNotice from "./ErrorNotice";
import { useRef, useState } from "react";
import { mutation, request, type Lot, type Printing, type Session } from "./api";
import PrintingPicker from "./PrintingPicker";

const finishes: Record<string, string> = { nonfoil: "Normal / nonfoil", foil: "Foil", etched: "Etched foil", unknown: "Unknown finish" };

function Editor({ lot, session, onSaved }: { lot: Lot; session: Session; onSaved: () => Promise<void> }) {
  const [printing, setPrinting] = useState(lot.printing);
  const [finish, setFinish] = useState(lot.finish);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<Error | string>("");
  const attempt = useRef({ body: "", key: "" });
  function choose(value: Printing) {
    setPrinting(value);
    if (finish !== "unknown" && !value.finishes.includes(finish)) setFinish("");
  }
  async function save() {
    setBusy(true); setError("");
    const data = { printing_id: printing.id, finish, expected_version: lot.version };
    const body = JSON.stringify(data);
    if (attempt.current.body !== body) attempt.current = { body, key: crypto.randomUUID() };
    try {
      await request("/api/v1/collection/" + lot.id + "/details", mutation(session, data, attempt.current.key));
      setSaved(true);
    } catch (e) { setError(e as Error); setBusy(false); return; }
    try { await onSaved(); }
    catch { setError("Your correction was saved. Close and reopen the card to reload its details."); }
    finally { setBusy(false); }
  }
  return <div>
    <p className="fine">Applies to {lot.quantity.toLocaleString()} {lot.quantity === 1 ? "copy" : "copies"} in {lot.binder}. Match the set symbol and collector number printed on your card.</p>
    <fieldset disabled={busy || saved} className="card-edit-fields">
      <details onToggle={(e) => setChoosing(e.currentTarget.open)}><summary>Change set, rarity or card</summary>
        <p className="fine">Choose the correct printing below. Its rarity, artwork and price guide update together.</p>
        {choosing && <PrintingPicker initialPrinting={lot.printing} selectedId={printing.id} onSelect={choose} />}
      </details>
      <div className="chosen-printing" aria-label="Selected printing"><span className="eyebrow">Selected printing</span><strong>{printing.name}</strong><p>{printing.set_name} ({printing.set_code.toUpperCase()}) · #{printing.collector_number}<br /><span className="rarity-text">{printing.rarity || "Rarity unavailable"}</span> · {printing.language.toUpperCase()}</p></div>
      <label>Card finish<select value={finish} onChange={(e) => setFinish(e.target.value)}>{!finish && <option value="" disabled>Choose a finish</option>}{[...printing.finishes, "unknown"].map((value) => <option key={value} value={value}>{finishes[value] || value}</option>)}</select></label>
      {!finish && <p className="fine">This printing does not have the previously recorded finish. Choose the finish on your copy.</p>}
      <button type="button" className="button primary" disabled={!finish || (printing.id === lot.printing.id && finish === lot.finish)} onClick={() => void save()}>{busy ? "Saving…" : saved ? "Saved" : "Save card details"}</button>
    </fieldset>
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
  </div>;
}

export default function CardEditor(props: { lot: Lot; session: Session; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  return <details className="card-editor" onToggle={(e) => setOpen(e.currentTarget.open)}><summary>Edit card details</summary>{open && <Editor {...props} />}</details>;
}
