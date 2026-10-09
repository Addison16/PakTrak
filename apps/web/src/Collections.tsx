import useBackgroundError from "./useBackgroundError";
import ErrorNotice from "./ErrorNotice";
import { useEffect, useRef, useState } from "react";
import { ApiError, mutation, request, type Location as Binder, type Printing, type Session } from "./api";
import PrintingPicker from "./PrintingPicker";
import Gallery from "./Gallery";
import DataUpdates, { ProgressView } from "./DataUpdates";
import type { WorkProgress } from "./api";
import "./collection-qol.css";
import { usePullRefresh } from "./pullRefresh";

type Counts = { rows: number; copies: number };
type Import = {
  id: string; filename: string; format: string; state: string; revision: number; headers: string[];
  mapping: Record<string, string>; options: Record<string, unknown>; error: string | null;
  summary: { rows: number; ready_copies: number; committed_copies: number; unresolved_rows: number; states: Record<string, Counts>; undone_copies?: number; previously_removed_copies?: number; wishlist_rows?: number };
  jobs: { id: string; kind: string; state: string; stage: string; error: string | null; progress: WorkProgress | null }[];
};
type Row = { id: string; row_number: number; state: string; error: string | null; raw_fields: Record<string, string>; normalized: { name?: string; quantity?: number; finish?: string; binder?: string; set_code?: string; collector_number?: string; language?: string } };
type Export = { id: string; format: string; state: string; snapshot_at: string | null; expires_at: string | null; requires_acknowledgment: boolean; download_url: string | null; report: { copies?: number; excluded_copies?: number; metadata_loss_copies?: number; warnings?: string[] } };
const formatNames: Record<string, string> = { auto: "Automatic", canonical: "Full CSV", csv: "CSV", generic: "CSV", text: "Text list" };
const fields: Record<string, string> = { scryfall_id: "Scryfall ID", name: "Card name", set_code: "Set code", collector_number: "Collector number", quantity: "Quantity", language: "Language", finish: "Finish / foil", condition: "Condition", binder: "Binder name", binder_type: "Binder or list type", notes: "Notes", purchase_price: "Purchase price", purchase_currency: "Purchase currency", misprint: "Misprint", altered: "Altered", source_metadata_json: "Source metadata JSON" };
const stateNames: Record<string, string> = { PREVIEWING: "Preparing preview", REVIEW: "Ready to review", COMMITTING: "Adding copies", COMPLETED: "Import complete", UNDOING: "Undo in progress", UNDONE: "Import undone", FAILED: "Needs attention", QUEUED: "Queued", PROCESSING: "Preparing export", READY: "Ready", EXPIRED: "Expired" };

function Mapping({ batch, session, open, onToggle, onChange, onError }: { batch: Import; session: Session; open: boolean; onToggle: (open: boolean) => void; onChange: (value: Import) => void; onError: (message: string) => void }) {
  const [mapping, setMapping] = useState(batch.mapping);
  const [delimiter, setDelimiter] = useState(String(batch.options.delimiter || "auto"));
  const [encoding, setEncoding] = useState(String(batch.options.encoding || "utf-8-sig"));
  const [quantity, setQuantity] = useState(Boolean(batch.options.default_quantity));
  const [language, setLanguage] = useState(String(batch.options.default_language || ""));
  const [binder, setBinder] = useState(String(batch.options.default_binder || "Imported collection"));
  const [textFinish, setTextFinish] = useState(String(batch.options.text_default_finish || "unknown"));
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      onChange(await request<Import>("/api/v1/imports/" + batch.id + "/preview", mutation(session, {
        expected_revision: batch.revision, mapping: Object.fromEntries(Object.entries(mapping).filter(([, column]) => column)),
        options: { delimiter, encoding, default_quantity: quantity ? 1 : null, default_language: language, default_binder: binder, text_default_finish: textFinish },
      })));
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <details className="mapping" open={open} onToggle={(event) => onToggle(event.currentTarget.open)}><summary>Column mapping and file options</summary>
    <p className="fine">Choose which source columns describe your owned cards. Extra columns are retained as source metadata. A list or wishlist is excluded when its type is mapped.</p>
    <div className="form-grid">{Object.entries(fields).map(([field, label]) => <label key={field}>{label}<select value={mapping[field] || ""} onChange={(e) => setMapping({ ...mapping, [field]: e.target.value })}><option value="">Not supplied</option>{batch.headers.map((name) => <option key={name}>{name}</option>)}</select></label>)}</div>
    <div className="form-grid"><label>Delimiter<select value={delimiter} onChange={(e) => setDelimiter(e.target.value)}><option value="auto">Detect</option><option value=",">Comma</option><option value=";">Semicolon</option><option value={"\t"}>Tab</option></select></label><label>Encoding<select value={encoding} onChange={(e) => setEncoding(e.target.value)}><option value="utf-8-sig">UTF-8 (with or without BOM)</option><option value="utf-16">UTF-16</option></select></label></div>
    <label className="checkbox"><input type="checkbox" checked={quantity} onChange={(e) => setQuantity(e.target.checked)} />Use quantity 1 when no quantity is supplied</label>
    <label>Language when absent<select value={language} onChange={(e) => setLanguage(e.target.value)}><option value="">Leave unresolved (or use printing ID)</option>{["en", "de", "es", "fr", "it", "pt", "ja", "ko", "ru", "zhs", "zht"].map((value) => <option key={value}>{value}</option>)}</select></label>
    <label>Binder when absent<input value={binder} maxLength={255} onChange={(e) => setBinder(e.target.value)} /></label>
    {batch.format === "text" && <label>Unmarked text entries<select value={textFinish} onChange={(e) => setTextFinish(e.target.value)}><option value="nonfoil">Normal / nonfoil</option><option value="unknown">Keep finish unknown</option></select></label>}
    <button className="button secondary" disabled={busy || !binder.trim()} onClick={() => void save()}>Rebuild preview</button>
  </details>;
}

