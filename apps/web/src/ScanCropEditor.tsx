import ErrorNotice from "./ErrorNotice";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { mutation, request, type Session } from "./api";
import type { ReviewState } from "./scanTypes";
import { readDraft, removeDraft, writeDraft } from "./recovery";
import "./scan-qol.css";

type CropDraft = { points: number[][]; version?: number };
// The magnifier follows the active corner from the side of the photo away from
// the finger, so the corner stays visible while it is dragged.
type Loupe = { index: number; width: number; height: number; left: number; top: number };
const LOUPE_SIZE = 136;
const KEY_STEPS: Record<string, number[]> = { ArrowLeft: [-.002, 0], ArrowRight: [.002, 0], ArrowUp: [0, -.002], ArrowDown: [0, .002] };
// Open an existing outline already enlarged around its card so the first drag is precise.
function startZoom(polygon: number[][] | undefined) {
  if (!polygon?.length) return 1;
  const xs = polygon.map((p) => p[0]), ys = polygon.map((p) => p[1]);
  const size = Math.max(Math.max(...xs) - Math.min(...xs), (Math.max(...ys) - Math.min(...ys)) * .75);
  return Math.max(1, Math.min(3, Math.floor(.6 / Math.max(size, .01))));
}
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
  const viewport = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ index: number; offset: number[]; added: boolean } | null>(null);
  const [loupe, setLoupe] = useState<Loupe | null>(null);
  const receipt = useRef<{ body: string; key: string } | null>(null);
  const [zoom, setZoom] = useState(() => startZoom(region?.polygon));
  const centered = useRef(false);
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const history = useRef<number[][][]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const [version, setVersion] = useState(region?.version);
  const [savedUncertain, setSavedUncertain] = useState(false);
  const recoveryKey = `crop:${session.owner_id}:${scanId}:${region?.id || "new"}`;
  const photo = `/api/v1/scans/${scanId}/image?kind=prepared`;
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
  function position(e: PointerEvent) { const box = canvas.current!.getBoundingClientRect(); return [(e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height]; }
  function showLoupe(index: number, point: number[]) {
    const box = canvas.current!.getBoundingClientRect(), view = viewport.current!.getBoundingClientRect();
    const x = box.left + point[0] * box.width, inset = 10;
    // Fingers and hands reach in from below, so use the top of the visible
    // photo on the opposite side from the corner.
    setLoupe({
      index, width: box.width, height: box.height,
      left: x < view.left + view.width / 2 ? Math.min(view.right, innerWidth) - LOUPE_SIZE - inset : Math.max(view.left, 0) + inset,
      top: Math.min(Math.max(view.top, 0) + inset, innerHeight - LOUPE_SIZE - inset),
    });
  }
  function remember() { history.current = [...history.current.slice(-49), points]; setUndoCount(history.current.length); }
  function undo() {
    const previous = history.current.pop(); setUndoCount(history.current.length);
    if (previous) setPoints(previous);
  }
  function center() {
    const view = viewport.current, polygon = region?.polygon;
    if (centered.current || !view || !canvas.current || !polygon?.length || zoom <= 1) return;
    centered.current = true;
    const box = canvas.current.getBoundingClientRect();
    const x = polygon.reduce((sum, p) => sum + p[0], 0) / polygon.length, y = polygon.reduce((sum, p) => sum + p[1], 0) / polygon.length;
    view.scrollTo(x * box.width - view.clientWidth / 2, y * box.height - view.clientHeight / 2);
  }
  // Two fingers zoom the photo around the point between them instead of placing a corner.
  const fingers = useRef(new Set<number>());
  const pinch = useRef<{ distance: number; zoom: number; fx: number; fy: number; mx: number; my: number; height: number } | null>(null);
  const pinchScroll = useRef<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const target = pinchScroll.current; pinchScroll.current = null;
    if (target) viewport.current?.scrollTo(target.left, target.top);
  }, [zoom]);
  useEffect(() => {
    const view = viewport.current;
    if (!view) return;
    const spread = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const begin = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !canvas.current) return;
      const box = canvas.current.getBoundingClientRect(), frame = view.getBoundingClientRect();
      const x = (event.touches[0].clientX + event.touches[1].clientX) / 2, y = (event.touches[0].clientY + event.touches[1].clientY) / 2;
      pinch.current = { distance: spread(event.touches) || 1, zoom: zoomRef.current, fx: (x - box.left) / box.width, fy: (y - box.top) / box.height, mx: x - frame.left, my: y - frame.top, height: box.height / zoomRef.current };
    };
    const change = (event: TouchEvent) => {
      const start = pinch.current;
      if (!start || event.touches.length !== 2) return;
      event.preventDefault();
      const next = Math.max(1, Math.min(4, start.zoom * spread(event.touches) / start.distance));
      pinchScroll.current = { left: start.fx * view.clientWidth * next - start.mx, top: start.fy * start.height * next - start.my };
      setZoom(next); setLoupe(null);
    };
    // The second finger of a pinch is not captured, so if it lifts outside the canvas its pointer id would otherwise linger and make every later tap look like a multi-touch.
    const end = (event: TouchEvent) => { if (event.touches.length < 2) pinch.current = null; if (event.touches.length === 0) fingers.current.clear(); };
    const lift = (event: globalThis.PointerEvent) => { fingers.current.delete(event.pointerId); };
    view.addEventListener("touchstart", begin, { passive: true });
    view.addEventListener("touchmove", change, { passive: false });
    view.addEventListener("touchend", end); view.addEventListener("touchcancel", end);
    window.addEventListener("pointerup", lift); window.addEventListener("pointercancel", lift);
    return () => { view.removeEventListener("touchstart", begin); view.removeEventListener("touchmove", change); view.removeEventListener("touchend", end); view.removeEventListener("touchcancel", end); window.removeEventListener("pointerup", lift); window.removeEventListener("pointercancel", lift); };
  }, []);
  function start(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "touch") fingers.current.add(e.pointerId);
    if (fingers.current.size > 1) { stop(true); return; }
    if (busy || e.button > 0) return;
    const pointer = position(e), box = canvas.current!.getBoundingClientRect();
    const handle = (e.target as Element).closest<HTMLElement>("[data-corner]");
    let index = handle ? Number(handle.dataset.corner) : -1;
    if (index < 0) index = points.findIndex((p) => Math.hypot((p[0] - pointer[0]) * box.width, (p[1] - pointer[1]) * box.height) < 24);
    // Only a corner that is actually added or dragged earns an undo entry.
    if (index < 0 && points.length >= 4) return;
    let next = points;
    remember();
    if (index < 0) {
      index = points.length; next = [...points, [clamp(pointer[0]), clamp(pointer[1])]]; setPoints(next);
    }
    // Keep the grab offset so the corner moves with the finger instead of jumping beneath it.
    dragging.current = { index, offset: [next[index][0] - pointer[0], next[index][1] - pointer[1]], added: index === points.length };
    e.currentTarget.setPointerCapture(e.pointerId);
    showLoupe(index, next[index]);
  }
  function move(e: PointerEvent<HTMLDivElement>) {
    const drag = dragging.current;
    if (busy || !drag) return;
    const pointer = position(e), next = [clamp(pointer[0] + drag.offset[0]), clamp(pointer[1] + drag.offset[1])];
    setPoints((current) => current.map((p, i) => i === drag.index ? next : p));
    showLoupe(drag.index, next);
  }
  function stop(cancelled: boolean) {
    const drag = dragging.current;
    dragging.current = null; setLoupe(null);
    // A touch that turns into scrolling should not leave a stray corner behind.
    if (cancelled && drag?.added) setPoints((current) => current.filter((_, i) => i !== drag.index));
    // A tap that did not move a corner leaves nothing to undo.
    const before = history.current[history.current.length - 1];
    if (drag && before && (drag.added ? cancelled : JSON.stringify(before) === JSON.stringify(points))) { history.current.pop(); setUndoCount(history.current.length); }
  }
  function nudge(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const delta = KEY_STEPS[e.key];
    if (!delta) return;
    e.preventDefault(); if (busy) return;
    if (!e.repeat) remember();
    const step = e.shiftKey ? 10 : 1, point = points[index], next = [clamp(point[0] + delta[0] * step), clamp(point[1] + delta[1] * step)];
    setPoints((current) => current.map((p, i) => i === index ? next : p));
    showLoupe(index, next);
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
    <p>Tap around the four corners in either direction, starting at any corner. Drag a corner to refine it; a magnifier shows the spot under your finger. Use arrow keys when a corner is focused; hold Shift for larger adjustments.</p>
    {recovery && <div className="scan-recovery" aria-label="Recovered outline draft"><div><strong>Your unfinished outline is available</strong><p>Restore your corners, then check the photo before saving.</p></div><div className="actions"><button className="button primary" disabled={busy} onClick={() => { setPoints(recovery.points); setSavedUncertain(!!region && recovery.version !== region.version); setVersion(region?.version); setRecovery(null); }}>Restore outline</button><button className="text-button" disabled={busy} onClick={() => { removeDraft(recoveryKey); setRecovery(null); }}>Discard outline draft</button></div></div>}
    <div className="crop-precision-tools" role="group" aria-label="Crop magnification"><button className="button secondary" disabled={busy || zoom <= 1} onClick={() => setZoom((value) => Math.max(1, Math.ceil(value) - 1))}>− Zoom out</button><span aria-live="polite">{Math.round(zoom * 10) / 10}×</span><button className="button secondary" disabled={busy || zoom >= 4} onClick={() => setZoom((value) => Math.min(4, Math.floor(value) + 1))}>+ Zoom in</button><button className="text-button" disabled={busy} onClick={() => { setZoom(1); canvas.current?.parentElement?.scrollTo(0, 0); }}>Fit photo</button></div>
    {savedUncertain && <p className="message" role="status">The saved outline changed. Your corners are preserved; review them before saving again.</p>}
    <div className="crop-viewport" ref={viewport} tabIndex={0} role="region" aria-label="Photo outline. Scroll when enlarged." onScroll={() => setLoupe(null)}>
    <div className="crop-canvas" ref={canvas} onPointerDown={start} onPointerMove={move} onPointerUp={(e) => { fingers.current.delete(e.pointerId); stop(false); }} onPointerCancel={(e) => { fingers.current.delete(e.pointerId); stop(true); }}
      style={{ width: `${zoom * 100}%`, touchAction: "pan-x pan-y" }}>
      <img src={photo} alt="Tap around one card in your photo" draggable={false} onLoad={center} />
      <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true"><polygon points={points.map((p) => p.join(",")).join(" ")} /></svg>
      {points.map((p, i) => <button type="button" key={i} className="crop-handle" data-corner={i} data-x={p[0]} data-y={p[1]} data-active={loupe?.index === i || undefined}
        style={{ left: `${p[0] * 100}%`, top: `${p[1] * 100}%` }} aria-label={`Corner ${i + 1}; use arrow keys to adjust`}
        onKeyDown={(e) => nudge(e, i)} onBlur={() => { if (!dragging.current) setLoupe(null); }}><span>{i + 1}</span></button>)}
    </div>
    </div>
    {loupe && points[loupe.index] && <div className="crop-loupe" aria-hidden="true" style={{ left: loupe.left, top: loupe.top, width: LOUPE_SIZE, height: LOUPE_SIZE }}>
      {(() => {
        // Magnify less once the photo itself is zoomed; it already shows more detail.
        const scale = Math.max(2, 4 / zoom), point = points[loupe.index];
        return <div className="crop-loupe-content" style={{ width: loupe.width * scale, height: loupe.height * scale,
          transform: `translate(${LOUPE_SIZE / 2 - point[0] * loupe.width * scale}px, ${LOUPE_SIZE / 2 - point[1] * loupe.height * scale}px)` }}>
          <img src={photo} alt="" draggable={false} />
          <svg viewBox="0 0 1 1" preserveAspectRatio="none">{["halo", "edge"].map((kind) => <polygon key={kind} className={kind} points={points.map((p) => p.join(",")).join(" ")} />)}</svg>
        </div>;
      })()}
    </div>}
    {localSaved !== null && <p className="scan-local-status" role="status">{localSaved ? "Unfinished corners saved on this device." : "This browser could not save your outline draft. Keep this page open until you save."}</p>}
    <div className="actions"><button className="button primary" disabled={busy || !!recovery || points.length !== 4} onClick={() => void save()}>{busy ? "Saving outline…" : "Save outline & identify"}</button><button className="button secondary" disabled={busy || !!recovery || !undoCount} onClick={undo}>Undo last corner</button><button className="text-button" disabled={busy} onClick={() => { remember(); removeDraft(recoveryKey); setRecovery(null); setPoints([]); setSavedUncertain(false); }}>Start outline over</button><button className="text-button" disabled={busy} onClick={() => { removeDraft(recoveryKey); onCancel(); }}>Cancel outline</button></div>
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
  </section>;
}
