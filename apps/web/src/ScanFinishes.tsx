import ErrorNotice from "./ErrorNotice";
import { useEffect, useRef, useState } from "react";
import { foilName, mutation, request, type Session } from "./api";
import type { Batch, ReviewState } from "./scanTypes";
import { Icon } from "./Icon";
import { readDraft, removeDraft, writeDraft } from "./recovery";
import "./scan-qol.css";

type FoilDraft = { foils: string[]; etched: string[]; token: string };
function isFoilDraft(value: FoilDraft | null): value is FoilDraft {
  return !!value && Array.isArray(value.foils) && value.foils.length <= 32 && value.foils.every((id) => typeof id === "string")
    && Array.isArray(value.etched) && value.etched.length <= 32 && value.etched.every((id) => typeof id === "string")
    && typeof value.token === "string";
}

export default function ScanFinishes({ scanId, session, data, processing, disabled, openRequest = 0, onSaved, onRefresh, onStateChange, onReviewCard }: {
  scanId: string; session: Session; data: Batch; processing: boolean; disabled: boolean;
  openRequest?: number;
  onSaved: () => Promise<void>; onRefresh: () => Promise<Batch>;
  onStateChange: (state: ReviewState) => void;
  onReviewCard?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [foils, setFoils] = useState<Set<string>>(new Set());
  const [etched, setEtched] = useState<Set<string>>(new Set());
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | string>("");
  const recoveryKey = `foils:${session.owner_id}:${scanId}`;
  const [recovery, setRecovery] = useState<FoilDraft | null>(() => { const saved = readDraft<FoilDraft>(recoveryKey); return isFoilDraft(saved) ? saved : null; });
  const [localSaved, setLocalSaved] = useState<boolean | null>(null);
  const [notice, setNotice] = useState("");
  const working = useRef(false);
  const receipt = useRef<{ body: string; key: string } | null>(null);
  const plan = data.finishes;
  const active = data.items.filter((r) => r.state !== "IGNORED");
  const selected = active.filter((r) => foils.has(r.id));
  const conflicts = active.filter((item) => {
    const card = item.lot?.printing || item.confirmed_printing || item.candidates[0]?.printing;
    const finish = foils.has(item.id) ? etched.has(item.id) ? "etched" : "foil" : "nonfoil";
    return !!card && !card.finishes.includes(finish);
  });
  const dirty = !!recovery || open && ([...foils].sort().join() !== [...plan.foil_ids].sort().join()
    || [...etched].filter((id) => foils.has(id)).sort().join() !== [...plan.etched_ids].sort().join());
  useEffect(() => { onStateChange({ dirty, busy }); }, [dirty, busy, onStateChange]);
  useEffect(() => () => onStateChange({ dirty: false, busy: false }), [onStateChange]);
  useEffect(() => { if (openRequest && !open && !processing && !disabled) start(); }, [openRequest]);
  useEffect(() => {
    if (!open || recovery) return;
    if (!dirty) { removeDraft(recoveryKey); setLocalSaved(null); return; }
    setLocalSaved(writeDraft(recoveryKey, { foils: [...foils], etched: [...etched].filter((id) => foils.has(id)), token } satisfies FoilDraft));
  }, [open, recovery, dirty, foils, etched, token, recoveryKey]);

  function start() {
    if (recovery) { restore(); return; }
    setFoils(new Set(plan.foil_ids)); setEtched(new Set(plan.etched_ids));
    setToken(plan.token); setError(""); setNotice(""); setOpen(true);
  }
  function restore() {
    if (!recovery) return;
    const ids = new Set(active.map((item) => item.id));
    const restored = recovery.foils.filter((id) => ids.has(id));
    setFoils(new Set(restored)); setEtched(new Set(recovery.etched.filter((id) => restored.includes(id))));
    setToken(plan.token); setError(""); setOpen(true); setRecovery(null);
    setNotice(recovery.token !== plan.token || restored.length !== recovery.foils.length ? "Your foil choices are restored. This batch changed; check the current cards before confirming." : "Your unfinished foil choices are restored. Confirm to save their finishes.");
  }
  function discard() {
    removeDraft(recoveryKey); setRecovery(null); setLocalSaved(null); setNotice(""); setError(""); setOpen(false);
  }
  function correctPrinting(id: string) {
    const draft = { foils: [...foils], etched: [...etched].filter((item) => foils.has(item)), token };
    writeDraft(recoveryKey, draft); setRecovery(draft); setOpen(false); onReviewCard?.(id);
  }
  // A single light sweep marks a card as foil; it does not replay while the card stays selected.
  const [shimmer, setShimmer] = useState<string | null>(null);
  function toggle(id: string, etchedOnly: boolean) {
    if (!foils.has(id)) setShimmer(id);
    setFoils((before) => { const next = new Set(before); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    if (etchedOnly) setEtched((before) => new Set(before).add(id));
  }
  async function save() {
    if (working.current) return;
    working.current = true; setBusy(true); setError("");
    const body = { foil_count: selected.length, foil_ids: selected.map((r) => r.id), etched_ids: selected.filter((r) => etched.has(r.id)).map((r) => r.id), token };
    const encoded = JSON.stringify(body);
    if (receipt.current?.body !== encoded) receipt.current = { body: encoded, key: crypto.randomUUID() };
    try {
      await request(`/api/v1/scans/${scanId}/finishes`, mutation(session, body, receipt.current.key));
      removeDraft(recoveryKey); setRecovery(null); setLocalSaved(null);
      await onSaved(); setOpen(false);
    } catch (e) {
      setError(e as Error);
      // Keep the user's taps, but require another explicit save after a conflict.
      try { const updated = await onRefresh(); setToken(updated.finishes.token); } catch { /* Retry keeps the request receipt. */ }
    } finally { working.current = false; setBusy(false); }
  }
  return <section className="scan-finishes" aria-label="Foil cards" data-attention={open || !plan.confirmed || undefined}>
    <div className="scan-finishes-heading"><div className="scan-finishes-title"><span className="finish-section-icon" aria-hidden="true"><Icon name="spark" /></span><div><span className="eyebrow">STEP 1 · FOIL CARDS</span><h3>{open ? "Tap any foil cards" : plan.confirmed ? `${plan.foil_ids.length} foil · ${active.length - plan.foil_ids.length} nonfoil` : plan.foil_count === 0 ? "All cards are nonfoil" : plan.foil_count === null ? "Which cards are foil?" : `Select your ${plan.foil_count} foil ${plan.foil_count === 1 ? "card" : "cards"}`}</h3></div></div>
      {!open && <button className={"button " + (plan.confirmed || plan.foil_count === 0 ? "secondary" : "primary")} disabled={disabled || processing || !active.length} onClick={start}>{plan.confirmed || plan.foil_count === 0 ? "Change foil cards" : "Select foil cards"}{!plan.confirmed && plan.foil_count !== 0 && <Icon name="arrow" />}</button>}</div>
    {!open && <p className="fine">{plan.foil_count === 0 ? "Every card is saved as nonfoil. Use Change foil cards to tap any foils." : processing ? "Identification continues on the server. Select foil cards when it finishes." : plan.confirmed ? "Finishes are saved for this batch." : "Select the foil cards, then confirm. Every other card will be nonfoil."}</p>}
    {recovery && <div className="scan-recovery" aria-label="Recovered foil draft"><div><strong>Your unfinished foil choices are available</strong><p>Saved on this device for this account. Review them before confirming finishes.</p></div><div className="actions"><button className="button primary" disabled={busy || disabled || processing || !active.length} onClick={restore}>Restore foil choices</button><button className="text-button" disabled={busy} onClick={discard}>Discard foil draft</button></div></div>}
    {open && <>
      {notice && <p className="message" role="status">{notice}</p>}
      {localSaved !== null && <p className="scan-local-status" role="status">{localSaved ? "Unfinished foil choices saved on this device." : "This browser could not save a foil draft. Keep this page open until you confirm."}</p>}
      <p className="foil-instructions">Tap each foil card below, then confirm. Everything else will be nonfoil. If none are foil, just confirm.</p>
      {active.length > 0 && <>
      <div className="scan-gallery foil-gallery">{active.map((item) => {
        const card = item.lot?.printing || item.confirmed_printing || item.candidates[0]?.printing;
        const number = data.items.indexOf(item) + 1;
        const name = card?.name || `Card ${number}`;
        const chosen = foils.has(item.id);
        return <div className={"scan-tile" + (chosen ? " foil-selected" : "")} key={item.id} data-shimmer={chosen && shimmer === item.id || undefined} onAnimationEnd={(event) => { if (event.animationName === "foil-tap-sweep") setShimmer(null); }}>
          <button disabled={busy} aria-pressed={chosen} aria-label={`Foil card ${number}: ${name}`} onClick={() => toggle(item.id, !!card?.finishes.includes("etched") && !card.finishes.includes("foil"))}>
            {item.crop_url ? <img src={item.crop_url} alt="" loading="lazy" /> : card?.image_url ? <img src={card.image_url} alt="" loading="lazy" /> : <div className="scan-crop-missing">Card {number}</div>}
            <span className="scan-tile-number">{number}</span><span className={"foil-tile-check" + (chosen ? " checked" : "")} aria-hidden="true"><svg viewBox="0 0 16 16">{chosen ? <path d="M3.5 8.5l3 3 6-7" /> : <path d="M8 3.5v9M3.5 8h9" />}</svg></span><strong>{name}</strong><span className="scan-match-state">{chosen ? `✓ Selected as ${(etched.has(item.id) ? "etched foil" : card ? foilName(card).toLowerCase() : "foil")}` : "Tap to mark foil"}</span>
          </button>
          {chosen && card?.finishes.includes("etched") && <label className="foil-etched">Foil type<select disabled={busy} value={etched.has(item.id) ? "etched" : "foil"} onChange={(e) => setEtched((before) => { const next = new Set(before); if (e.target.value === "etched") next.add(item.id); else next.delete(item.id); return next; })}>{card.finishes.includes("foil") && <option value="foil">{foilName(card)}</option>}<option value="etched">Etched foil</option></select></label>}
          {conflicts.some((conflict) => conflict.id === item.id) && <span className="scan-finish-conflict">This printing does not support the selected finish.{onReviewCard && <button className="text-button" disabled={busy} onClick={() => correctPrinting(item.id)}>Correct printing</button>}</span>}
        </div>;
      })}</div>
      </>}
      <p className="fine">This saves finishes for {active.length} cards. It does not add copies or change their storage locations.</p>
      <div className="foil-confirmation">
        {selected.length > 0 && <p className="foil-selection-count" role="status">{selected.length} foil {selected.length === 1 ? "card" : "cards"} selected</p>}
        {conflicts.length > 0 && <p className="message" role="status">{conflicts.length} {conflicts.length === 1 ? "printing needs" : "printings need"} a finish correction before confirmation.</p>}
        <div className="actions"><button className="button primary" disabled={busy || disabled || processing || !active.length || conflicts.length > 0} onClick={() => void save()}>{busy ? "Saving finishes…" : "Confirm card finishes"}</button><button className="text-button" disabled={busy} onClick={discard}>Cancel</button></div>
      </div>
      {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
    </>}
  </section>;
}
