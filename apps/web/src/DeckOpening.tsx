import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { DeckBoxVisual } from "./DeckBox";
import { presentationCovers, useDeckPresentation } from "./deckPresentation";
import type { DeckCover, DeckSummary } from "./deckTypes";
import { sampleCardMotion } from "./cardMotion";

export type DeckOpeningOrigin = { ownerId?: string; deck: DeckSummary; left: number; top: number; width: number; height: number };

type FlightPose = { offset: number; x: number; y: number; turn: number; flip: number; scale: number };
const poseTransform = ({ x, y, turn, flip, scale }: Omit<FlightPose, "offset">) => `translate3d(${x}px, ${y}px, 0) rotateZ(${turn}deg) rotateY(${flip}deg) scale(${scale})`;

function flightFrames(points: FlightPose[]): Keyframe[] {
  return sampleCardMotion(points, ["x", "y", "turn", "flip", "scale"]).map(point => ({ offset: point.offset, transform: poseTransform(point) }));
}

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
  const launchPoses = useRef<FlightPose[]>([]);

  useLayoutEffect(() => {
    const flights = [...root.current!.querySelectorAll<HTMLElement>(".deck-opening-card")];
    let cancelled = false;
    const finished: Promise<Animation>[] = [];
    const random = (index: number, salt: number) => { const value = Math.sin(seed + index * 127.1 + salt * 311.7) * 43758.5453; return value - Math.floor(value); };
    const animations = flights.flatMap((flight, index) => {
      const direction = index % 2 ? 1 : -1;
      const across = direction * (stage.viewportWidth * (.5 + random(index, 1) * .12));
      const backFirst = flights.length === 1 || index % 3 === 1;
      const fan = (index - (flights.length - 1) / 2) / Math.max(1, flights.length - 1);
      const fanWidth = Math.min(stage.viewportWidth * .76, stage.cardWidth * 7);
      const readableBack = direction * (172 + random(index, 10) * 16);
      // Give a few backs a clear, on-screen beat. The old 170° pose was
      // already beyond the viewport, so its artwork only flashed past.
      const timing: KeyframeAnimationOptions = { duration: 1120 + index % 3 * 60, delay: 190 + index * 18, easing: "linear", fill: "both" };
      flight.style.zIndex = backFirst ? "14" : "12";
      const settled = { offset: 1, x: (random(index, 8) - .5) * stage.viewportWidth * .65, y: -stage.cardWidth * (1.45 + random(index, 9) * .7), turn: direction * 360 + (index % 7 - 3) * 18, flip: direction * 360, scale: .9 + random(index, 10) * .1 };
      launchPoses.current[index] = settled;
      const movement = flight.animate(flightFrames([
        { offset: 0, x: 0, y: 50, turn: 0, flip: 0, scale: .4 },
        { offset: .16, x: fan * fanWidth * .65, y: -stage.cardWidth * (1.55 + index % 3 * .12), turn: direction * (backFirst ? 8 : 25), flip: backFirst ? readableBack : direction * 25, scale: .95 },
        { offset: backFirst ? .44 : .38, x: fan * fanWidth, y: -stage.cardWidth * (2.25 + (index % 4) * .1), turn: direction * (backFirst ? 13 : 38), flip: backFirst ? readableBack + direction * 4 : direction * 45, scale: backFirst ? 1.08 : 1 },
        { offset: .56, x: across, y: stage.viewportHeight * (.08 + random(index, 3) * .68) - stage.top, turn: direction * (100 + random(index, 4) * 60), flip: direction * (backFirst ? 210 : 170), scale: 1.08 },
        { offset: .76, x: -across * .85, y: stage.viewportHeight * (.08 + random(index, 5) * .7) - stage.top, turn: direction * (210 + random(index, 6) * 60), flip: direction * 300, scale: .9 + random(index, 7) * .15 },
        settled,
      ]), timing);
      finished.push(movement.finished);
      // Opacity on the rotating parent flattens its 3D faces in browsers.
      // Fade the individual surfaces so the real back remains visible.
      const fades = [...flight.querySelectorAll(".deck-opening-card-front, .deck-opening-card-back")].map(surface => surface.animate([
        { opacity: 0 }, { opacity: 1 },
      ], { duration: 140, delay: timing.delay, easing: "ease-out", fill: "both" }));
      return [movement, ...fades];
    });
    launchAnimations.current = animations;
    const emptyTimer = flights.length ? undefined : window.setTimeout(() => setLaunched(true), 620);
    if (flights.length) void Promise.all(finished).then(() => { if (!cancelled) setLaunched(true); }).catch(() => {});
    return () => { cancelled = true; clearTimeout(emptyTimer); animations.forEach((animation) => animation.cancel()); };
  }, [stage, seed]);

  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const dismiss = () => complete.current();
    const preferenceChanged = () => { if (reduceMotion.matches) dismiss(); };
    window.addEventListener("resize", dismiss);
    reduceMotion.addEventListener("change", preferenceChanged);
    return () => { window.removeEventListener("resize", dismiss); reduceMotion.removeEventListener("change", preferenceChanged); };
  }, []);

  useLayoutEffect(() => {
    if (!launched || !ready || !root.current) return;
    const detail = document.querySelector<HTMLElement>(`.deck-detail[data-deck-view="${CSS.escape(origin.deck.id)}"]`);
    if (!detail) return;
    const flights = [...root.current.querySelectorAll<HTMLElement>(".deck-opening-card")];
    // Read the gallery once before hiding anything. Repeated copies and cards
    // below the viewport leave at their original size instead of piling into
    // the same large artwork layers during the reveal.
    const targets = [...detail.querySelectorAll<HTMLElement>(".deck-gallery .deck-art-button")].map(element => ({ element, rect: element.getBoundingClientRect() })).filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.left < stage.viewportWidth && rect.right > 0 && rect.top < stage.viewportHeight && rect.bottom > 0);
    const claimed = new Set<HTMLElement>();
    const cardHeight = stage.cardWidth * 680 / 488;
    const plans = flights.map((flight, index) => {
      const card = cards[index];
      const target = card ? targets.find(({ element }) => !claimed.has(element) && element.dataset.printingId === card.id && (!card.section || element.dataset.cardSection === card.section)) : undefined;
      if (target) claimed.add(target.element);
      const start = launchPoses.current[index];
      const exit = index % 4;
      const end = {
        x: target ? target.rect.left + target.rect.width / 2 - stage.viewportWidth / 2 : exit < 2 ? (exit ? 1 : -1) * (stage.viewportWidth / 2 + stage.cardWidth * 2) : (index % 5 - 2) * stage.cardWidth,
        y: target ? target.rect.top + target.rect.height / 2 - (stage.top + stage.height * .08 + cardHeight / 2) : exit === 2 ? -stage.top - cardHeight * 2 : exit === 3 ? stage.viewportHeight - stage.top + cardHeight * 2 : (index % 3 - 1) * stage.viewportHeight * .3,
        turn: target ? Math.round(start.turn / 360) * 360 : start.turn + (index % 2 ? 1 : -1) * 45,
        flip: start.flip,
        scale: target ? target.rect.width / stage.cardWidth : .9,
      };
      return { flight, index, start, end, matching: target?.element };
    });
    setRevealing(true);
    let cancelled = false;
    const hidden = new Set<HTMLElement>();
    const veil = root.current.querySelector<HTMLElement>(".deck-opening-veil")!.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 440, easing: "ease", fill: "both" });
    const finished = [veil.finished];
    const animations = [veil, ...plans.flatMap(({ flight, index, start, end, matching }) => {
      const delay = index * 18;
      if (matching) {
        matching.dataset.deckLanding = "true";
        hidden.add(matching);
        flight.dataset.landingPrintingId = matching.dataset.printingId;
        flight.dataset.landingSection = matching.dataset.cardSection;
      }
      // Keep the same transform functions across the handoff and a gentle
      // start/end velocity. The settled cards face forward, so the reveal
      // needs only their front surface and no further 3D flips.
      const movement = flight.animate([
        { transform: poseTransform(start) }, { transform: poseTransform(end) },
      ], { duration: 560, delay, easing: "cubic-bezier(.4, 0, .2, 1)", fill: "both" });
      const fade = flight.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, easing: "linear", fill: "both" });
      fade.pause();
      void movement.finished.then(() => {
        if (cancelled) return;
        if (matching) { delete matching.dataset.deckLanding; hidden.delete(matching); }
        // Keep the flying artwork visible until the real target is restored,
        // even when a slow frame delays the completion callback.
        fade.play();
      }).catch(() => {});
      finished.push(fade.finished);
      return [movement, fade];
    })];
    launchAnimations.current.forEach(animation => animation.cancel());
    void Promise.all(finished).then(() => { if (!cancelled) complete.current(); }).catch(() => {});
    return () => {
      cancelled = true;
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
