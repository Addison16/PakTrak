import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { mutation, request, type Printing, type Session } from "./api";
import ErrorNotice from "./ErrorNotice";
import { Icon } from "./Icon";
import { navigation } from "./navigation";
import { formats, sections, type Deck, type DeckWorkState, type Section } from "./deckTypes";
import "./deck-scan.css";

type PhotoBatch = { id: string; filename: string; state: string; created_at: string; cards: number; already_added: number; thumbnail_url: string | null };
type PhotoCard = { observation_id: string; scan_id: string; printing: Printing; section: Section };
type Preview = { items: PhotoCard[]; batches: { id: string; filename: string; ready: number; pending: number; already_added: number; processing: boolean }[]; token: string; deck_version: number };

export default function DeckScan({ session, deck, fromBatch, onCreated, onSaved, onStateChange }: {
  session: Session; deck: Deck | null; fromBatch?: string; onCreated: (deck: Deck) => void; onSaved: (deck: Deck) => void; onStateChange: (state: DeckWorkState) => void;
}) {
  const [name, setName] = useState("");
  const [format, setFormat] = useState("casual");
  const [batches, setBatches] = useState<PhotoBatch[]>([]);
  const [allBatches, setAllBatches] = useState(!!fromBatch);
  const [offset, setOffset] = useState(0), [next, setNext] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(fromBatch ? [fromBatch] : []));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [choices, setChoices] = useState<Record<string, Section | "skip">>({});
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<Error | string>("");
  const working = useRef(false);
  const receipt = useRef<{ body: string; key: string } | null>(null);
  const dirty = deck ? !!preview : !!name.trim();
  useLayoutEffect(() => { onStateChange({ dirty, busy }); }, [dirty, busy, onStateChange]);
  useEffect(() => () => onStateChange({ dirty: false, busy: false }), [onStateChange]);

  useEffect(() => {
    if (!deck) return;
    setLoaded(false);
    let stopped = false, reading = false;
    async function list() {
      if (stopped || reading || document.hidden) return;
      reading = true;
      try {
        const value = await request<{ items: PhotoBatch[]; next_offset: number | null }>(`/api/v1/deck-scans/batches?deck_id=${deck!.id}&linked_only=${!allBatches}&offset=${offset}`);
        if (!stopped) { setBatches(value.items); setNext(value.next_offset); }
      } catch (reason) { if (!stopped) setError(reason as Error); }
      finally { reading = false; if (!stopped) setLoaded(true); }
    }
    void list();
    const timer = window.setInterval(() => void list(), 5000);
    document.addEventListener("visibilitychange", list);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", list); };
  }, [deck?.id, allBatches, offset]);

  async function act(work: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true); setError("");
    try { await work(); } catch (reason) { setError(reason as Error); }
    finally { working.current = false; setBusy(false); }
  }
  function savedRequest(body: unknown) {
    const encoded = JSON.stringify(body);
    if (receipt.current?.body !== encoded) receipt.current = { body: encoded, key: crypto.randomUUID() };
    return mutation(session, body, receipt.current.key);
  }
  function chooseBatch(id: string) {
    setSelected((current) => {
      const result = new Set(current); if (result.has(id)) result.delete(id); else result.add(id); return result;
    });
    setPreview(null); setChoices({});
  }
  async function loadPreview() {
    const value = await request<Preview>("/api/v1/deck-scans/preview", mutation(session, { deck_id: deck!.id, scan_ids: [...selected].sort() }));
    setPreview(value); setChoices((current) => Object.fromEntries(value.items.map((item) => [item.observation_id, current[item.observation_id] || "main"])));
  }
  const picked = preview?.items.filter((item) => choices[item.observation_id] !== "skip") || [];
  const pending = preview?.batches.reduce((sum, batch) => sum + batch.pending, 0) || 0;
  const processing = preview?.batches.some((batch) => batch.processing);
  const counts = Object.fromEntries(Object.keys(sections).map((section) => [section, picked.filter((item) => choices[item.observation_id] === section).length]));
  const back = () => navigation.close({ page: "decks", deck: deck?.id });

  return <section className="panel deck-scan" aria-labelledby="deck-scan-title">
    <div className="batch-toolbar"><button className="button secondary" disabled={busy} onClick={back}>← {deck ? "Back to deck" : "Back to decks"}</button></div>
    <div className="eyebrow">YOUR DECK, FROM PHOTOS</div>
    <h2 id="deck-scan-title" tabIndex={-1}>{deck ? `Scan cards for ${deck.name}` : "Scan a deck you own"}</h2>
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
    {!deck ? <form onSubmit={(event) => { event.preventDefault(); void act(async () => {
      const value = await request<Deck>("/api/v1/decks", savedRequest({ name: name.trim(), format, match_mode: "any", notes: "" }));
      onCreated(value);
    }); }}>
      <p>Name your deck, photograph its cards in small groups, then review the matches and save them to its deck box.</p>
      <label>Deck name<input required maxLength={255} value={name} disabled={busy} placeholder="My blue Commander deck" onChange={(event) => setName(event.target.value)} /></label>
      <label>Deck format<select value={format} disabled={busy} onChange={(event) => setFormat(event.target.value)}>{formats.map((value) => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></label>
      <p className="fine">Deck scans leave collection quantities unchanged by default. You can also add collection copies when uploading a photo.</p>
      <button className="button primary" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create deck for scanning"}<Icon name="camera" /></button>
    </form> : <>
      <div className="deck-scan-start"><p>Photograph about 15 separated cards at a time. Each accepted photo stays linked to this deck while the server identifies it.</p>
        <button className="button primary" disabled={busy} onClick={() => navigation.go({ page: "scan", targetDeck: deck.id })}><Icon name="camera" />Take deck photos</button>
        <p className="fine">Repeat for the rest of your deck. Choose a commander and sideboard cards in the preview below.</p></div>
      <h3>Choose photo batches</h3>
      <label className="checkbox"><input type="checkbox" checked={allBatches} disabled={busy} onChange={(event) => { setAllBatches(event.target.checked); setOffset(0); }} />Include my other saved batches</label>
      {!loaded && batches.length === 0 && <p role="status">Loading photo batches…</p>}
      {loaded && batches.length === 0 && <p>No {allBatches ? "saved" : "linked"} photos on this page yet. Take a photo or include your other batches.</p>}
      <ul className="plain-list deck-scan-batches">{batches.map((batch) => <li key={batch.id}>
        <label className="deck-scan-batch"><input type="checkbox" checked={selected.has(batch.id)} disabled={busy || selected.size >= 32 && !selected.has(batch.id)} onChange={() => chooseBatch(batch.id)} />
          {batch.thumbnail_url && <img src={batch.thumbnail_url} alt="" loading="lazy" />}
          <span><strong>{batch.filename}</strong><small>{batch.cards} cards · {batch.already_added} already added{["QUEUED", "PROCESSING"].includes(batch.state) ? " · Processing on server" : ""}</small></span></label>
        <button className="text-button" disabled={busy} onClick={() => navigation.go({ page: "batches", batch: batch.id })}>Review batch</button>
      </li>)}</ul>
      <div className="pagination">{offset > 0 && <button className="text-button" disabled={busy} onClick={() => setOffset(Math.max(0, offset - 20))}>Newer photos</button>}{next !== null && <button className="text-button" disabled={busy} onClick={() => setOffset(next)}>Older photos</button>}</div>
      <div className="actions"><button className="button secondary" disabled={busy || selected.size === 0} onClick={() => void act(loadPreview)}>{preview ? "Refresh preview" : "Preview scanned cards"}</button><span className="fine">{selected.size} photo batches selected · up to 32 at once</span></div>
      {preview && <section className="deck-scan-preview" aria-label="Scanned deck preview">
        <h3>Review cards for your deck</h3>
        <p>{picked.length} cards to add · {counts.commander} commander · {counts.main} mainboard · {counts.sideboard} sideboard</p>
        {pending > 0 && <p className="message">{pending} cards still need a match approved in their photo batches. They are not included in this preview.</p>}
        {processing && <p className="message" role="status">Some photos are still processing. Refresh this preview when they finish.</p>}
        {deck.format === "commander" && <p className="fine">Set your commander’s section below. For partners, select both commanders. Other cards start in Mainboard; mark any extras as Sideboard.</p>}
        {preview.items.length === 0 && <p>No new reviewed cards to add. Previously added cards stay in your deck; finish any pending batch reviews first.</p>}
        <ul className="plain-list deck-scan-cards">{preview.items.map((item, index) => <li key={item.observation_id}>
          {item.printing.image_url ? <img src={`/api/v1/scans/${item.scan_id}/reference/${item.printing.id}/image`} alt={item.printing.name} loading="lazy" onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} /> : <div className="deck-scan-no-art" aria-hidden="true"><Icon name="decks" /></div>}
          <strong>{item.printing.name}</strong><small>{item.printing.set_code.toUpperCase()} #{item.printing.collector_number} · 1 copy</small>
          <label>Deck section<select aria-label={`Section for ${item.printing.name}, card ${index + 1}`} value={choices[item.observation_id] || "main"} disabled={busy} onChange={(event) => setChoices({ ...choices, [item.observation_id]: event.target.value as Section | "skip" })}>{Object.entries(sections).map(([value, label]) => <option key={value} value={value}>{label}</option>)}<option value="skip">Leave out for now</option></select></label>
        </li>)}</ul>
        <div className="deck-scan-save"><p className="fine">Each pictured card adds one deck copy. Repeat cards combine into quantities. Saving this preview does not change your collection. Later batch corrections can be applied by editing the saved deck.</p>
          <button className="button primary" disabled={busy || !!processing || picked.length === 0} onClick={() => void act(async () => {
            const body = { deck_id: deck.id, scan_ids: [...selected].sort(), expected_version: preview.deck_version, token: preview.token, items: picked.map((item) => ({ observation_id: item.observation_id, section: choices[item.observation_id] })) };
            const value = await request<Deck>("/api/v1/deck-scans/save", savedRequest(body)); onSaved(value);
          })}>{busy ? "Saving…" : `Add ${picked.length} scanned cards to deck`}<Icon name="arrow" /></button></div>
      </section>}
    </>}
  </section>;
}
