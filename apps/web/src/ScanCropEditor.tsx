import ErrorNotice from "./ErrorNotice";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { mutation, request, type Session } from "./api";
import type { ReviewState } from "./scanTypes";
import { readDraft, removeDraft, writeDraft } from "./recovery";
import "./scan-qol.css";

type CropDraft = { points: number[][]; version?: number };
function isCropDraft(value: CropDraft | null): value is CropDraft {
  return !!value && Array.isArray(value.points) && value.points.length <= 4
    && value.points.every((point) => Array.isArray(point) && point.length === 2 && point.every((coordinate) => Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1))
    && (value.version === undefined || Number.isInteger(value.version));
}

export default function ScanCropEditor({ scanId, session, region, onCancel, onSaved, onStateChange }: {
  scanId: string; session: Session; region: { id: string; polygon: number[][]; version: number } | null;
  onCancel: () => void; onSaved: (id: string) => void;
  onStateChange: (state: ReviewState) => void;
}) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => { root.current?.scrollIntoView({ block: "start", behavior: "smooth" }); }, []);
  const [points, setPoints] = useState<number[][]>(region?.polygon || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | string>("");
  const canvas = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);
  const receipt = useRef<{ body: string; key: string } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [version, setVersion] = useState(region?.version);
  const [savedUncertain, setSavedUncertain] = useState(false);
  const recoveryKey = `crop:${session.owner_id}:${scanId}:${region?.id || "new"}`;
  const [recovery, setRecovery] = useState<CropDraft | null>(() => { const saved = readDraft<CropDraft>(recoveryKey); return isCropDraft(saved) ? saved : null; });
  const [localSaved, setLocalSaved] = useState<boolean | null>(null);
  const dirty = JSON.stringify(points) !== JSON.stringify(region?.polygon || []);
  useEffect(() => { onStateChange({ dirty, busy }); }, [dirty, busy, onStateChange]);
  useEffect(() => () => onStateChange({ dirty: false, busy: false }), [onStateChange]);
  useEffect(() => {
    if (recovery) return;
    if (!dirty) { removeDraft(recoveryKey); setLocalSaved(null); return; }
    setLocalSaved(writeDraft(recoveryKey, { points, version } satisfies CropDraft));
  }, [points, version, dirty, recovery, recoveryKey]);
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  function position(e: PointerEvent) { const box = canvas.current!.getBoundingClientRect(); return [clamp((e.clientX - box.left) / box.width), clamp((e.clientY - box.top) / box.height)]; }
  function start(e: PointerEvent<HTMLDivElement>) {
    if (busy) return;
    const next = position(e), box = canvas.current!.getBoundingClientRect();
    let index = points.findIndex((p) => Math.hypot((p[0] - next[0]) * box.width, (p[1] - next[1]) * box.height) < 24);
    if (index < 0 && points.length < 4) { index = points.length; setPoints([...points, next]); }
    if (index >= 0) { dragging.current = index; e.currentTarget.setPointerCapture(e.pointerId); }
  }
  async function save() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const body = { polygon: points, ...(region ? { expected_version: version } : {}) };
      const encoded = JSON.stringify(body);
      if (receipt.current?.body !== encoded) receipt.current = { body: encoded, key: crypto.randomUUID() };
      const result = await request<{ id: string }>(`/api/v1/scans/${scanId}/observations${region ? `/${region.id}/geometry` : ""}`, {
        ...mutation(session, body, receipt.current.key), method: region ? "PUT" : "POST",
      }); removeDraft(recoveryKey); onSaved(result.id);
    } catch (e) {
      setError(e as Error);
      if (region) {
        try {
          const latest = await request<{ items: { id: string; polygon: number[][]; version: number }[] }>(`/api/v1/scans/${scanId}/observations`);
          const saved = latest.items.find((item) => item.id === region.id);
          if (saved && JSON.stringify(saved.polygon) === JSON.stringify(points)) { removeDraft(recoveryKey); onSaved(saved.id); return; }
          if (saved && saved.version !== version) { setVersion(saved.version); receipt.current = null; setSavedUncertain(true); }
        } catch { /* Keep identical receipt for a safe retry of the same body. */ }
      }
    }
    finally { setBusy(false); }
  }
  return <section ref={root} className="scan-crop-editor" aria-label="Card outline editor"><h3>{region ? "Adjust this card’s outline" : "Outline a missed card"}</h3>
    <p>Tap around the four corners in either direction, starting at any corner. Drag a dot to refine it. Use arrow keys when a corner is focused; hold Shift for larger adjustments.</p>
    {recovery && <div className="scan-recovery" aria-label="Recovered outline draft"><div><strong>Your unfinished outline is available</strong><p>Restore your corners, then check the photo before saving.</p></div><div className="actions"><button className="button primary" disabled={busy} onClick={() => { setPoints(recovery.points); setSavedUncertain(!!region && recovery.version !== region.version); setVersion(region?.version); setRecovery(null); }}>Restore outline</button><button className="text-button" disabled={busy} onClick={() => { removeDraft(recoveryKey); setRecovery(null); }}>Discard outline draft</button></div></div>}
    {localSaved !== null && <p className="scan-local-status" role="status">{localSaved ? "Unfinished corners saved on this device." : "This browser could not save your outline draft. Keep this page open until you save."}</p>}
    <div className="crop-precision-tools" role="group" aria-label="Crop magnification"><button className="button secondary" disabled={busy || zoom <= 1} onClick={() => setZoom((value) => Math.max(1, value - 1))}>− Zoom out</button><span aria-live="polite">{zoom}×</span><button className="button secondary" disabled={busy || zoom >= 4} onClick={() => setZoom((value) => Math.min(4, value + 1))}>+ Zoom in</button><button className="text-button" disabled={busy} onClick={() => { setZoom(1); canvas.current?.parentElement?.scrollTo(0, 0); }}>Fit photo</button></div>
    {savedUncertain && <p className="message" role="status">The saved outline changed. Your corners are preserved; review them before saving again.</p>}
    <div className="crop-viewport" tabIndex={0} role="region" aria-label="Photo outline. Scroll when enlarged.">
    <div className="crop-canvas" ref={canvas} onPointerDown={start} onPointerMove={(e) => {
      if (busy || dragging.current === null) return; const index = dragging.current, next = position(e);
      setPoints((current) => current.map((p, i) => i === index ? next : p));
    }} onPointerUp={() => { dragging.current = null; }} onPointerCancel={() => { dragging.current = null; }} style={{ width: `${zoom * 100}%`, touchAction: "pan-x pan-y" }}>
      <img src={`/api/v1/scans/${scanId}/image?kind=prepared`} alt="Tap around one card in your photo" draggable={false} />
      <svg viewBox="0 0 1 1" preserveAspectRatio="none"><polygon points={points.map((p) => p.join(",")).join(" ")} />{points.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r=".014" tabIndex={0} role="button" aria-label={`Corner ${i + 1}; use arrow keys to adjust`} onKeyDown={(e) => {
        const delta: Record<string, number[]> = { ArrowLeft: [-.002, 0], ArrowRight: [.002, 0], ArrowUp: [0, -.002], ArrowDown: [0, .002] };
        if (delta[e.key]) { e.preventDefault(); if (busy) return; const move = delta[e.key], step = e.shiftKey ? 10 : 1; setPoints((current) => current.map((point, j) => i === j ? [clamp(point[0] + move[0] * step), clamp(point[1] + move[1] * step)] : point)); }
      }} />)}</svg>
    </div>
    </div>
    <div className="actions"><button className="button primary" disabled={busy || !!recovery || points.length !== 4} onClick={() => void save()}>{busy ? "Saving outline…" : "Save outline & identify"}</button><button className="text-button" disabled={busy} onClick={() => { removeDraft(recoveryKey); setRecovery(null); setPoints([]); setSavedUncertain(false); }}>Start outline over</button><button className="text-button" disabled={busy} onClick={() => { removeDraft(recoveryKey); onCancel(); }}>Cancel outline</button></div>
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
  </section>;
}
