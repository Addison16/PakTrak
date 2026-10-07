import ErrorNotice from "./ErrorNotice";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ApiError, mutation, request, type Lot, type Printing, type Session } from "./api";

import DeckImport from "./DeckImport";
import DeckScan from "./DeckScan";
import { Icon } from "./Icon";
import DeckList from "./DeckList";
import DeckOpening, { type DeckOpeningOrigin } from "./DeckOpening";
import DeckBuyList from "./DeckBuyList";
import DeckStats from "./DeckStats";
import StoreButtons, { ReferralNote } from "./StoreButtons";
import DeckCardPreview from "./DeckCardPreview";
import { captureCardFlight, preloadCardBack, type CardFlightOrigin } from "./CardArrival";
import DeckLegality from "./DeckLegality";
import DeckTokens from "./DeckTokens";
import DeckValue from "./DeckValue";
import DeckHero from "./DeckHero";
import DeckPresentationPicker from "./DeckPresentationPicker";
import { presentationCovers, useDeckPresentation } from "./deckPresentation";
import { CardArt } from "./CardDetail";
import PrintingPicker from "./PrintingPicker";
import { splitCollectorSearch } from "./cardSearch";
import { navigation, restoreScroll, useRoute } from "./navigation";
import { formats, sections, type Deck, type DeckCard as Card, type DeckCollection, type DeckSummary, type DeckWorkState, type MatchMode, type Section } from "./deckTypes";
import { readDraft, removeDraft, writeDraft } from "./recovery";
import "./deck-qol.css";
import "./deck-studio.css";

type EditableCard = Card & { quantityInput?: string };
type DeckDraft = { name: string; format: string; notes: string; matchMode: MatchMode; cards: EditableCard[]; baseVersion: number };
const draftKey = (owner: string, id: string) => `paktrak:deck-draft:${owner}:${id}`;
function validDraft(value: DeckDraft | null): value is DeckDraft {
  return !!value && typeof value.name === "string" && typeof value.notes === "string" && formats.includes(value.format)
    && ["any", "exact"].includes(value.matchMode) && Number.isInteger(value.baseVersion) && value.baseVersion > 0
    && Array.isArray(value.cards) && value.cards.length <= 300 && value.cards.every((card) => !!card.printing && typeof card.printing.id === "string" && typeof card.printing.name === "string" && Array.isArray(card.locations) && Object.hasOwn(sections, card.section) && Number.isInteger(card.quantity) && card.quantity >= 0 && card.quantity <= 100000);
}
function cardChoices(cards: EditableCard[]) { return cards.filter((card) => card.quantity > 0).map((card) => ({ printing_id: card.printing.id, section: card.section, quantity: card.quantity })); }
function deckText(cards: Card[]) {
  return (["commander", "main", "sideboard"] as Section[]).flatMap((section) => {
    const entries = cards.filter((card) => card.section === section && card.quantity > 0);
    return entries.length ? [sections[section], ...entries.map((card) => `${card.quantity} ${card.printing.name} (${card.printing.set_code.toUpperCase()}) ${card.printing.collector_number}`), ""] : [];
  }).join("\n");
}
function draftChanges(draft: DeckDraft, saved: Deck) {
  const savedCards = new Map(saved.cards.map((card) => [card.printing.id + ":" + card.section, card]));
  const draftCards = new Map(draft.cards.filter((card) => card.quantity > 0).map((card) => [card.printing.id + ":" + card.section, card]));
  const changed = [...new Set([...savedCards.keys(), ...draftCards.keys()])].flatMap((key) => {
    const before = savedCards.get(key), after = draftCards.get(key);
    return before?.quantity === after?.quantity ? [] : [`${(after || before)!.printing.name} · ${sections[(after || before)!.section]}: ${before?.quantity || 0} → ${after?.quantity || 0}`];
  });
  return [draft.name !== saved.name ? `Name: ${saved.name} → ${draft.name}` : "", draft.format !== saved.format ? `Format: ${saved.format} → ${draft.format}` : "", draft.matchMode !== saved.match_mode ? "Collection matching changed" : "", draft.notes !== saved.notes ? "Notes changed" : "", ...changed].filter(Boolean);
}
function quantityProblem(card: EditableCard) {
  const input = card.quantityInput ?? String(card.quantity);
  if (!input.trim()) return "Enter a quantity, or 0 to remove this card when you save.";
  const value = Number(input);
  return Number.isInteger(value) && value >= 0 && value <= 100000 ? "" : "Use a whole number from 0 to 100,000.";
}

