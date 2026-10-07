import { useState } from "react";
import type { DeckCard } from "./deckTypes";
import "./social.css";

type StatCard = Pick<DeckCard, "printing" | "quantity" | "section">;
const isLand = (card: StatCard) => /\bLand\b/.test((card.printing.type_line || "").split("//")[0]);
const LABELS = ["0", "1", "2", "3", "4", "5", "6", "7+"];

function shuffle<T>(items: T[]) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const pick = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[pick]] = [copy[pick], copy[index]];
  }
  return copy;
}

/** Mana curve for the main deck and commander, and a sample opening hand from the main deck. */
export default function DeckStats({ cards }: { cards: StatCard[] }) {
  const counted = cards.filter((card) => card.section !== "sideboard");
  const spells = counted.filter((card) => !isLand(card));
  const lands = counted.filter(isLand).reduce((sum, card) => sum + card.quantity, 0);
  const curve = LABELS.map(() => 0);
  let unknown = 0, total = 0, copies = 0;
  for (const card of spells) {
    const cmc = card.printing.cmc;
    if (cmc == null) { unknown += card.quantity; continue; }
    curve[Math.min(7, Math.floor(cmc))] += card.quantity;
    total += cmc * card.quantity; copies += card.quantity;
  }
  const tallest = Math.max(1, ...curve);
  const library = counted.filter((card) => card.section === "main").flatMap((card) => Array.from({ length: card.quantity }, (_, copy) => ({ ...card, key: `${card.printing.id}:${copy}` })));
  const [hand, setHand] = useState<typeof library | null>(null);
  const [drawn, setDrawn] = useState(0);
  const [size, setSize] = useState(7);
  const [deckOrder, setDeckOrder] = useState<typeof library>([]);

  function draw(count: number) {
    const order = shuffle(library);
    setDeckOrder(order); setHand(order.slice(0, count)); setSize(count); setDrawn(0);
  }
  if (!counted.length) return null;
  return <section className="deck-stats" aria-label="Mana curve and sample hand">
    <h3>Mana curve</h3>
    <div className="mana-curve" role="img" aria-label={`Mana curve: ${curve.map((count, index) => `${count} at ${LABELS[index]}`).join(", ")}`}>
      {curve.map((count, index) => <div key={index} className="mana-curve-bar"><span>{count || ""}</span><i style={{ height: `${(count / tallest) * 80}%` }} /></div>)}
    </div>
    <div className="mana-curve-axis" aria-hidden="true">{LABELS.map((label) => <span key={label}>{label}</span>)}</div>
    <p className="fine">Mana value of spells in the main deck and commander. {lands} {lands === 1 ? "land" : "lands"}{copies ? ` · average ${(total / copies).toFixed(2)}` : ""}{unknown ? ` · ${unknown} without a mana value` : ""}.</p>

    {library.length >= 7 && <>
      <h3>Sample hand</h3>
      <div className="actions">
        <button type="button" className="button secondary" onClick={() => draw(7)}>{hand ? "New hand" : "Draw a sample hand"}</button>
        {hand && size > 1 && <button type="button" className="button secondary" onClick={() => draw(size - 1)}>Mulligan to {size - 1}</button>}
        {hand && size + drawn < library.length && <button type="button" className="text-button" onClick={() => { setDrawn(drawn + 1); setHand(deckOrder.slice(0, size + drawn + 1)); }}>Draw a card</button>}
      </div>
      {hand && <>
        <p className="fine" role="status">{hand.length} cards · {hand.filter(isLand).length} {hand.filter(isLand).length === 1 ? "land" : "lands"}{drawn ? ` · ${drawn} drawn` : ""}</p>
        <div className="sample-hand">{hand.map((card) => <figure key={card.key}>
          {card.printing.image_url ? <img src={card.printing.image_url} alt={card.printing.name} loading="lazy" /> : <span className="printing-art-placeholder" aria-hidden="true" />}
          <figcaption>{card.printing.name}</figcaption>
        </figure>)}</div>
      </>}
    </>}
  </section>;
}
