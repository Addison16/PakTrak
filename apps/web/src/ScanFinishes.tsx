import ErrorNotice from "./ErrorNotice";
import { useEffect, useRef, useState } from "react";
import { mutation, request, type Session } from "./api";
import type { Batch, ReviewState } from "./scanTypes";
import { Icon } from "./Icon";

export default function ScanFinishes({ scanId, session, data, processing, disabled, openRequest = 0, onSaved, onRefresh, onStateChange }: {
  scanId: string; session: Session; data: Batch; processing: boolean; disabled: boolean;
  openRequest?: number;
  onSaved: () => Promise<void>; onRefresh: () => Promise<Batch>;
  onStateChange: (state: ReviewState) => void;
}) {
  const [open, setOpen] = useState(false);
  const [countDraft, setCountDraft] = useState<number | "">(0);
  const count = countDraft === "" ? 0 : countDraft;
  const [foils, setFoils] = useState<Set<string>>(new Set());
  const [etched, setEtched] = useState<Set<string>>(new Set());
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | string>("");
  const working = useRef(false);
  const receipt = useRef<{ body: string; key: string } | null>(null);
  const plan = data.finishes;
  const active = data.items.filter((r) => r.state !== "IGNORED");
  const selected = active.filter((r) => foils.has(r.id));
  const dirty = open && (count !== (plan.foil_count ?? plan.foil_ids.length)
    || [...foils].sort().join() !== [...plan.foil_ids].sort().join()
    || [...etched].filter((id) => foils.has(id)).sort().join() !== [...plan.etched_ids].sort().join());
  useEffect(() => { onStateChange({ dirty, busy }); }, [dirty, busy, onStateChange]);
  useEffect(() => () => onStateChange({ dirty: false, busy: false }), [onStateChange]);
  useEffect(() => { if (openRequest && !open && !processing && !disabled) start(); }, [openRequest]);

  function start() {
    setCountDraft(plan.foil_count ?? plan.foil_ids.length);
    setFoils(new Set(plan.foil_ids)); setEtched(new Set(plan.etched_ids));
    setToken(plan.token); setError(""); setOpen(true);
  }
  function toggle(id: string, etchedOnly: boolean) {
    setFoils((before) => { const next = new Set(before); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    if (etchedOnly) setEtched((before) => new Set(before).add(id));
  }
  function clearFoils() { setFoils(new Set()); setEtched(new Set()); }
  async function save() {
    if (working.current) return;
    working.current = true; setBusy(true); setError("");
    const body = { foil_count: count, foil_ids: selected.map((r) => r.id), etched_ids: selected.filter((r) => etched.has(r.id)).map((r) => r.id), token };
    const encoded = JSON.stringify(body);
    if (receipt.current?.body !== encoded) receipt.current = { body: encoded, key: crypto.randomUUID() };
    try {
      await request(`/api/v1/scans/${scanId}/finishes`, mutation(session, body, receipt.current.key));
      await onSaved(); setOpen(false);
    } catch (e) {
      setError(e as Error);
      // Keep the user's taps, but require another explicit save after a conflict.
      try { const updated = await onRefresh(); setToken(updated.finishes.token); } catch { /* Retry keeps the request receipt. */ }
    } finally { working.current = false; setBusy(false); }
  }
  return <section className="scan-finishes" aria-label="Foil cards" data-attention={open || !plan.confirmed || undefined}>
    <div className="scan-finishes-heading"><div className="scan-finishes-title"><span className="finish-section-icon" aria-hidden="true"><Icon name="spark" /></span><div><span className="eyebrow">STEP 1 · FOIL CARDS</span><h3>{open ? count === 0 ? "All cards will be nonfoil" : "Choose your foil cards" : plan.confirmed ? `${plan.foil_ids.length} foil · ${active.length - plan.foil_ids.length} nonfoil` : plan.foil_count === 0 ? "All cards are nonfoil" : plan.foil_count === null ? "Which cards are foil?" : `Select your ${plan.foil_count} foil ${plan.foil_count === 1 ? "card" : "cards"}`}</h3></div></div>
      {!open && <button className={"button " + (plan.confirmed || plan.foil_count === 0 ? "secondary" : "primary")} disabled={disabled || processing || !active.length} onClick={start}>{plan.confirmed || plan.foil_count === 0 ? "Change foil cards" : "Select foil cards"}{!plan.confirmed && plan.foil_count !== 0 && <Icon name="arrow" />}</button>}</div>
    {!open && <p className="fine">{plan.foil_count === 0 ? "Every card defaults to nonfoil. Change the foil count if needed." : processing ? "Identification continues on the server. Select foil cards when it finishes." : plan.confirmed ? "Finishes are saved for this batch." : "Select the foil cards, then confirm. Every other card will be nonfoil."}</p>}
    {open && <>
      <label className="foil-count">How many cards are foil?<input type="number" inputMode="numeric" min={0} max={32} value={String(countDraft)} disabled={busy}
        onFocus={(e) => e.currentTarget.select()} onBlur={() => { setCountDraft(count); if (count === 0) clearFoils(); }}
        onChange={(e) => { const value = e.target.value === "" ? "" : Math.max(0, Math.min(32, Math.trunc(Number(e.target.value) || 0))); setCountDraft(value); if (value === 0) clearFoils(); }} /></label>
      <p className="foil-instructions">{count === 0 ? "No foil cards to select. Confirm to mark every card nonfoil." : <>Tap the <strong>{count} foil {count === 1 ? "card" : "cards"}</strong> below, then confirm. Everything else will be nonfoil.</>}</p>
      {count > 0 && <>
      <div className="scan-gallery foil-gallery">{active.map((item) => {
        const card = item.lot?.printing || item.confirmed_printing || item.candidates[0]?.printing;
        const number = data.items.indexOf(item) + 1;
        const name = card?.name || `Card ${number}`;
        const chosen = foils.has(item.id);
        return <div className={"scan-tile" + (chosen ? " foil-selected" : "")} key={item.id}>
          <button disabled={busy} aria-pressed={chosen} aria-label={`Foil card ${number}: ${name}`} onClick={() => toggle(item.id, !!card?.finishes.includes("etched") && !card.finishes.includes("foil"))}>
            {item.crop_url ? <img src={item.crop_url} alt="" loading="lazy" /> : card?.image_url ? <img src={card.image_url} alt="" loading="lazy" /> : <div className="scan-crop-missing">Card {number}</div>}
            <span className="scan-tile-number">{number}</span><span className={"foil-tile-check" + (chosen ? " checked" : "")} aria-hidden="true">{chosen ? "✓" : "+"}</span><strong>{name}</strong><span className="scan-match-state">{chosen ? "✓ Selected as foil" : "Tap to mark foil"}</span>
          </button>
          {chosen && card?.finishes.includes("etched") && <label className="foil-etched">Foil type<select disabled={busy} value={etched.has(item.id) ? "etched" : "foil"} onChange={(e) => setEtched((before) => { const next = new Set(before); if (e.target.value === "etched") next.add(item.id); else next.delete(item.id); return next; })}><option value="foil">Foil</option><option value="etched">Etched foil</option></select></label>}
        </div>;
      })}</div>
      </>}
      <p className="fine">This saves finishes for {active.length} cards. It does not add copies or change their storage locations.</p>
      <div className="foil-confirmation">
        {count > 0 && <div className="foil-selection-progress"><p className="foil-selection-count" role="status">{selected.length} of {count} foil cards selected</p>
          <progress value={Math.min(selected.length, count)} max={count} aria-label="Foil selection progress" />
          <p className="fine">{selected.length === count ? "Ready to confirm. The rest will be nonfoil." : selected.length > count ? `Remove ${selected.length - count} from your selection, or change the foil count.` : `Choose ${count - selected.length} more ${count - selected.length === 1 ? "card" : "cards"}.`}</p></div>}
        <div className="actions"><button className="button primary" disabled={busy || disabled || processing || selected.length !== count || !active.length} onClick={() => void save()}>{busy ? "Saving finishes…" : "Confirm card finishes"}</button><button className="text-button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button></div>
      </div>
      {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
    </>}
  </section>;
}
