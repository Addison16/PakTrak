import { useEffect, useState, type CSSProperties } from "react";
import type { DeckCover, DeckSummary } from "./deckTypes";

const mana: Record<string, { name: string; paint: string; pip: string; ink: string }> = {
  W: { name: "White", paint: "#a89b7d", pip: "#eee2bf", ink: "#493f29" },
  U: { name: "Blue", paint: "#2c526b", pip: "#bed8e5", ink: "#1f4257" },
  B: { name: "Black", paint: "#39333f", pip: "#c6bfcd", ink: "#352c3e" },
  R: { name: "Red", paint: "#813f35", pip: "#e5b49a", ink: "#612f25" },
  G: { name: "Green", paint: "#2c5143", pip: "#bfd1ae", ink: "#314c35" },
  C: { name: "Colorless", paint: "#4d5a59", pip: "#d4dbd6", ink: "#354744" },
};

const manaPaths: Record<string, string> = {
  W: "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5",
  U: "M12 2C10 6 5 11 5 15a7 7 0 0 0 14 0c0-4-5-9-7-13ZM8 15a4 4 0 0 0 4 4",
  B: "M7 16H5v-5a7 7 0 0 1 14 0v5h-2v5H7v-5ZM8 10v3m8-3v3m-6 5v3m4-3v3m-3-6 1-1 1 1",
  R: "M13 2c2 7-5 7-3 12 2 0 4-2 5-5 3 3 5 5 5 8a8 8 0 0 1-16 0c0-5 4-7 4-11 1 2 2 3 2 4 3-3 3-5 3-8Z",
  G: "M20 3C9 2 3 7 4 13c1 6 8 8 12 4 3-3 4-7 4-14ZM3 21 16 8M9 15v-5m0 5h5",
  C: "m12 2 8 10-8 10-8-10 8-10Z",
};

function ManaMark({ color }: { color: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={manaPaths[color]} /></svg>;
}

function BoxMark({ commander }: { commander: boolean }) {
  return <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" focusable="false">{commander
    ? <><path d="m12 22 10 9 10-17 10 17 10-9-6 24H18Z" /><path d="M18 51h28M26 40h12" /></>
    : <><rect x="19" y="12" width="31" height="42" rx="4" /><path d="M14 18h-1a4 4 0 0 0-4 4v31a5 5 0 0 0 5 5h25" /><path d="m34 24 7 9-7 9-7-9Z" /></>}</svg>;
}

function CoverArt({ card, commander }: { card: DeckCover; commander: boolean }) {
  const src = card.art_url || card.image_url;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return <span className="deck-box-image" title={card.name}>
    <span className="deck-box-mark"><BoxMark commander={commander} /></span>
    {src && !failed && <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />}
  </span>;
}

export default function DeckBox({ deck, busy, onOpen }: { deck: DeckSummary; busy: boolean; onOpen: () => void }) {
  const commander = deck.format === "commander";
  const previews = deck.preview_cards || [];
  const covers = deck.cover_cards ?? (commander ? previews.filter((card) => card.section === "commander").slice(0, 2) : previews.slice(0, 1));
  const colors = ["W", "U", "B", "R", "G"].filter((color) => deck.colors?.includes(color));
  const paints = (colors.length ? colors : ["C"]).map((color) => mana[color].paint);
  const colorName = colors.length ? colors.map((color) => mana[color].name).join(" / ") : deck.colors_known === false ? "Colors unavailable" : "Colorless";
  const coverName = covers.length ? `${commander ? "Commander" : "Featured card"}: ${covers.map((card) => card.name).join(" and ")}` : commander && deck.copies ? "Commander not set" : "No cover card yet";
  const description = `${deck.name}, ${deck.format}, ${deck.copies || 0} cards, ${colorName}. ${coverName}.`;
  const paint = paints.length === 1 ? paints[0] : `linear-gradient(125deg, ${paints.join(", ")})`;
  return <button className="deck-box-button" data-deck-id={deck.id} data-deck-colors={colors.join("") || "C"} disabled={busy} onClick={onOpen} aria-label={`Open ${description}`} title={description}>
    <span className="deck-box" style={{ "--deck-paint": paint } as CSSProperties} aria-hidden="true">
      <span className="deck-box-front">
        <span className="deck-box-seam"><span className="deck-box-stamp"><BoxMark commander={commander} /><span>PakTrak</span></span></span>
        <span className="deck-box-cover" data-count={covers.length}>{covers.length
          ? covers.map((card) => <CoverArt key={card.id} card={card} commander={commander} />)
          : <span className="deck-box-mark"><BoxMark commander={commander} /></span>}</span>
        <span className="deck-box-colors">{(colors.length ? colors : ["C"]).map((color) => <span key={color} className="deck-mana-pip" style={{ backgroundColor: mana[color].pip, color: mana[color].ink }}><ManaMark color={color} /></span>)}</span>
      </span>
    </span>
    <span className="deck-box-label"><strong>{deck.name}</strong><span className="deck-box-meta"><span className="deck-box-format">{deck.format}</span><span className="deck-box-count">{deck.copies || 0} cards</span></span></span>
  </button>;
}
