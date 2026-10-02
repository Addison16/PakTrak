import ErrorNotice from "./ErrorNotice";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, mutation, request, type Printing, type Session } from "./api";
import PrintingPicker from "./PrintingPicker";
import DeckLegality from "./DeckLegality";
import { formats, sections, type Deck, type DeckWorkState, type MatchMode, type Section } from "./deckTypes";
import { readDraft, removeDraft, writeDraft } from "./recovery";
import "./deck-qol.css";

type ImportRow = { line: number; name: string; quantity: number; section: Section | null; printing: Printing | null; error: string | null; can_choose: boolean; collection_match?: boolean; owned?: number; excluded?: boolean; source_key?: string; identity_error?: string | null; quantity_error?: string | null; section_error?: string | null; reviewed?: boolean; quantityInput?: string };
type ImportDraft = { content: string; name: string; format: string; mode: MatchMode; sectionMode: string; fileFormat: string; operation: "replace" | "add"; rows: ImportRow[] | null; priorRows?: ImportRow[]; layoutNote: string };
export default function DeckImport({ session, deck, onImported, onCancel, onStateChange }: {
  session: Session; deck?: Deck; onImported: (deck: Deck) => void; onCancel: () => void; onStateChange: (state: DeckWorkState) => void;
}) {
  const [target, setTarget] = useState(deck);
  const [operation, setOperation] = useState<"replace" | "add">("replace");
  const [name, setName] = useState("");
  const [format, setFormat] = useState("casual");
  const [mode, setMode] = useState<MatchMode>(deck?.match_mode || "any");
  const [sectionMode, setSectionMode] = useState("auto");
  const [layoutNote, setLayoutNote] = useState("");
  const [fileFormat, setFileFormat] = useState("text");
  const [content, setContent] = useState("");
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [choosing, setChoosing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | string>("");
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState("");
  const working = useRef(false);
  const receipt = useRef<{ body: string; key: string } | null>(null);
  const recoveryKey = `paktrak:deck-import:${session.owner_id}:${deck?.id || "new"}`;
  const [recoverable, setRecoverable] = useState<ImportDraft | null>(() => {
    const saved = readDraft<ImportDraft>(recoveryKey);
    return saved && typeof saved.content === "string" && saved.content.length <= 256 * 1024 && typeof saved.name === "string" && ["any", "exact"].includes(saved.mode) && (!saved.rows || Array.isArray(saved.rows) && saved.rows.length <= 600) ? saved : null;
  });
  const priorRows = useRef<ImportRow[]>([]);
  const [localSaved, setLocalSaved] = useState(true);
  const [onlyIssues, setOnlyIssues] = useState(false);
  function invalidatePreview() { if (rows) priorRows.current = rows; setRows(null); setChoosing(null); }
  function editRow(index: number, patch: Partial<ImportRow>) {
    setRows((before) => (before || []).map((row, i) => {
      if (i !== index) return row;
      const updated = { ...row, ...patch, reviewed: true };
      updated.quantity_error = !String(updated.quantityInput ?? updated.quantity).trim() || !Number.isInteger(updated.quantity) || updated.quantity < 1 || updated.quantity > 100000 ? "Enter a whole quantity from 1 to 100,000." : null;
      updated.section_error = updated.section && Object.hasOwn(sections, updated.section) ? null : "Choose a deck section.";
      updated.identity_error = updated.printing ? null : updated.identity_error || "Choose a printing.";
      updated.error = updated.identity_error || updated.quantity_error || updated.section_error;
      updated.can_choose = !!updated.name.trim() || !!updated.printing;
      return updated;
    }));
  }
  const included = (rows || []).filter((row) => !row.excluded);
  const unresolved = included.filter((row) => row.error || !row.printing);
  const combined = new Map<string, { printing_id: string; section: Section; quantity: number }>();
  if (target && operation === "add") for (const card of target.cards) combined.set(card.printing.id + ":" + card.section, { printing_id: card.printing.id, section: card.section, quantity: card.quantity });
  for (const row of included) if (row.printing && row.section && !row.error) {
    const id = row.printing.id + ":" + row.section;
    const item = combined.get(id) || { printing_id: row.printing.id, section: row.section, quantity: 0 };
    item.quantity += row.quantity; combined.set(id, item);
  }
  const printings = new Map([...(target?.cards.map((card) => [card.printing.id, card.printing] as const) || []), ...included.filter((row) => row.printing).map((row) => [row.printing!.id, row.printing!] as const)]);
  function quantities(values: { printing_id: string; section: Section; quantity: number }[]) {
    const counts = new Map<string, number>();
    for (const card of values) {
      const identity = mode === "any" ? printings.get(card.printing_id)?.name.toLowerCase() || card.printing_id : card.printing_id;
      const key = identity + ":" + card.section;
      counts.set(key, (counts.get(key) || 0) + card.quantity);
    }
    return counts;
  }
  const previous = quantities(target?.cards.map((card) => ({ printing_id: card.printing.id, section: card.section, quantity: card.quantity })) || []);
  const following = quantities([...combined.values()]);
  const added = [...following].reduce((sum, [key, count]) => sum + Math.max(0, count - (previous.get(key) || 0)), 0);
  const removed = [...previous].reduce((sum, [key, count]) => sum + Math.max(0, count - (following.get(key) || 0)), 0);
  const afterCount = [...combined.values()].reduce((sum, card) => sum + card.quantity, 0);
  const deckFormat = target?.format || format;
  const limitError = combined.size > 300 ? "The resulting deck exceeds 300 printing/section entries. Exclude rows or replace the list instead."
    : [...combined.values()].some((card) => card.quantity > 100000) ? "The resulting quantity exceeds 100,000 for a printing in one section." : "";
  const dirty = !!content.trim() || !!name.trim();
  useEffect(() => {
    if (dirty && !recoverable) setLocalSaved(writeDraft(recoveryKey, { content, name, format, mode, sectionMode, fileFormat, operation, rows, priorRows: priorRows.current, layoutNote } satisfies ImportDraft));
  }, [content, name, format, mode, sectionMode, fileFormat, operation, rows, layoutNote, dirty, recoverable, recoveryKey]);
  useLayoutEffect(() => { onStateChange({ dirty, busy }); }, [dirty, busy, onStateChange]);
  useEffect(() => () => onStateChange({ dirty: false, busy: false }), [onStateChange]);
  async function act(work: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true); setError(""); setConflict(false);
    try { await work(); } catch (e) { setError(e as Error); setConflict(e instanceof ApiError && e.status === 409); }
    finally { working.current = false; setBusy(false); }
  }
  async function readFile(file?: File) {
    if (!file) return;
    await act(async () => {
      if (file.size > 256 * 1024) throw new Error("Choose a deck list smaller than 256 KiB.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
      let text: string;
      try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); } catch { throw new Error("Save the deck list as UTF-8 or UTF-16, then try again."); }
      setContent(text); setFileFormat(file.name.toLowerCase().endsWith(".csv") ? "csv" : "text"); invalidatePreview();
      if (!target && !name) setName(file.name.replace(/\.[^.]+$/, "").slice(0, 255));
    });
  }
  async function preview() {
    const data = await request<{ items: ImportRow[]; layout?: { applied: boolean; reason: string; counts: Record<Section, number> } }>("/api/v1/decks/import-preview", mutation(session, { content, file_format: fileFormat, match_mode: mode, deck_format: deckFormat, section_mode: target && operation === "add" ? "listed" : sectionMode }));
    setLayoutNote(data.layout?.applied ? `Arranged automatically: ${data.layout.counts.commander} commander · ${data.layout.counts.main} mainboard · ${data.layout.counts.sideboard} extras. Quantities count as individual cards.` : deckFormat === "commander" && data.layout?.reason === "listed_sections" ? "Your list’s Commander, Mainboard and Sideboard labels were preserved." : "");
    const reviewed = new Map([...priorRows.current, ...(rows || [])].filter((row) => row.source_key && row.reviewed).map((row) => [row.source_key, row]));
    setRows(data.items.map((row) => {
      const prior = row.source_key ? reviewed.get(row.source_key) : undefined;
      return prior ? { ...row, printing: prior.printing, quantity: prior.quantity, quantityInput: prior.quantityInput, section: prior.section, excluded: prior.excluded, reviewed: true, identity_error: prior.identity_error, quantity_error: prior.quantity_error, section_error: prior.section_error, error: prior.error } : row;
    })); setChoosing(null);
  }
  async function save() {
    if (unresolved.length || !included.length || !rows) throw new Error("Resolve or exclude the remaining rows before importing.");
    if (limitError) throw new Error(limitError);
    const matching = { match_mode: mode, use_collection_versions: mode === "any" };
    const body = target ? { name: target.name, format: target.format, notes: target.notes, ...matching, expected_version: target.version, cards: [...combined.values()] }
      : { name: name.trim(), format, notes: "", ...matching, cards: [...combined.values()] };
    const encoded = JSON.stringify(body);
    if (receipt.current?.body !== encoded) receipt.current = { body: encoded, key: crypto.randomUUID() };
    const saved = await request<Deck>("/api/v1/decks" + (target ? "/" + target.id : ""), mutation(session, body, receipt.current.key));
    removeDraft(recoveryKey); onImported(saved);
  }
  return <section className="panel deck-import" aria-label="Import deck list">
    {recoverable && <aside className="deck-recovery deck-import-recovery" aria-label="Recover deck import"><h3>Your unfinished import is saved.</h3><p>Restore the list and reviewed choices from this device.</p><div className="actions"><button className="button primary" onClick={() => { setContent(recoverable.content); setName(recoverable.name); setFormat(recoverable.format); setMode(recoverable.mode); setSectionMode(recoverable.sectionMode); setFileFormat(recoverable.fileFormat); setOperation(recoverable.operation); setRows(recoverable.rows); priorRows.current = recoverable.priorRows || recoverable.rows || []; setLayoutNote(recoverable.layoutNote); setRecoverable(null); }}>Restore import draft</button><button className="text-button" onClick={() => { removeDraft(recoveryKey); setRecoverable(null); }}>Discard import draft</button></div></aside>}
    {dirty && <p className="fine" role="status">{localSaved ? "Unfinished import backed up on this device." : "Device backup unavailable. Keep this page open until you save."}</p>}
    <div className="batch-toolbar"><button className="button secondary" disabled={busy} onClick={onCancel}>{target ? "← Back to deck" : "← Back to decks"}</button><span className="fine">{busy ? "Working…" : "Preview before saving"}</span></div>
    <div className="eyebrow">{target ? "UPDATE DECK LIST" : "NEW DECK"}</div><h2 id="deck-import-title" tabIndex={-1}>{target ? `Import into ${target.name}` : "Import a deck list"}</h2>
    <p>Paste a list or choose a text / CSV file. Cards match by name and use editions you own. {target ? "This keeps your deck’s name, format and notes." : "The saved deck opens as a card gallery."}</p>
    {target ? <fieldset className="deck-import-operation"><legend>How should this list change your deck?</legend>
      <label className="checkbox"><input type="radio" name="deck-import-operation" checked={operation === "replace"} disabled={busy} onChange={() => { setOperation("replace"); invalidatePreview(); }} /><span><strong>Replace card list</strong><small>Use this as the complete list, including commander and sideboard. Cards absent from the new list are removed from this deck.</small></span></label>
      <label className="checkbox"><input type="radio" name="deck-import-operation" checked={operation === "add"} disabled={busy} onChange={() => { setOperation("add"); invalidatePreview(); }} /><span><strong>Add to current list</strong><small>Keep the current cards and add these quantities. Matching printings in each section are combined.</small></span></label>
    </fieldset> : <><label>Import deck name<input value={name} maxLength={255} disabled={busy} onChange={(e) => setName(e.target.value)} placeholder="My next deck" /></label>
    <label>Import deck format<select value={format} disabled={busy} onChange={(e) => { setFormat(e.target.value); invalidatePreview(); }}>{formats.map((value) => <option key={value} value={value}>{value}</option>)}</select></label></>}
    {deckFormat === "commander" && <div className="commander-import-layout">
      {target && operation === "add" ? <p className="fine">Adding cards keeps your current commander(s). Unmarked incoming cards go to the mainboard; section labels are respected.</p> : <><label>Commander import layout<select value={sectionMode} disabled={busy} onChange={(e) => { setSectionMode(e.target.value); invalidatePreview(); }}><option value="auto">First card is commander</option><option value="two_commanders">First two cards are commanders</option><option value="listed">Use listed sections only</option></select></label><p className="fine">For lists without section labels: {sectionMode === "two_commanders" ? "the first two cards are commanders, the next 98 go to the mainboard" : sectionMode === "listed" ? "unmarked cards go to the mainboard" : "the first card is your commander, the next 99 go to the mainboard"}{sectionMode !== "listed" && ", and anything after card 100 is saved in the sideboard as extras"}. Existing section labels are always preserved.</p></>}
    </div>}
    <label>Collection matching<select value={mode} disabled={busy} onChange={(e) => { setMode(e.target.value as MatchMode); invalidatePreview(); }}><option value="any">Match by name · use my editions</option><option value="exact">Keep listed editions only</option></select></label>
    <label>Deck list file<input type="file" accept=".txt,.text,.csv,text/plain,text/csv" disabled={busy} onChange={(e) => { void readFile(e.target.files?.[0]); e.target.value = ""; }} /></label>
    <label>List format<select value={fileFormat} disabled={busy} onChange={(e) => { setFileFormat(e.target.value); invalidatePreview(); }}><option value="text">Plain text</option><option value="csv">CSV</option></select></label>
    <label>Paste deck list<textarea rows={8} value={content} maxLength={256 * 1024} disabled={busy} spellCheck={false} placeholder={deckFormat === "commander" ? "1 Your commander\n1 First mainboard card\n1 Another mainboard card\n…" : "Mainboard\n4 Card name\nSideboard\n2 Another card"} onChange={(e) => { setContent(e.target.value); invalidatePreview(); }} /></label>
    <p className="fine">Up to 300 card lines. Mainboard, Sideboard and Commander are kept separate. Optional set codes and collector numbers are supported. CSV can use Name, Quantity, Set Code, Collector Number, Scryfall ID and Section.</p>
    <button className="button secondary" disabled={busy || !content.trim()} onClick={() => void act(preview)}>{busy ? "Working…" : "Preview deck list"}</button>
    {rows && <div className="deck-import-preview" aria-label="Deck import preview">
      <h3>{included.reduce((sum, row) => sum + row.quantity, 0)} cards in the incoming list</h3>
      {layoutNote && <p className="message">{layoutNote}</p>}
      <p>{unresolved.length ? `${unresolved.length} rows need attention. Choose a card, correct the source list, or exclude the row.` : "All included rows are matched. Review the list before saving."}{rows.length !== included.length && ` ${rows.length - included.length} ${rows.length - included.length === 1 ? "row" : "rows"} excluded.`}</p>
      {mode === "any" && <p className="fine">Matching editions from your collection are selected automatically. All editions and finishes of the same card count toward what you need. Each owned copy counts once across the deck.</p>}
      {target && !unresolved.length && <div className="deck-import-impact" role="status"><strong>{target.copies} → {afterCount} cards in this deck</strong><p>{added} {added === 1 ? "copy" : "copies"} added · {removed} {removed === 1 ? "copy" : "copies"} removed</p><span className="fine">{operation === "replace" ? "Replaces every deck section with the incoming list." : "Adds the incoming quantities to their listed sections."} Your collection quantities stay the same.</span></div>}
      {!unresolved.length && !limitError && included.length > 0 && <DeckLegality session={session} format={deckFormat} cards={[...combined.values()]} live />}
      <label className="checkbox"><input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />Show only rows needing attention</label>
      <ul className="plain-list deck-import-rows">{rows.map((row, index) => !onlyIssues || !row.excluded && (!!row.error || !row.printing) ? <li key={index} className={row.excluded ? "excluded" : ""}>
        <strong>{row.quantity || "?"} × {row.printing?.name || row.name}</strong><span className="fine">Line {row.line} · {row.section ? sections[row.section] : "Unknown section"}{row.printing && ` · ${row.printing.set_code.toUpperCase()} #${row.printing.collector_number}`}</span>
        {row.collection_match && !row.excluded && <span className="deck-card-owned">✓ Using an edition you own · {row.owned} in your collection</span>}
        {row.error && !row.excluded && <p className="row-error">{row.error}</p>}
        {!row.excluded && <div className="deck-import-row-controls"><label>Quantity · line {row.line}<input type="number" inputMode="numeric" min={1} max={100000} value={row.quantityInput ?? String(row.quantity || "")} disabled={busy} onChange={(e) => editRow(index, { quantity: Number(e.target.value), quantityInput: e.target.value })} /></label><label>Section · line {row.line}<select value={row.section || ""} disabled={busy} onChange={(e) => editRow(index, { section: e.target.value as Section })}>{!row.section && <option value="">Choose section</option>}{Object.entries(sections).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>}
        <div className="actions">{row.can_choose && !row.excluded && <button className="text-button" disabled={busy} onClick={() => setChoosing(choosing === index ? null : index)}>{choosing === index ? "Close card search" : row.printing ? "Change printing" : "Choose card"}</button>}
          <button className="text-button" disabled={busy} onClick={() => { editRow(index, { excluded: !row.excluded }); setChoosing(null); }}>{row.excluded ? "Include row" : "Exclude row"}</button></div>
        {choosing === index && <PrintingPicker initialPrinting={row.printing || undefined} initialQuery={row.name} onSelect={(printing) => { editRow(index, { printing, identity_error: null, collection_match: false, owned: undefined }); setChoosing(null); }} />}
      </li> : null)}</ul>
      <p className="fine">Your collection quantities stay the same. The saved deck will show what you own and what is missing.</p>
      {limitError && <p className="message error" role="alert">{limitError}</p>}
      <button className="button primary" disabled={busy || (!target && !name.trim()) || !included.length || !!unresolved.length || !!limitError} onClick={() => void act(save)}>{target ? operation === "replace" ? "Replace deck list" : "Add cards to deck" : "Import deck"}</button>
    </div>}
    {error && <ErrorNotice error={error} onDismiss={() => setError("")}>{target && conflict && <button className="text-button" disabled={busy} onClick={() => void act(async () => {
      setTarget(await request<Deck>("/api/v1/decks/" + target.id)); setNotice("Saved deck reloaded. Review the updated counts before applying your list.");
    })}>Reload saved deck</button>}</ErrorNotice>}
    {notice && <p className="message" role="status">{notice}</p>}
    <div className="batch-exit actions"><button className="button secondary" disabled={busy} onClick={onCancel}>Cancel import</button></div>
  </section>;
}