function RepairRow({ row, batch, session, onChange, onError }: { row: Row; batch: Import; session: Session; onChange: (value: Import) => void; onError: (value: string) => void }) {
  const [printing, setPrinting] = useState<Printing | null>(null);
  const [finish, setFinish] = useState(row.normalized.finish || "unknown");
  const [busy, setBusy] = useState(false);
  async function save(skip: boolean) {
    setBusy(true);
    try { onChange(await request<Import>(`/api/v1/imports/${batch.id}/rows/${row.id}`, mutation(session, { expected_revision: batch.revision, skip, printing_id: printing?.id || null, owned_cards: !skip, finish }))); }
    catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <details className="row-repair"><summary>Review this row</summary>
    {row.state !== "INVALID" && <><PrintingPicker initialQuery={row.normalized.name || ""} onSelect={(value) => { setPrinting(value); setFinish(value.finishes.includes(row.normalized.finish || "") ? row.normalized.finish! : "unknown"); }} />{printing && <div className="chosen-printing"><strong>{printing.name}</strong><p>{printing.set_code.toUpperCase()} · #{printing.collector_number} · {printing.language.toUpperCase()}</p><label>Finish<select value={finish} onChange={(e) => setFinish(e.target.value)}><option value="unknown">Unknown</option>{printing.finishes.map((value) => <option key={value}>{value}</option>)}</select></label><button className="button secondary" disabled={busy} onClick={() => void save(false)}>I own these cards — use this printing</button></div>}</>}
    {row.state === "INVALID" && <p className="fine">Correct this row in the CSV or adjust its column mapping, then rebuild the preview.</p>}
    <button className="text-button" disabled={busy} onClick={() => void save(true)}>Exclude row {row.row_number}</button>
  </details>;
}

function CollectionTransfers({ session }: { session: Session }) {
  const [error, setError] = useState<Error | string>("");
  const backgroundError = useBackgroundError();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [catalogCount, setCatalogCount] = useState<number | null>(null);
  const [binders, setBinders] = useState<Binder[]>([]);
  const [binder, setBinder] = useState("");
  const [imports, setImports] = useState<Import[]>([]);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyNext, setHistoryNext] = useState<number | null>(null);
  const [selected, setSelected] = useState<Import | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [rowOffset, setRowOffset] = useState(0);
  const [rowNext, setRowNext] = useState<number | null>(null);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [focusRow, setFocusRow] = useState<number | null>(null);
  const [issues, setIssues] = useState({ previous: null as number | null, next: null as number | null, count: 0 });
  const [owned, setOwned] = useState(false);
  const [partial, setPartial] = useState(false);
  const [undoReady, setUndoReady] = useState(false);
  const [format, setFormat] = useState("auto");
  const [repeat, setRepeat] = useState(false);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const [exports, setExports] = useState<Export[]>([]);
  const [exportOffset, setExportOffset] = useState(0);
  const [exportNext, setExportNext] = useState<number | null>(null);
  const [exportFormat, setExportFormat] = useState("csv");
  const picker = useRef<HTMLInputElement>(null);
  const selectedId = selected?.id;
  const revision = selected?.revision;

  async function refresh(isCurrent = () => true) {
    const [catalog, binderData] = await Promise.all([
      request<{ printings: number }>("/api/v1/catalog/status"), request<{ items: Binder[] }>("/api/v1/binders"),
    ]);
    if (!isCurrent()) return;
    setCatalogCount(catalog.printings); setBinders(binderData.items);
    {
      const [importData, exportData] = await Promise.all([
        request<{ items: Import[]; next_offset: number | null }>("/api/v1/imports?offset=" + historyOffset),
        request<{ items: Export[]; next_offset: number | null }>("/api/v1/exports?offset=" + exportOffset),
      ]);
      if (!isCurrent()) return;
      setImports(importData.items); setHistoryNext(importData.next_offset); setExports(exportData.items); setExportNext(exportData.next_offset);
      if (selectedId) {
        const [batch, data] = await Promise.all([
          request<Import>("/api/v1/imports/" + selectedId),
          request<{ items: Row[]; next_offset: number | null; previous_issue: number | null; next_issue: number | null; attention_count: number }>("/api/v1/imports/" + selectedId + "/rows?" + new URLSearchParams({ offset: String(rowOffset), attention: String(attentionOnly), ...(focusRow ? { focus: String(focusRow) } : {}) })),
        ]);
        if (!isCurrent()) return;
        setSelected((current) => current?.id === batch.id && batch.revision >= current.revision ? batch : current); setRows(data.items); setRowNext(data.next_offset);
        setIssues({ previous: data.previous_issue ?? null, next: data.next_issue ?? null, count: data.attention_count ?? 0 });
      }
    }
  }
  // Imports and exports change only while a job runs; otherwise check back occasionally.
  const transferActive = useRef(false);
  transferActive.current = [...imports, ...exports, ...(selected ? [selected] : [])].some((item) => ["PREVIEWING", "COMMITTING", "UNDOING", "QUEUED", "PROCESSING"].includes(item.state));
  useEffect(() => {
    let running = false; let stopped = false; let lastLoaded = 0;
    async function poll(event?: Event) {
      if (running || stopped || document.hidden || !navigator.onLine) return;
      if (!event && lastLoaded && !transferActive.current && Date.now() - lastLoaded < 20000) return;
      running = true;
      try { await refresh(() => !stopped); lastLoaded = Date.now(); if (!stopped) backgroundError.recovered(); } catch (e) { if (!stopped) backgroundError.failed(e as Error); } finally { running = false; }
    }
    void poll(new Event("load")); const timer = window.setInterval(() => void poll(), 3500);
    document.addEventListener("visibilitychange", poll); window.addEventListener("online", poll);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", poll); window.removeEventListener("online", poll); };
  }, [binder, selectedId, revision, rowOffset, attentionOnly, focusRow, historyOffset, exportOffset]);
  usePullRefresh(true, () => refresh());
  useEffect(() => { setOwned(false); setPartial(false); setUndoReady(false); }, [selectedId, revision]);
  // The mapping panel keeps its open state across preview rebuilds (which remount Mapping).
  const [mappingOpen, setMappingOpen] = useState(false);
  useEffect(() => { setMappingOpen(false); }, [selectedId]);

  async function act(operation: () => Promise<void>) {
    setError(""); setBusy(true);
    try { await operation(); } catch (e) { setError(e as Error); } finally { setBusy(false); }
  }
  async function chooseFile(file: File | undefined) {
    if (!file || busy) return;
    setDuplicate(null); setNotice("");
    if (file.size > 5 * 1024 * 1024) { setError("Choose a CSV or text file no larger than 5 MiB."); return; }
    await act(async () => {
      try {
        const value = await request<Import>("/api/v1/imports?filename=" + encodeURIComponent(file.name) + "&format=" + format + "&repeat=" + repeat, {
          method: "POST", body: file, headers: { "Content-Type": "text/csv", "X-CSRF-Token": session.csrf_token, "Idempotency-Key": crypto.randomUUID() },
        });
        setSelected(value); setRowOffset(0); setHistoryOffset(0);
        setNotice("File saved. You can close this page while your preview is prepared. Copies are added only after you confirm.");
      } catch (e) { if (e instanceof ApiError) setDuplicate(e.detail.existing_import_id || null); throw e; }
      finally { if (picker.current) picker.current.value = ""; }
    });
  }
  async function selectImport(id: string) { setSelected(await request<Import>("/api/v1/imports/" + id)); setRowOffset(0); setRows([]); setFocusRow(null); setAttentionOnly(false); }
  async function confirmImport() {
    if (!selected) return;
    setSelected(await request<Import>("/api/v1/imports/" + selected.id + "/confirm", mutation(session, { expected_revision: selected.revision, owned_cards: owned, accept_partial: partial })));
    setNotice("Import confirmed and saved. The server will add the reviewed copies even if you close this page.");
  }
  const binderSelect = <label>Storage location<select value={binder} onChange={(e) => { setBinder(e.target.value); }}><option value="">All locations</option>{binders.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>;
  return <>
    {backgroundError.error && <ErrorNotice error={backgroundError.error} onDismiss={backgroundError.dismiss} />}
    {error && <ErrorNotice error={error} onDismiss={() => setError("")}>{duplicate && <button className="text-button" onClick={() => void act(() => selectImport(duplicate))}>Open existing import</button>}</ErrorNotice>}
    {notice && <p className="message success" role="status">{notice}</p>}
    {catalogCount === 0 && <p className="message">This server’s card catalog is empty. You can upload a CSV and inspect its preview, but printings must be loaded before copies can be added.</p>}
    <>

      <section className="panel">
        <div className="section-heading"><h2>Bring your collection</h2><span className="step">CSV / TXT</span></div>
        <p>Upload a CSV or a text card list, then review the quantities and printings before adding them.</p>
        <label>Source format<select value={format} onChange={(e) => setFormat(e.target.value)}><option value="auto">Detect from file</option><option value="generic">CSV — map columns</option><option value="text">Text card list</option><option value="canonical">Full CSV</option></select></label>
        <input ref={picker} data-testid="csv-input" hidden type="file" accept=".csv,.txt,.tsv,text/csv,text/plain,text/tab-separated-values" onChange={(e) => void chooseFile(e.target.files?.[0])} />
        <button className="button primary" disabled={busy} onClick={() => picker.current?.click()}>{busy ? "Saving…" : "Choose CSV or text file"}</button>
        <p className="fine">Up to 5 MiB · 10,000 rows · UTF-8 or UTF-16 · Raw uploads expire after 7 days; imported records remain</p>
        <label className="checkbox"><input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />Allow the same file to represent additional owned copies</label>
        <p className="fine">Text example: <code>4 Lightning Bolt (M11) 146</code>. Card names without a set may need you to choose a printing. Unmarked text entries default to nonfoil; file options can keep their finish unknown.</p><DataUpdates />
      </section>
      {selected && <section className="panel" aria-label="Import preview">
        <div className="section-heading"><h2>{stateNames[selected.state] || selected.state}</h2><span className="badge">{formatNames[selected.format] || "CSV"}</span></div>
        <p className="filename">{selected.filename}</p>
        {selected.format === "text" && <p className="fine">Unmarked entries: {selected.options.text_default_finish === "nonfoil" ? "normal / nonfoil" : "unknown finish"}. *F* means foil; *E* means etched foil. You can change the unmarked-entry setting in file options before adding copies.</p>}
        {selected.error && <p className="message error">{selected.error}</p>}
        {selected.summary.rows !== undefined && <div className="stat-grid"><div><strong>{selected.summary.rows}</strong><span>source rows</span></div><div><strong>{selected.summary.ready_copies}</strong><span>copies ready</span></div><div><strong>{selected.summary.committed_copies}</strong><span>copies added</span></div></div>}
        {selected.state === "UNDONE" && <p className="saved">Removed {selected.summary.undone_copies} remaining copies from this import. {selected.summary.previously_removed_copies || 0} copies had already been removed.</p>}
        {["PREVIEWING", "COMMITTING", "UNDOING"].includes(selected.state) && <p className="saved" role="status">Saved on the server. You can close this page.</p>}
        {selected.jobs.filter((job) => ["QUEUED", "RUNNING"].includes(job.state)).map((job) => <ProgressView key={job.id} value={job.progress} />)}
        {["REVIEW", "FAILED"].includes(selected.state) && <Mapping key={selected.id + ":" + selected.revision} batch={selected} session={session} open={mappingOpen} onToggle={setMappingOpen} onChange={setSelected} onError={setError} />}
        <div className="import-attention-toolbar"><label className="checkbox"><input type="checkbox" checked={attentionOnly} onChange={(event) => { setAttentionOnly(event.target.checked); setRowOffset(0); setFocusRow(null); }} />Needs attention only · {issues.count}</label><button className="text-button" disabled={issues.previous === null} onClick={() => { setAttentionOnly(false); setFocusRow(issues.previous); setRowOffset(0); }}>Previous issue</button><button className="text-button" disabled={issues.next === null} onClick={() => { setAttentionOnly(false); setFocusRow(issues.next); setRowOffset(0); }}>Next issue</button>{focusRow && <button className="text-button" onClick={() => { setFocusRow(null); setRowOffset(Math.floor((focusRow - 1) / 40) * 40); }}>Show surrounding rows</button>}</div>
        {!rows.length && attentionOnly && <p className="saved" role="status">No rows need attention in this import.</p>}
        {rows.length > 0 && <details open><summary>Review source rows</summary><ul className="plain-list import-rows">{rows.map((row) => <li key={row.id}>
          <div className="holding-title"><strong>{row.normalized.name || Object.values(row.raw_fields)[0] || "Unresolved card"}</strong><span className="badge">{row.state.toLowerCase()}</span></div>
          <p className="fine">Row {row.row_number} · {row.normalized.quantity ?? "?"} copies{row.normalized.set_code ? " · " + row.normalized.set_code.toUpperCase() : ""}{row.normalized.collector_number ? " #" + row.normalized.collector_number : ""}{row.normalized.language ? " · " + row.normalized.language : ""}{row.normalized.binder ? " · " + row.normalized.binder : ""} · {row.normalized.finish || "unknown finish"}</p>
          {row.error && <p className="row-error">{row.error}</p>}
          {selected.state === "REVIEW" && <RepairRow key={row.id + selected.revision} row={row} batch={selected} session={session} onChange={setSelected} onError={setError} />}
        </li>)}</ul><div className="pagination">{rowOffset > 0 && <button className="text-button" onClick={() => setRowOffset(Math.max(0, rowOffset - 40))}>Previous rows</button>}{rowNext !== null && <button className="text-button" onClick={() => setRowOffset(rowNext)}>More rows</button>}</div></details>}
        {!!selected.summary.wishlist_rows && !["PREVIEWING", "UNDOING"].includes(selected.state) && <p className="fine">{selected.summary.wishlist_rows} {selected.summary.wishlist_rows === 1 ? "row is" : "rows are"} from a wishlist or list, so {selected.summary.wishlist_rows === 1 ? "it isn’t" : "they aren’t"} added to your collection. <button type="button" className="text-button" disabled={busy} onClick={() => void act(async () => {
          const result = await request<{ added: number }>(`/api/v1/wishlist/from-import/${selected.id}`, { ...mutation(session), action: "Add to wishlist" });
          setNotice(`Added ${result.added} ${result.added === 1 ? "card" : "cards"} to your wishlist.`);
          setSelected(await request<Import>("/api/v1/imports/" + selected.id));
        })}>Add them to my wishlist</button></p>}
        {selected.summary.unresolved_rows > 0 && <p className="message">{selected.summary.unresolved_rows} rows need attention. <a href={"/api/v1/imports/" + selected.id + "/unresolved.csv"}>Download unresolved and excluded rows</a></p>}
        {selected.state === "REVIEW" && <div className="confirmation">
          <label className="checkbox"><input type="checkbox" checked={owned} onChange={(e) => setOwned(e.target.checked)} />These are cards I own. Add the reviewed quantities to my collection.</label>
          {selected.summary.unresolved_rows > 0 && <label className="checkbox"><input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />Add only ready rows; keep unresolved rows in this import’s history</label>}
          <button className="button primary" disabled={busy || !owned || selected.summary.ready_copies <= 0 || (selected.summary.unresolved_rows > 0 && !partial)} onClick={() => void act(confirmImport)}>Add {selected.summary.ready_copies || 0} copies</button>
        </div>}
        {["COMPLETED", "COMMITTING", "FAILED"].includes(selected.state) && <details className="undo"><summary>Undo this import</summary><p>Remove only copies added by this import that remain in your collection. Copies from other imports or scans stay in place.</p><label className="checkbox"><input type="checkbox" checked={undoReady} onChange={(e) => setUndoReady(e.target.checked)} />Stop further additions and remove this import’s remaining copies</label><button className="button secondary" disabled={busy || !undoReady} onClick={() => void act(async () => setSelected(await request<Import>("/api/v1/imports/" + selected.id + "/undo", mutation(session, { expected_revision: selected.revision }))))}>Undo remaining copies</button></details>}
      </section>}
      {imports.length > 0 && <section className="panel"><h2>Import history</h2><ul className="plain-list">{imports.map((batch) => <li key={batch.id}><button className="batch" onClick={() => void act(() => selectImport(batch.id))}><span className="batch-details"><strong>{batch.filename}</strong><span>{batch.summary.committed_copies || 0} copies added</span></span><span className="badge">{stateNames[batch.state] || batch.state}</span></button></li>)}</ul><div className="pagination">{historyOffset > 0 && <button className="text-button" onClick={() => setHistoryOffset(Math.max(0, historyOffset - 20))}>Newer imports</button>}{historyNext !== null && <button className="text-button" onClick={() => setHistoryOffset(historyNext)}>Older imports</button>}</div></section>}
      <section className="panel"><h2>Take your collection with you</h2><p>Export all your cards or one storage location. Use CSV for card details, text for a simple list, or full CSV to retain extra source fields. Choose Decks for every saved deck.</p>
        {exportFormat !== "decks" && binderSelect}<label>Export format<select value={exportFormat} onChange={(e) => setExportFormat(e.target.value)}><option value="csv">CSV — card details and locations</option><option value="text">Text — quantity and card list</option><option value="canonical">Full CSV — all card details</option><option value="decks">Decks — every saved deck</option></select></label>
        {exportFormat === "decks" && <><p className="fine">The text file lists each deck with its format, notes and cards by section, ready to share or paste into an AI chat. The CSV can be restored on another server from Decks › Move all decks.</p>
          <div className="actions"><a className="button primary" href="/api/v1/decks/download-all?format=text">Download decks as text</a><a className="button secondary" href="/api/v1/decks/download-all">Download decks as CSV</a></div></>}
        {exportFormat === "text" && <p className="fine">Text lists omit locations, condition, language, notes and purchase details. Unmarked entries are normally read as nonfoil; full CSV preserves unknown finishes.</p>}
        {exportFormat !== "decks" && <button className="button primary" disabled={busy} onClick={() => void act(async () => { await request<Export>("/api/v1/exports", mutation(session, { format: exportFormat, binder_id: binder || null })); setNotice("Export queued. Your server will save the file; you can return to download it."); setExportOffset(0); await refresh(); })}>Prepare export</button>}
        <ul className="plain-list export-list">{exports.map((value) => <li key={value.id}><div className="holding-title"><strong>{formatNames[value.format] || "CSV"}</strong><span className="badge">{stateNames[value.state] || value.state}</span></div>
          {value.snapshot_at && <p className="fine">Snapshot {new Date(value.snapshot_at).toLocaleString()} · {value.report.copies || 0} copies</p>}
          {value.report.warnings?.length ? <div className="message"><ul>{value.report.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div> : null}
          {value.download_url && (!value.requires_acknowledgment ? <a className="button secondary" href={value.download_url}>Download {value.format === "text" ? "text file" : "CSV"}</a> : <button className="button secondary" disabled={busy} onClick={() => void act(async () => { await request("/api/v1/exports/" + value.id + "/acknowledge", mutation(session)); await refresh(); })}>Acknowledge omitted details</button>)}
          {value.expires_at && <p className="fine">Download expires {new Date(value.expires_at).toLocaleString()}</p>}
        </li>)}</ul><div className="pagination">{exportOffset > 0 && <button className="text-button" onClick={() => setExportOffset(Math.max(0, exportOffset - 20))}>Newer exports</button>}{exportNext !== null && <button className="text-button" onClick={() => setExportOffset(exportNext)}>Older exports</button>}</div>
      </section>
    </>
  </>;
}

export default function Collections({ session, mode }: { session: Session; mode: "collection" | "transfers" }) {
  return mode === "collection" ? <Gallery session={session} /> : <CollectionTransfers session={session} />;
}
