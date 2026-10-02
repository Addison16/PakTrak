import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { DeckBoxVisual } from "./DeckBox";
import { presentationCovers, useDeckPresentation } from "./deckPresentation";
import type { DeckCover, DeckSummary } from "./deckTypes";

export type DeckOpeningOrigin = { ownerId?: string; deck: DeckSummary; left: number; top: number; width: number; height: number };

// Load the route immediately. This presentation only covers the handoff; it
// never owns navigation or delays the request, and can be dismissed safely.
export default function DeckOpening({ origin, ready, onComplete }: { origin: DeckOpeningOrigin; ready: boolean; onComplete: () => void }) {
  const [launched, setLaunched] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const complete = useRef(onComplete);
  complete.current = onComplete;
  const [stage] = useState(() => {
    const width = Math.min(206, window.innerWidth * .43, window.innerHeight * .28);
    const height = width * origin.height / origin.width;
    const cardWidth = Math.min(110, window.innerWidth * .19, width * .57);
    return { width, height, left: (window.innerWidth - width) / 2, top: Math.max(cardWidth * 1.6 + 20, (window.innerHeight - height) * .56), cardWidth, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
  });
  const { presentation } = useDeckPresentation(origin.ownerId || "", origin.deck);
  const previews = [...presentationCovers(origin.deck, presentation), ...(origin.deck.preview_cards || [])];
  const unique = previews.filter((card, index) => previews.findIndex((other) => other.id === card.id) === index);
  const cards: (DeckCover | undefined)[] = Array.from({ length: Math.min(12, origin.deck.copies || 0) }, (_, index) => unique.length ? unique[index % unique.length] : undefined);
  const seed = [...origin.deck.id].reduce((value, character) => value * 31 + character.charCodeAt(0) | 0, 0);
  const launchAnimations = useRef<Animation[]>([]);

  useLayoutEffect(() => {
    const flights = [...root.current!.querySelectorAll<HTMLElement>(".deck-opening-card")];
    const random = (index: number, salt: number) => { const value = Math.sin(seed + index * 127.1 + salt * 311.7) * 43758.5453; return value - Math.floor(value); };
    const pose = (x: number, y: number, turn: number, flip: number, scale: number) => `translate3d(${x}px, ${y}px, 0) rotateZ(${turn}deg) rotateY(${flip}deg) scale(${scale})`;
    const animations = flights.flatMap((flight, index) => {
      const direction = index % 2 ? 1 : -1;
      const across = direction * (stage.viewportWidth * (.5 + random(index, 1) * .12));
      const backFirst = flights.length === 1 || index % 3 === 1;
      const fan = (index - (flights.length - 1) / 2) / Math.max(1, flights.length - 1);
      const fanWidth = Math.min(stage.viewportWidth * .76, stage.cardWidth * 7);
      const readableBack = direction * (172 + random(index, 10) * 16);
      // Give a few backs a clear, on-screen beat. The old 170° pose was
      // already beyond the viewport, so its artwork only flashed past.
      const timing: KeyframeAnimationOptions = { duration: 900 + index % 3 * 75, delay: 190 + index * 18, easing: "linear", fill: "both" };
      const movement = flight.animate([
        { offset: 0, transform: pose(0, 50, 0, 0, .4), zIndex: "3", easing: "cubic-bezier(.25,.65,.4,1)" },
        { offset: .16, transform: pose(fan * fanWidth * .65, -stage.cardWidth * (1.55 + index % 3 * .12), direction * (backFirst ? 8 : 35), backFirst ? readableBack : direction * 25, .95), zIndex: backFirst ? "14" : "5", easing: "ease-in-out" },
        { offset: backFirst ? .44 : .38, transform: pose(fan * fanWidth, -stage.cardWidth * (2.25 + (index % 4) * .1), direction * (backFirst ? 13 : 52), backFirst ? readableBack + direction * 4 : direction * 45, backFirst ? 1.08 : 1), zIndex: backFirst ? "14" : "8", easing: "cubic-bezier(.3,.55,.45,1)" },
        { offset: .56, transform: pose(across, stage.viewportHeight * (.08 + random(index, 3) * .68) - stage.top, direction * (150 + random(index, 4) * 220), direction * (backFirst ? 370 : 170), 1.15), zIndex: "12", easing: "ease-in-out" },
        { offset: .76, transform: pose(-across * .85, stage.viewportHeight * (.08 + random(index, 5) * .7) - stage.top, direction * (460 + random(index, 6) * 260), direction * (backFirst ? 550 : 370), .72 + random(index, 7) * .55), zIndex: "12", easing: "cubic-bezier(.2,.65,.3,1)" },
        { offset: 1, transform: pose((random(index, 8) - .5) * stage.viewportWidth * .65, -stage.cardWidth * (1.45 + random(index, 9) * .7), direction * 720 + (index % 7 - 3) * 18, direction * 720, .82 + random(index, 10) * .2), zIndex: "12" },
      ], timing);
      // Opacity on the rotating parent flattens its 3D faces in browsers.
      // Fade the individual surfaces so the real back remains visible.
      const fades = [...flight.children].map(surface => surface.animate([
        { offset: 0, opacity: 0, easing: "cubic-bezier(.25,.65,.4,1)" },
        { offset: .16, opacity: 1 },
        { offset: 1, opacity: 1 },
      ], timing));
      return [movement, ...fades];
    });
    launchAnimations.current = animations;
    return () => animations.forEach((animation) => animation.cancel());
  }, [stage, seed]);

  useEffect(() => {
    const timer = window.setTimeout(() => setLaunched(true), 1120);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const dismiss = () => complete.current();
    const preferenceChanged = () => { if (reduceMotion.matches) dismiss(); };
    window.addEventListener("resize", dismiss);
    reduceMotion.addEventListener("change", preferenceChanged);
    return () => { clearTimeout(timer); window.removeEventListener("resize", dismiss); reduceMotion.removeEventListener("change", preferenceChanged); };
  }, []);

  useLayoutEffect(() => {
    if (!launched || !ready || !root.current) return;
    const detail = document.querySelector<HTMLElement>(`.deck-detail[data-deck-view="${CSS.escape(origin.deck.id)}"]`);
    if (!detail) return;
    setRevealing(true);
    const targets = [...detail.querySelectorAll<HTMLElement>(".deck-gallery .deck-art-button")];
    const flights = [...root.current.querySelectorAll<HTMLElement>(".deck-opening-card")];
    const poses = flights.map(flight => getComputedStyle(flight).transform);
    launchAnimations.current.forEach(animation => animation.cancel());
    const hidden = new Set<HTMLElement>();
    const timers: number[] = [];
    const animations = flights.flatMap((flight, index) => {
      const card = cards[index];
      const matching = card ? targets.find(target => target.dataset.printingId === card.id && (!card.section || target.dataset.cardSection === card.section)) : undefined;
      const target = matching?.getBoundingClientRect();
      const landing = target && target.width > 0 && target.height > 0;
      const exit = index % 4;
      const x = landing ? target.left + target.width / 2 - stage.viewportWidth / 2 : exit < 2 ? (exit ? 1 : -1) * (stage.viewportWidth / 2 + stage.cardWidth * 2) : (index % 5 - 2) * stage.cardWidth;
      const y = landing ? target.top + target.height / 2 - (stage.top + stage.height * .08 + flight.offsetHeight / 2) : exit === 2 ? -stage.top - flight.offsetHeight * 2 : exit === 3 ? stage.viewportHeight - stage.top + flight.offsetHeight * 2 : (index % 3 - 1) * stage.viewportHeight * .3;
      const end = `translate3d(${x}px, ${y}px, 0) rotateZ(${landing ? 0 : (index % 2 ? 1 : -1) * 1080}deg) rotateY(${landing ? 0 : 720}deg) scale(${landing ? target.width / stage.cardWidth : 1.1})`;
      const delay = index * 18;
      if (landing && matching) {
        matching.dataset.deckLanding = "true";
        hidden.add(matching);
        flight.dataset.landingPrintingId = matching.dataset.printingId;
        flight.dataset.landingSection = matching.dataset.cardSection;
        const image = flight.querySelector<HTMLImageElement>("img");
        if (image) { image.style.objectFit = "contain"; }
        timers.push(window.setTimeout(() => { delete matching.dataset.deckLanding; }, 560 + delay));
      }
      const timing: KeyframeAnimationOptions = { duration: 660, delay, easing: "linear", fill: "both" };
      const movement = flight.animate([
        { offset: 0, transform: poses[index], zIndex: "12", easing: "cubic-bezier(.22, .75, .2, 1)" },
        { offset: .85, transform: end, zIndex: "12", easing: "linear" },
        { offset: 1, transform: end, zIndex: "12" },
      ], timing);
      const fades = [...flight.children].map(surface => surface.animate([
        { offset: 0, opacity: 1 },
        { offset: .85, opacity: 1 },
        { offset: 1, opacity: 0 },
      ], timing));
      return [movement, ...fades];
    });
    timers.push(window.setTimeout(() => complete.current(), 890));
    return () => {
      timers.forEach(clearTimeout);
      animations.forEach(animation => animation.cancel());
      hidden.forEach(target => { delete target.dataset.deckLanding; });
    };
  }, [launched, ready, stage, origin.deck.id]);

  const boxStyle = {
    left: origin.left, top: origin.top, width: origin.width, height: origin.height,
    "--lift-x": `${stage.left + stage.width / 2 - origin.left - origin.width / 2}px`,
    "--lift-y": `${stage.top + stage.height / 2 - origin.top - origin.height / 2}px`,
    "--lift-scale": stage.width / origin.width,
  } as CSSProperties;
  return createPortal(<div ref={root} className={`deck-opening${revealing ? " deck-opening--revealing" : ""}`} data-deck-opening={origin.deck.id} aria-hidden="true">
    <div className="deck-opening-veil" />
    <div className="deck-opening-box" style={boxStyle}><DeckBoxVisual deck={origin.deck} presentation={presentation} /></div>
    {cards.map((card, index) => <span key={index} className="deck-opening-card" data-printing-id={card?.id} style={{
      left: (window.innerWidth - stage.cardWidth) / 2, top: stage.top + stage.height * .08, width: stage.cardWidth,
      zIndex: 4,
    } as CSSProperties}>
      <span className="deck-opening-card-front">
        {card?.image_url && <img src={card.image_url} alt="" decoding="async" onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} />}
      </span>
      <span className="deck-opening-card-back" />
      <span className="deck-opening-card-edge deck-opening-card-edge-left" />
      <span className="deck-opening-card-edge deck-opening-card-edge-right" />
      <span className="deck-opening-card-edge deck-opening-card-edge-top" />
      <span className="deck-opening-card-edge deck-opening-card-edge-bottom" />
    </span>)}
    <div className="deck-opening-caption" style={{ top: stage.top + stage.height + 28 }}><span className="eyebrow">{launched && !ready ? "OPENING DECK" : "YOUR NEXT GAME"}</span><span>{origin.deck.name}</span></div>
  </div>, document.body);
}
