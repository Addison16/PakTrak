import { useEffect, useRef, useState } from "react";
import { money, request, type CollectionCard as Card, type DataFeed, type Location, type Printing, type Session } from "./api";
import CollectionCard from "./CollectionCard";
import CardArrival, { type CardFlightOrigin } from "./CardArrival";

type Face = { name?: string; mana_cost?: string; type_line?: string; oracle_text?: string; flavor_text?: string; artist?: string; power?: string; toughness?: string; loyalty?: string; defense?: string; image_url: string | null };
type Detail = { printing: Printing; faces: Face[]; legalities: Record<string, string>; released_at: string | null; scryfall_url: string | null; prices: { provider: string; name: string; kind: string; feed: DataFeed | null; finishes: { finish: string; amount: string; available: boolean | null; url: string | null }[] }[] };
export const finishes: Record<string, string> = { nonfoil: "Nonfoil", foil: "Foil", etched: "Etched foil", unknown: "Unknown finish" };

export function CardArt({ url, fallbackUrl, name, eager = false }: { url?: string | null; fallbackUrl?: string | null; name: string; eager?: boolean }) {
  const [decodedUrl, setDecodedUrl] = useState(fallbackUrl || url);
  const [failed, setFailed] = useState(false);
  const source = fallbackUrl && decodedUrl !== url ? fallbackUrl : url;
  useEffect(() => {
    if (!fallbackUrl || !url || url === fallbackUrl) return;
    let stopped = false;
    const image = new Image();
    image.src = url;
    // Retain the painted thumbnail while its larger version loads and decodes.
    // A failed detail request can still use the valid cached artwork.
    void image.decode().then(() => { if (!stopped) setDecodedUrl(url); }).catch(() => {});
    return () => { stopped = true; };
  }, [url, fallbackUrl]);
  useEffect(() => setFailed(false), [source]);
  return <div className="card-art">{source && !failed ? <img src={source} alt={name} loading={eager ? "eager" : "lazy"} decoding="async" width={488} height={680} onError={() => setFailed(true)} /> : <div className="art-placeholder"><span aria-hidden="true">✧</span><strong>{name}</strong><small>Artwork unavailable</small></div>}</div>;
}

