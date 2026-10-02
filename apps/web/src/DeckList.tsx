import type { DeckSummary } from "./deckTypes";
import DeckBox from "./DeckBox";

export default function DeckList({ ownerId, decks, busy, creating, newName, offset, next, onName, onCreate, onCreating, onImport, onScan, onOpen, onPage }: {
  ownerId: string; decks: DeckSummary[]; busy: boolean; creating: boolean; newName: string; offset: number; next: number | null;
  onName: (name: string) => void; onCreate: () => void; onCreating: (value: boolean) => void;
  onImport: () => void; onScan: () => void; onOpen: (deck: DeckSummary, box: HTMLElement) => void; onPage: (offset: number) => void;
}) {
  return <section className="panel history deck-list" aria-labelledby="decks-title">
    <div className="section-heading"><div><div className="eyebrow">YOUR NEXT GAME</div><h2 id="decks-title" tabIndex={-1}>Your decks</h2></div></div>
    <p className="fine">Open a deck to browse its cards, see what you own and find what’s missing.</p>
    <div className="actions"><button className="button primary" disabled={busy} onClick={() => onCreating(!creating)}>New deck</button><button className="button secondary" disabled={busy} onClick={onScan}>Scan a deck</button><button className="button secondary" disabled={busy} onClick={onImport}>Import deck list</button></div>
    {creating && <form className="deck-create" onSubmit={(event) => { event.preventDefault(); onCreate(); }}>
      <label>New deck name<input value={newName} required maxLength={255} placeholder="Friday night deck" onChange={(event) => onName(event.target.value)} /></label>
      <div className="actions"><button className="button primary" disabled={busy || !newName.trim()}>Create deck</button><button type="button" className="text-button" disabled={busy} onClick={() => onCreating(false)}>Cancel</button></div>
    </form>}
    {decks.length === 0 && <p>{offset ? "No more decks on this page." : "No saved decks yet. Start with a name or import a card list."}</p>}
    <ul className="deck-list-rows" aria-label="Saved deck boxes">{decks.map((deck) => <li key={deck.id}><DeckBox ownerId={ownerId} deck={deck} busy={busy} onOpen={(box) => onOpen(deck, box)} /></li>)}</ul>
    {(offset > 0 || next !== null) && <div className="pagination">{offset > 0 && <button className="text-button" disabled={busy} onClick={() => onPage(Math.max(0, offset - 20))}>Previous decks</button>}{next !== null && <button className="text-button" disabled={busy} onClick={() => onPage(next)}>More decks</button>}</div>}
  </section>;
}
