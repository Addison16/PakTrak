import ErrorNotice from "./ErrorNotice";
import { useRef, useState } from "react";
import { foilName, isQueued, mutation, queuedNotice, send, type Lot, type Printing, type Session } from "./api";
import PrintingPicker from "./PrintingPicker";

const finishes: Record<string, string> = { nonfoil: "Normal / nonfoil", foil: "Foil", etched: "Etched foil", unknown: "Unknown finish" };

function Editor({ lot, session, onSaved }: { lot: Lot; session: Session; onSaved: () => Promise<void> }) {
  const [printing, setPrinting] = useState(lot.printing);
  const [finish, setFinish] = useState(lot.finish);
  const [condition, setCondition] = useState(lot.condition);
  const [notes, setNotes] = useState(lot.notes);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<"" | "saved" | "queued">("");
  const [error, setError] = useState<Error | string>("");
  const attempt = useRef({ body: "", key: "" });
  function choose(value: Printing) {
    setPrinting(value);
    if (finish !== "unknown" && !value.finishes.includes(finish)) setFinish("");
  }
  async function save() {
    setBusy(true); setError("");
    const data = { printing_id: printing.id, finish, condition, notes, expected_version: lot.version };
    const body = JSON.stringify(data);
    if (attempt.current.body !== body) attempt.current = { body, key: crypto.randomUUID() };
    const changes = [printing.id !== lot.printing.id && `Printing: ${printing.set_code.toUpperCase()} #${printing.collector_number}`, finish !== lot.finish && `Finish: ${finish === "foil" ? foilName(printing) : finishes[finish] || finish}`,
      condition !== lot.condition && `Condition: ${condition === "ungraded" ? "Ungraded" : condition}`, notes !== lot.notes && "Notes changed"].filter(Boolean).join(" · ");
    try {
      const result = await send(session, "/api/v1/collection/" + lot.id + "/details", mutation(session, data, attempt.current.key),
        { label: `Edit ${lot.printing.name} in ${lot.binder}`, detail: changes, resource: "lot:" + lot.id, preview: { finish, condition, notes } });
      if (isQueued(result)) { setSaved("queued"); setBusy(false); return; }
      setSaved("saved");
    } catch (e) { setError(e as Error); setBusy(false); return; }
    try { await onSaved(); }
    catch { setError("Your correction was saved. Close and reopen the card to reload its details."); }
    finally { setBusy(false); }
  }
  return <div>
    <p className="fine">Applies to {lot.quantity.toLocaleString()} {lot.quantity === 1 ? "copy" : "copies"} in {lot.binder}. Match the set symbol and collector number printed on your card.</p>
    <fieldset disabled={busy || !!saved} className="card-edit-fields">
      <details onToggle={(e) => setChoosing(e.currentTarget.open)}><summary>Change set, rarity or card</summary>
        <p className="fine">Choose the correct printing below. Its rarity, artwork and price guide update together.</p>
        {choosing && <PrintingPicker initialPrinting={lot.printing} selectedId={printing.id} onSelect={choose} />}
      </details>
      <div className="chosen-printing" aria-label="Selected printing"><span className="eyebrow">Selected printing</span><strong>{printing.name}</strong><p>{printing.set_name} ({printing.set_code.toUpperCase()}) · #{printing.collector_number}<br /><span className="rarity-text">{printing.rarity || "Rarity unavailable"}</span> · {printing.language.toUpperCase()}</p></div>
      <label>Card finish<select value={finish} onChange={(e) => setFinish(e.target.value)}>{!finish && <option value="" disabled>Choose a finish</option>}{[...printing.finishes, "unknown"].map((value) => <option key={value} value={value}>{value === "foil" ? foilName(printing) : finishes[value] || value}</option>)}</select></label>
      {!finish && <p className="fine">This printing does not have the previously recorded finish. Choose the finish on your copy.</p>}
      <label>Condition<select value={condition} onChange={(e) => setCondition(e.target.value)}>{["ungraded", "NM", "LP", "MP", "HP", "damaged"].map((value) => <option key={value} value={value}>{value === "ungraded" ? "Ungraded" : value}</option>)}</select></label>
      <label>Copy notes<textarea rows={3} maxLength={4096} placeholder="Binder page, box divider, or anything useful for finding these copies" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      <button type="button" className="button primary" disabled={!finish || (printing.id === lot.printing.id && finish === lot.finish && condition === lot.condition && notes === lot.notes)} onClick={() => void save()}>{busy ? "Saving…" : saved === "queued" ? "Queued" : saved ? "Saved" : "Save card details"}</button>
    </fieldset>
    {saved === "queued" && <p className="message success" role="status">{queuedNotice}</p>}
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
  </div>;
}

export default function CardEditor(props: { lot: Lot; session: Session; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  return <details className="card-editor" onToggle={(e) => setOpen(e.currentTarget.open)}><summary>Edit card details</summary>{open && <Editor {...props} />}</details>;
}
