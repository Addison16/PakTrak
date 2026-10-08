import { useEffect, useRef, useState, type CSSProperties } from "react";
import { checkConnection, connection } from "./offline";
import { runPullRefresh, usePullRefreshAvailable } from "./pullRefresh";
import "./pull-refresh.css";

const reach = 120; // Furthest the page moves, however far the finger goes.
const trigger = 64; // Pull at least this far to refresh.
const hold = 52; // Gap kept open while the screen reloads.
const minimumSpin = 600;
const messageTime = 2400;
const offlineText = "You’re offline. Showing saved copies.";
const failedText = "Couldn’t refresh. Try again in a moment.";

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
// The pull slows the further it goes, like a rubber band.
const resist = (finger: number) => reach * (1 - Math.exp(-finger / 180));

// Places with their own touch handling, or content scrolled inside a box.
function blocked(target: EventTarget | null) {
  if (document.querySelector("dialog[open]") || document.body.style.overflow === "hidden") return true;
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select, [contenteditable], [data-no-pull]")) return true;
  for (let node: Element | null = target; node && node !== document.body; node = node.parentElement) if (node.scrollTop > 0) return true;
  return false;
}

/** Pull down from the top of a screen to reload its data in place. */
export default function PullToRefresh({ enabled }: { enabled: boolean }) {
  const available = usePullRefreshAvailable();
  const [pull, setPull] = useState(0);
  const [state, setState] = useState<"idle" | "pulling" | "refreshing" | "message">("idle");
  const [message, setMessage] = useState("");
  const busy = useRef(false);
  const ready = enabled && available;

  const settled = useRef(true);

  function move(distance: number, animate: boolean) {
    setPull(distance); settled.current = !distance;
    const page = document.querySelector<HTMLElement>("main.signed-in");
    if (!page || reducedMotion()) return;
    page.style.transition = animate ? "transform 280ms cubic-bezier(.2, .8, .2, 1)" : "none";
    page.style.transform = distance ? `translateY(${distance}px)` : "translateY(0)";
    // A transform changes how fixed and sticky content inside the page behaves, so clear it once settled.
    if (!distance) window.setTimeout(() => { if (!busy.current && settled.current) { page.style.transform = ""; page.style.transition = ""; } }, animate ? 300 : 0);
  }

  async function refresh() {
    busy.current = true; setState("refreshing"); move(hold, true);
    const started = performance.now();
    let text = "";
    if (!connection().reachable && !await checkConnection(true)) text = offlineText;
    else {
      const ok = await runPullRefresh();
      text = !connection().reachable ? offlineText : ok ? "" : failedText;
    }
    await wait(Math.max(0, minimumSpin - (performance.now() - started)));
    if (text) { setMessage(text); setState("message"); await wait(messageTime); }
    busy.current = false; setState("idle"); move(0, true);
  }
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!ready) return;
    document.documentElement.classList.add("pull-refresh-ready");
    let start: { x: number; y: number } | null = null;
    let mode: "pull" | "other" | null = null;
    let distance = 0;
    function begin(event: TouchEvent) {
      start = null; mode = null; distance = 0;
      if (busy.current || event.touches.length !== 1 || window.scrollY > 0 || blocked(event.target)) return;
      start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    }
    function track(event: TouchEvent) {
      if (!start || mode === "other") return;
      if (event.touches.length !== 1) { mode = "other"; if (distance) move(0, true); return; }
      const dx = event.touches[0].clientX - start.x;
      const dy = event.touches[0].clientY - start.y;
      // Decide on the first movement, before the browser starts its own scroll or bounce.
      if (!mode) mode = dy > 0 && dy >= Math.abs(dx) && window.scrollY <= 0 ? "pull" : "other";
      if (mode !== "pull") return;
      if (event.cancelable) event.preventDefault();
      distance = resist(Math.max(0, dy));
      setState("pulling"); move(distance, false);
    }
    function end() {
      if (mode === "pull") {
        if (distance >= trigger) void refreshRef.current();
        else { setState("idle"); move(0, true); }
      }
      start = null; mode = null; distance = 0;
    }
    document.addEventListener("touchstart", begin, { passive: true });
    document.addEventListener("touchmove", track, { passive: false });
    document.addEventListener("touchend", end);
    document.addEventListener("touchcancel", end);
    return () => {
      document.documentElement.classList.remove("pull-refresh-ready");
      document.removeEventListener("touchstart", begin);
      document.removeEventListener("touchmove", track);
      document.removeEventListener("touchend", end);
      document.removeEventListener("touchcancel", end);
      if (!busy.current) move(0, false);
    };
  }, [ready]);

  const progress = Math.min(1, pull / trigger);
  const spinning = state === "refreshing";
  return <div className="pull-refresh" data-state={state}
    style={{ "--pull": `${pull}px`, "--pull-progress": progress } as CSSProperties}>
    {state === "message" ? <p className="pull-refresh-message" aria-hidden="true">{message}</p>
      : state !== "idle" && <span className="pull-refresh-spinner" data-ready={pull >= trigger || spinning || undefined}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"
          style={spinning ? undefined : { transform: `rotate(${progress * 270}deg)` }}>
          <path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v4.5h-4.5" />
        </svg>
      </span>}
    <span className="sr-only" role="status">{spinning ? "Refreshing" : state === "message" ? message : ""}</span>
  </div>;
}
