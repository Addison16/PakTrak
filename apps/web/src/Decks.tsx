import ErrorNotice from "./ErrorNotice";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { mutation, request, type Lot, type Printing, type Session } from "./api";

import DeckImport from "./DeckImport";
import DeckScan from "./DeckScan";
import { Icon } from "./Icon";
import DeckList from "./DeckList";
import DeckBuyList from "./DeckBuyList";
import DeckCardPreview from "./DeckCardPreview";
import DeckLegality from "./DeckLegality";
import DeckTokens from "./DeckTokens";
import DeckValue from "./DeckValue";
import { CardArt } from "./CardDetail";
import PrintingPicker from "./PrintingPicker";
import { splitCollectorSearch } from "./cardSearch";
import { navigation, restoreScroll, useRoute } from "./navigation";
import { formats, sections, type Deck, type DeckCard as Card, type DeckSummary, type DeckWorkState, type MatchMode, type Section } from "./deckTypes";

type EditableCard = Card & { quantityInput?: string };
function quantityProblem(card: EditableCard) {
  const input = card.quantityInput ?? String(card.quantity);
  if (!input.trim()) return "Enter a quantity, or 0 to remove this card when you save.";
  const value = Number(input);
  return Number.isInteger(value) && value >= 0 && value <= 100000 ? "" : "Use a whole number from 0 to 100,000.";
}

