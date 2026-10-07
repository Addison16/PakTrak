import { useState } from "react";
import type { Deck } from "./deckTypes";
import StoreButtons, { ReferralNote } from "./StoreButtons";
import { storeList, withReferral, type Store, type StoreLinks } from "./storeLinks";

const stores: string[] = ["cardkingdom", "tcgplayer", "manapool"];

export default function DeckBuyList({ deck, busy, links, onRefresh }: { deck: Deck; busy: boolean; links?: StoreLinks; onRefresh: () => void }) {
  const [format, setFormat] = useState("cardkingdom");
  const [message, setMessage] = useState("");
  const text = storeList(format, deck.missing_cards, deck.match_mode === "exact");
  return <section className="deck-buy-list" aria-label="Missing cards buy list">
    <div className="section-heading"><h3>{deck.missing_copies ? `Buy list · ${deck.missing_copies} missing copies` : "You have every card for this deck"}</h3><button className="text-button" disabled={busy} onClick={onRefresh}>Refresh collection comparison</button></div>
    {deck.missing_copies > 0 && <>
      <label>Buy list format<select value={format} onChange={(e) => { setFormat(e.target.value); setMessage(""); }}><option value="cardkingdom">Card Kingdom · text</option><option value="tcgplayer">TCGplayer · text</option><option value="manapool">ManaPool · text</option><option value="text">Plain text · quantity and name</option><option value="csv">Detailed CSV</option></select></label>
      {format !== "csv" && <label>Missing cards to copy<textarea readOnly rows={Math.min(8, Math.max(3, deck.missing_cards.length))} value={text} onFocus={(e) => e.target.select()} /></label>}
      <div className="actions"><a className="button primary" href={`/api/v1/decks/${deck.id}/buy-list?format=${format}`}>Download buy list</a>
        {format !== "csv" && <button className="button secondary" onClick={() => { void navigator.clipboard?.writeText(text).then(() => setMessage("Buy list copied."), () => setMessage("Select the list above and use Copy on your phone.")); if (!navigator.clipboard) setMessage("Select the list above and use Copy on your phone."); }}>Copy buy list</button>}</div>
      {stores.includes(format) && <StoreButtons stores={[format as Store]} cards={deck.missing_cards} exact={deck.match_mode === "exact"} links={links} />}
      {format === "cardkingdom" && <p className="fine">Paste into <a href={withReferral("cardkingdom", "https://www.cardkingdom.com/builder", links)} target="_blank" rel="noreferrer">Card Kingdom’s deck builder</a>, then choose editions, finishes and conditions.</p>}
      {format === "tcgplayer" && <p className="fine">Paste into <a href={withReferral("tcgplayer", "https://www.tcgplayer.com/massentry", links)} target="_blank" rel="noreferrer">TCGplayer’s Mass Entry</a> and select Magic: The Gathering. {deck.match_mode === "exact" ? "Set codes and collector numbers are included; check the matched editions." : "Choose your preferred printings in the store."} Review finishes and conditions before buying.</p>}
      {format === "manapool" && <p className="fine">Paste into <a href={withReferral("manapool", "https://manapool.com/add-deck", links)} target="_blank" rel="noreferrer">ManaPool’s mass entry</a>. {deck.match_mode === "exact" ? "Set codes and collector numbers are included." : "Choose your preferred printings in the store."} Review finishes and conditions before buying.</p>}
      {format === "csv" && <p className="fine">Missing quantities and card names, with printing identifiers when exact-printing matching is selected.</p>}
      {message && <p className="fine" role="status">{message}</p>}
      {stores.includes(format) && <ReferralNote links={links} />}
    </>}
    <p className="fine">Each owned copy counts once across this deck’s sections. Copies are not reserved across other decks. All finishes count toward ownership.</p>
  </section>;
}
