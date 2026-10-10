import { useState } from "react";
import type { DeckCard } from "./deckTypes";
import "./social.css";

type StatCard = Pick<DeckCard, "printing" | "quantity" | "section">;
const isLand = (card: StatCard) => /\bLand\b/.test((card.printing.type_line || "").split("//")[0]);
const LABELS = ["0", "1", "2", "3", "4", "5", "6", "7+"];
const COLORS: [string, string][] = [["W", "White"], ["U", "Blue"], ["B", "Black"], ["R", "Red"], ["G", "Green"]];
const TYPES: [string, string][] = [["Creature", "Creatures"], ["Planeswalker", "Planeswalkers"], ["Battle", "Battles"], ["Instant", "Instants"], ["Sorcery", "Sorceries"], ["Artifact", "Artifacts"], ["Enchantment", "Enchantments"], ["Land", "Lands"]];
const TURNS = 7;
const percent = (value: number) => `${Math.round(value * 100)}%`;

/** Colored mana symbols in a cost; a hybrid symbol counts toward each of its colors. */
function pips(cost: string | undefined) {
  const found: Record<string, number> = {};
  for (const [, symbol] of (cost || "").matchAll(/\{([^}]+)\}/g)) {
    for (const part of new Set(symbol.split("/"))) if ("WUBRG".includes(part) && part.length === 1) found[part] = (found[part] || 0) + 1;
  }
  return found;
}

/** Odds of seeing lands when drawing from a shuffled library (hypergeometric). */
function landOdds(size: number, lands: number) {
  const logFactorial = [0];
  for (let n = 1; n <= size; n++) logFactorial[n] = logFactorial[n - 1] + Math.log(n);
  const choose = (n: number, k: number) => logFactorial[n] - logFactorial[k] - logFactorial[n - k];
  /** Chance of exactly each land count among the first `seen` cards. */
  return (seen: number) => {
    const drawn = Math.min(seen, size), odds: number[] = [];
    for (let found = 0; found <= drawn; found++) odds.push(found > lands || drawn - found > size - lands ? 0 : Math.exp(choose(lands, found) + choose(size - lands, drawn - found) - choose(size, drawn)));
    return odds;
  };
}

function shuffle<T>(items: T[]) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const pick = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[pick]] = [copy[pick], copy[index]];
  }
  return copy;
}

