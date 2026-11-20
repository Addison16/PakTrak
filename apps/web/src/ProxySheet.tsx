import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Printing } from "./api";
import "./proxy-sheet.css";

export type ProxyCard = { printing: Printing; quantity: number };
const PER_PAGE = 9, MOST = 180;

/** A print-ready page of stand-in cards at real card size, nine to a sheet, for cards not owned yet. */
export default function ProxySheet({ title, cards, onClose }: { title: string; cards: ProxyCard[]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [loaded, setLoaded] = useState(0);
  const copies = cards.flatMap((card) => Array.from({ length: card.quantity }, () => card.printing));
  const shown = copies.slice(0, MOST);
  const pictures = shown.filter((printing) => printing.image_url).length;
  const pages = Array.from({ length: Math.ceil(shown.length / PER_PAGE) }, (_, index) => shown.slice(index * PER_PAGE, (index + 1) * PER_PAGE));
  useEffect(() => { dialog.current?.showModal(); }, []);
  // Printing hides the rest of the app only while this sheet is open.
  useEffect(() => { document.documentElement.dataset.printing = "proxies"; return () => { delete document.documentElement.dataset.printing; }; }, []);
  const ready = loaded >= pictures;
  return createPortal(<dialog ref={dialog} className="proxy-sheet" aria-labelledby="proxy-sheet-title" onClose={onClose}>
    <div className="proxy-sheet-bar">
      <div><h2 id="proxy-sheet-title">Print proxies</h2><p className="fine">{shown.length} {shown.length === 1 ? "card" : "cards"} on {pages.length} {pages.length === 1 ? "page" : "pages"} for {title}{copies.length > MOST ? `. The first ${MOST} of ${copies.length} are shown; print the rest from a smaller list` : ""}.</p></div>
      <div className="actions"><button type="button" className="button primary" disabled={!ready} onClick={() => window.print()}>{ready ? "Print" : `Loading pictures… ${loaded} / ${pictures}`}</button><button type="button" className="button secondary" onClick={() => dialog.current?.close()}>Close</button></div>
      <p className="fine">Print at 100% scale (“Actual size”), not “Fit to page”, so the cards come out at real size. Stand-in cards are for casual games and testing a deck before buying; they aren’t allowed in sanctioned events. Two-sided cards print their front.</p>
    </div>
    {pages.map((page, index) => <div className="proxy-page" key={index}>{page.map((printing, slot) => <div className="proxy-card" key={slot}>
      {printing.image_url ? <img src={printing.image_url.replace(/\/grid$/, "/detail")} alt={printing.name} onLoad={() => setLoaded((count) => count + 1)} onError={() => setLoaded((count) => count + 1)} />
        : <div className="proxy-card-text"><strong>{printing.name}</strong><span>{printing.mana_cost}</span><span>{printing.type_line}</span><small>{printing.set_code.toUpperCase()} #{printing.collector_number}</small></div>}
    </div>)}</div>)}
  </dialog>, document.body);
}
