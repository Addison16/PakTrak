import { useEffect, useState } from "react";
import { request } from "./api";
import ErrorNotice from "./ErrorNotice";

type Entry = { request_id: string; created_at: string; method: string; route: string; status: number; code: string; summary: string; duration_ms: number; context: { fields?: { field: string; issue: string }[]; exception_type?: string; frames?: { file: string; function: string; line: number }[] } };
type Result = { items: Entry[]; next_offset: number | null; retention_days: number };

export default function ErrorLogs() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Result | null>(null);
  const [query, setQuery] = useState("");
  const [reference, setReference] = useState("");
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | string>("");
  const [copied, setCopied] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setBusy(true); setError("");
    void request<Result>(`/api/v1/diagnostics/errors?offset=${offset}${reference ? "&reference=" + encodeURIComponent(reference) : ""}`, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setData(value); })
      .catch((e: Error) => { if (!controller.signal.aborted) setError(e); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [open, reference, offset, revision]);
  return <section className="error-log-panel" aria-label="Request error logs">
    <div className="section-heading"><h3>Error logs</h3><button className="button secondary" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Close error logs" : "View error logs"}</button></div>
    {open && <>
      <p className="fine">Failed app requests and sign-in confirmations from the last {data?.retention_days || 14} days. Match an error reference to see what failed. Connection failures that never reach the app appear only in the browser’s error details.</p>
      <form className="error-log-search" onSubmit={(e) => { e.preventDefault(); const value = query.trim(); if (value && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) { setError("Paste the complete error reference from Error details."); return; } setOffset(0); setReference(value); setRevision((n) => n + 1); }}>
        <label>Error reference<input value={query} onChange={(e) => setQuery(e.target.value)} maxLength={64} placeholder="Paste a reference to find it" /></label>
        <button className="button secondary" disabled={busy}>Find error</button>
        <button type="button" className="text-button" disabled={busy} onClick={() => { setQuery(""); setReference(""); setOffset(0); setRevision((n) => n + 1); }}>Show recent errors</button>
      </form>
      {busy && <p role="status">Loading error logs…</p>}
      {error && <ErrorNotice error={error} onDismiss={() => setError("")} onRetry={() => setRevision((n) => n + 1)} />}
      {!busy && data?.items.length === 0 && <p>{reference ? "No saved error matches that reference." : "No recent request errors."}</p>}
      <ul className="plain-list error-log-entries">{data?.items.map((entry) => <li key={entry.request_id}>
        <strong>{entry.summary}</strong><p className="fine"><time dateTime={entry.created_at}>{new Date(entry.created_at).toLocaleString()}</time> · HTTP {entry.status} · {entry.duration_ms} ms</p>
        <p className="error-log-route">{entry.method} {entry.route}</p>
        {entry.context.fields?.map((field, i) => <p className="fine" key={i}>{field.field}: {field.issue}</p>)}
        <details><summary>Diagnostic details</summary><pre>{JSON.stringify(entry, null, 2)}</pre><button className="text-button" onClick={() => {
          void navigator.clipboard?.writeText(JSON.stringify(entry, null, 2)).then(() => setCopied(entry.request_id), () => setCopied(""));
        }}>Copy log entry</button>{copied === entry.request_id && <span className="fine" role="status">Copied.</span>}</details>
        <p className="fine error-reference">Reference: {entry.request_id}</p>
      </li>)}</ul>
      <div className="pagination">{offset > 0 && <button className="text-button" disabled={busy} onClick={() => setOffset(Math.max(0, offset - 50))}>Newer errors</button>}{data?.next_offset != null && <button className="text-button" disabled={busy} onClick={() => setOffset(data.next_offset!)}>Older errors</button>}</div>
    </>}
  </section>;
}
