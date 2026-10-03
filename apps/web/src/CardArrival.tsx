import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { sampleCardMotion } from "./cardMotion";
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
    const scene = stage.current;
    const flight = card.current;
    const shape = solid.current;
    let disposed = false;
    let frame = 0;
    let attempts = 0;
    let observer: ResizeObserver | null = null;
    let openedDialog: HTMLDialogElement | null = null;
    const animations: Animation[] = [];
    const hidden = new Set<HTMLElement>();
    const reveal = (element: HTMLElement) => { if (element.dataset.cardFlightHidden === marker) delete element.dataset.cardFlightHidden; };
    const restore = () => {
      // Make the viewer persistently visible before cancelling any animation.
      // A compositor visibility animation must never be the only thing showing it.
      hidden.forEach(reveal);
      // React can remove the overlay on a later frame. Hide it before cancel
      // resets its transform and opacity, including during interrupted flights.
      delete scene.dataset.cardArrivalReady;
      delete scene.dataset.cardArrivalLanded;
      cancelAnimationFrame(frame);
      animations.forEach(animation => animation.cancel());
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
      const targetX = destination.left + destination.width / 2;
      const targetY = destination.top + destination.height / 2;
      const channels = ["x", "y", "sx", "sy"] as const;
      let duration = 820;
      const handoffDuration = duration * .1;
      let arrivalTime = duration - handoffDuration;
      let path = sampleCardMotion([
        { offset: 0, x: sourceX, y: sourceY, sx: scaleX, sy: scaleY },
        { offset: duration * .48, x: sourceX + (targetX - sourceX) * .5 + direction * Math.min(22, Math.abs(targetX - sourceX) * .08 + 8), y: sourceY + (targetY - sourceY) * .5 - Math.min(56, destination.height * .12), sx: scaleX + (1 - scaleX) * .65, sy: scaleY + (1 - scaleY) * .65 },
        { offset: arrivalTime, x: targetX, y: targetY, sx: 1, sy: 1 },
      ], channels);
      path.push({ ...path[path.length - 1], offset: duration });
      const placementFrames = () => path.map(point => ({ offset: point.offset / duration, transform: pose(point.x, point.y, point.sx, point.sy) }));
      openedDialog = dialog;
      for (const element of [origin.source, target]) {
        element.dataset.cardFlightHidden = marker;
        hidden.add(element);
      }
      const placement = flight.animate(placementFrames(), { duration, fill: "both", easing: "linear" });
      animations.push(placement);
      const spin = sampleCardMotion([
        { offset: 0, x: 0, y: 0, z: 0 },
        { offset: .26, x: -7, y: direction * 90, z: direction * -6 },
        { offset: .48, x: 6, y: direction * 180, z: direction * 8 },
        { offset: .7, x: 4, y: direction * 270, z: direction * 4 },
        { offset: .9, x: 0, y: direction * 360, z: 0 },
      ], ["x", "y", "z"]);
      spin.push({ ...spin[spin.length - 1], offset: 1 });
      animations.push(shape.animate(spin.map(point => ({ offset: point.offset, transform: `rotateX(${point.x}deg) rotateY(${point.y}deg) rotateZ(${point.z}deg)` })), { duration, fill: "both", easing: "linear" }));
      scene.dataset.cardArrivalReady = "true";
      const handoff = () => {
        if (disposed) return;
        // Once the spin ends, use one flat front surface. Fading a 3D back
        // surface can make WebKit paint it through the front as a mirrored card.
        scene.dataset.cardArrivalLanded = "true";
        const image = target.querySelector<HTMLImageElement>("img");
        const url = image?.src;
        const ready = () => {
          const current = target.querySelector<HTMLImageElement>("img");
          return !current || (current === image && current.src === url && current.complete && current.naturalWidth > 0);
        };
        // Hidden images can finish downloading before the browser decodes them.
        // Hold the landed card until the viewer image can actually be painted.
        void (image ? image.decode().catch(() => {}) : Promise.resolve()).then(() => {
          if (disposed) return;
          frame = requestAnimationFrame(() => {
            if (disposed) return;
            if (!ready()) { handoff(); return; }
            reveal(target);
            // Give the visible viewer a paint beneath the still-opaque flight.
            // Then blend its image and shadow, without toggling visibility again.
            frame = requestAnimationFrame(() => {
              if (disposed) return;
              if (!ready()) { target.dataset.cardFlightHidden = marker; handoff(); return; }
              const shadow = getComputedStyle(target).boxShadow;
              const front = shape.querySelector<HTMLElement>(".card-arrival-front")!;
              const fade = front.animate([
                { opacity: 1, boxShadow: getComputedStyle(front).boxShadow },
                { opacity: 0, boxShadow: shadow },
              ], { duration: handoffDuration, fill: "both", easing: "ease-out" });
              animations.push(fade);
              void fade.finished.then(finish).catch(() => {});
            });
          });
        });
      };
      void placement.finished.then(handoff).catch(() => {});
      // Loading oracle text and holdings can recenter a native dialog. Keep
      // the source pose and spin, and update the endpoint to the live artwork.
      let endpoint = destination;
      observer = new ResizeObserver(() => {
        if (disposed) return;
        const rect = target.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) { finish(); return; }
        const delta = { x: rect.left + rect.width / 2 - endpoint.left - endpoint.width / 2, y: rect.top + rect.height / 2 - endpoint.top - endpoint.height / 2, sx: (rect.width - endpoint.width) / destination.width, sy: (rect.height - endpoint.height) / destination.height };
        if (channels.every(channel => Math.abs(delta[channel]) < .001)) return;
        const elapsed = Math.max(0, Number(placement.currentTime));
        if (elapsed >= arrivalTime) { finish(); return; }
        // Preserve the pose already on screen. Ease the remaining path toward
        // the new endpoint instead of jumping when late card details load.
        const end = Math.max(1, path.findIndex(point => point.offset >= elapsed));
        const from = path[end - 1], to = path[end];
        const current = { offset: elapsed, x: 0, y: 0, sx: 0, sy: 0 };
        const fraction = (elapsed - from.offset) / (to.offset - from.offset);
        for (const channel of channels) current[channel] = from[channel] + (to[channel] - from[channel]) * fraction;
        if (arrivalTime - elapsed < 180) {
          // A late response must not squeeze a large correction into the last
          // few milliseconds. Preserve position and velocity and allow a short
          // settling tail before revealing the destination artwork.
          const remaining = 180;
          arrivalTime = elapsed + remaining;
          duration = arrivalTime + handoffDuration;
          const landing = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, sx: rect.width / destination.width, sy: rect.height / destination.height };
          const tail = Array.from({ length: 31 }, (_, frame) => {
            const t = frame / 30;
            const point = { ...current, offset: elapsed + remaining * t };
            for (const channel of channels) {
              const velocity = (to[channel] - from[channel]) / (to.offset - from.offset);
              point[channel] = (2 * t ** 3 - 3 * t ** 2 + 1) * current[channel]
                + (t ** 3 - 2 * t ** 2 + t) * velocity * remaining
                + (-2 * t ** 3 + 3 * t ** 2) * landing[channel];
            }
            return point;
          });
          path = [...path.filter(point => point.offset < elapsed), ...tail, { ...tail[tail.length - 1], offset: duration }];
          (placement.effect as KeyframeEffect).updateTiming({ duration });
        } else {
          path = [...path.filter(point => point.offset < elapsed), current, ...path.filter(point => point.offset > elapsed)].map(point => {
            const t = Math.max(0, Math.min(1, (point.offset - elapsed) / (arrivalTime - elapsed)));
            const blend = t ** 3 * (10 - 15 * t + 6 * t ** 2);
            const adjusted = { ...point };
            for (const channel of channels) adjusted[channel] += delta[channel] * blend;
            return adjusted;
          });
        }
        endpoint = rect;
        (placement.effect as KeyframeEffect).setKeyframes(placementFrames());
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
