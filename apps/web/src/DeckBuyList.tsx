import { useState } from "react";
import type { Deck } from "./deckTypes";

export default function DeckBuyList({ deck, busy, onRefresh }: { deck: Deck; busy: boolean; onRefresh: () => void }) {
  const [format, setFormat] = useState("cardkingdom");
  const [message, setMessage] = useState("");
  const names = new Map<string, number>();
  for (const item of deck.missing_cards) names.set(item.printing.name, (names.get(item.printing.name) || 0) + item.quantity);
  const text = (format === "manapool" || format === "tcgplayer") && deck.match_mode === "exact"
    ? deck.missing_cards.map((item) => `${item.quantity} ${item.printing.name} ${format === "tcgplayer" ? `[${item.printing.set_code.toUpperCase()}]` : `(${item.printing.set_code.toUpperCase()})`} ${item.printing.collector_number}`).join("\n")
    : [...names].sort(([a], [b]) => a.localeCompare(b)).map(([name, quantity]) => `${quantity} ${name}`).join("\n");
  return <section className="deck-buy-list" aria-label="Missing cards buy list">
    <div className="section-heading"><h3>{deck.missing_copies ? `Buy list · ${deck.missing_copies} missing copies` : "You have every card for this deck"}</h3><button className="text-button" disabled={busy} onClick={onRefresh}>Refresh collection comparison</button></div>
    {deck.missing_copies > 0 && <>
      <label>Buy list format<select value={format} onChange={(e) => { setFormat(e.target.value); setMessage(""); }}><option value="cardkingdom">Card Kingdom · text</option><option value="tcgplayer">TCGplayer · text</option><option value="manapool">ManaPool · text</option><option value="text">Plain text · quantity and name</option><option value="csv">Detailed CSV</option></select></label>
      {format !== "csv" && <label>Missing cards to copy<textarea readOnly rows={Math.min(8, Math.max(3, deck.missing_cards.length))} value={text} onFocus={(e) => e.target.select()} /></label>}
      <div className="actions"><a className="button primary" href={`/api/v1/decks/${deck.id}/buy-list?format=${format}`}>Download buy list</a>
        {format !== "csv" && <button className="button secondary" onClick={() => { void navigator.clipboard?.writeText(text).then(() => setMessage("Buy list copied."), () => setMessage("Select the list above and use Copy on your phone.")); if (!navigator.clipboard) setMessage("Select the list above and use Copy on your phone."); }}>Copy buy list</button>}</div>
      {format === "cardkingdom" && <p className="fine">Paste into <a href="https://www.cardkingdom.com/builder" target="_blank" rel="noreferrer">Card Kingdom’s deck builder</a>, then choose editions, finishes and conditions.</p>}
      {format === "tcgplayer" && <p className="fine">Paste into <a href="https://www.tcgplayer.com/massentry" target="_blank" rel="noreferrer">TCGplayer’s Mass Entry</a> and select Magic: The Gathering. {deck.match_mode === "exact" ? "Set codes and collector numbers are included; check the matched editions." : "Choose your preferred printings in the store."} Review finishes and conditions before buying.</p>}
      {format === "manapool" && <p className="fine">Paste into <a href="https://manapool.com/add-deck" target="_blank" rel="noreferrer">ManaPool’s mass entry</a>. {deck.match_mode === "exact" ? "Set codes and collector numbers are included." : "Choose your preferred printings in the store."} Review finishes and conditions before buying.</p>}
      {format === "csv" && <p className="fine">Missing quantities and card names, with printing identifiers when exact-printing matching is selected.</p>}
      {message && <p className="fine" role="status">{message}</p>}
    </>}
    <p className="fine">Each owned copy counts once across this deck’s sections. Copies are not reserved across other decks. All finishes count toward ownership.</p>
  </section>;
}
