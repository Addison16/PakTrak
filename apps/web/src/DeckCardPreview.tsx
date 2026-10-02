import { useEffect, useRef } from "react";
import { CardArt } from "./CardDetail";
import CardArrival, { type CardFlightOrigin } from "./CardArrival";
import { sections, type DeckCard } from "./deckTypes";

export default function DeckCardPreview({ card, origin, position, total, onPrevious, onNext, onClose }: {
  card: DeckCard; origin?: CardFlightOrigin | null; position: number; total: number; onPrevious: () => void; onNext: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const art = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    const overflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = overflow; };
  }, []);
  return <dialog ref={dialog} className="card-dialog deck-preview-dialog" aria-labelledby="deck-preview-title" onClose={onClose}>
    <div className="dialog-heading"><span className="eyebrow">{sections[card.section]} · {position + 1} of {total}</span><button autoFocus className="text-button" onClick={() => dialog.current?.close()} aria-label="Close deck card preview">Close ×</button></div>
    <div ref={art} className="deck-preview-art"><CardArt url={card.printing.image_url} name={card.printing.name} eager /></div>
    <CardArrival origin={origin} cardKey={card.printing.id + "_" + card.section} targetRef={art} dialogRef={dialog} />
    <h2 id="deck-preview-title">{card.printing.name}</h2>
    <p className="fine">{card.printing.set_name || card.printing.set_code.toUpperCase()} · #{card.printing.collector_number} · {card.printing.language.toUpperCase()}</p>
    <p className={card.missing ? "row-error" : "deck-card-owned"}>Need {card.quantity} · Have {card.available} · Missing {card.missing}</p>
    <p className="card-location"><strong>Find it:</strong> {card.locations.length ? card.locations.map((location) => `${location.name} (${location.quantity})`).join(" · ") : "No matching copies in your collection"}</p>
    <div className="deck-preview-navigation"><button className="button secondary" disabled={position === 0} onClick={onPrevious}>← Previous</button><button className="button secondary" disabled={position === total - 1} onClick={onNext}>Next →</button></div>
  </dialog>;
}
