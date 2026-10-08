import { useEffect, useRef, useSyncExternalStore } from "react";

type Handler = () => unknown;

// Screens that can reload their data in place. Pulling down runs the ones on
// screen; a screen without one (forms, trade value) doesn't offer the gesture.
const handlers = new Set<{ run: Handler }>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

/** Registers what pulling down reloads while this screen is showing. */
export function usePullRefresh(active: boolean, handler: Handler) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!active) return;
    const entry = { run: () => latest.current() };
    handlers.add(entry); notify();
    return () => { handlers.delete(entry); notify(); };
  }, [active]);
}

export function usePullRefreshAvailable() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => handlers.size > 0);
}

/** Runs every registered reload; resolves false if any of them failed. */
export async function runPullRefresh() {
  const results = await Promise.allSettled([...handlers].map(async (entry) => entry.run()));
  return results.every((result) => result.status === "fulfilled");
}
