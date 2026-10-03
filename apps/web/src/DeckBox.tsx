import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { DeckCover, DeckSummary } from "./deckTypes";
import { caseAppearance, DeckEmblem, defaultPresentation, presentationCovers, useDeckPresentation, type CaseEmblem, type DeckPresentation } from "./deckPresentation";
import "./deck-box.css";
import "./deck-box-light.css";

const mana: Record<string, { name: string; paint: string; pip: string }> = {
  W: { name: "White", paint: "#454034", pip: "#e6d8b3" },
  U: { name: "Blue", paint: "#1c2d3c", pip: "#afccdf" },
  B: { name: "Black", paint: "#24212f", pip: "#c2b6d0" },
  R: { name: "Red", paint: "#3c2424", pip: "#dfab99" },
  G: { name: "Green", paint: "#1d322c", pip: "#b0cfb7" },
  C: { name: "Colorless", paint: "#282e32", pip: "#cad0d5" },
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

function CoverArt({ card, commander, emblem }: { card: DeckCover; commander: boolean; emblem: CaseEmblem }) {
  const src = card.art_url || card.image_url;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return <span className="deck-box-image" title={card.name}>
    <span className="deck-box-mark"><DeckEmblem emblem={emblem} commander={commander} /></span>
    {src && !failed && <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />}
  </span>;
}

export function deckCovers(deck: DeckSummary) {
  return presentationCovers(deck, defaultPresentation);
}

export function DeckBoxVisual({ deck, presentation = defaultPresentation }: { deck: DeckSummary; presentation?: DeckPresentation }) {
  const commander = deck.format === "commander";
  const covers = presentationCovers(deck, presentation);
  const colors = ["W", "U", "B", "R", "G"].filter((color) => deck.colors?.includes(color));
  const { paint, accent } = caseAppearance(deck, presentation);
  return <span className="deck-box" data-format={deck.format} style={{ "--deck-paint": paint, "--deck-accent": accent } as CSSProperties} aria-hidden="true">
    <span className="deck-box-ground" />
    <span className="deck-box-case">
    <span className="deck-box-side"><span className="deck-box-side-panel"><DeckEmblem emblem={presentation.emblem} commander={commander} /><span>PakTrak</span></span></span>
    <span className="deck-box-mouth" />
    <span className="deck-box-front">
      <span className="deck-box-cover" data-count={covers.length}>{covers.length
        ? covers.map((card) => <CoverArt key={card.id} card={card} commander={commander} emblem={presentation.emblem} />)
        : <span className="deck-box-mark"><DeckEmblem emblem={presentation.emblem} commander={commander} /></span>}</span>
      <span className="deck-box-inlay" />
      <span className="deck-box-light" />
      <span className="deck-box-colors">{(colors.length ? colors : ["C"]).map((color) => <span key={color} className="deck-mana-pip" style={{ "--mana-tint": mana[color].pip } as CSSProperties}><ManaMark color={color} /></span>)}</span>
      <span className="deck-box-foot"><span>{commander ? "COMMANDER" : deck.format}</span><span>{deck.copies || 0}</span></span>
    </span>
    <span className="deck-box-lid">
      <span className="deck-box-lid-top"><span className="deck-box-light" /></span>
      <span className="deck-box-seam"><span className="deck-box-stamp"><DeckEmblem emblem={presentation.emblem} commander={commander} /><span>PakTrak</span></span><span className="deck-box-clasp" /><span className="deck-box-light" /></span>
    </span>
    </span>
  </span>;
}

export default function DeckBox({ deck, busy, onOpen, ownerId = "" }: { deck: DeckSummary; busy: boolean; onOpen: (box: HTMLElement) => void; ownerId?: string }) {
  const { presentation } = useDeckPresentation(ownerId, deck);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = button.current;
    if (!element || busy) return;
    const hover = matchMedia("(hover: hover) and (pointer: fine)");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let bounds: DOMRect | null = null;
    let point = { x: .5, y: .5 };
    const reset = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      bounds = null;
      delete element.dataset.boxLight;
      for (const name of ["--box-light-x", "--box-light-y", "--box-turn-x", "--box-turn-y"]) element.style.removeProperty(name);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch" || !hover.matches || reduced.matches) return;
      bounds ??= element.querySelector(".deck-box")!.getBoundingClientRect();
      point = {
        x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
        y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
      };
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        element.style.setProperty("--box-light-x", `${(point.x * 100).toFixed(2)}%`);
        element.style.setProperty("--box-light-y", `${(point.y * 100).toFixed(2)}%`);
        element.style.setProperty("--box-turn-x", `${((.5 - point.y) * 4).toFixed(2)}deg`);
        element.style.setProperty("--box-turn-y", `${((point.x - .5) * 6).toFixed(2)}deg`);
        element.dataset.boxLight = "active";
      });
    };
    element.addEventListener("pointerenter", move);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerleave", reset);
    element.addEventListener("pointercancel", reset);
    element.addEventListener("blur", reset);
    window.addEventListener("blur", reset);
    window.addEventListener("resize", reset);
    window.addEventListener("scroll", reset, true);
    hover.addEventListener("change", reset);
    reduced.addEventListener("change", reset);
    return () => {
      reset();
      element.removeEventListener("pointerenter", move);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerleave", reset);
      element.removeEventListener("pointercancel", reset);
      element.removeEventListener("blur", reset);
      window.removeEventListener("blur", reset);
      window.removeEventListener("resize", reset);
      window.removeEventListener("scroll", reset, true);
      hover.removeEventListener("change", reset);
      reduced.removeEventListener("change", reset);
    };
  }, [busy]);
  const commander = deck.format === "commander";
  const covers = presentationCovers(deck, presentation);
  const colors = ["W", "U", "B", "R", "G"].filter((color) => deck.colors?.includes(color));
  const colorName = colors.length ? colors.map((color) => mana[color].name).join(" / ") : deck.colors_known === false ? "Colors unavailable" : "Colorless";
  const coverName = covers.length ? `${commander && !presentation.featuredCard ? "Commander" : "Featured card"}: ${covers.map((card) => card.name).join(" and ")}` : commander && deck.copies ? "Commander not set" : "No cover card yet";
  const description = `${deck.name}, ${deck.format}, ${deck.copies || 0} cards, ${colorName}. ${coverName}.`;
  return <button ref={button} type="button" className="deck-box-button" data-deck-id={deck.id} data-deck-colors={colors.join("") || "C"} disabled={busy} onClick={(event) => onOpen(event.currentTarget.querySelector<HTMLElement>(".deck-box")!)} aria-label={`Open ${description}`} title={description}>
    <DeckBoxVisual deck={deck} presentation={presentation} />
    <span className="deck-box-label"><strong>{deck.name}</strong><span className="deck-box-meta"><span className="deck-box-format">{deck.format}</span><span className="deck-box-count">{deck.copies || 0} cards</span></span><span className="deck-box-open" aria-hidden="true">Open deck <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 10h13m-5-5 5 5-5 5" /></svg></span></span>
  </button>;
}
