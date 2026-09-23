import ErrorNotice from "./ErrorNotice";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { mutation, request, type Session } from "./api";
import type { ReviewState } from "./scanTypes";

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
  const key = useRef(crypto.randomUUID());
  const dirty = JSON.stringify(points) !== JSON.stringify(region?.polygon || []);
  useEffect(() => { onStateChange({ dirty, busy }); }, [dirty, busy, onStateChange]);
  useEffect(() => () => onStateChange({ dirty: false, busy: false }), [onStateChange]);
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
      const result = await request<{ id: string }>(`/api/v1/scans/${scanId}/observations${region ? `/${region.id}/geometry` : ""}`, {
        ...mutation(session, { polygon: points, ...(region ? { expected_version: region.version } : {}) }, key.current), method: region ? "PUT" : "POST",
      }); onSaved(result.id);
    } catch (e) { setError(e as Error); }
    finally { setBusy(false); }
  }
  return <section ref={root} className="scan-crop-editor" aria-label="Card outline editor"><h3>{region ? "Adjust this card’s outline" : "Outline a missed card"}</h3>
    <p>Tap around the four corners in either direction, starting at any corner. Drag a dot to refine it. Use arrow keys when a corner is focused.</p>
    <div className="crop-canvas" ref={canvas} onPointerDown={start} onPointerMove={(e) => {
      if (dragging.current === null) return; const index = dragging.current, next = position(e);
      setPoints((current) => current.map((p, i) => i === index ? next : p));
    }} onPointerUp={() => { dragging.current = null; }} onPointerCancel={() => { dragging.current = null; }}>
      <img src={`/api/v1/scans/${scanId}/image?kind=prepared`} alt="Tap around one card in your photo" draggable={false} />
      <svg viewBox="0 0 1 1" preserveAspectRatio="none"><polygon points={points.map((p) => p.join(",")).join(" ")} />{points.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r=".014" tabIndex={0} role="button" aria-label={`Corner ${i + 1}; use arrow keys to adjust`} onKeyDown={(e) => {
        const delta: Record<string, number[]> = { ArrowLeft: [-.002, 0], ArrowRight: [.002, 0], ArrowUp: [0, -.002], ArrowDown: [0, .002] };
        if (delta[e.key]) { e.preventDefault(); const move = delta[e.key]; setPoints((current) => current.map((point, j) => i === j ? [clamp(point[0] + move[0]), clamp(point[1] + move[1])] : point)); }
      }} />)}</svg>
    </div>
    <div className="actions"><button className="button primary" disabled={busy || points.length !== 4} onClick={() => void save()}>Save outline &amp; identify</button><button className="text-button" disabled={busy} onClick={() => setPoints([])}>Start outline over</button><button className="text-button" disabled={busy} onClick={onCancel}>Cancel outline</button></div>
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
  </section>;
}
