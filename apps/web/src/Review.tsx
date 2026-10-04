import useBackgroundError from "./useBackgroundError";
import ErrorNotice from "./ErrorNotice";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { money, mutation, providers, request, savePriceSource, type Location, type Printing, type Session, type WorkProgress, type PriceSource } from "./api";
import PrintingPicker from "./PrintingPicker";
import CropEditor from "./ScanCropEditor";
import ScanFinishes from "./ScanFinishes";
import { Icon } from "./Icon";
import type { Batch, Region, ReviewState } from "./scanTypes";
import ImageViewer, { type ViewerImage } from "./ImageViewer";
import { navigation } from "./navigation";
import { readDraft, removeDraft, writeDraft } from "./recovery";
import "./scan-qol.css";

type CardDraft = { version: number; choice: Printing | null; editing: boolean; finish: string; condition: string };
type SavedReview = { schema: 1; cards: [string, CardDraft][]; current: string | null; binder: string; binderDirty: boolean; selected: string[]; bulkFinish: string; bulkCondition: string; bulkBinder: string };
type ReviewFilter = "all" | "pending" | "unmatched" | "finish";
const range = (min: string | null, max: string | null) => min === max ? money(min) : money(min) + "–" + money(max);
const savedPrinting = (item: Region) => item.lot?.printing || item.confirmed_printing || item.candidates[0]?.printing || null;
const finishConflict = (item: Region) => item.state !== "IGNORED" && item.finish !== "unknown" && !!savedPrinting(item) && !savedPrinting(item)!.finishes.includes(item.finish);
function validSavedReview(value: SavedReview | null): value is SavedReview {
  return !!value && value.schema === 1 && Array.isArray(value.cards) && value.cards.every((entry) => Array.isArray(entry) && typeof entry[0] === "string" && entry[1] && typeof entry[1].version === "number" && typeof entry[1].finish === "string" && typeof entry[1].condition === "string" && (!entry[1].choice || typeof entry[1].choice.id === "string" && Array.isArray(entry[1].choice.finishes))) && Array.isArray(value.selected) && value.selected.every((id) => typeof id === "string") && typeof value.binder === "string" && typeof value.bulkBinder === "string";
}

