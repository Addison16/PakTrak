import { useEffect, useId, useRef, useState, type RefObject } from "react";
import "./card-arrival.css";

let cardBackPreloaded = false;
export function preloadCardBack() {
  if (cardBackPreloaded) return;
  cardBackPreloaded = true;
  const image = new Image();
  image.src = "/cards/mtg-card-back.png";
}

export type CardFlightOrigin = {
  cardKey: string;
  imageUrl: string;
  source: HTMLElement;
  left: number;
  top: number;
  width: number;
  height: number;
  capturedAt: number;
};

export function captureCardFlight(source: HTMLElement, cardKey: string): CardFlightOrigin | null {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !source.isConnected) return null;
  const art = source.querySelector<HTMLElement>(".card-art");
  const image = art?.querySelector<HTMLImageElement>("img");
  if (!art || !image?.complete || !image.naturalWidth) return null;
  const rect = art.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1 || rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) return null;
  return { cardKey, imageUrl: image.currentSrc || image.src, source: art, left: rect.left, top: rect.top, width: rect.width, height: rect.height, capturedAt: performance.now() };
}

type Props = {
  origin?: CardFlightOrigin | null;
  cardKey: string;
  targetRef: RefObject<HTMLElement | null>;
  dialogRef: RefObject<HTMLDialogElement | null>;
};