export default function Decks({ session, active, navigationRef }: { session: Session; active: boolean; navigationRef: RefObject<(() => boolean) | null> }) {
  const route = useRoute();
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [offset, setOffset] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  const [deck, setDeck] = useState<Deck | null>(null);
  const [name, setName] = useState("");
  const [format, setFormat] = useState("casual");
  const [notes, setNotes] = useState("");
  const [matchMode, setMatchMode] = useState<MatchMode>("any");
  const importing = active && route.view === "import";
  const scanning = active && route.view === "scan";
  const [importState, setImportState] = useState<DeckWorkState>({ dirty: false, busy: false });
  const editing = active && route.view === "edit";
  const [creating, setCreating] = useState(false);
  const [cardFilter, setCardFilter] = useState("");
  const [gallery, setGallery] = useState(true);
  function setPreviewCard(card: Card | null) {
    const destination = { ...route, card: card ? card.printing.id + "_" + card.section : undefined };
    if (card) navigation.go(destination, { replace: !!route.card });
    else if (navigation.route.page === "decks" && navigation.route.card) navigation.close(destination);
  }
  const returnTo = useRef<{ id: string; y: number } | null>(null);
  const listSequence = useRef(0);
  const [onlyMissing, setOnlyMissing] = useState(false);
  const working = useRef(false);
  const saveReceipt = useRef<{ body: string; key: string } | null>(null);
  const [cards, setCards] = useState<EditableCard[]>([]);
  const [newName, setNewName] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | string>("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [searchOffset, setSearchOffset] = useState(0);
  const [searchNext, setSearchNext] = useState<number | null>(null);
  const [results, setResults] = useState<Lot[]>([]);
  const [section, setSection] = useState<Section>("main");
  const [archiveReady, setArchiveReady] = useState(false);

  async function list(pageOffset = offset) {
    const sequence = ++listSequence.current;
    const result = await request<{ items: DeckSummary[]; next_offset: number | null }>("/api/v1/decks?offset=" + pageOffset);
    if (sequence === listSequence.current) { setDecks(result.items); setNext(result.next_offset); }
  }
  function fill(value: Deck) {
    setDeck(value); setName(value.name); setFormat(value.format); setNotes(value.notes); setCards(value.cards); setMatchMode(value.match_mode); setOnlyMissing(false); setCardFilter("");
    setDirty(false); setArchiveReady(false); setQuery(""); setResults([]); setSearchOffset(0);
  }
  useEffect(() => {
    if (!active) return;
    void list().catch((e: Error) => setError(e));
  }, [active, offset]);
  useEffect(() => {
    if (!active || !route.deck) { resetView(); return; }
    setImportState({ dirty: false, busy: false });
    if (deck?.id === route.deck) { if (dirty) fill(deck); return; }
    setDeck(null); setError("");
    const controller = new AbortController();
    void request<Deck>("/api/v1/decks/" + route.deck, { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) { fill(value); requestAnimationFrame(restoreScroll); }
    }).catch((e: Error) => { if (!controller.signal.aborted) setError(e); });
    return () => controller.abort();
  }, [active, route.deck, route.view]);
  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) { if (dirty || importState.dirty || busy || importState.busy) { event.preventDefault(); event.returnValue = ""; } }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, busy, importState.dirty, importState.busy]);
  useEffect(() => {
    if (!query.trim() || !active || !editing || importing) { setResults([]); setSearchNext(null); return; }
    let stopped = false;
    const timer = window.setTimeout(() => {
      request<{ items: Lot[]; next_offset: number | null }>(`/api/v1/collection?q=${encodeURIComponent(query)}&offset=${searchOffset}`)
        .then((data) => { if (!stopped) { setResults(data.items); setSearchNext(data.next_offset); } })
        .catch((e: Error) => { if (!stopped) setError(e); });
    }, 300);
    return () => { stopped = true; clearTimeout(timer); };
  }, [query, searchOffset, active, editing, importing]);
  async function act(work: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true); setError(""); setNotice("");
    try { await work(); } catch (e) { setError(e as Error); } finally { working.current = false; setBusy(false); }
  }
  function canLeave() {
    if (working.current || importState.busy) { setError("Wait for the current save or preview to finish."); return false; }
    return !(dirty || importState.dirty) || window.confirm("Discard unfinished deck changes?\n\nYour last saved deck and your collection will stay unchanged.");
  }
  function resetView() {
    setDeck(null); setCards([]); setDirty(false);
    setImportState({ dirty: false, busy: false }); setError(""); setNotice("");
  }
  function closeDeck() { navigation.close({ page: "decks" }); }
  useLayoutEffect(() => {
    navigationRef.current = canLeave;
    return () => { navigationRef.current = null; };
  });
  useEffect(() => {
    if (!active || deck || importing || scanning) return;
    const saved = returnTo.current;
    const row = saved && document.querySelector<HTMLButtonElement>(`[data-deck-id="${CSS.escape(saved.id)}"]`);
    if (row) { row.focus({ preventScroll: true }); window.scrollTo(0, saved.y); }
    returnTo.current = null;
  }, [deck?.id, importing, scanning, active]);
  function focusTitle(id = "deck-title") {
    window.setTimeout(() => { document.getElementById(id)?.focus({ preventScroll: true }); window.scrollTo(0, 0); }, 0);
  }
  function startImport() {
    if (dirty) { setError("Save or discard your deck changes before importing a list."); return; }
    if (navigation.go({ page: "decks", deck: deck?.id, view: "import" })) { setError(""); setNotice(""); focusTitle("deck-import-title"); }
  }
  function finishEditing() {
    if (dirty) void act(async () => { await save(); navigation.close({ page: "decks", deck: deck?.id }, true); focusTitle(); });
    else { navigation.close({ page: "decks", deck: deck?.id }); focusTitle(); }
  }
  async function save() {
    if (!deck) return;
    if (cards.some(quantityProblem)) throw new Error("Finish entering card quantities before saving your deck.");
    const body = {
      name: name.trim(), format, notes, match_mode: matchMode, expected_version: deck.version,
      cards: cards.filter((card) => card.quantity > 0).map((card) => ({ printing_id: card.printing.id, section: card.section, quantity: card.quantity })),
    };
    const encoded = JSON.stringify(body);
    if (saveReceipt.current?.body !== encoded) saveReceipt.current = { body: encoded, key: crypto.randomUUID() };
    const result = await request<Deck>("/api/v1/decks/" + deck.id, mutation(session, body, saveReceipt.current.key));
    fill(result); await list(); setNotice("Deck saved.");
  }
  function add(lot: Lot) {
    const index = cards.findIndex((card) => card.printing.id === lot.printing.id && card.section === section);
    setCards(index >= 0 ? cards.map((card, i) => i === index ? { ...card, quantity: card.quantity + 1, quantityInput: undefined } : card) : [...cards, { printing: lot.printing, section, quantity: 1, owned: lot.quantity, needed_in_deck: 1, available: 0, missing: 0, locations: [{ id: lot.binder_id, name: lot.binder, quantity: lot.quantity }] }]);
    setDirty(true); setNotice("");
  }
  function addPrinting(printing: Printing) {
    const index = cards.findIndex((card) => card.printing.id === printing.id && card.section === section);
    setCards(index >= 0 ? cards.map((card, i) => i === index ? { ...card, quantity: card.quantity + 1, quantityInput: undefined } : card) : [...cards, { printing, section, quantity: 1, owned: 0, needed_in_deck: 1, available: 0, missing: 1, locations: [] }]);
    setDirty(true); setNotice("");
  }
  function changeSection(index: number, value: Section) {
    const moved = cards[index];
    const existing = cards.findIndex((card, i) => i !== index && card.printing.id === moved.printing.id && card.section === value);
    setCards(cards.flatMap((card, i) => i === index ? (existing >= 0 ? [] : [{ ...card, section: value }]) : [i === existing ? { ...card, quantity: card.quantity + moved.quantity, quantityInput: undefined } : card]));
    setDirty(true);
  }
  function changeQuantity(index: number, input: string) {
    const value = Number(input);
    const quantity = Number.isInteger(value) && value >= 0 && value <= 100000 ? value : 0;
    setCards(cards.map((card, i) => i === index ? { ...card, quantity, quantityInput: input } : card));
    setDirty(true); setNotice("");
  }
  const invalidQuantities = cards.some(quantityProblem);
  const deckSearch = splitCollectorSearch(cardFilter);
  const visibleCards = cards.filter((card) => (!onlyMissing || dirty || card.missing > 0)
    && `${card.printing.name} ${card.printing.set_code} ${card.printing.collector_number}`.toLowerCase().includes(deckSearch.text.toLowerCase())
    && (!deckSearch.collectorNumber || card.printing.collector_number.toLowerCase() === deckSearch.collectorNumber.toLowerCase()));
  const previewCards = (["commander", "main", "sideboard"] as Section[]).flatMap((board) => visibleCards.filter((card) => card.section === board));
  const previewCard = active ? previewCards.find((card) => card.printing.id + "_" + card.section === route.card) : undefined;
  const previewIndex = previewCards.indexOf(previewCard!);
  return <>
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
    {notice && <p className="message success" role="status">{notice}</p>}
    {active && route.deck && !deck && <section className="panel"><button className="button secondary" onClick={closeDeck}>← Back to decks</button>{!error && <p role="status">Opening deck…</p>}</section>}
    {!deck && !route.deck && !importing && !scanning && <DeckList decks={decks} busy={busy} creating={creating} newName={newName} offset={offset} next={next} onName={setNewName} onCreating={setCreating} onImport={startImport} onScan={() => navigation.go({ page: "decks", view: "scan" })} onPage={setOffset}
      onCreate={() => void act(async () => {
        const value = await request<Deck>("/api/v1/decks", mutation(session, { name: newName.trim(), format: "casual", notes: "" }));
        fill(value); navigation.go({ page: "decks", deck: value.id, view: "edit" }, { force: true });
        setNewName(""); setCreating(false); setOffset(0); focusTitle(); await list(0);
      })}
      onOpen={(item) => {
        returnTo.current = { id: item.id, y: window.scrollY };
        navigation.go({ page: "decks", deck: item.id }); setGallery(true); focusTitle();
      }} />}
    {importing && <DeckImport session={session} deck={deck || undefined} onStateChange={setImportState} onCancel={() => {
      navigation.close({ page: "decks", deck: deck?.id });
    }} onImported={(value) => {
      const updating = !!deck;
      fill(value); navigation.go({ page: "decks", deck: value.id }, { replace: true, force: true }); setGallery(true); setImportState({ dirty: false, busy: false }); setOffset(0); focusTitle();
      setNotice(`${updating ? "Deck list updated" : "Deck imported"}. You own ${value.owned_copies} of ${value.copies} copies; ${value.missing_copies} still needed.`);
      void list(0).catch((e: Error) => setError(e));
    }} />}
    {scanning && (!route.deck || deck) && <DeckScan key={deck?.id || "new"} session={session} deck={deck} fromBatch={route.fromBatch} onStateChange={setImportState} onCreated={(value) => {
      fill(value); setImportState({ dirty: false, busy: false }); navigation.go({ page: "decks", deck: value.id, view: "scan", fromBatch: route.fromBatch }, { replace: true, force: true });
      void list(0).catch((e: Error) => setError(e));
    }} onSaved={(value) => {
      fill(value); setImportState({ dirty: false, busy: false }); navigation.go({ page: "decks", deck: value.id }, { replace: true, force: true }); setGallery(true); focusTitle();
      setNotice("Scanned cards saved to your deck. You can add more photo batches anytime."); void list().catch((e: Error) => setError(e));
    }} />}
    {deck && !importing && !scanning && <section className="panel deck-detail" aria-label={editing ? "Deck editor" : "Deck overview"}>
      <div className="batch-toolbar"><button className="button secondary" disabled={busy} onClick={closeDeck}>← Back to decks</button>
        <button className="button primary" disabled={busy || (editing && (!name.trim() || invalidQuantities))} onClick={() => editing ? finishEditing() : navigation.go({ page: "decks", deck: deck.id, view: "edit" })}>{editing ? dirty ? "Save & done" : "Done editing" : "Edit deck"}</button></div>
      <div className="eyebrow">{editing ? "EDITING DECK" : "SAVED DECK"}</div>
      <h2 id="deck-title" tabIndex={-1}>{deck.name}</h2>
      <div className="batch-detail-meta"><span className="badge deck-format">{deck.format}</span><span>{cards.reduce((sum, card) => sum + card.quantity, 0)} cards</span><span>{deck.match_mode === "any" ? "Any printing counts" : "Exact printings"}</span></div>
      <p className="batch-save-status" role="status">{busy ? "Working…" : dirty ? "Unsaved changes · save your deck before leaving." : "✓ All changes saved"}</p>
      <div className="deck-overview-actions"><button className="button secondary" disabled={busy || dirty} onClick={startImport}>Import deck list</button>
        <button className="button secondary" disabled={busy || dirty} onClick={() => navigation.go({ page: "decks", deck: deck.id, view: "scan" })}><Icon name="camera" />Scan cards</button>
        <p className="fine">{dirty ? "Save or discard these edits before importing another list." : "Replace this deck’s card list or add cards from a CSV / text file."}</p></div>
      {deck.valuation && <DeckValue key={deck.id} session={session} cards={cards.filter(card => card.quantity > 0).map(card => ({ printing_id: card.printing.id, quantity: card.quantity, section: card.section }))} saved={deck.valuation} live={dirty} paused={invalidQuantities} busy={busy} onCard={(id, section) => { const card = cards.find(item => item.printing.id === id && item.section === section); if (card) { setOnlyMissing(false); setCardFilter(""); setPreviewCard(card); } }} />}
      {!dirty && <><div className="deck-availability" aria-label="Deck collection comparison"><span><strong>{deck.copies}</strong> Needed</span><span><strong>{deck.owned_copies}</strong> Owned</span><span><strong>{deck.missing_copies}</strong> Missing</span></div><progress value={deck.owned_copies} max={Math.max(1, deck.copies)} aria-label="Deck collection completion" />
        <details className="deck-shopping"><summary>{deck.missing_copies ? `Buy list · ${deck.missing_copies} missing copies` : "Collection comparison"}</summary><DeckBuyList key={deck.id} deck={deck} busy={busy} onRefresh={() => void act(async () => fill(await request<Deck>("/api/v1/decks/" + deck.id)))} /></details>
      </>}
      {dirty && <p className="message">Save your changes to update owned quantities and the missing-card buy list.</p>}
      {!invalidQuantities && <DeckLegality session={session} format={format} cards={cards.filter((card) => card.quantity > 0).map((card) => ({ printing_id: card.printing.id, quantity: card.quantity, section: card.section }))} saved={deck.legality} live={dirty} onCard={(id) => { const card = cards.find((item) => item.printing.id === id); if (card) { setOnlyMissing(false); setCardFilter(""); setPreviewCard(card); } }} />}
      {!editing && notes && <div className="deck-notes"><h3>Notes</h3><p>{notes}</p></div>}
      {editing && <fieldset className="deck-edit-fields" disabled={busy}><legend className="eyebrow">DECK DETAILS</legend>
        <label>Deck name<input value={name} maxLength={255} onChange={(e) => { setName(e.target.value); setDirty(true); }} /></label>
        <div className="form-grid"><label>Deck format<select value={format} onChange={(e) => { setFormat(e.target.value); setDirty(true); }}>{formats.map((value) => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></label>
          <label>Compare with my collection<select value={matchMode} onChange={(e) => { setMatchMode(e.target.value as MatchMode); setDirty(true); }}><option value="any">Any printing of the card</option><option value="exact">Exact printings only</option></select></label></div>
        <label>Deck notes<textarea rows={3} value={notes} maxLength={4096} onChange={(e) => { setNotes(e.target.value); setDirty(true); }} /></label>
        <label>Add cards to<select value={section} onChange={(e) => setSection(e.target.value as Section)}>{Object.entries(sections).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <details open><summary>Add from your collection</summary>
          <label>Find cards you own<input type="search" value={query} onChange={(e) => { setQuery(e.target.value); setSearchOffset(0); }} placeholder="Card name or Plains #287" /></label>
          <ul className="plain-list">{results.map((lot) => <li key={lot.id}><button className="printing-choice" disabled={busy} onClick={() => add(lot)}><strong>Add {lot.printing.name}</strong><span>{lot.printing.set_code.toUpperCase()} #{lot.printing.collector_number} · {lot.quantity} in {lot.binder}</span></button></li>)}</ul>
          <div className="pagination">{searchOffset > 0 && <button className="text-button" onClick={() => setSearchOffset(Math.max(0, searchOffset - 40))}>Previous cards</button>}{searchNext !== null && <button className="text-button" onClick={() => setSearchOffset(searchNext)}>More cards</button>}</div>
        </details>
        <details className="deck-catalog-add"><summary>Add any card, including cards you need</summary><PrintingPicker onSelect={addPrinting} /></details>
      </fieldset>}
      <div className="deck-card-list-heading"><h3>Deck list</h3><label>Find a card in this deck<input type="search" value={cardFilter} onChange={(e) => setCardFilter(e.target.value)} placeholder="Name, set or Plains #287" /></label></div>
      {editing && <p className="fine" id="deck-quantity-help">Clear a quantity to type a new amount. Set it to 0 to remove that card from the deck when you save.</p>}
      {!editing && <div className="deck-view-controls" role="group" aria-label="Deck card view"><button className="filter-chip" aria-pressed={gallery} onClick={() => setGallery(true)}>Gallery</button><button className="filter-chip" aria-pressed={!gallery} onClick={() => setGallery(false)}>List</button><span className="fine">Tap a card to preview it.</span></div>}
      {!dirty && <label className="checkbox"><input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />Show only missing cards</label>}
      {(["commander", "main", "sideboard"] as Section[]).map((board) => {
        const entries = visibleCards.filter((card) => card.section === board);
        return entries.length > 0 && <section className="deck-card-section" key={board} aria-label={sections[board]}><h3>{sections[board]} <span>{entries.reduce((sum, card) => sum + card.quantity, 0)}</span></h3>
          <ul className={gallery && !editing ? "plain-list deck-cards deck-gallery" : "plain-list deck-cards"}>{entries.map((card) => {
            const index = cards.indexOf(card);
            const quantityError = quantityProblem(card);
            const quantityHint = quantityError || (card.quantity === 0 ? "Removed from this deck when you save. Enter a new quantity to keep it." : "");
            const quantityHintId = `deck-quantity-${card.printing.id}-${card.section}`;
            return <li key={card.printing.id + card.section} className={editing ? "deck-card-row editing" : "deck-card-row"}>
              {editing ? <span className="deck-card-art" aria-hidden="true">{card.printing.image_url ? <img src={card.printing.image_url} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : <span>▧</span>}</span>
                : <button className="deck-card-art deck-art-button" aria-label={`Preview ${card.printing.name} · ${sections[card.section]}`} onClick={() => setPreviewCard(card)}><CardArt url={card.printing.image_url} name={card.printing.name} /></button>}
              <div className="deck-card-copy"><div className="holding-title"><strong>{card.printing.name}</strong><span className="deck-quantity">×{card.quantity}</span></div>
                <p className="fine">{card.printing.set_code.toUpperCase()} #{card.printing.collector_number} · {card.printing.language.toUpperCase()}</p>
                {!dirty && <p className={card.missing ? "row-error" : "deck-card-owned"}>Need {card.quantity} · Have {card.available} · Missing {card.missing}</p>}
                <p className="card-location"><strong>Find it:</strong> {card.locations.length ? card.locations.map((location) => `${location.name} (${location.quantity})`).join(" · ") : "No matching copies in your collection"}</p>
              </div>
              {editing && <fieldset className="deck-card-controls" disabled={busy}><div className="form-grid"><label>Copies in deck<input type="number" inputMode="numeric" min={0} max={100000} step={1} value={String(card.quantityInput ?? card.quantity)} aria-invalid={!!quantityError || undefined} aria-describedby={`deck-quantity-help${quantityHint ? " " + quantityHintId : ""}`} onChange={(e) => changeQuantity(index, e.target.value)} onBlur={() => { if (!quantityError) setCards(cards.map((item, i) => i === index ? { ...item, quantityInput: undefined } : item)); }} /></label>
                <label>Deck section<select value={card.section} disabled={invalidQuantities} onChange={(e) => changeSection(index, e.target.value as Section)}>{Object.entries(sections).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
                {quantityHint && <p className={quantityError ? "row-error" : "fine"} id={quantityHintId}>{quantityHint}</p>}
                <button className="text-button" onClick={() => { setCards(cards.filter((_, i) => i !== index)); setDirty(true); }}>Remove from deck</button></fieldset>}
            </li>;
          })}</ul></section>;
      })}
      {previewCard && previewIndex >= 0 && <DeckCardPreview card={previewCard} position={previewIndex} total={previewCards.length} onPrevious={() => setPreviewCard(previewCards[previewIndex - 1])} onNext={() => setPreviewCard(previewCards[previewIndex + 1])} onClose={() => setPreviewCard(null)} />}
      {cards.length === 0 ? <p>{editing ? "Search your collection above or import a deck list to add cards." : "This deck is empty. Import a list or use Edit deck to add cards."}</p> : visibleCards.length === 0 && <p>No cards match this view. Clear the search or missing-card filter to see the whole deck.</p>}
      <DeckTokens key={deck.id} session={session} cards={cards.filter((card) => card.quantity > 0).map((card) => ({ printing_id: card.printing.id, quantity: card.quantity, section: card.section }))} saved={deck.tokens} live={dirty} paused={invalidQuantities} format={format} onCard={(id) => { const card = cards.find((item) => item.printing.id === id); if (card) { setOnlyMissing(false); setCardFilter(""); setPreviewCard(card); } }} />
      {editing && <div className="deck-save"><p role="status">{dirty ? "Unsaved changes" : "All changes saved"}</p><div className="actions">
        <button className="button primary" disabled={busy || !dirty || !name.trim() || invalidQuantities} onClick={() => void act(save)}>Save deck</button>
        {dirty && <button className="text-button" disabled={busy} onClick={() => { if (canLeave()) void act(async () => fill(await request<Deck>("/api/v1/decks/" + deck.id))); }}>Discard changes</button>}
      </div></div>}
      {!dirty && <details className="deck-export"><summary>Export deck list</summary><div className="actions"><a className="text-button" href={"/api/v1/decks/" + deck.id + "/download?format=text"}>Export saved deck as text</a><a className="text-button" href={"/api/v1/decks/" + deck.id + "/download?format=csv"}>Export saved deck as CSV</a></div></details>}
      <div className="batch-exit actions">{editing && <button className="button primary" disabled={busy || !name.trim() || invalidQuantities} onClick={finishEditing}>{dirty ? "Save & done" : "Done editing"}</button>}<button className="button secondary" disabled={busy} onClick={closeDeck}>Close deck</button></div>
      {editing && <details className="deck-archive"><summary>Archive deck</summary><label className="checkbox"><input type="checkbox" checked={archiveReady} onChange={(e) => setArchiveReady(e.target.checked)} />Remove this deck from my saved list. Keep my collection.</label><button className="button secondary" disabled={busy || !archiveReady || dirty} onClick={() => void act(async () => { await request("/api/v1/decks/" + deck.id + "/archive", mutation(session, { expected_version: deck.version })); navigation.go({ page: "decks" }, { replace: true, force: true }); resetView(); await list(); })}>Archive this deck</button></details>}
    </section>}
  </>;
}