/** Mana curve, land drop odds, color balance and card types for the main deck and commander, and a sample opening hand from the main deck. */
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

  const symbols: Record<string, number> = {}, sources: Record<string, number> = {};
  let manaCards = 0;
  for (const card of counted) {
    if (!isLand(card)) for (const [color, count] of Object.entries(pips(card.printing.mana_cost))) symbols[color] = (symbols[color] || 0) + count * card.quantity;
    const makes = (card.printing.produced_mana || []).filter((color) => "WUBRG".includes(color));
    if (makes.length) manaCards += card.quantity;
    for (const color of new Set(makes)) sources[color] = (sources[color] || 0) + card.quantity;
  }
  const allSymbols = Object.values(symbols).reduce((sum, count) => sum + count, 0);
  const colorRows = COLORS.filter(([color]) => symbols[color] || sources[color]).map(([color, name]) => ({ color, name, symbols: symbols[color] || 0, symbolShare: allSymbols ? (symbols[color] || 0) / allSymbols : 0, sources: sources[color] || 0, sourceShare: manaCards ? (sources[color] || 0) / manaCards : 0 }));
  const short = manaCards ? colorRows.filter((row) => row.symbols && row.symbolShare - row.sourceShare >= 0.1).sort((a, b) => (b.symbolShare - b.sourceShare) - (a.symbolShare - a.sourceShare))[0] : undefined;

  const types = TYPES.map(([type, name]) => ({ name, count: counted.filter((card) => new RegExp(`\\b${type}\\b`).test((card.printing.type_line || "").split("//")[0])).reduce((sum, card) => sum + card.quantity, 0) })).filter((row) => row.count);
  const library = counted.filter((card) => card.section === "main").flatMap((card) => Array.from({ length: card.quantity }, (_, copy) => ({ ...card, key: `${card.printing.id}:${copy}` })));
  const libraryLands = library.filter(isLand).length;
  const odds = library.length >= 8 && libraryLands ? landOdds(library.length, libraryLands) : null;
  const opening = odds?.(7);
  const turns = odds ? Array.from({ length: TURNS }, (_, index) => {
    const turn = index + 1, play = odds(7 + turn - 1), draw = odds(7 + turn);
    const atLeast = (chances: number[]) => chances.slice(turn).reduce((sum, chance) => sum + chance, 0);
    return { turn, inPlay: play.reduce((sum, chance, found) => sum + chance * Math.min(found, turn), 0), play: atLeast(play), draw: atLeast(draw) };
  }) : [];
  const [hand, setHand] = useState<typeof library | null>(null);
  const [drawn, setDrawn] = useState(0);
  const [size, setSize] = useState(7);
  const [deckOrder, setDeckOrder] = useState<typeof library>([]);

  function draw(count: number) {
    const order = shuffle(library);
    setDeckOrder(order); setHand(order.slice(0, count)); setSize(count); setDrawn(0);
  }
  if (!counted.length) return null;
  return <section className="deck-stats" aria-label="Deck stats">
    <h3>Mana curve</h3>
    <div className="mana-curve" role="img" aria-label={`Mana curve: ${curve.map((count, index) => `${count} at ${LABELS[index]}`).join(", ")}`}>
      {curve.map((count, index) => <div key={index} className="mana-curve-bar"><span>{count || ""}</span><i style={{ height: `${(count / tallest) * 80}%` }} /></div>)}
    </div>
    <div className="mana-curve-axis" aria-hidden="true">{LABELS.map((label) => <span key={label}>{label}</span>)}</div>
    <p className="fine">Mana value of spells in the main deck and commander. {lands} {lands === 1 ? "land" : "lands"}{copies ? ` · average ${(total / copies).toFixed(2)}` : ""}{unknown ? ` · ${unknown} without a mana value` : ""}.</p>

    {odds && opening && <>
      <h3>Land drops</h3>
      <p className="fine">{libraryLands} of {library.length} cards are lands. An opening hand of 7 averages {(7 * libraryLands / library.length).toFixed(1)} lands and has 2 to 4 of them {percent(opening.slice(2, 5).reduce((sum, chance) => sum + chance, 0))} of the time.</p>
      <table className="deck-odds">
        <caption className="sr-only">Chance of playing a land every turn</caption>
        <thead><tr><th scope="col">Turn</th><th scope="col">Lands in play</th><th scope="col">On the play</th><th scope="col">On the draw</th></tr></thead>
        <tbody>{turns.map((row) => <tr key={row.turn}><th scope="row">{row.turn}</th><td>{row.inPlay.toFixed(1)}</td><td>{percent(row.play)}</td><td>{percent(row.draw)}</td></tr>)}</tbody>
      </table>
      <p className="fine">Lands in play is the average mana your lands give you that turn if you play one whenever you can, before other mana sources. On the play and on the draw are the chances you had a land to play every turn so far.</p>
    </>}

    {colorRows.length > 0 && <>
      <h3>Color balance</h3>
      <div className="deck-colors">{colorRows.map((row) => <div key={row.color} className="deck-color" role="group" aria-label={`${row.name}: ${row.symbols} mana symbols, ${percent(row.symbolShare)} of all symbols. ${row.sources} cards make ${row.name.toLowerCase()} mana.`}>
        <strong>{row.name}</strong>
        <span>Symbols</span><span className="deck-color-bar" aria-hidden="true"><i style={{ width: percent(row.symbolShare) }} /></span><span>{row.symbols ? `${row.symbols} · ${percent(row.symbolShare)}` : "None"}</span>
        <span>Sources</span><span className="deck-color-bar sources" aria-hidden="true"><i style={{ width: percent(row.sourceShare) }} /></span><span>{row.sources ? `${row.sources} · ${percent(row.sourceShare)}` : "None"}</span>
      </div>)}</div>
      <p className="fine">Symbols are the colored mana symbols in your spells' costs. Sources are lands and other cards that make that color, as a share of every card that makes colored mana.{short ? ` ${short.name} is ${percent(short.symbolShare)} of your symbols but only ${percent(short.sourceShare)} of your mana cards make it.` : ""}</p>
    </>}

    {types.length > 0 && <>
      <h3>Card types</h3>
      <dl className="deck-types">{types.map((row) => <div key={row.name}><dt>{row.name}</dt><dd>{row.count}</dd></div>)}</dl>
      <p className="fine">Cards with more than one type, like artifact creatures, count once for each.</p>
    </>}

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