// The flight lives inside the native dialog's top layer. Navigation and card
// data load immediately; this decorative handoff never blocks either one.
export default function CardArrival({ origin, cardKey, targetRef, dialogRef }: Props) {
  const stage = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const solid = useRef<HTMLDivElement>(null);
  const marker = useId();
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    if (!origin || origin.cardKey !== cardKey || reduced.matches) { setVisible(false); return; }
    if (!visible || !stage.current || !card.current || !solid.current) return;
    const flight = card.current;
    const shape = solid.current;
    let disposed = false;
    let frame = 0;
    let attempts = 0;
    let observer: ResizeObserver | null = null;
    let openedDialog: HTMLDialogElement | null = null;
    const timers: number[] = [];
    const animations: Animation[] = [];
    const hidden = new Set<HTMLElement>();
    const reveal = (element: HTMLElement) => { if (element.dataset.cardFlightHidden === marker) delete element.dataset.cardFlightHidden; };
    const restore = () => {
      cancelAnimationFrame(frame);
      timers.forEach(clearTimeout);
      animations.forEach(animation => animation.cancel());
      hidden.forEach(reveal);
      observer?.disconnect();
      openedDialog?.removeEventListener("scroll", finish);
      openedDialog?.removeEventListener("close", finish);
    };
    const finish = () => {
      if (disposed) return;
      disposed = true;
      restore();
      setVisible(false);
    };
    const start = () => {
      if (disposed) return;
      const dialog = dialogRef.current;
      const wrapper = targetRef.current;
      const target = wrapper?.querySelector<HTMLElement>(".card-art") || wrapper;
      // Parent showModal effects run after their children. Measure once the
      // real modal is open, rather than guessing its responsive position.
      if (!dialog?.open || !target || target.getBoundingClientRect().width < 1) {
        if (++attempts < 12) frame = requestAnimationFrame(start);
        else finish();
        return;
      }
      if (!origin.source.isConnected || performance.now() - origin.capturedAt > 4000) { finish(); return; }
      const destination = target.getBoundingClientRect();
      if (destination.height < 1 || destination.bottom <= 0 || destination.top >= innerHeight) { finish(); return; }
      flight.style.width = `${destination.width}px`;
      flight.style.height = `${destination.height}px`;
      const sourceX = origin.left + origin.width / 2;
      const sourceY = origin.top + origin.height / 2;
      const scaleX = origin.width / destination.width;
      const scaleY = origin.height / destination.height;
      const direction = sourceX < destination.left + destination.width / 2 ? 1 : -1;
      const pose = (x: number, y: number, sx: number, sy: number) => `translate3d(${x - destination.width * sx / 2}px, ${y - destination.height * sy / 2}px, 0) scale(${sx}, ${sy})`;
      const path = (rect: DOMRect): Keyframe[] => {
        const targetX = rect.left + rect.width / 2;
        const targetY = rect.top + rect.height / 2;
        const endScaleX = rect.width / destination.width;
        const endScaleY = rect.height / destination.height;
        const end = pose(targetX, targetY, endScaleX, endScaleY);
        return [
          { offset: 0, transform: pose(sourceX, sourceY, scaleX, scaleY), opacity: 1, easing: "cubic-bezier(.25,.6,.35,1)" },
          { offset: .48, transform: pose(sourceX + (targetX - sourceX) * .5 + direction * 22, sourceY + (targetY - sourceY) * .5 - Math.min(72, rect.height * .16), scaleX + (endScaleX - scaleX) * .65, scaleY + (endScaleY - scaleY) * .65), opacity: 1, easing: "cubic-bezier(.2,.75,.2,1)" },
          { offset: .9, transform: end, opacity: 1, easing: "linear" },
          { offset: 1, transform: end, opacity: 0 },
        ];
      };
      const duration = 820;
      openedDialog = dialog;
      for (const element of [origin.source, target]) {
        element.dataset.cardFlightHidden = marker;
        hidden.add(element);
      }
      stage.current!.dataset.cardArrivalReady = "true";
      const placement = flight.animate(path(destination), { duration, fill: "both", easing: "linear" });
      animations.push(placement);
      animations.push(shape.animate([
        { offset: 0, transform: "rotateX(0deg) rotateY(0deg) rotateZ(0deg)", easing: "cubic-bezier(.3,.5,.3,1)" },
        { offset: .26, transform: `rotateX(-12deg) rotateY(${direction * 90}deg) rotateZ(${direction * -12}deg)`, easing: "linear" },
        { offset: .48, transform: `rotateX(10deg) rotateY(${direction * 180}deg) rotateZ(${direction * 16}deg)`, easing: "linear" },
        { offset: .7, transform: `rotateX(8deg) rotateY(${direction * 270}deg) rotateZ(${direction * 8}deg)`, easing: "cubic-bezier(.2,.7,.2,1)" },
        { offset: .9, transform: `rotateX(0deg) rotateY(${direction * 360}deg) rotateZ(0deg)` },
        { offset: 1, transform: `rotateX(0deg) rotateY(${direction * 360}deg) rotateZ(0deg)` },
      ], { duration, fill: "both", easing: "linear" }));
      timers.push(window.setTimeout(() => reveal(target), duration * .9));
      timers.push(window.setTimeout(finish, duration + 35));
      // Loading oracle text and holdings can recenter a native dialog. Keep
      // the source pose and spin, and update the endpoint to the live artwork.
      observer = new ResizeObserver(() => {
        const rect = target.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) finish();
        else (placement.effect as KeyframeEffect).setKeyframes(path(rect));
      });
      observer.observe(target);
      observer.observe(dialog);
      dialog.addEventListener("scroll", finish, { once: true });
      dialog.addEventListener("close", finish, { once: true });
    };
    frame = requestAnimationFrame(start);
    const preferenceChanged = () => { if (reduced.matches) finish(); };
    window.addEventListener("resize", finish);
    window.visualViewport?.addEventListener("resize", finish);
    reduced.addEventListener("change", preferenceChanged);
    return () => {
      disposed = true;
      restore();
      window.removeEventListener("resize", finish);
      window.visualViewport?.removeEventListener("resize", finish);
      reduced.removeEventListener("change", preferenceChanged);
    };
  }, [origin, cardKey, marker, targetRef, dialogRef, visible]);

  if (!visible || !origin || origin.cardKey !== cardKey) return null;
  return <div ref={stage} className="card-arrival-stage" aria-hidden="true">
    <div ref={card} className="card-arrival-card" data-card-key={cardKey}>
      <div ref={solid} className="card-arrival-solid">
        <div className="card-arrival-front"><img src={origin.imageUrl} alt="" decoding="async" draggable={false} onError={() => setVisible(false)} /></div>
        <div className="card-arrival-back" />
        <span className="card-arrival-edge card-arrival-edge-left" />
        <span className="card-arrival-edge card-arrival-edge-right" />
        <span className="card-arrival-edge card-arrival-edge-top" />
        <span className="card-arrival-edge card-arrival-edge-bottom" />
      </div>
    </div>
  </div>;
}