export default function CardDetail({ card, origin, binder, locations, session, onSaved, onCorrected, onClose, onStep }: { card: Card; origin?: CardFlightOrigin | null; binder: string; locations: Location[]; session: Session; onSaved: () => Promise<void>; onCorrected: () => Promise<void>; onClose: () => void; onStep?: (delta: number) => (() => void) | null }) {
  const swipe = useRef<{ id: number; x: number; y: number } | null>(null);
  const previous = onStep?.(-1), next = onStep?.(1);
  const dialog = useRef<HTMLDialogElement>(null);
  const art = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [faceIndex, setFaceIndex] = useState(0);
  const [finish, setFinish] = useState(card.printing.finishes[0] || "nonfoil");
  const [error, setError] = useState("");
  useEffect(() => {
    const modal = dialog.current;
    const launcher = origin?.source.closest<HTMLElement>("button") || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    modal?.showModal();
    const old = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = old;
      // Removing an open dialog during Back navigation leaves focus on body.
      // Only restore a visible launcher when another control has not taken it.
      let attempts = 0;
      const restoreLauncher = () => {
        const focused = document.activeElement;
        if (!launcher?.isConnected || !launcher.getClientRects().length || (focused !== document.body && !modal?.contains(focused))) return;
        launcher.focus({ preventScroll: true });
        // Give the browser's native top layer a frame to release focus if its
        // cleanup follows React's unmount effects.
        if (document.activeElement !== launcher && ++attempts < 3) requestAnimationFrame(restoreLauncher);
      };
      restoreLauncher();
    };
  }, []);
  useEffect(() => {
    let stopped = false;
    request<Detail>("/api/v1/collection/printings/" + card.printing.id).then((value) => { if (!stopped) setDetail(value); }).catch((e: Error) => { if (!stopped) setError(e.message); });
    return () => { stopped = true; };
  }, [card.printing.id]);
  const face = detail?.faces[faceIndex];
  return <dialog ref={dialog} className="card-dialog" aria-labelledby="card-detail-title" onClose={onClose} onClick={(event) => { if (event.target === dialog.current) { const box = dialog.current.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.current.close(); } }}>
    <div className="dialog-heading"><span className="eyebrow">In your collection</span>{onStep && <span className="card-step"><button type="button" className="text-button" aria-label="Previous card" disabled={!previous} onClick={() => previous?.()}>←</button><button type="button" className="text-button" aria-label="Next card" disabled={!next} onClick={() => next?.()}>→</button></span>}<button autoFocus className="text-button" aria-label="Close card details" onClick={() => dialog.current?.close()}>Close <span aria-hidden="true">×</span></button></div>
    <div className="card-detail-layout"><div ref={art} className="detail-art"
      onPointerDown={(e) => { swipe.current = e.pointerType === "mouse" || !e.isPrimary ? null : { id: e.pointerId, x: e.clientX, y: e.clientY }; }}
      onPointerCancel={() => { swipe.current = null; }}
      onPointerUp={(e) => {
        const start = swipe.current; swipe.current = null;
        if (!start || start.id !== e.pointerId) return;
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (Math.abs(dx) >= 50 && Math.abs(dx) >= Math.abs(dy) * 1.5) (dx < 0 ? next : previous)?.();
      }}><CardArt url={face ? face.image_url : card.printing.image_url} fallbackUrl={faceIndex === 0 ? card.printing.image_url : undefined} name={face?.name || card.printing.name} eager />
      {detail && detail.faces.length > 1 && <button className="button secondary" onClick={() => setFaceIndex((faceIndex + 1) % detail.faces.length)}>View {faceIndex === 0 ? "other" : "front"} face</button>}
      {face?.artist && <p className="fine artist-credit">Illustrated by {face.artist}</p>}
    </div><div className="detail-copy"><h2 id="card-detail-title">{face?.name || card.printing.name}</h2><p className="detail-type">{face?.type_line || card.printing.type_line}</p>
      {face?.mana_cost && <p className="mana-cost" aria-label="Mana cost">{face.mana_cost}</p>}
      {error && <p className="message error">{error}</p>}
      {!detail && !error && <p role="status">Loading card details…</p>}
      {face?.oracle_text && <p className="oracle-text">{face.oracle_text}</p>}
      {face?.flavor_text && <p className="flavor-text">{face.flavor_text}</p>}
      {face?.power != null && <p className="card-stats">{face.power} / {face.toughness}</p>}
      {face?.loyalty != null && <p className="card-stats">Loyalty {face.loyalty}</p>}
      {face?.defense != null && <p className="card-stats">Defense {face.defense}</p>}
      <p className="fine">{card.printing.set_name} · #{card.printing.collector_number} · <span className="rarity-text">{card.printing.rarity}</span> · {card.printing.language.toUpperCase()}</p>
      {detail?.released_at && <p className="fine">Released {detail.released_at}</p>}
      {detail?.scryfall_url && <a className="text-button" href={detail.scryfall_url} target="_blank" rel="noopener noreferrer">View on Scryfall ↗</a>}
    </div></div>
    {detail && <section className="price-section" aria-label="Price comparison"><div className="section-heading"><h3>Price guide</h3><span className="fine">USD · per copy</span></div>
      <div className="finish-tabs" aria-label="Price finish">{card.printing.finishes.map((value) => <button className="filter-chip" key={value} aria-pressed={finish === value} onClick={() => setFinish(value)}>{finishes[value] || value}</button>)}</div>
      <div className="price-comparison">{detail.prices.map((source) => { const price = source.finishes.find((item) => item.finish === finish); return <div className="provider-price" key={source.provider}><strong>{source.name}</strong><span className="price-amount">{money(price?.amount)}</span><span className="fine">{source.kind}</span>
        {!price && <span className="fine">No price for this finish</span>}
        {price?.available === false && <span className="fine">Near mint out of stock</span>}
        <span className={source.feed?.stale ? "fine stale-price" : "fine"}>{source.feed?.updated_at ? `${source.feed.stale ? "Older data · " : "Saved "}${new Date(source.feed.updated_at).toLocaleString()}` : "Awaiting first update"}</span>
        {price?.url && <a className="text-button" href={price.url} target="_blank" rel="noopener noreferrer">View listing ↗</a>}
      </div>; })}</div>
      <p className="fine">Daily reference prices, before shipping and tax. Condition can change a copy’s value. Your collection total uses recorded finishes; unknown finishes, altered cards and misprints are left unpriced.</p>
    </section>}
    <section aria-label="Owned copies"><h3>Your copies & locations</h3><ul className="plain-list holdings"><CollectionCard card={card} binder={binder} locations={locations} session={session} onSaved={onSaved} onCorrected={onCorrected} /></ul></section>
    {detail && <details><summary>Format legality</summary><div className="legality-grid">{Object.entries(detail.legalities).filter(([name]) => ["standard", "pioneer", "modern", "legacy", "vintage", "commander", "pauper", "brawl"].includes(name)).map(([name, value]) => <div key={name}><span>{name}</span><span className={value === "legal" ? "legal" : ""}>{value.replaceAll("_", " ")}</span></div>)}</div><p className="fine">Card information and legality from Scryfall’s saved catalog.</p></details>}
    <CardArrival origin={origin} cardKey={faceIndex === 0 ? card.printing.id : `${card.printing.id}:face:${faceIndex}`} targetRef={art} dialogRef={dialog} />
  </dialog>;
}
