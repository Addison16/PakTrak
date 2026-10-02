import { useState, type ReactNode } from "react";
import type { DeckCover } from "./deckTypes";

function Artwork({ card }: { card: DeckCover }) {
  const url = card.art_url || card.image_url;
  const [failed, setFailed] = useState(false);
  return <span className="deck-hero-art-face">{url && !failed && <img src={url} alt="" decoding="async" fetchPriority="high" onError={() => setFailed(true)} />}</span>;
}

export default function DeckHero({ covers, children }: { covers: DeckCover[]; children: ReactNode }) {
  return <header className="deck-hero" data-artwork={covers.length > 0 || undefined}>
    <div className="deck-hero-art" data-count={covers.length} aria-hidden="true">{covers.map(card => <Artwork key={`${card.id}:${card.art_url || card.image_url || ""}`} card={card} />)}</div>
    <div className="deck-hero-content">{children}</div>
  </header>;
}
