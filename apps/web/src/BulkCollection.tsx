import { useEffect, useRef, useState } from "react";
import { mutation, request, type Location, type Session } from "./api";
import ErrorNotice from "./ErrorNotice";
import "./collection-qol.css";

type Preview = { token: string; copies: number; groups_changed: number; groups: { id: string; name: string; binder: string; quantity: number; finish: string; condition: string }[] };
const describe = (value: string) => value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
export default function BulkCollection({ ids, binder, locations, session, onClose, onSaved }: { ids: string[]; binder: string; locations: Location[]; session: Session; onClose: () => void; onSaved: (copies: number) => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [action, setAction] = useState("move");
  const [destination, setDestination] = useState("");
  const [finish, setFinish] = useState("nonfoil");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | string>("");
  const receipt = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => {
    const element = dialog.current!; const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow; element.showModal(); document.body.style.overflow = "hidden";
    return () => { element.close(); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  const payload = { printing_ids: ids, source_binder_id: binder || undefined, action, ...(action === "move" ? { binder_id: destination } : { finish }) };
  async function run(confirm: boolean) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      if (!confirm) setPreview(await request<Preview>("/api/v1/collection/bulk/preview", mutation(session, payload)));
      else if (preview) {
        const body = { ...payload, token: preview.token }; const encoded = JSON.stringify(body);
        if (receipt.current?.body !== encoded) receipt.current = { body: encoded, key: crypto.randomUUID() };
        const result = await request<{ copies_changed: number }>("/api/v1/collection/bulk/apply", mutation(session, body, receipt.current.key));
        await onSaved(result.copies_changed); onClose();
      }
    } catch (e) { setError(e as Error); if (confirm) setPreview(null); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="bulk-collection-dialog" aria-labelledby="bulk-title" onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
    <div className="dialog-heading"><div><span className="eyebrow">ORGANIZE TOGETHER</span><h2 id="bulk-title">{ids.length} selected {ids.length === 1 ? "printing" : "printings"}</h2></div><button className="text-button" disabled={busy} onClick={onClose}>Close ×</button></div>
    <p className="fine">{binder ? "Changes apply to copies in the selected storage location." : "Changes apply to every owned copy of the selected printings."} Preview the exact groups before saving.</p>
    <fieldset disabled={busy}><label>Action<select value={action} onChange={(e) => { setAction(e.target.value); setPreview(null); }}><option value="move">Move to a storage location</option><option value="finish">Set card finish</option></select></label>
      {action === "move" ? <label>Destination<select value={destination} onChange={(e) => { setDestination(e.target.value); setPreview(null); }}><option value="">Choose a location</option>{locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : <label>Card finish<select value={finish} onChange={(e) => { setFinish(e.target.value); setPreview(null); }}><option value="nonfoil">Nonfoil</option><option value="foil">Foil</option><option value="etched">Etched foil</option><option value="unknown">Unknown</option></select></label>}
      <button className="button secondary" disabled={action === "move" && !destination} onClick={() => void run(false)}>Preview changes</button>
    </fieldset>
    {preview && <section className="bulk-preview" aria-label="Exact copies to change"><h3>{preview.copies} {preview.copies === 1 ? "copy" : "copies"} will change</h3><p className="fine">{preview.groups_changed} {preview.groups_changed === 1 ? "group" : "groups"} affected. Groups already matching your choice are kept.</p><ul className="plain-list">{preview.groups.map((group) => <li key={group.id}><strong>{group.name} <span>×{group.quantity}</span></strong><p>{group.binder} · {describe(group.finish)} · {describe(group.condition)}</p></li>)}</ul><button className="button primary" disabled={busy || !preview.copies} onClick={() => void run(true)}>{busy ? "Saving…" : `Confirm ${preview.copies} ${preview.copies === 1 ? "copy" : "copies"}`}</button></section>}
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
  </dialog>;
}