export default function Review({ scanId, photo, session, onStateChange, processing = false, progress, onChange }: {
  scanId: string; photo: string | null; session: Session;
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
  const recoveryKey = `review:${session.owner_id}:${scanId}`;
  const [recovery, setRecovery] = useState<SavedReview | null>(() => { const saved = readDraft<SavedReview>(recoveryKey); return validSavedReview(saved) ? saved : null; });
  const [localSaved, setLocalSaved] = useState<boolean | null>(null);
  const [filter, setFilter] = useState<ReviewFilter>("all");
  const [order, setOrder] = useState("photo");
  const [viewer, setViewer] = useState<{ images: ViewerImage[]; initialIndex?: number } | null>(null);
  const [referenceFailed, setReferenceFailed] = useState(false);
  const [referenceFallback, setReferenceFallback] = useState(false);
  const [referenceAttempt, setReferenceAttempt] = useState(0);
  const regions = data?.items || [];
  const region = regions.find((r) => r.id === regionId) || regions.find((r) => r.state === "NEEDS_REVIEW") || regions[0];
  const regionIndex = regions.indexOf(region);
  const pending = regions.filter((r) => r.state === "NEEDS_REVIEW");
  const unmatched = pending.filter((r) => !r.candidates.length && !!r.recognition.status);
  const conflicts = regions.filter(finishConflict);
  const visibleRegions = regions.filter((item) => filter === "all" || filter === "pending" && item.state === "NEEDS_REVIEW" || filter === "unmatched" && unmatched.includes(item) || filter === "finish" && finishConflict(item)).slice().sort((a, b) => order === "strength" ? (a.candidates[0]?.match_score ?? -1) - (b.candidates[0]?.match_score ?? -1) || regions.indexOf(a) - regions.indexOf(b) : regions.indexOf(a) - regions.indexOf(b));
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
  const dirty = foilState.dirty || cropState.dirty || binderDirty || selectedRegions.length > 0 || regions.some((item) => {
    const draft = item.id === regionId ? { version: item.version, choice, editing, finish, condition } : drafts.current.get(item.id);
    return !!draft && changed(item, draft);
  });
  const saving = busy || foilState.busy || cropState.busy;
  const finishPending = !!data?.finishes && (!data.finishes.confirmed || foilState.dirty);
  useEffect(() => { setReferenceFailed(false); setReferenceFallback(false); }, [printing?.id, region?.id]);
  function clearRecovery() {
    removeDraft(recoveryKey); removeDraft(`foils:${session.owner_id}:${scanId}`);
    removeDraft(`crop:${session.owner_id}:${scanId}:new`);
    for (const item of regions) removeDraft(`crop:${session.owner_id}:${scanId}:${item.id}`);
  }
  const clearRecoveryRef = useRef(clearRecovery); clearRecoveryRef.current = clearRecovery;
  // An approved in-app departure means discard; a reload leaves recovery intact.
  useEffect(() => () => {
    if (navigation.route.page !== "batches" || navigation.route.batch !== scanId) clearRecoveryRef.current();
  }, [recoveryKey]);
  useEffect(() => {
    if (!data || recovery) return;
    const cards = new Map(drafts.current);
    if (regionId && region) cards.set(regionId, { version: region.version, choice, editing, finish, condition });
    const changedCards = [...cards].filter(([id, draft]) => { const item = regions.find((row) => row.id === id); return item && changed(item, draft); });
    if (!changedCards.length && !binderDirty && !selectedRegions.length) { removeDraft(recoveryKey); setLocalSaved(null); return; }
    setLocalSaved(writeDraft(recoveryKey, { schema: 1, cards: changedCards, current: regionId, binder, binderDirty, selected: [...selected], bulkFinish, bulkCondition, bulkBinder } satisfies SavedReview));
  }, [data, recovery, regionId, choice, editing, finish, condition, binder, binderDirty, selected, bulkFinish, bulkCondition, bulkBinder]);
  useLayoutEffect(() => { onStateChange({ dirty, busy: saving }); }, [dirty, saving, onStateChange]);
  useEffect(() => () => onStateChange({ dirty: false, busy: false }), [onStateChange]);
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
    if (region && !regionId) chooseRegion(region, false, false);
  }, [region?.id, regionId]);

  function goToStep(step: "foils" | "cards") {
    if (saving) return;
    setDestination(step);
    if (step === "foils") setFoilOpenRequest((value) => value + 1);
  }
  useEffect(() => {
    if (!destination || !data) return;
    if (destination === "cards" && pending.length > 0) chooseRegion(pending[0]);
    const target = destination === "foils" ? foilSection.current : pending.length > 0 ? detail.current : galleryHeading.current;
    const frame = window.requestAnimationFrame(() => {
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      setDestination(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [destination, !!data]);

  function chooseRegion(item: Region, scroll = false, preserve = true) {
    if (preserve && regionId && region) drafts.current.set(regionId, { version: region.version, choice, editing, finish, condition });
    const saved = drafts.current.get(item.id);
    const draft = saved;
    if (draft && draft.version !== item.version) {
      // Keep deliberate user choices when recognition or another tab changed a
      // version. The next explicit save uses the current version after review.
      draft.version = item.version;
      setNotice("This card changed on the server. Your unfinished choices are kept; check them before saving.");
    }
    setRegionId(item.id); setChoice(draft?.choice || null); setEditing(draft?.editing || false);
    const draftPrinting = draft?.choice || savedPrinting(item);
    const nextFinish = draft?.finish || item.lot?.finish || item.finish || "unknown";
    setFinish(nextFinish !== "unknown" && draftPrinting && !draftPrinting.finishes.includes(nextFinish) ? "unknown" : nextFinish);
    setCondition(draft?.condition || item.lot?.condition || "ungraded"); setError("");
    if (scroll) window.setTimeout(() => detail.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 0);
  }
  function restoreReview() {
    if (!recovery || !data) return;
    let changedVersions = 0;
    drafts.current.clear();
    for (const [id, draft] of recovery.cards) {
      const item = regions.find((row) => row.id === id && row.state !== "IGNORED");
      if (!item) continue;
      if (item.version !== draft.version) changedVersions++;
      drafts.current.set(id, { ...draft, version: item.version, editing: draft.editing || !!item.lot });
    }
    setBinder(recovery.binder); setBinderDirty(recovery.binderDirty);
    setSelected(new Set(recovery.selected.filter((id) => pending.some((item) => item.id === id))));
    setBulkFinish(recovery.bulkFinish || "keep"); setBulkCondition(recovery.bulkCondition || "ungraded"); setBulkBinder(recovery.bulkBinder);
    const item = regions.find((row) => row.id === recovery.current) || regions.find((row) => drafts.current.has(row.id)) || region;
    if (item) chooseRegion(item, false, false);
    setRecovery(null); setNotice(changedVersions ? `Recovered your choices. ${changedVersions} ${changedVersions === 1 ? "card has" : "cards have"} changed on the server; check the current matches before saving.` : "Unfinished choices recovered. Approve or save each card when you are ready.");
  }
  function openComparison(initialIndex = 0) {
    const images: ViewerImage[] = [];
    if (region?.crop_url) images.push({ src: region.crop_url, label: "Your photo" });
    if (printing?.image_url) images.push({ src: `/api/v1/scans/${scanId}/reference/${printing.id}/image`, fallback: printing.image_url, label: "Catalog reference" });
    if (images.length) setViewer({ images, initialIndex: Math.min(initialIndex, images.length - 1) });
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
    {recovery && <section className="scan-recovery" aria-label="Recovered review draft"><div><strong>Your unfinished review is available</strong><p>Saved on this device for this account. Check the latest matches before saving; no cards were approved by this draft.</p></div><div className="actions"><button className="button primary" disabled={saving || !data} onClick={restoreReview}>Restore review draft</button><button className="text-button" disabled={saving} onClick={() => { removeDraft(recoveryKey); setRecovery(null); }}>Discard review draft</button></div></section>}
    {localSaved !== null && <p className="scan-local-status" role="status">{localSaved ? "Unfinished choices saved on this device. Approve or save to update your collection." : "This browser could not save a recovery draft. Keep this page open until you save your choices."}</p>}
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
      <details className="scan-estimate-notes"><summary>About prices and matching</summary>
        <p className="fine">Estimates use suggested printings and cached market prices. Ranges include available finishes until you choose one.{summary.prices_updated_at && <> Prices updated {new Date(summary.prices_updated_at).toLocaleString()}.</>}</p>
        <p className="fine">{summary.auto_add_enabled ? `Matches above ${Math.round(summary.auto_add_threshold * 100)}% strength ${deckOnly ? "are matched automatically" : "import automatically"}. Review the remaining suggestions below.` : "Review and approve suggested matches below."}</p>
      </details>
    </div>}
    {processing && <div className="scan-progress" role="status"><div><strong>{summary ? `${summary.checked} of ${summary.regions} cards checked` : "Finding cards in your photo…"}</strong>
      <span>{progress?.eta_seconds ? `About ${progress.eta_seconds < 60 ? `${progress.eta_seconds}s` : `${Math.ceil(progress.eta_seconds / 60)} min`} of processing left` : "The server is working"}</span></div>
      <progress max={Math.max(1, summary?.regions || 1)} value={summary?.checked || 0} aria-label="Card identification progress" />
      <p className="fine">You can close this page. Results and approvals are saved on the server.</p></div>}
    {data?.finishes && <div ref={foilSection} className="scan-finish-section" tabIndex={-1}><ScanFinishes scanId={scanId} session={session} data={data} processing={processing} openRequest={foilOpenRequest} disabled={busy || cropState.busy} onStateChange={setFoilState} onRefresh={refresh} onSaved={async () => {
      const updated = await refresh();
      for (const [id, draft] of drafts.current) {
        const saved = updated.items.find((item) => item.id === id);
        if (!saved || saved.state === "IGNORED") { drafts.current.delete(id); continue; }
        drafts.current.set(id, { ...draft, version: saved.version, finish: saved.lot?.finish || saved.finish });
      }
      const current = updated.items.find((r) => r.id === region?.id);
      if (current) setFinish(current.finish !== "unknown" && choice && !choice.finishes.includes(current.finish) ? "unknown" : current.finish);
      setNotice(deckOnly ? "Foil and nonfoil labels saved for these deck photos." : "Foil and nonfoil labels saved. Imported copies and price estimates are updated."); onChange?.();
    }} onReviewCard={(id) => { const item = regions.find((row) => row.id === id); if (item) { chooseRegion(item, true); setEditing(true); } }} />
      {!processing && !finishPending && pending.length > 0 && <button className="button primary review-after-foils" disabled={saving} onClick={() => goToStep("cards")}>Next: review {pending.length} {pending.length === 1 ? "match" : "matches"} <Icon name="arrow" /></button>}
    </div>}
    <div className="scan-tools"><label>Cards in this photo<input type="number" inputMode="numeric" min={1} max={32} value={String(expected)}
      onFocus={(e) => e.currentTarget.select()} onBlur={() => setExpected((value) => value === "" ? Math.max(1, Math.min(32, summary?.cards || 15)) : value)}
      onChange={(e) => setExpected(e.target.value === "" ? "" : Math.max(1, Math.min(32, Math.trunc(Number(e.target.value) || 1))))} /></label>
      <button className="button secondary" disabled={busy || processing || !photo} onClick={() => void act(async () => {
        await request("/api/v1/scans/" + scanId + "/identify", mutation(session, { find_missing: true })); setNotice("The server is checking this photo again. Saved card decisions are preserved.");
      })}>Check photo again</button>
      <button className="text-button" disabled={busy || !photo} onClick={() => setCropEditor("new")}>Add a missed card</button></div>
    {summary && expected !== "" && summary.cards !== expected && <p className="message">{summary.cards} of {expected} expected cards found. Check the outlines, add a missed card or ignore an extra region.</p>}
    {photo && !cropEditor && <details className="scan-photo-details"><summary>View photo and card outlines</summary><div className="region-photo"><img src={photo} alt="Your complete uploaded batch" /><svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">{regions.map((item, i) => <g key={item.id}><polygon points={item.polygon.map((p) => p.join(",")).join(" ")} className={item.id === region?.id ? "active" : ""} /><text x={item.polygon.reduce((v, p) => v + p[0], 0) / 4} y={item.polygon.reduce((v, p) => v + p[1], 0) / 4}>{i + 1}</text></g>)}</svg></div></details>}
    {cropEditor && <CropEditor key={cropEditor === "new" ? "new" : cropEditor.id} scanId={scanId} session={session} region={cropEditor === "new" ? null : cropEditor} onStateChange={setCropState}
      onCancel={() => setCropEditor(null)} onSaved={(id) => { setCropEditor(null); setRegionId(id); setChoice(null); setEditing(false); void refresh(); onChange?.(); }} />}
    {regions.length > 0 && <>
      <div className="scan-gallery-heading"><h3 ref={galleryHeading} tabIndex={-1}><span className="eyebrow">{pending.length ? "REVIEW MATCHES" : "BATCH GALLERY"}</span>Your scanned cards</h3>{pending.some((r) => r.candidates?.length) && <button className="text-button" disabled={busy} onClick={() => setSelected(new Set(regions.filter((r) => r.state === "NEEDS_REVIEW" && r.candidates?.length).map((r) => r.id)))}>Select suggestions</button>}
        {selected.size > 0 && <button className="text-button" onClick={() => setSelected(new Set())}>Clear selection</button>}</div>
      <p className="scan-gallery-help">{pending.length ? deckOnly ? "Tap a card to check its match. Matched cards are ready for your deck preview." : "Tap a card to check its match. Cards marked Imported are already in your collection." : "Tap any card to see its details or make a correction."}</p>
      <div className="scan-queue-tools"><div className="scan-queue-filters" role="group" aria-label="Filter scanned cards">{([["all", "All cards", regions.length], ["pending", "Needs review", pending.length], ["unmatched", "No match", unmatched.length], ["finish", "Finish conflicts", conflicts.length]] as const).map(([value, label, count]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label} <span>{count}</span></button>)}</div><label className="scan-queue-sort">Card order<select value={order} onChange={(event) => setOrder(event.target.value)}><option value="photo">Order in photo</option><option value="strength">Lowest match strength first</option></select></label></div>
      {!visibleRegions.length && <p className="scan-filter-empty" role="status">No cards in this view. <button className="text-button" onClick={() => setFilter("all")}>Show all cards</button></p>}
      <div className="scan-gallery" aria-label="Scanned cards">{visibleRegions.map((item) => {
        const i = regions.indexOf(item);
        const suggested = item.candidates?.[0];
        const name = item.lot?.printing.name || item.confirmed_printing?.name || suggested?.printing.name || (item.recognition?.status ? "Choose a match" : "Identifying…");
        return <div className={"scan-tile" + (item.id === regionId ? " current" : "")} key={item.id}>
          {item.state === "NEEDS_REVIEW" && suggested && <label className="scan-select"><input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} aria-label={`Select card ${i + 1}: ${name}`} /></label>}
          <button disabled={busy} onClick={() => chooseRegion(item, true)} aria-pressed={item.id === regionId} aria-label={`${item.state === "NEEDS_REVIEW" ? "Review" : "View"} card ${i + 1}: ${name}`}>
            {item.crop_url || item.lot?.printing.image_url || item.confirmed_printing?.image_url || suggested?.printing.image_url ? <img src={item.crop_url || `/api/v1/scans/${scanId}/reference/${(item.lot?.printing || item.confirmed_printing || suggested!.printing).id}/image`} alt="" loading="lazy" /> : <div className="scan-crop-missing">Photo expired</div>}
            <span className="scan-tile-number">{i + 1}</span><strong>{name}</strong>
            <span className={"scan-match-state " + (item.state === "COMMITTED" ? "imported" : "")}>{item.state === "COMMITTED" ? deckOnly ? item.recognition.auto_confirmed ? "✓ Auto-matched" : "✓ Matched" : item.recognition.auto_imported ? "✓ Auto-imported" : "✓ Imported" : item.state === "IGNORED" ? "Ignored" : suggested ? `${suggested.match_score > (summary?.auto_add_threshold ?? .88) ? "✓ " : ""}${Math.round(suggested.match_score * 100)}% match` : item.recognition?.status ? "Needs a match" : "Reading card…"}</span>
            {item.finish && item.finish !== "unknown" && <span className={"scan-finish " + item.finish}>{item.finish === "etched" ? "Etched foil" : item.finish === "foil" ? "Foil" : "Nonfoil"}</span>}
            {finishConflict(item) && <span className="scan-finish-conflict">Finish unavailable for this printing</span>}
            {item.state === "NEEDS_REVIEW" && <span className="scan-review-prompt">Review match <span aria-hidden="true">→</span></span>}
          </button></div>;
      })}</div>
      {selectedRegions.length > 0 && <div className="scan-bulk"><strong>{selectedRegions.length} suggested {selectedRegions.length === 1 ? "card" : "cards"} selected</strong><p>Check their suggested printings before approving. These settings apply to every selected card.</p>
        <div className="form-grid"><label>Selected cards finish<select value={bulkFinish} onChange={(e) => setBulkFinish(e.target.value)}><option value="keep">Keep each card’s finish</option><option value="unknown">Unknown for all</option>{["nonfoil", "foil", "etched"].filter((value) => selectedRegions.every((r) => r.candidates[0].printing.finishes.includes(value))).map((value) => <option key={value} value={value}>{value === "nonfoil" ? "Nonfoil" : value === "foil" ? "Foil" : "Etched"}</option>)}</select></label>
        {!deckOnly && <label>Selected cards condition<select value={bulkCondition} onChange={(e) => setBulkCondition(e.target.value)}>{["ungraded", "NM", "LP", "MP", "HP", "damaged"].map((value) => <option key={value}>{value}</option>)}</select></label>}</div>
        {!deckOnly && <label>Selected cards location<input value={bulkBinder} maxLength={255} onChange={(e) => setBulkBinder(e.target.value)} /></label>}
        <button className="button primary" disabled={busy || !bulkBinder.trim()} onClick={() => void approveSelected()}>{deckOnly ? "Approve" : "Import"} {selectedRegions.length} selected</button></div>}
      {region && <section ref={detail} className="scan-card-detail" tabIndex={-1} aria-label="Review selected card">

        <div className="scan-review-heading"><h3>Card {regionIndex + 1} · {region.state === "COMMITTED" ? deckOnly ? "Matched" : "Imported" : region.state === "IGNORED" ? "Ignored" : "Review suggestion"}</h3>
</div>
        {!processing && pending.length === 0 && <p className="saved" role="status">✓ All cards reviewed.{data?.finishes && !data.finishes.confirmed ? " Finish by confirming the foil cards above." : ""}</p>}
        {notice && <p className="message success" role="status">{notice}</p>}
        <div className="scan-comparison"><figure>{region.crop_url && <button className="scan-photo-enlarge" aria-label="Enlarge your scanned card" onClick={() => openComparison()}><img src={region.crop_url} alt="Your scanned card" /><span>Enlarge ↗</span></button>}<figcaption>Your photo</figcaption>
          {region.crop_url && <button className="text-button scan-photo-flip" disabled={saving || !!cropEditor} onClick={flipPhoto}>Flip photo 180°</button>}</figure>
          <figure>{printing?.image_url ? referenceFailed ? <div className="scan-reference-missing" role="status">Artwork could not be loaded.<button className="text-button" onClick={() => { setReferenceFailed(false); setReferenceFallback(false); setReferenceAttempt((value) => value + 1); }}>Retry artwork</button></div> : <button className="scan-photo-enlarge" aria-label="Enlarge catalog reference" onClick={() => openComparison(region.crop_url ? 1 : 0)}><img key={`${printing.id}-${referenceAttempt}-${referenceFallback}`} src={referenceFallback ? printing.image_url : `/api/v1/scans/${scanId}/reference/${printing.id}/image`} alt={printing.name + " catalog reference"} loading="lazy" onError={() => { if (!referenceFallback) setReferenceFallback(true); else setReferenceFailed(true); }} /><span>Compare ↗</span></button> : <div className="scan-reference-empty">{printing ? "Artwork unavailable" : "Finding a suggestion"}</div>}<figcaption>{choice ? "Selected printing" : region.lot || region.confirmed_printing ? "Saved printing" : "Suggested printing"}</figcaption></figure></div>
        {printing && <div className="scan-suggested"><h3>{printing.display_name || printing.name}</h3>{printing.display_name && printing.display_name !== printing.name && <p>{printing.name}</p>}<p>{printing.set_name || printing.set_code.toUpperCase()} · #{printing.collector_number} · {printing.language.toUpperCase()} · <span className="rarity-text">{printing.rarity}</span></p>
          {displayedEstimate && <p>{range(displayedEstimate.min, displayedEstimate.max)} <span className="fine">estimated · {providers[provider]}</span></p>}</div>}
        {region.state === "NEEDS_REVIEW" && <>
          {!choice && region.candidates?.[0] && <div className="scan-confidence"><strong>{Math.round(region.candidates[0].match_score * 100)}% match strength</strong><p>{region.candidates[0].evidence.join(" · ")}</p>
            <p className="fine">{region.recognition.reason} This similarity score is not a measured accuracy probability.</p></div>}
          {!processing && !region.candidates?.length && <p className="message">{region.recognition?.reason || "Run Check photo again to get a suggested match."}</p>}
          {region.candidates?.length > 1 && <details className="scan-alternatives"><summary>Other suggested printings</summary>{region.candidates.slice(1).map((candidate) => <button className="printing-choice" key={candidate.printing_id} onClick={() => changePrinting(candidate.printing)}><strong>{candidate.printing.name}</strong><span>{candidate.printing.set_code.toUpperCase()} · #{candidate.printing.collector_number} · {Math.round(candidate.match_score * 100)}% match</span></button>)}</details>}
        </>}
        {region.state !== "IGNORED" && <div className="actions"><button className="button secondary" disabled={busy} onClick={() => { if (!editing && region.lot) setFinish(region.lot.finish); setEditing(!editing); }}>{editing ? "Close card search" : "Edit card / printing"}</button>
          {region.state === "NEEDS_REVIEW" && photo && <button className="text-button" disabled={busy} onClick={() => setCropEditor(region)}>Adjust crop</button>}</div>}
        {editing && <PrintingPicker key={region.id} initialPrinting={printing || undefined} selectedId={printing?.id} onSelect={changePrinting} />}
        {(region.state === "NEEDS_REVIEW" || editing) && <>
          <div className="form-grid"><label>Finish<select value={finish} onChange={(e) => setFinish(e.target.value)}><option value="unknown">Unknown / mixed</option>{(printing?.finishes || ["nonfoil", "foil", "etched"]).map((value) => <option key={value} value={value}>{value === "nonfoil" ? "Nonfoil" : value === "foil" ? "Foil" : "Etched"}</option>)}</select></label>
            {!region.lot && !deckOnly && <label>Condition<select value={condition} onChange={(e) => setCondition(e.target.value)}>{["ungraded", "NM", "LP", "MP", "HP", "damaged"].map((value) => <option key={value}>{value}</option>)}</select></label>}</div>
          {!region.lot && !deckOnly && <label>Storage location<input value={binder} list={"review-locations-" + scanId} maxLength={255} placeholder="Red binder or Box 4" onChange={(e) => { setBinder(e.target.value); setBinderDirty(true); }} /><datalist id={"review-locations-" + scanId}>{locations.map((item) => <option key={item.id} value={item.name} />)}</datalist></label>}
          {finish === "unknown" && <p className="fine">Finish stays unknown until you choose one. Choose nonfoil or foil for an exact price estimate.</p>}
          {region.state === "NEEDS_REVIEW" && pending.length > 1 && <p className="fine">{deckOnly ? "Approve match" : "Approve & import"} in the bar below opens the next card that needs review.</p>}
          {deckOnly && region.state === "COMMITTED" && editing && <button className="button primary" disabled={busy || !printing} onClick={() => void act(() => approve([{ observation_id: region.id, expected_version: region.version, printing_id: printing!.id, finish }]), (updated) => { drafts.current.delete(region.id); const saved = updated.items.find((item) => item.id === region.id); if (saved) chooseRegion(saved, false, false); })}>Save card correction</button>}
          {region.lot && editing && <button className="button primary" disabled={busy || !printing} onClick={() => void act(async () => {
            await request("/api/v1/collection/" + region.lot!.id + "/details", mutation(session, { expected_version: region.lot!.version, printing_id: printing!.id, finish }));
            drafts.current.delete(region.id); setEditing(false); setChoice(null); setNotice("Card details updated.");
          })}>Save card correction</button>}
        </>}
        {deckOnly && region.state === "COMMITTED" && <p className="saved">✓ Match saved for your deck. Your collection quantities are unchanged.</p>}
        {!deckOnly && region.state === "COMMITTED" && <p className="saved">✓ {region.recognition.auto_imported ? "Automatically imported. " : ""}{region.lot?.quantity || 0} copies from this card remain in your collection{region.lot?.binder ? ` · ${region.lot.binder}` : ""}.</p>}
        {(region.state !== "COMMITTED" || deckOnly) && <button className="text-button" disabled={busy} onClick={() => void act(async () => {
          await request("/api/v1/scans/" + scanId + "/observations/" + region.id + "/decision", mutation(session, { expected_version: region.version, action: region.state === "IGNORED" ? "restore" : "ignore" }));
        }, (updated) => { if (region.state !== "IGNORED") advanceReview(updated, region.id); })}>{region.state === "IGNORED" ? "Restore this region" : "Not a card / ignore"}</button>}
          {pending.length > 0 && <button className="text-button" disabled={busy || !nextPending(regions, region.id)} onClick={() => { const next = nextPending(regions, region.id); if (next) chooseRegion(next, true); }}>Next to review · {pending.length} left</button>}
        {/* Approval sits in the sticky bar so it stays under the thumb while scrolling the card. */}
        <nav className="scan-review-nav" aria-label="Card review navigation">
          <button className="button secondary" aria-label="Previous card" disabled={busy || regionIndex <= 0} onClick={() => chooseRegion(regions[regionIndex - 1], true)}><span aria-hidden="true">←</span><span className="scan-review-nav-label"> Previous</span></button>
          <div className="scan-review-nav-center">
            {region.state === "NEEDS_REVIEW" && <button className="button primary" disabled={busy || !printing || !binder.trim()} onClick={() => void approveOne()}>{deckOnly ? "Approve match" : "Approve & import"}</button>}
            <span aria-live="polite">{regionIndex + 1} / {regions.length}</span>
          </div>
          <button className="button secondary" aria-label="Next card" disabled={busy || regionIndex >= regions.length - 1} onClick={() => chooseRegion(regions[regionIndex + 1], true)}><span className="scan-review-nav-label">Next </span><span aria-hidden="true">→</span></button>
        </nav>
      </section>}
    </>}
    {!processing && regions.length === 0 && data && <p>No regions found yet. Check the photo again or outline a card to start identification.</p>}
    {!region && notice && <p className="message success" role="status">{notice}</p>}
    {backgroundError.error && <ErrorNotice error={backgroundError.error} onDismiss={backgroundError.dismiss} />}
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
    {viewer && <ImageViewer {...viewer} onClose={() => setViewer(null)} />}
  </div>;
}
