import { useEffect, useRef, type RefObject } from "react";

type Step = (() => void) | null | undefined;
type Side = "left" | "right";

// Controls that need their own horizontal gestures or arrow keys.
const ownGestures = "input, select, textarea, [contenteditable], .finish-tabs";
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// The next viewer slides in from the side the user moved toward. A collection
// step remounts its dialog, so the hint lives outside the component.
let entering: { side: Side; at: number } | null = null;

export function slideTo(side: Side, step: Step) {
  if (!step) return;
  entering = { side, at: performance.now() };
  step();
}

function artOf(holder: RefObject<HTMLElement | null>) {
  return holder.current?.querySelector<HTMLElement>(".card-art") || holder.current;
}

// Swipe left or right anywhere on a card viewer to step through the list it
// came from. The artwork follows the finger, resists at the first and last
// card, and slides out before the next card slides in.
export function useCardSwipe(surface: RefObject<HTMLElement | null>, art: RefObject<HTMLElement | null>, cardKey: string, previous: Step, next: Step) {
  const steps = useRef({ previous, next });
  steps.current = { previous, next };

  useEffect(() => {
    const hint = entering;
    entering = null;
    const card = artOf(art);
    if (!card) return;
    card.style.transform = "";
    card.style.opacity = "";
    if (!hint || performance.now() - hint.at > 1500 || reducedMotion()) return;
    const from = hint.side === "right" ? 1 : -1;
    const animation = card.animate([
      { transform: `translate3d(${from * 56}px, 0, 0) rotate(${from * 2.5}deg)`, opacity: 0 },
      { transform: "none", opacity: 1 },
    ], { duration: 240, easing: "cubic-bezier(.2, .8, .25, 1)" });
    return () => animation.cancel();
  }, [cardKey]);

  useEffect(() => {
    const area = surface.current;
    if (!area) return;
    let drag: { id: number; x: number; y: number; dx: number; active: boolean } | null = null;
    let swipedAt = -Infinity;
    let leaving: Animation | null = null;
    const place = (dx: number) => {
      const card = artOf(art);
      if (card && !reducedMotion()) card.style.transform = dx ? `translate3d(${dx}px, 0, 0) rotate(${dx / 45}deg)` : "";
    };
    const settle = (dx: number) => {
      const card = artOf(art);
      place(0);
      if (card && dx && !reducedMotion()) card.animate([{ transform: `translate3d(${dx}px, 0, 0) rotate(${dx / 45}deg)` }, { transform: "none" }], { duration: 260, easing: "cubic-bezier(.3, 1.4, .5, 1)" });
    };
    const leave = (dx: number, step: () => void) => {
      const side: Side = dx < 0 ? "right" : "left";
      const card = artOf(art);
      if (!card || reducedMotion()) { slideTo(side, step); return; }
      const out = Math.sign(dx) * Math.max(area.clientWidth * .6, Math.abs(dx) + 80);
      leaving = card.animate([
        { transform: `translate3d(${dx}px, 0, 0) rotate(${dx / 45}deg)`, opacity: 1 },
        { transform: `translate3d(${out}px, 0, 0) rotate(${out / 45}deg)`, opacity: 0 },
      ], { duration: 150, easing: "cubic-bezier(.4, 0, 1, 1)", fill: "forwards" });
      leaving.onfinish = () => {
        // Hold the card off screen with inline styles until the next one enters.
        card.style.transform = `translate3d(${out}px, 0, 0)`;
        card.style.opacity = "0";
        leaving?.cancel();
        leaving = null;
        slideTo(side, step);
      };
    };
    const down = (event: PointerEvent) => {
      const start = event.target instanceof Element && event.target.closest(ownGestures);
      drag = event.pointerType === "mouse" || !event.isPrimary || start || leaving ? null : { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, active: false };
    };
    const move = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.active) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        if (Math.abs(dx) < Math.abs(dy) * 1.2) { drag = null; return; }
        drag.active = true;
      }
      drag.dx = dx;
      place((dx < 0 ? steps.current.next : steps.current.previous) ? dx : dx * .25);
    };
    const up = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      const { x, active } = drag;
      drag = null;
      const dx = event.clientX - x;
      if (!active && Math.abs(dx) < 10) return;
      swipedAt = performance.now();
      const step = dx < 0 ? steps.current.next : steps.current.previous;
      if (step && Math.abs(dx) >= Math.min(70, area.clientWidth * .18)) leave(dx, step);
      else settle(active ? (step ? dx : dx * .25) : 0);
    };
    const cancel = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      if (drag.active) settle(drag.dx);
      drag = null;
    };
    // A swipe that starts on a button or the backdrop is not a tap.
    const click = (event: MouseEvent) => {
      if (performance.now() - swipedAt > 400) return;
      swipedAt = -Infinity;
      event.preventDefault();
      event.stopPropagation();
    };
    const key = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.target instanceof Element && event.target.closest(ownGestures))) return;
      const step = event.key === "ArrowLeft" ? steps.current.previous : event.key === "ArrowRight" ? steps.current.next : undefined;
      if (!step) return;
      event.preventDefault();
      slideTo(event.key === "ArrowRight" ? "right" : "left", step);
    };
    area.addEventListener("pointerdown", down);
    area.addEventListener("pointermove", move);
    area.addEventListener("pointerup", up);
    area.addEventListener("pointercancel", cancel);
    area.addEventListener("click", click, true);
    area.addEventListener("keydown", key);
    return () => {
      leaving?.cancel();
      area.removeEventListener("pointerdown", down);
      area.removeEventListener("pointermove", move);
      area.removeEventListener("pointerup", up);
      area.removeEventListener("pointercancel", cancel);
      area.removeEventListener("click", click, true);
      area.removeEventListener("keydown", key);
    };
  }, []);
}