export default function Decks({ session, active, navigationRef }: { session: Session; active: boolean; navigationRef: RefObject<(() => boolean) | null> }) {
  const route = useRoute();
  useEffect(preloadCardBack, []);
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [offset, setOffset] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  const [deck, setDeck] = useState<Deck | null>(null);
  const deckIsCurrent = active && route.page === "decks" && !!route.deck && deck?.id === route.deck;
  const { presentation, savePresentation, resetPresentation } = useDeckPresentation(session.owner_id, deck);
  const [showAppearance, setShowAppearance] = useState(false);
  const appearanceTrigger = useRef<HTMLButtonElement>(null);
  const artViewKey = `paktrak:deck-art-view:v1:${session.owner_id}`;
  const [artView, setArtView] = useState(() => { try { return localStorage.getItem(artViewKey) === "true"; } catch { return false; } });
  function changeArtView(value: boolean) { setArtView(value); if (value) setGallery(true); try { localStorage.setItem(artViewKey, String(value)); } catch { /* The current view still works without storage. */ } }
  const [opening, setOpening] = useState<DeckOpeningOrigin | null>(null);
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
  const [cardFlight, setCardFlight] = useState<{ deckId: string; cardKey: string; origin: CardFlightOrigin } | null>(null);
  function setPreviewCard(card: Card | null, source?: HTMLElement) {
    const cardKey = card ? card.printing.id + "_" + card.section : undefined;
    const destination = { ...route, card: cardKey };
    if (card) {
      const origin = source && cardKey ? captureCardFlight(source, cardKey) : null;
      if (navigation.go(destination, { replace: !!route.card })) {
        setCardFlight(origin && deck && cardKey ? { deckId: deck.id, cardKey, origin } : null);
      }
    } else {
      setCardFlight(null);
      if (navigation.route.page === "decks" && navigation.route.card) navigation.close(destination);
    }
  }
  useEffect(() => {
    if (cardFlight && (!deckIsCurrent || route.view || route.deck !== cardFlight.deckId || route.card !== cardFlight.cardKey)) setCardFlight(null);
  }, [deckIsCurrent, route.deck, route.view, route.card, cardFlight]);
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
  const [recoverable, setRecoverable] = useState<DeckDraft | null>(null);
  const [localDraftSaved, setLocalDraftSaved] = useState(true);
  const baseVersion = useRef(0);
  const restoringDraft = useRef(false);
  const undoStack = useRef<DeckDraft[]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const lastEdit = useRef("");
  const [saveConflict, setSaveConflict] = useState(false);
  const [conflictSaved, setConflictSaved] = useState<Deck | null>(null);
  const [collectionAnswer, setCollectionAnswer] = useState<{ key: string; report?: DeckCollection; error?: string } | null>(null);
  const [collectionRetry, setCollectionRetry] = useState(0);
  const [addQuantity, setAddQuantity] = useState("1");
  const [duplicateName, setDuplicateName] = useState("");
  const [duplicating, setDuplicating] = useState(false);
  const duplicateReceipt = useRef<{ body: string; key: string } | null>(null);
  const [copyMessage, setCopyMessage] = useState("");
  const [copyFallback, setCopyFallback] = useState(false);
  const draft = (): DeckDraft => ({ name, format, notes, matchMode, cards, baseVersion: baseVersion.current || deck?.version || 1 });
  function remember(field = "") {
    if (!field || lastEdit.current !== field) {
      undoStack.current = [...undoStack.current.slice(-39), draft()]; setUndoCount(undoStack.current.length);
    }
    lastEdit.current = field; setDirty(true); setNotice("");
  }
  function applyDraft(value: DeckDraft) {
    setName(value.name); setFormat(value.format); setNotes(value.notes); setMatchMode(value.matchMode); setCards(value.cards);
    baseVersion.current = value.baseVersion; setDirty(true); setOnlyMissing(false); setCardFilter("");
  }
  function undo() {
    const value = undoStack.current.pop(); if (!value || !deck) return;
    applyDraft(value); lastEdit.current = ""; setUndoCount(undoStack.current.length); setNotice("Last deck edit undone.");
    if (!draftChanges(value, deck).length) { setDirty(false); removeDraft(draftKey(session.owner_id, deck.id)); }
  }

  async function list(pageOffset = offset) {
    const sequence = ++listSequence.current;
    const result = await request<{ items: DeckSummary[]; next_offset: number | null }>("/api/v1/decks?offset=" + pageOffset);
    if (sequence === listSequence.current) { setDecks(result.items); setNext(result.next_offset); }
  }
  function fill(value: Deck, clearStored = false) {
    setDeck(value); setName(value.name); setFormat(value.format); setNotes(value.notes); setCards(value.cards); setMatchMode(value.match_mode); setOnlyMissing(false); setCardFilter("");
    setDirty(false); setArchiveReady(false); setQuery(""); setResults([]); setSearchOffset(0);
    baseVersion.current = value.version; undoStack.current = []; setUndoCount(0); lastEdit.current = "";
    setSaveConflict(false); setConflictSaved(null); setDuplicating(false); setDuplicateName(""); setCopyMessage(""); setCopyFallback(false); setCollectionAnswer(null);
    if (clearStored) removeDraft(draftKey(session.owner_id, value.id));
    const saved = clearStored ? null : readDraft<DeckDraft>(draftKey(session.owner_id, value.id));
    setRecoverable(validDraft(saved) ? saved : null);
  }
  useEffect(() => {
    if (!active) return;
    void list().catch((e: Error) => setError(e));
  }, [active, offset]);
  useEffect(() => {
    if (!active || !route.deck) { resetView(); return; }
    setImportState({ dirty: false, busy: false });
    if (deck?.id === route.deck) { if (restoringDraft.current) { restoringDraft.current = false; return; } if (dirty) fill(deck); return; }
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
    if (dirty && deck && active && editing) setLocalDraftSaved(writeDraft(draftKey(session.owner_id, deck.id), draft()));
  }, [dirty, deck?.id, active, editing, name, format, notes, matchMode, cards, session.owner_id]);
  const invalidQuantities = cards.some(quantityProblem);
  const collectionPayload = JSON.stringify({ cards: cardChoices(cards), match_mode: matchMode });
  useEffect(() => {
    if (!dirty || !deck || !active || invalidQuantities) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void request<DeckCollection>("/api/v1/decks/collection-preview", { ...mutation(session, JSON.parse(collectionPayload)), signal: controller.signal })
        .then((report) => { if (!controller.signal.aborted) setCollectionAnswer({ key: collectionPayload, report }); })
        .catch((e: Error) => { if (!controller.signal.aborted) setCollectionAnswer({ key: collectionPayload, error: e.message }); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [dirty, deck?.id, active, invalidQuantities, collectionPayload, collectionRetry, session.csrf_token]);
  const comparison = invalidQuantities ? undefined : !dirty ? deck : collectionAnswer?.key === collectionPayload ? collectionAnswer.report : undefined;
  const comparisonError = dirty && !invalidQuantities && collectionAnswer?.key === collectionPayload ? collectionAnswer.error : undefined;
  const ownership = new Map(comparison?.cards.map((card) => [card.printing.id + ":" + card.section, card]));
  const addCount = Number(addQuantity);
  const addQuantityError = !addQuantity.trim() || !Number.isInteger(addCount) || addCount < 1 || addCount > 100000;
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
    const deckWorkActive = importing || scanning;
    if (working.current || deckWorkActive && importState.busy) { setError("Wait for the current save or preview to finish."); return false; }
    if (!(dirty || deckWorkActive && importState.dirty)) return true;
    if (!window.confirm("Discard unfinished deck changes?\n\nYour last saved deck and your collection will stay unchanged.")) return false;
    if (deck && dirty) removeDraft(draftKey(session.owner_id, deck.id));
    if (importState.dirty && importing) removeDraft(`paktrak:deck-import:${session.owner_id}:${deck?.id || "new"}`);
    return true;
  }
  function resetView() {
    setDeck(null); setCards([]); setDirty(false);
    setImportState({ dirty: false, busy: false }); setError(""); setNotice("");
    setRecoverable(null); undoStack.current = []; setUndoCount(0); setSaveConflict(false); setConflictSaved(null);
  }
  function closeDeck() { navigation.close({ page: "decks" }); }
  useEffect(() => { setShowAppearance(false); }, [active, route.deck, route.view]);
  useLayoutEffect(() => {
    navigationRef.current = canLeave;
    return () => { navigationRef.current = null; };
  });
  useEffect(() => {
    if (!active || deck || route.deck || importing || scanning) return;
    const saved = returnTo.current;
    const row = saved && document.querySelector<HTMLButtonElement>(`[data-deck-id="${CSS.escape(saved.id)}"]`);
    if (row) { row.focus({ preventScroll: true }); window.scrollTo(0, saved.y); }
    returnTo.current = null;
  }, [deck?.id, route.deck, importing, scanning, active]);
  function focusTitle(id = "deck-title") {
    window.setTimeout(() => { document.getElementById(id)?.focus({ preventScroll: true }); window.scrollTo(0, 0); }, 0);
  }
  useEffect(() => {
    if (opening && (!active || route.deck !== opening.deck.id || route.view || route.card || error)) setOpening(null);
  }, [active, route.deck, route.view, route.card, error, opening]);
  useEffect(() => {
    if (active && deck && !opening && returnTo.current?.id === deck.id && !editing && !importing && !scanning) focusTitle();
  }, [active, deck?.id, opening, editing, importing, scanning]);
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
      name: name.trim(), format, notes, match_mode: matchMode, expected_version: baseVersion.current || deck.version,
      cards: cards.filter((card) => card.quantity > 0).map((card) => ({ printing_id: card.printing.id, section: card.section, quantity: card.quantity })),
    };
    const encoded = JSON.stringify(body);
    if (saveReceipt.current?.body !== encoded) saveReceipt.current = { body: encoded, key: crypto.randomUUID() };
    let result: Deck;
    try { result = await request<Deck>("/api/v1/decks/" + deck.id, mutation(session, body, saveReceipt.current.key)); }
    catch (e) { if (e instanceof ApiError && e.status === 409) { setSaveConflict(true); setConflictSaved(null); } throw e; }
    fill(result, true); await list(); setNotice("Deck saved.");
  }
  function add(lot: Lot) {
    if (addQuantityError || invalidQuantities) return;
    const index = cards.findIndex((card) => card.printing.id === lot.printing.id && card.section === section);
    if (index >= 0 && cards[index].quantity + addCount > 100000) { setError("A card can have at most 100,000 copies in one section."); return; }
    if (index < 0 && cards.length >= 300) { setError("A deck can contain up to 300 printing/section entries."); return; }
    remember(); setCards(index >= 0 ? cards.map((card, i) => i === index ? { ...card, quantity: card.quantity + addCount, quantityInput: undefined } : card) : [...cards, { printing: lot.printing, section, quantity: addCount, owned: lot.quantity, needed_in_deck: addCount, available: 0, missing: 0, locations: [] }]);
  }
  function addPrinting(printing: Printing) {
    if (addQuantityError || invalidQuantities) return;
    const index = cards.findIndex((card) => card.printing.id === printing.id && card.section === section);
    if (index >= 0 && cards[index].quantity + addCount > 100000) { setError("A card can have at most 100,000 copies in one section."); return; }
    if (index < 0 && cards.length >= 300) { setError("A deck can contain up to 300 printing/section entries."); return; }
    remember(); setCards(index >= 0 ? cards.map((card, i) => i === index ? { ...card, quantity: card.quantity + addCount, quantityInput: undefined } : card) : [...cards, { printing, section, quantity: addCount, owned: 0, needed_in_deck: addCount, available: 0, missing: addCount, locations: [] }]);
  }
  function changeSection(index: number, value: Section) {
    const moved = cards[index];
    const existing = cards.findIndex((card, i) => i !== index && card.printing.id === moved.printing.id && card.section === value);
    if (existing >= 0 && cards[existing].quantity + moved.quantity > 100000) { setError("Combining those rows would exceed 100,000 copies in one section."); return; }
    remember();
    setCards(cards.flatMap((card, i) => i === index ? (existing >= 0 ? [] : [{ ...card, section: value }]) : [i === existing ? { ...card, quantity: card.quantity + moved.quantity, quantityInput: undefined } : card]));
  }
  function changeQuantity(index: number, input: string) {
    const value = Number(input);
    const quantity = Number.isInteger(value) && value >= 0 && value <= 100000 ? value : 0;
    remember("quantity:" + cards[index].printing.id + ":" + cards[index].section); setCards(cards.map((card, i) => i === index ? { ...card, quantity, quantityInput: input } : card));
  }
  const deckSearch = splitCollectorSearch(cardFilter);
  const visibleCards = cards.filter((card) => (!onlyMissing || !comparison || (ownership.get(card.printing.id + ":" + card.section)?.missing || 0) > 0)
    && `${card.printing.name} ${card.printing.set_code} ${card.printing.collector_number}`.toLowerCase().includes(deckSearch.text.toLowerCase())
    && (!deckSearch.collectorNumber || card.printing.collector_number.toLowerCase() === deckSearch.collectorNumber.toLowerCase()));
  const previewCards = (["commander", "main", "sideboard"] as Section[]).flatMap((board) => visibleCards.filter((card) => card.section === board));
  const previewCard = deckIsCurrent ? previewCards.find((card) => card.printing.id + "_" + card.section === route.card) : undefined;
  const previewIndex = previewCards.indexOf(previewCard!);
  return <>
    {error && <ErrorNotice error={error} onDismiss={() => setError("")}>{saveConflict && deck && <button className="text-button" disabled={busy} onClick={() => void act(async () => { setConflictSaved(await request<Deck>("/api/v1/decks/" + deck.id)); })}>Reload saved deck for comparison</button>}</ErrorNotice>}
    {notice && <p className="message success" role="status">{notice}</p>}
    {active && route.deck && !deckIsCurrent && <section className="panel"><button className="button secondary" onClick={closeDeck}>← Back to decks</button>{!error && <p role="status">Opening deck…</p>}</section>}
    {active && !route.deck && !importing && !scanning && <DeckList ownerId={session.owner_id} decks={decks} busy={busy} creating={creating} newName={newName} offset={offset} next={next} onName={setNewName} onCreating={setCreating} onImport={startImport} onScan={() => navigation.go({ page: "decks", view: "scan" })} onPage={setOffset}
      onCreate={() => void act(async () => {
        const value = await request<Deck>("/api/v1/decks", mutation(session, { name: newName.trim(), format: "casual", notes: "" }));
        fill(value); navigation.go({ page: "decks", deck: value.id, view: "edit" }, { force: true });
        setNewName(""); setCreating(false); setOffset(0); focusTitle(); await list(0);
      })}
      onOpen={(item, box) => {
        if (opening) return;
        const { left, top, width, height } = box.getBoundingClientRect();
        returnTo.current = { id: item.id, y: window.scrollY };
        if (!navigation.go({ page: "decks", deck: item.id })) { returnTo.current = null; return; }
        if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) setOpening({ deck: item, ownerId: session.owner_id, left, top, width, height });
        setGallery(true);
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
    {deck && deckIsCurrent && !importing && !scanning && <section className="panel deck-detail" data-deck-view={deck.id} data-art-view={!editing && artView || undefined} aria-label={editing ? "Deck editor" : "Deck overview"}>
      <DeckHero covers={presentationCovers(deck, presentation)}>
        <div className="batch-toolbar deck-studio-toolbar"><button className="button secondary" disabled={busy} onClick={closeDeck}>← Back to decks</button>
          <div className="deck-studio-toolbar-actions">
            {!editing && <button className="button secondary" aria-pressed={artView} onClick={() => changeArtView(!artView)}>{artView ? "Exit art view" : "Art view"}</button>}
            <button ref={appearanceTrigger} className="button secondary" disabled={busy || dirty} onClick={() => setShowAppearance(true)}>Customize case</button>
            <button className="button primary" disabled={busy || (editing && (!name.trim() || invalidQuantities))} onClick={() => editing ? finishEditing() : navigation.go({ page: "decks", deck: deck.id, view: "edit" })}>{editing ? dirty ? "Save & done" : "Done editing" : "Edit deck"}</button>
          </div>
        </div>
        <div className="deck-hero-identity">
          <div className="deck-hero-title"><div className="eyebrow">{editing ? "DECK STUDIO" : artView ? "THE ART OF YOUR DECK" : "YOUR NEXT GAME"}</div>
            <h2 id="deck-title" tabIndex={-1}>{deck.name}</h2>
      <div className="batch-detail-meta"><span className="badge deck-format">{deck.format}</span><span>{cards.reduce((sum, card) => sum + card.quantity, 0)} cards</span><span>{deck.match_mode === "any" ? "Any printing counts" : "Exact printings"}</span></div>
      <p className="batch-save-status" role="status">{busy ? "Working…" : dirty ? localDraftSaved ? "Unsaved changes · draft backed up on this device." : "Unsaved changes · device backup unavailable. Save your deck to keep your work." : "✓ All changes saved"}</p>
          </div>
      {deck.valuation && <DeckValue compact key={`value:${deck.id}`} session={session} cards={cards.filter(card => card.quantity > 0).map(card => ({ printing_id: card.printing.id, quantity: card.quantity, section: card.section }))} saved={deck.valuation} live={dirty} paused={invalidQuantities} busy={busy} onCard={(id, section) => { const card = cards.find(item => item.printing.id === id && item.section === section); if (card) { setOnlyMissing(false); setCardFilter(""); setPreviewCard(card); } }} />}
        </div>
      </DeckHero>
      {showAppearance && <DeckPresentationPicker key={`appearance:${deck.id}`} deck={deck} presentation={presentation} onSave={savePresentation} onReset={resetPresentation} onClose={() => { setShowAppearance(false); appearanceTrigger.current?.focus({ preventScroll: true }); }} />}
      {recoverable && <section className="deck-recovery" aria-label="Recover deck draft">
        <div><span className="eyebrow">PICK UP WHERE YOU LEFT OFF</span><h3>An unfinished deck edit is saved on this device</h3><p>Restore your cards, quantities and notes, or keep the saved deck.{recoverable.baseVersion !== deck.version && " The saved deck has changed since this draft; review the differences before saving."}</p></div>
        <div className="actions"><button className="button primary" disabled={busy} onClick={() => {
          remember(); applyDraft(recoverable); setRecoverable(null); restoringDraft.current = !editing;
          if (recoverable.baseVersion !== deck.version) { setSaveConflict(true); setConflictSaved(deck); }
          navigation.go({ page: "decks", deck: deck.id, view: "edit" }, { force: true }); setNotice("Unfinished deck edit restored.");
        }}>Restore deck draft</button><button className="text-button" disabled={busy} onClick={() => { removeDraft(draftKey(session.owner_id, deck.id)); setRecoverable(null); }}>Discard saved draft</button></div>
      </section>}
      {saveConflict && <section className="deck-conflict" aria-label="Review concurrent deck changes">
        <h3>This deck changed on another device or tab</h3><p>Your draft is still here. Load the latest saved deck to review the differences before choosing which list to keep.</p>
        {!conflictSaved ? <button className="button secondary" disabled={busy} onClick={() => void act(async () => { setConflictSaved(await request<Deck>("/api/v1/decks/" + deck.id)); })}>Compare with saved deck</button> : <>
          <div className="deck-conflict-counts"><span>Saved list<strong>{conflictSaved.copies} cards · version {conflictSaved.version}</strong></span><span>Your draft<strong>{cards.reduce((sum, card) => sum + card.quantity, 0)} cards</strong></span></div>
          <details open><summary>Differences from the saved version</summary>{draftChanges(draft(), conflictSaved).length ? <ul>{draftChanges(draft(), conflictSaved).map((change, index) => <li key={index}>{change}</li>)}</ul> : <p>The lists and deck details match.</p>}</details>
          <div className="actions"><button className="button primary" disabled={busy || conflictSaved.archived} onClick={() => {
            setDeck(conflictSaved); baseVersion.current = conflictSaved.version; setSaveConflict(false); setConflictSaved(null); setError(""); setDirty(true);
            setNotice("Your draft is kept. Saving will replace the version you just reviewed.");
          }}>Keep my draft for saving</button><button className="button secondary" disabled={busy} onClick={() => { if (canLeave()) fill(conflictSaved, true); }}>Use saved version</button></div>
          {conflictSaved.archived && <p className="fine">The saved deck was archived. Copy your draft list below to keep your work.</p>}
          <label>Your draft list<textarea readOnly rows={4} value={deckText(cards)} onFocus={(e) => e.target.select()} /></label>
        </>}
      </section>}

      {editing && <div className="deck-edit-shortcuts"><button className="button secondary" disabled={busy || !undoCount} onClick={undo}>↶ Undo last edit</button><span className="fine">Changes stay in your draft until you save.</span></div>}
      {editing && <fieldset className="deck-edit-fields" disabled={busy}><legend className="eyebrow">DECK DETAILS</legend>
        <label>Deck name<input value={name} maxLength={255} onChange={(e) => { remember("name"); setName(e.target.value); }} onBlur={() => { lastEdit.current = ""; }} /></label>
        <div className="form-grid"><label>Deck format<select value={format} onChange={(e) => { remember(); setFormat(e.target.value); }}>{formats.map((value) => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></label>
          <label>Compare with my collection<select value={matchMode} onChange={(e) => { remember(); setMatchMode(e.target.value as MatchMode); }}><option value="any">Any printing of the card</option><option value="exact">Exact printings only</option></select></label></div>
        <label>Deck notes<textarea rows={3} value={notes} maxLength={4096} onChange={(e) => { remember("notes"); setNotes(e.target.value); }} onBlur={() => { lastEdit.current = ""; }} /></label>
        <div className="form-grid deck-add-options"><label>Add cards to<select value={section} onChange={(e) => setSection(e.target.value as Section)}>{Object.entries(sections).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Copies to add<input type="number" min={1} max={100000} step={1} inputMode="numeric" value={addQuantity} aria-invalid={addQuantityError || undefined} onChange={(e) => setAddQuantity(e.target.value)} /></label></div>
        {addQuantityError && <p className="row-error">Choose a whole number from 1 to 100,000 before adding a card.</p>}
        <details open><summary>Add from your collection</summary>
          <label>Find cards you own<input type="search" value={query} onChange={(e) => { setQuery(e.target.value); setSearchOffset(0); }} placeholder="Card name or Plains #287" /></label>
          <ul className="plain-list">{results.map((lot) => <li key={lot.id}><button className="printing-choice" disabled={busy || addQuantityError || invalidQuantities} onClick={() => add(lot)}><strong>Add {addQuantityError ? "" : `${addCount} × `}{lot.printing.name}</strong><span>{lot.printing.set_code.toUpperCase()} #{lot.printing.collector_number} · {lot.quantity} in {lot.binder}</span></button></li>)}</ul>
          <div className="pagination">{searchOffset > 0 && <button className="text-button" onClick={() => setSearchOffset(Math.max(0, searchOffset - 40))}>Previous cards</button>}{searchNext !== null && <button className="text-button" onClick={() => setSearchOffset(searchNext)}>More cards</button>}</div>
        </details>
        <details className="deck-catalog-add"><summary>Add any card, including cards you need</summary><fieldset className="deck-picker-fieldset" disabled={addQuantityError || invalidQuantities}><PrintingPicker onSelect={addPrinting} /></fieldset></details>
      </fieldset>}
      <div className="deck-card-list-heading"><h3>Deck list</h3><label>Find a card in this deck<input type="search" value={cardFilter} onChange={(e) => setCardFilter(e.target.value)} placeholder="Name, set or Plains #287" /></label></div>
      {editing && <p className="fine" id="deck-quantity-help">Clear a quantity to type a new amount. Set it to 0 to remove that card from the deck when you save.</p>}
      {!editing && <div className="deck-view-controls" role="group" aria-label="Deck card view"><button className="filter-chip" aria-pressed={gallery} onClick={() => setGallery(true)}>Gallery</button><button className="filter-chip" aria-pressed={!gallery} onClick={() => setGallery(false)}>List</button><span className="fine">Tap a card to preview it.</span></div>}
      {(comparison || onlyMissing) && <label className="checkbox"><input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />Show only missing cards</label>}
      <div className="deck-studio-card-sections" data-commander={gallery && !editing && visibleCards.some(card => card.section === "commander") && visibleCards.some(card => card.section === "main") || undefined}>
      {(["commander", "main", "sideboard"] as Section[]).map((board) => {
        const entries = visibleCards.filter((card) => card.section === board);
        return entries.length > 0 && <section className="deck-card-section" key={board} data-card-board={board} aria-label={sections[board]}><h3>{sections[board]} <span>{entries.reduce((sum, card) => sum + card.quantity, 0)}</span></h3>
          <ul className={gallery && !editing ? "plain-list deck-cards deck-gallery" : "plain-list deck-cards"}>{entries.map((card) => {
            const index = cards.indexOf(card);
            const collectionCard = ownership.get(card.printing.id + ":" + card.section);
            const quantityError = quantityProblem(card);
            const quantityHint = quantityError || (card.quantity === 0 ? "Removed from this deck when you save. Enter a new quantity to keep it." : "");
            const quantityHintId = `deck-quantity-${card.printing.id}-${card.section}`;
            return <li key={card.printing.id + card.section} className={editing ? "deck-card-row editing" : "deck-card-row"}>
              {editing ? <span className="deck-card-art" aria-hidden="true">{card.printing.image_url ? <img src={card.printing.image_url} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : <span>▧</span>}</span>
                : <button className="deck-card-art deck-art-button" data-printing-id={card.printing.id} data-card-section={card.section} aria-label={`Preview ${card.printing.name} · ${sections[card.section]}`} onClick={(event) => setPreviewCard(card, event.currentTarget)}><CardArt url={card.printing.image_url} name={card.printing.name} /></button>}
              <div className="deck-card-copy"><div className="holding-title"><strong>{card.printing.name}</strong><span className="deck-quantity">×{card.quantity}</span></div>
                <p className="fine">{card.printing.set_code.toUpperCase()} #{card.printing.collector_number} · {card.printing.language.toUpperCase()}</p>
                {collectionCard && <p className={collectionCard.missing ? "row-error" : "deck-card-owned"}>Need {card.quantity} · Have {collectionCard.available} · Missing {collectionCard.missing}</p>}
                <p className="card-location"><strong>Find it:</strong> {card.quantity === 0 ? "Removed from the deck when you save" : !collectionCard ? comparisonError ? "Collection comparison unavailable" : "Collection comparison pending" : collectionCard.locations.length ? collectionCard.locations.map((location) => `${location.name} (${location.quantity})`).join(" · ") : "No matching copies in your collection"}</p>
                {!editing && collectionCard?.other_decks?.length ? <span className="deck-also">Also in {collectionCard.other_decks.map((other) => `${other.name} (${other.quantity})`).join(" · ")}</span> : null}
              </div>
              {editing && <fieldset className="deck-card-controls" disabled={busy}><div className="form-grid"><label>Copies in deck<span className="deck-quantity-stepper"><button type="button" aria-label={`Remove one copy of ${card.printing.name} in ${sections[card.section]}`} disabled={!!quantityError || card.quantity === 0} onClick={() => { lastEdit.current = ""; changeQuantity(index, String(card.quantity - 1)); }}>−</button><input aria-label="Copies in deck" type="number" inputMode="numeric" min={0} max={100000} step={1} value={String(card.quantityInput ?? card.quantity)} aria-invalid={!!quantityError || undefined} aria-describedby={`deck-quantity-help${quantityHint ? " " + quantityHintId : ""}`} onChange={(e) => changeQuantity(index, e.target.value)} onBlur={() => { lastEdit.current = ""; if (!quantityError) setCards(cards.map((item, i) => i === index ? { ...item, quantityInput: undefined } : item)); }} /><button type="button" aria-label={`Add one copy of ${card.printing.name} in ${sections[card.section]}`} disabled={!!quantityError || card.quantity === 100000} onClick={() => { lastEdit.current = ""; changeQuantity(index, String(card.quantity + 1)); }}>+</button></span></label>
                <label>Deck section<select value={card.section} disabled={invalidQuantities} onChange={(e) => changeSection(index, e.target.value as Section)}>{Object.entries(sections).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
                {quantityHint && <p className={quantityError ? "row-error" : "fine"} id={quantityHintId}>{quantityHint}</p>}
                <button className="text-button" onClick={() => { remember(); setCards(cards.filter((_, i) => i !== index)); }}>Remove from deck</button></fieldset>}
            </li>;
          })}</ul></section>;
      })}
      </div>
      {previewCard && previewIndex >= 0 && <DeckCardPreview card={ownership.get(previewCard.printing.id + ":" + previewCard.section) || previewCard} origin={cardFlight?.deckId === deck.id && cardFlight.cardKey === route.card ? cardFlight.origin : null} position={previewIndex} total={previewCards.length} onPrevious={() => setPreviewCard(previewCards[previewIndex - 1])} onNext={() => setPreviewCard(previewCards[previewIndex + 1])} onClose={() => setPreviewCard(null)} />}
      {cards.length === 0 ? <p>{editing ? "Search your collection above or import a deck list to add cards." : "This deck is empty. Import a list or use Edit deck to add cards."}</p> : visibleCards.length === 0 && <p>No cards match this view. Clear the search or missing-card filter to see the whole deck.</p>}
      <div className="deck-studio-secondary">
      <div className="deck-overview-actions"><button className="button secondary" disabled={busy || dirty} onClick={startImport}>Import deck list</button>
        <button className="button secondary" disabled={busy || dirty} onClick={() => navigation.go({ page: "decks", deck: deck.id, view: "scan" })}><Icon name="camera" />Scan cards</button>
        <p className="fine">{dirty ? "Save or discard these edits before importing another list." : "Replace this deck’s card list or add cards from a CSV / text file."}</p></div>

      {comparison && <><div className="deck-availability" aria-label="Deck collection comparison"><span><strong>{comparison.copies}</strong> Needed</span><span><strong>{comparison.owned_copies}</strong> Owned</span><span><strong>{comparison.missing_copies}</strong> Missing</span></div><progress value={comparison.owned_copies} max={Math.max(1, comparison.copies)} aria-label="Deck collection completion" />
      {dirty && <p className="fine" role="status">Live collection comparison · save to update your downloadable buy list.</p>}
      </>}
      {!dirty && <>
        <details className="deck-shopping"><summary>{deck.missing_copies ? `Buy list · ${deck.missing_copies} missing copies` : "Collection comparison"}</summary><DeckBuyList key={deck.id} deck={deck} busy={busy} session={session} links={session.store_links} onRefresh={() => void act(async () => fill(await request<Deck>("/api/v1/decks/" + deck.id)))} /></details>
      </>}
      {dirty && !comparison && <p className={comparisonError ? "message error" : "message"} role="status">{invalidQuantities ? "Finish entering quantities to compare this draft with your collection." : comparisonError ? <>Collection comparison unavailable. {comparisonError} <button className="text-button" onClick={() => { setCollectionAnswer(null); setCollectionRetry((value) => value + 1); }}>Retry collection comparison</button></> : "Checking your collection for this draft…"}</p>}
      {!invalidQuantities && <DeckLegality session={session} format={format} cards={cards.filter((card) => card.quantity > 0).map((card) => ({ printing_id: card.printing.id, quantity: card.quantity, section: card.section }))} saved={deck.legality} live={dirty} onCard={(id) => { const card = cards.find((item) => item.printing.id === id); if (card) { setOnlyMissing(false); setCardFilter(""); setPreviewCard(card); } }} />}
      {!editing && notes && <div className="deck-notes"><h3>Notes</h3><p>{notes}</p></div>}
      {!invalidQuantities && <DeckStats key={`stats:${deck.id}`} cards={cards.filter((card) => card.quantity > 0)} />}
      <DeckTokens key={`tokens:${deck.id}`} session={session} cards={cards.filter((card) => card.quantity > 0).map((card) => ({ printing_id: card.printing.id, quantity: card.quantity, section: card.section }))} saved={deck.tokens} live={dirty} paused={invalidQuantities} format={format} onCard={(id) => { const card = cards.find((item) => item.printing.id === id); if (card) { setOnlyMissing(false); setCardFilter(""); setPreviewCard(card); } }} />
      </div>
      {editing && <div className="deck-save"><p role="status">{dirty ? "Unsaved changes" : "All changes saved"}</p><div className="actions">
        <button className="button primary" disabled={busy || !dirty || !name.trim() || invalidQuantities} onClick={() => void act(save)}>Save deck</button>
        {dirty && <button className="text-button" disabled={busy} onClick={() => { if (canLeave()) void act(async () => fill(await request<Deck>("/api/v1/decks/" + deck.id), true)); }}>Discard changes</button>}
      </div></div>}
      {!dirty && <details className="deck-export"><summary>Export deck list</summary><div className="actions"><button className="button secondary" onClick={() => {
        void (async () => { try { if (!navigator.clipboard) throw new Error("Clipboard unavailable"); await navigator.clipboard.writeText(deckText(deck.cards)); setCopyMessage("Full deck list copied, including sections and editions."); setCopyFallback(false); } catch { setCopyMessage("Select the full list below and use Copy."); setCopyFallback(true); } })();
      }}>Copy deck list</button><a className="text-button" href={"/api/v1/decks/" + deck.id + "/download?format=text"}>Export saved deck as text</a><a className="text-button" href={"/api/v1/decks/" + deck.id + "/download?format=csv"}>Export saved deck as CSV</a><a className="text-button" href={"/api/v1/decks/" + deck.id + "/download?format=arena"}>Export for MTG Arena</a><a className="text-button" href={"/api/v1/decks/" + deck.id + "/download?format=mtgo"}>Export for MTGO</a></div>{copyMessage && <p className="fine" role="status">{copyMessage}</p>}{copyFallback && <label>Full deck list to copy<textarea readOnly rows={6} value={deckText(deck.cards)} onFocus={(e) => e.target.select()} /></label>}
        <h3>Buy the whole deck</h3><StoreButtons stores={["tcgplayer", "cardkingdom", "manapool"]} cards={deck.cards} exact={deck.match_mode === "exact"} links={session.store_links} short /><p className="fine">Opens the store with every card in this deck, including ones you own. TCGplayer and ManaPool fill the list in; for Card Kingdom it’s copied to paste.</p><ReferralNote links={session.store_links} /></details>}
      {!dirty && <div className="deck-duplicate"><button className="button secondary" disabled={busy} onClick={() => { setDuplicating(!duplicating); setDuplicateName(`${deck.name} (copy)`.slice(0, 255)); }}>Duplicate deck</button>
        {duplicating && <form onSubmit={(e) => { e.preventDefault(); void act(async () => {
          const body = { name: duplicateName.trim(), format: deck.format, notes: deck.notes, match_mode: deck.match_mode, cards: cardChoices(deck.cards) };
          const encoded = JSON.stringify(body); if (duplicateReceipt.current?.body !== encoded) duplicateReceipt.current = { body: encoded, key: crypto.randomUUID() };
          const copied = await request<Deck>("/api/v1/decks", mutation(session, body, duplicateReceipt.current.key));
          fill(copied, true); navigation.go({ page: "decks", deck: copied.id }, { force: true }); setOffset(0); setNotice("Deck duplicated. Your collection quantities stay the same."); await list(0); focusTitle();
        }); }}><label>Name for the duplicate<input maxLength={255} value={duplicateName} disabled={busy} onChange={(e) => setDuplicateName(e.target.value)} /></label><p className="fine">Copies the saved cards, notes, format and collection matching. Use it to try a different build.</p><div className="actions"><button className="button primary" disabled={busy || !duplicateName.trim()}>Create duplicate</button><button className="text-button" type="button" disabled={busy} onClick={() => setDuplicating(false)}>Cancel duplicate</button></div></form>}
      </div>}
      <div className="batch-exit actions">{editing && <button className="button primary" disabled={busy || !name.trim() || invalidQuantities} onClick={finishEditing}>{dirty ? "Save & done" : "Done editing"}</button>}<button className="button secondary" disabled={busy} onClick={closeDeck}>Close deck</button></div>
      {editing && <details className="deck-archive"><summary>Archive deck</summary><label className="checkbox"><input type="checkbox" checked={archiveReady} onChange={(e) => setArchiveReady(e.target.checked)} />Remove this deck from my saved list. Keep my collection.</label><button className="button secondary" disabled={busy || !archiveReady || dirty} onClick={() => void act(async () => { await request("/api/v1/decks/" + deck.id + "/archive", mutation(session, { expected_version: deck.version })); navigation.go({ page: "decks" }, { replace: true, force: true }); resetView(); await list(); })}>Archive this deck</button></details>}
    </section>}
    {opening && <DeckOpening key={opening.deck.id} origin={opening} ready={deck?.id === opening.deck.id} onComplete={() => setOpening(null)} />}
  </>;
}
