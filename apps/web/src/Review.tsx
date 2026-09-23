import useBackgroundError from "./useBackgroundError";
import ErrorNotice from "./ErrorNotice";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { money, mutation, providers, request, savePriceSource, type Location, type Printing, type Session, type WorkProgress, type PriceSource } from "./api";
import PrintingPicker from "./PrintingPicker";
import CropEditor from "./ScanCropEditor";
import ScanFinishes from "./ScanFinishes";
import { Icon } from "./Icon";
import type { Batch, Region, ReviewState } from "./scanTypes";

type CardDraft = { version: number; choice: Printing | null; editing: boolean; finish: string; condition: string };
const range = (min: string | null, max: string | null) => min === max ? money(min) : money(min) + "–" + money(max);

export default function Review({ scanId, photo, session, editable, onEdit, onStateChange, processing = false, progress, onChange }: {
  scanId: string; photo: string | null; session: Session; editable: boolean; onEdit: () => void;
  onStateChange: (state: ReviewState) => void; processing?: boolean; progress?: WorkProgress | null; onChange?: () => void;
}) {
  const [data, setData] = useState<Batch | null>(null);
  const deckOnly = data?.add_to_collection === false;
  const [regionId, setRegionId] = useState<string | null>(null);
  const [choice, setChoice] = useState<Printing | null>(null);
  const [editing, setEditing] = useState(false);
  const [finish, setFinish] = useState("unknown");
  const [condition, setCondition] = useState("ungraded");
  const [binder, setBinder] = useState("Scanned cards");
  const [binderDirty, setBinderDirty] = useState(false);
  const [foilState, setFoilState] = useState<ReviewState>({ dirty: false, busy: false });
  const [cropState, setCropState] = useState<ReviewState>({ dirty: false, busy: false });
  const [bulkFinish, setBulkFinish] = useState("keep");
  const [bulkCondition, setBulkCondition] = useState("ungraded");
  const [bulkBinder, setBulkBinder] = useState("Scanned cards");
  const [locations, setLocations] = useState<Location[]>([]);
  const [provider, setProvider] = useState<PriceSource>(session.preferred_price_source || "tcgplayer");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<Error | string>("");
  const backgroundError = useBackgroundError();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [expected, setExpected] = useState<number | "">(15);
  const [cropEditor, setCropEditor] = useState<"new" | Region | null>(null);
  const detail = useRef<HTMLElement>(null);
  const foilSection = useRef<HTMLDivElement>(null);
  const galleryHeading = useRef<HTMLHeadingElement>(null);
  const [destination, setDestination] = useState<"foils" | "cards" | null>(null);
  const [foilOpenRequest, setFoilOpenRequest] = useState(0);
  const sequence = useRef(0);
  const working = useRef(false);
  const approvalKey = useRef<{ body: string; key: string } | null>(null);
  const orientationKey = useRef<{ body: string; key: string } | null>(null);
  const drafts = useRef(new Map<string, CardDraft>());
  const regions = data?.items || [];
  const region = regions.find((r) => r.id === regionId) || regions.find((r) => r.state === "NEEDS_REVIEW") || regions[0];
  const regionIndex = regions.indexOf(region);
  const pending = regions.filter((r) => r.state === "NEEDS_REVIEW");
  const printing = choice || region?.lot?.printing || region?.confirmed_printing || region?.candidates?.[0]?.printing || null;
  const displayedEstimate = !choice || choice.id === (region?.lot?.printing.id || region?.confirmed_printing?.id || region?.candidates?.[0]?.printing.id) ? region?.estimate : null;
  const summary = data?.summary;
  const selectedRegions = regions.filter((r) => selected.has(r.id) && r.state === "NEEDS_REVIEW" && r.candidates?.length);
  function changed(item: Region, draft: CardDraft) {
    return item.state !== "IGNORED" && (
      !!draft.choice && draft.choice.id !== (item.lot?.printing.id || item.confirmed_printing?.id || item.candidates?.[0]?.printing.id)
      || draft.finish !== (item.lot?.finish || item.finish || "unknown")
      || !item.lot && draft.condition !== "ungraded"
    );
  }
  const dirty = editable && (foilState.dirty || cropState.dirty || binderDirty || selectedRegions.length > 0 || regions.some((item) => {
    const draft = item.id === regionId ? { version: item.version, choice, editing, finish, condition } : drafts.current.get(item.id);
    return !!draft && changed(item, draft);
  }));
  const saving = busy || foilState.busy || cropState.busy;
  const finishPending = !!data?.finishes && (!data.finishes.confirmed || foilState.dirty);
  useLayoutEffect(() => { onStateChange({ dirty, busy: saving }); }, [dirty, saving, onStateChange]);
  useEffect(() => () => onStateChange({ dirty: false, busy: false }), [onStateChange]);
  useEffect(() => {
    if (editable) return;
    setFoilOpenRequest(0);
    drafts.current.clear(); setSelected(new Set()); setChoice(null); setEditing(false); setCropEditor(null);
    setBinderDirty(false); setNotice(""); setError(""); setRegionId(null);
  }, [editable]);

  async function refresh() {
    const version = ++sequence.current;
    const result = await request<Batch>("/api/v1/scans/" + scanId + "/observations?provider=" + provider);
    if (version === sequence.current) setData(result);
    return result;
  }
  useEffect(() => {
    let stopped = false, loading = false;
    async function poll() {
      if (stopped || loading || document.hidden || !navigator.onLine) return;
      loading = true;
      try { await refresh(); if (!stopped) backgroundError.recovered(); } catch (e) { if (!stopped) backgroundError.failed(e as Error); }
      finally { loading = false; }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), processing ? 2500 : 10000);
    document.addEventListener("visibilitychange", poll);
    return () => { stopped = true; sequence.current++; clearInterval(timer); document.removeEventListener("visibilitychange", poll); };
  }, [scanId, provider, processing]);
  useEffect(() => { request<{ items: Location[] }>("/api/v1/binders").then((r) => setLocations(r.items)).catch(() => {}); }, [scanId]);
  useLayoutEffect(() => {
    if (editable && region && !regionId) chooseRegion(region, false, false);
  }, [editable, region?.id, regionId]);

  function goToStep(step: "foils" | "cards") {
    if (saving) return;
    setDestination(step);
    if (step === "foils") setFoilOpenRequest((value) => value + 1);
    if (!editable && (step === "foils" || pending.length > 0)) onEdit();
  }
  useEffect(() => {
    if (!destination || !data || (destination === "foils" && !editable) || (destination === "cards" && pending.length > 0 && !editable)) return;
    if (destination === "cards" && pending.length > 0) chooseRegion(pending[0]);
    const target = destination === "foils" ? foilSection.current : pending.length > 0 ? detail.current : galleryHeading.current;
    const frame = window.requestAnimationFrame(() => {
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      setDestination(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [destination, editable, !!data]);

  function chooseRegion(item: Region, scroll = false, preserve = true) {
    if (editable && preserve && regionId && region) drafts.current.set(regionId, { version: region.version, choice, editing, finish, condition });
    const saved = drafts.current.get(item.id);
    const draft = saved?.version === item.version ? saved : undefined;
    setRegionId(item.id); setChoice(draft?.choice || null); setEditing(draft?.editing || false);
    setFinish(draft?.finish || item.lot?.finish || item.finish || "unknown");
    setCondition(draft?.condition || item.lot?.condition || "ungraded"); setError("");
    if (scroll) window.setTimeout(() => detail.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 0);
  }
  function nextPending(items: Region[], afterId: string) {
    const index = items.findIndex((r) => r.id === afterId);
    return [...items.slice(index + 1), ...items.slice(0, index)].find((r) => r.state === "NEEDS_REVIEW");
  }
  function advanceReview(updated: Batch, afterId: string) {
    drafts.current.delete(afterId);
    const next = nextPending(updated.items, afterId);
    if (next) chooseRegion(next, true, false);
    else { const saved = updated.items.find((r) => r.id === afterId); if (saved) chooseRegion(saved, true, false); }
  }
  function changePrinting(card: Printing) {
    setChoice(card);
    if (finish !== "unknown" && !card.finishes.includes(finish)) setFinish("unknown");
  }
  async function act(action: () => Promise<void>, after?: (updated: Batch) => void) {
    if (working.current) return;
    working.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); const updated = await refresh(); after?.(updated); onChange?.(); }
    catch (e) { setError(e as Error); await refresh().catch(() => {}); }
    finally { working.current = false; setBusy(false); }
  }
  async function approve(items: { observation_id: string; expected_version: number; printing_id: string; finish: string }[], destination = binder, grade = condition) {
    const body = { items, binder: destination.trim(), condition: grade };
    const encoded = JSON.stringify(body);
    if (approvalKey.current?.body !== encoded) approvalKey.current = { body: encoded, key: crypto.randomUUID() };
    await request("/api/v1/scans/" + scanId + "/approve", mutation(session, body, approvalKey.current.key));
    setNotice(deckOnly ? `${items.length} card matches saved for your deck.` : `${items.length} ${items.length === 1 ? "copy" : "copies"} imported into ${destination.trim()}.`);
    setSelected(new Set()); setBinderDirty(false);
    if (items.some((item) => item.observation_id === region?.id)) { setChoice(null); setEditing(false); }
  }
  function flipPhoto() {
    if (!region) return;
    const body = { expected_version: region.version, rotation: region.rotation === 180 ? 0 : 180 };
    const encoded = JSON.stringify({ id: region.id, ...body });
    if (orientationKey.current?.body !== encoded) orientationKey.current = { body: encoded, key: crypto.randomUUID() };
    const key = orientationKey.current.key;
    void act(async () => {
      await request(`/api/v1/scans/${scanId}/observations/${region.id}/orientation`, {
        ...mutation(session, body, key), method: "PUT",
      });
      setNotice(region.state === "NEEDS_REVIEW" ? "Photo flipped and saved. The server is checking this card again." : "Photo flipped and saved.");
    });
  }
  const approveOne = () => region && printing && act(() => approve([{
    observation_id: region.id, expected_version: region.version, printing_id: printing.id, finish,
  }]), (updated) => advanceReview(updated, region.id));
  const approveSelected = () => act(() => approve(selectedRegions.map((r) => ({
    observation_id: r.id, expected_version: r.version, printing_id: r.candidates[0].printing_id, finish: bulkFinish === "keep" ? r.finish : bulkFinish,
  })), bulkBinder, bulkCondition), (updated) => { for (const item of selectedRegions) drafts.current.delete(item.id); if (region && selectedRegions.some((r) => r.id === region.id)) advanceReview(updated, region.id); });
  function toggle(id: string) { setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }

  return <div className="review">
    {data && !!summary?.cards && <section className="batch-next-steps" aria-label="Batch next steps" data-complete={!processing && !pending.length && !finishPending || undefined}>
      <div className="batch-next-heading"><span className="eyebrow">{processing ? "WHILE WE SCAN" : finishPending || pending.length ? "YOUR NEXT STEPS" : "ALL SET"}</span>
        <h3>{processing ? "Your cards are taking shape" : finishPending || pending.length ? "Finish your batch" : "Batch complete"}</h3>
        <p>{processing ? "Matches appear as scanning continues. Foil selection opens when it finishes." : finishPending ? "Choose the foil cards, then check any matches that need approval." : pending.length ? "Finishes are saved. Check the remaining card matches below." : "Matches reviewed and finishes saved. You can still make corrections."}</p></div>
      <div className="batch-step-list">
        <button type="button" className="batch-step batch-step-foils" data-state={processing ? "waiting" : finishPending ? "next" : "done"} aria-label={finishPending ? "Choose foil cards" : "Edit foil choices"}
          disabled={saving || processing} onClick={() => goToStep("foils")}>
          <span className="batch-step-number" aria-hidden="true">{!finishPending ? "✓" : "1"}</span>
          <span className="batch-step-copy"><strong>{finishPending ? "Choose foil cards" : "Edit foil choices"}</strong><span>{processing ? "Ready when scanning finishes" : foilState.dirty ? "Confirm your foil choices below" : data.finishes.confirmed ? `${data.finishes.foil_ids.length} foil · ${summary.cards - data.finishes.foil_ids.length} nonfoil · Saved` : data.finishes.foil_count ? `Select ${data.finishes.foil_count} foil ${data.finishes.foil_count === 1 ? "card" : "cards"}, then confirm` : "Confirm foil and nonfoil labels"}</span></span><Icon name="arrow" />
        </button>
        <button type="button" className="batch-step batch-step-matches" data-state={pending.length ? finishPending ? "todo" : "next" : processing ? "waiting" : "done"} aria-label={pending.length ? "Review card matches" : "Browse scanned cards"}
          disabled={saving || !regions.length} onClick={() => goToStep("cards")}>
          <span className="batch-step-number" aria-hidden="true">{!pending.length && !processing ? "✓" : "2"}</span>
          <span className="batch-step-copy"><strong>{pending.length ? "Review card matches" : "Browse scanned cards"}</strong><span>{pending.length ? `${pending.length} ${pending.length === 1 ? "card needs" : "cards need"} approval` : processing ? "Results update as we scan" : "All matches reviewed · View or correct"}</span></span><Icon name="arrow" />
        </button>
      </div>
    </section>}
    {summary && <div className="scan-overview">
      <div className="scan-value"><span className="eyebrow">BATCH ESTIMATE</span><strong>{range(summary.value_min, summary.value_max)}</strong>
        <span>{summary.priced_cards} priced · {summary.unpriced_cards} awaiting a match or price</span></div>
      <label className="scan-price-source">Price source<select value={provider} onChange={(e) => {
        const source = e.target.value as PriceSource; setProvider(source);
        void savePriceSource(session, source, false).catch((e: Error) => setError(e));
      }}>{Object.entries(providers).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <div className="scan-counts"><span><strong>{summary.cards}</strong> cards found</span><span><strong>{summary.identified}</strong> suggested</span><span><strong>{deckOnly ? summary.confirmed || 0 : summary.imported}</strong> {deckOnly ? "matched" : "imported"}</span></div>
      <details className="scan-estimate-notes" open={editable}><summary>About prices and matching</summary>
        <p className="fine">Estimates use suggested printings and cached market prices. Ranges include available finishes until you choose one.{summary.prices_updated_at && <> Prices updated {new Date(summary.prices_updated_at).toLocaleString()}.</>}</p>
        <p className="fine">{summary.auto_add_enabled ? `Matches above ${Math.round(summary.auto_add_threshold * 100)}% strength ${deckOnly ? "are matched automatically" : "import automatically"}. Review the remaining suggestions below.` : "Review and approve suggested matches below."}</p>
      </details>
    </div>}
    {processing && <div className="scan-progress" role="status"><div><strong>{summary ? `${summary.checked} of ${summary.regions} cards checked` : "Finding cards in your photo…"}</strong>
      <span>{progress?.eta_seconds ? `About ${progress.eta_seconds < 60 ? `${progress.eta_seconds}s` : `${Math.ceil(progress.eta_seconds / 60)} min`} of processing left` : "The server is working"}</span></div>
      <progress max={Math.max(1, summary?.regions || 1)} value={summary?.checked || 0} aria-label="Card identification progress" />
      <p className="fine">You can close this page. Results and approvals are saved on the server.</p></div>}
    {editable && data?.finishes && <div ref={foilSection} className="scan-finish-section" tabIndex={-1}><ScanFinishes scanId={scanId} session={session} data={data} processing={processing} openRequest={foilOpenRequest} disabled={busy || cropState.busy} onStateChange={setFoilState} onRefresh={refresh} onSaved={async () => {
      const updated = await refresh(); drafts.current.clear();
      const current = updated.items.find((r) => r.id === region?.id);
      if (current) setFinish(current.finish);
      setNotice(deckOnly ? "Foil and nonfoil labels saved for these deck photos." : "Foil and nonfoil labels saved. Imported copies and price estimates are updated."); onChange?.();
    }} />
      {!processing && !finishPending && pending.length > 0 && <button className="button primary review-after-foils" disabled={saving} onClick={() => goToStep("cards")}>Next: review {pending.length} {pending.length === 1 ? "match" : "matches"} <Icon name="arrow" /></button>}
    </div>}
    {editable && <div className="scan-tools"><label>Cards in this photo<input type="number" inputMode="numeric" min={1} max={32} value={String(expected)}
      onFocus={(e) => e.currentTarget.select()} onBlur={() => setExpected((value) => value === "" ? Math.max(1, Math.min(32, summary?.cards || 15)) : value)}
      onChange={(e) => setExpected(e.target.value === "" ? "" : Math.max(1, Math.min(32, Math.trunc(Number(e.target.value) || 1))))} /></label>
      <button className="button secondary" disabled={busy || processing || !photo} onClick={() => void act(async () => {
        await request("/api/v1/scans/" + scanId + "/identify", mutation(session, { find_missing: true })); setNotice("The server is checking this photo again. Saved card decisions are preserved.");
      })}>Check photo again</button>
      <button className="text-button" disabled={busy || !photo} onClick={() => setCropEditor("new")}>Add a missed card</button></div>}
    {editable && summary && expected !== "" && summary.cards !== expected && <p className="message">{summary.cards} of {expected} expected cards found. Check the outlines, add a missed card or ignore an extra region.</p>}
    {photo && !cropEditor && <details className="scan-photo-details"><summary>View photo and card outlines</summary><div className="region-photo"><img src={photo} alt="Your complete uploaded batch" /><svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">{regions.map((item, i) => <g key={item.id}><polygon points={item.polygon.map((p) => p.join(",")).join(" ")} className={item.id === region?.id ? "active" : ""} /><text x={item.polygon.reduce((v, p) => v + p[0], 0) / 4} y={item.polygon.reduce((v, p) => v + p[1], 0) / 4}>{i + 1}</text></g>)}</svg></div></details>}
    {editable && cropEditor && <CropEditor key={cropEditor === "new" ? "new" : cropEditor.id} scanId={scanId} session={session} region={cropEditor === "new" ? null : cropEditor} onStateChange={setCropState}
      onCancel={() => setCropEditor(null)} onSaved={(id) => { setCropEditor(null); setRegionId(id); setChoice(null); setEditing(false); void refresh(); onChange?.(); }} />}
    {regions.length > 0 && <>
      <div className="scan-gallery-heading"><h3 ref={galleryHeading} tabIndex={-1}><span className="eyebrow">{editable ? "REVIEW MATCHES" : "BATCH GALLERY"}</span>Your scanned cards</h3>{editable && <button className="text-button" disabled={busy} onClick={() => setSelected(new Set(regions.filter((r) => r.state === "NEEDS_REVIEW" && r.candidates?.length).map((r) => r.id)))}>Select suggestions</button>}
        {editable && selected.size > 0 && <button className="text-button" onClick={() => setSelected(new Set())}>Clear selection</button>}</div>
      <p className="scan-gallery-help">{pending.length ? deckOnly ? "Tap a card to check its match. Matched cards are ready for your deck preview." : "Tap a card to check its match. Cards marked Imported are already in your collection." : "Tap any card to see its details or make a correction."}</p>
      <div className="scan-gallery" aria-label="Scanned cards">{regions.map((item, i) => {
        const suggested = item.candidates?.[0];
        const name = item.lot?.printing.name || item.confirmed_printing?.name || suggested?.printing.name || (item.recognition?.status ? "Choose a match" : "Identifying…");
        return <div className={"scan-tile" + (item.id === regionId ? " current" : "")} key={item.id}>
          {editable && item.state === "NEEDS_REVIEW" && suggested && <label className="scan-select"><input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} aria-label={`Select card ${i + 1}: ${name}`} /></label>}
          <button disabled={busy} onClick={() => chooseRegion(item, true)} aria-pressed={item.id === regionId} aria-label={`${editable ? "Review" : "View"} card ${i + 1}: ${name}`}>
            {item.crop_url || item.lot?.printing.image_url || item.confirmed_printing?.image_url || suggested?.printing.image_url ? <img src={item.crop_url || `/api/v1/scans/${scanId}/reference/${(item.lot?.printing || item.confirmed_printing || suggested!.printing).id}/image`} alt="" loading="lazy" /> : <div className="scan-crop-missing">Photo expired</div>}
            <span className="scan-tile-number">{i + 1}</span><strong>{name}</strong>
            <span className={"scan-match-state " + (item.state === "COMMITTED" ? "imported" : "")}>{item.state === "COMMITTED" ? deckOnly ? item.recognition.auto_confirmed ? "✓ Auto-matched" : "✓ Matched" : item.recognition.auto_imported ? "✓ Auto-imported" : "✓ Imported" : item.state === "IGNORED" ? "Ignored" : suggested ? `${suggested.match_score > (summary?.auto_add_threshold ?? .88) ? "✓ " : ""}${Math.round(suggested.match_score * 100)}% match` : item.recognition?.status ? "Needs a match" : "Reading card…"}</span>
            {item.finish && item.finish !== "unknown" && <span className={"scan-finish " + item.finish}>{item.finish === "etched" ? "Etched foil" : item.finish === "foil" ? "Foil" : "Nonfoil"}</span>}
            {item.state === "NEEDS_REVIEW" && <span className="scan-review-prompt">Review match <span aria-hidden="true">→</span></span>}
          </button></div>;
      })}</div>
      {editable && selectedRegions.length > 0 && <div className="scan-bulk"><strong>{selectedRegions.length} suggested {selectedRegions.length === 1 ? "card" : "cards"} selected</strong><p>Check their suggested printings before approving. These settings apply to every selected card.</p>
        <div className="form-grid"><label>Selected cards finish<select value={bulkFinish} onChange={(e) => setBulkFinish(e.target.value)}><option value="keep">Keep each card’s finish</option><option value="unknown">Unknown for all</option>{["nonfoil", "foil", "etched"].filter((value) => selectedRegions.every((r) => r.candidates[0].printing.finishes.includes(value))).map((value) => <option key={value} value={value}>{value === "nonfoil" ? "Nonfoil" : value === "foil" ? "Foil" : "Etched"}</option>)}</select></label>
        {!deckOnly && <label>Selected cards condition<select value={bulkCondition} onChange={(e) => setBulkCondition(e.target.value)}>{["ungraded", "NM", "LP", "MP", "HP", "damaged"].map((value) => <option key={value}>{value}</option>)}</select></label>}</div>
        {!deckOnly && <label>Selected cards location<input value={bulkBinder} maxLength={255} onChange={(e) => setBulkBinder(e.target.value)} /></label>}
        <button className="button primary" disabled={busy || !bulkBinder.trim()} onClick={() => void approveSelected()}>{deckOnly ? "Approve" : "Import"} {selectedRegions.length} selected</button></div>}
      {region && (editable || regionId) && <section ref={detail} className="scan-card-detail" tabIndex={-1} aria-label="Review selected card">

        <div className="scan-review-heading"><h3>Card {regionIndex + 1} · {region.state === "COMMITTED" ? deckOnly ? "Matched" : "Imported" : region.state === "IGNORED" ? "Ignored" : "Review suggestion"}</h3>
</div>
        {!processing && pending.length === 0 && <p className="saved" role="status">✓ All cards reviewed.{data?.finishes && !data.finishes.confirmed ? " Finish by confirming the foil cards above." : ""}</p>}
        {notice && <p className="message success" role="status">{notice}</p>}
        <div className="scan-comparison"><figure>{region.crop_url && <img src={region.crop_url} alt="Your scanned card" />}<figcaption>Your photo</figcaption>
          {editable && region.crop_url && <button className="text-button scan-photo-flip" disabled={saving || !!cropEditor} onClick={flipPhoto}>Flip photo 180°</button>}</figure>
          <figure>{printing?.image_url ? <img key={printing.id} src={choice ? `/api/v1/scans/${scanId}/reference/${printing.id}/image` : printing.image_url} alt={printing.name + " catalog reference"} loading="lazy" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} /> : <div className="scan-reference-empty">{printing ? "Artwork unavailable" : "Finding a suggestion"}</div>}<figcaption>{choice ? "Selected printing" : region.lot || region.confirmed_printing ? "Saved printing" : "Suggested printing"}</figcaption></figure></div>
        {printing && <div className="scan-suggested"><h3>{printing.name}</h3><p>{printing.set_name || printing.set_code.toUpperCase()} · #{printing.collector_number} · {printing.language.toUpperCase()} · <span className="rarity-text">{printing.rarity}</span></p>
          {displayedEstimate && <p>{range(displayedEstimate.min, displayedEstimate.max)} <span className="fine">estimated · {providers[provider]}</span></p>}</div>}
        {region.state === "NEEDS_REVIEW" && <>
          {!choice && region.candidates?.[0] && <div className="scan-confidence"><strong>{Math.round(region.candidates[0].match_score * 100)}% match strength</strong><p>{region.candidates[0].evidence.join(" · ")}</p>
            <p className="fine">{region.recognition.reason} This similarity score is not a measured accuracy probability.</p></div>}
          {!processing && !region.candidates?.length && <p className="message">{region.recognition?.reason || "Run Check photo again to get a suggested match."}</p>}
          {editable && region.candidates?.length > 1 && <details className="scan-alternatives"><summary>Other suggested printings</summary>{region.candidates.slice(1).map((candidate) => <button className="printing-choice" key={candidate.printing_id} onClick={() => changePrinting(candidate.printing)}><strong>{candidate.printing.name}</strong><span>{candidate.printing.set_code.toUpperCase()} · #{candidate.printing.collector_number} · {Math.round(candidate.match_score * 100)}% match</span></button>)}</details>}
        </>}
        {!editable && <button className="button secondary" onClick={() => { onEdit(); if (region.state !== "IGNORED") setEditing(true); }}>Edit this card</button>}
        {editable && region.state !== "IGNORED" && <div className="actions"><button className="button secondary" disabled={busy} onClick={() => { if (!editing && region.lot) setFinish(region.lot.finish); setEditing(!editing); }}>{editing ? "Close card search" : "Edit card / printing"}</button>
          {region.state === "NEEDS_REVIEW" && photo && <button className="text-button" disabled={busy} onClick={() => setCropEditor(region)}>Adjust crop</button>}</div>}
        {editable && editing && <PrintingPicker key={region.id} initialPrinting={printing || undefined} selectedId={printing?.id} onSelect={changePrinting} />}
        {editable && (region.state === "NEEDS_REVIEW" || editing) && <>
          <div className="form-grid"><label>Finish<select value={finish} onChange={(e) => setFinish(e.target.value)}><option value="unknown">Unknown / mixed</option>{(printing?.finishes || ["nonfoil", "foil", "etched"]).map((value) => <option key={value} value={value}>{value === "nonfoil" ? "Nonfoil" : value === "foil" ? "Foil" : "Etched"}</option>)}</select></label>
            {!region.lot && !deckOnly && <label>Condition<select value={condition} onChange={(e) => setCondition(e.target.value)}>{["ungraded", "NM", "LP", "MP", "HP", "damaged"].map((value) => <option key={value}>{value}</option>)}</select></label>}</div>
          {!region.lot && !deckOnly && <label>Storage location<input value={binder} list={"review-locations-" + scanId} maxLength={255} placeholder="Red binder or Box 4" onChange={(e) => { setBinder(e.target.value); setBinderDirty(true); }} /><datalist id={"review-locations-" + scanId}>{locations.map((item) => <option key={item.id} value={item.name} />)}</datalist></label>}
          {finish === "unknown" && <p className="fine">Finish stays unknown until you choose one. Choose nonfoil or foil for an exact price estimate.</p>}
          {region.state === "NEEDS_REVIEW" && <button className="button primary" disabled={busy || !printing || !binder.trim()} onClick={() => void approveOne()}>{deckOnly ? "Approve match" : "Approve & import"}</button>}
          {region.state === "NEEDS_REVIEW" && pending.length > 1 && <p className="fine">Approval opens the next card that needs review.</p>}
          {deckOnly && region.state === "COMMITTED" && editing && <button className="button primary" disabled={busy || !printing} onClick={() => void act(() => approve([{ observation_id: region.id, expected_version: region.version, printing_id: printing!.id, finish }]), (updated) => { drafts.current.delete(region.id); const saved = updated.items.find((item) => item.id === region.id); if (saved) chooseRegion(saved, false, false); })}>Save card correction</button>}
          {region.lot && editing && <button className="button primary" disabled={busy || !printing} onClick={() => void act(async () => {
            await request("/api/v1/collection/" + region.lot!.id + "/details", mutation(session, { expected_version: region.lot!.version, printing_id: printing!.id, finish }));
            drafts.current.delete(region.id); setEditing(false); setChoice(null); setNotice("Card details updated.");
          })}>Save card correction</button>}
        </>}
        {deckOnly && region.state === "COMMITTED" && <p className="saved">✓ Match saved for your deck. Your collection quantities are unchanged.</p>}
        {!deckOnly && region.state === "COMMITTED" && <p className="saved">✓ {region.recognition.auto_imported ? "Automatically imported. " : ""}{region.lot?.quantity || 0} copies from this card remain in your collection{region.lot?.binder ? ` · ${region.lot.binder}` : ""}.</p>}
        {editable && (region.state !== "COMMITTED" || deckOnly) && <button className="text-button" disabled={busy} onClick={() => void act(async () => {
          await request("/api/v1/scans/" + scanId + "/observations/" + region.id + "/decision", mutation(session, { expected_version: region.version, action: region.state === "IGNORED" ? "restore" : "ignore" }));
        }, (updated) => { if (region.state !== "IGNORED") advanceReview(updated, region.id); })}>{region.state === "IGNORED" ? "Restore this region" : "Not a card / ignore"}</button>}
          {pending.length > 0 && <button className="text-button" disabled={busy || !nextPending(regions, region.id)} onClick={() => { const next = nextPending(regions, region.id); if (next) chooseRegion(next, true); }}>Next to review · {pending.length} left</button>}
        <nav className="scan-review-nav" aria-label="Card review navigation">
          <button className="button secondary" aria-label="Previous card" disabled={busy || regionIndex <= 0} onClick={() => chooseRegion(regions[regionIndex - 1], true)}><span aria-hidden="true">←</span> Previous</button>
          <span aria-live="polite">{regionIndex + 1} / {regions.length}</span>
          <button className="button secondary" aria-label="Next card" disabled={busy || regionIndex >= regions.length - 1} onClick={() => chooseRegion(regions[regionIndex + 1], true)}>Next <span aria-hidden="true">→</span></button>
        </nav>
      </section>}
    </>}
    {!processing && regions.length === 0 && data && <p>No regions found yet. Check the photo again or outline a card to start identification.</p>}
    {!region && notice && <p className="message success" role="status">{notice}</p>}
    {backgroundError.error && <ErrorNotice error={backgroundError.error} onDismiss={backgroundError.dismiss} />}
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
  </div>;
}
