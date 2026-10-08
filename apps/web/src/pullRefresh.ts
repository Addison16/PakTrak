import { useEffect, useRef, useState, useSyncExternalStore } from "react";

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

/**
 * A reload counter for screens that load in an effect. Pulling bumps it and
 * waits until the effect calls settle(), so the spinner stays until data lands.
 */
export function usePullReload(active: boolean) {
  const [reload, setReload] = useState(0);
  const waiting = useRef<((error?: unknown) => void)[]>([]);
  const settle = (error?: unknown) => { const list = waiting.current; waiting.current = []; list.forEach((finish) => finish(error)); };
  useEffect(() => () => settle(), []);
  usePullRefresh(active, () => new Promise<void>((resolve, reject) => {
    waiting.current.push((error) => error === undefined ? resolve() : reject(error));
    setReload((value) => value + 1);
  }));
  return { reload, setReload, settle };
}

export function usePullRefreshAvailable() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => handlers.size > 0);
}

/** Runs every registered reload; resolves false if any of them failed. */
export async function runPullRefresh() {
  // A screen that never answers shouldn't leave the spinner up.
  const limit = (work: Promise<unknown>) => Promise.race([work, new Promise((_, reject) => window.setTimeout(() => reject(new Error("Refresh took too long")), 20000))]);
  const results = await Promise.allSettled([...handlers].map(async (entry) => limit(Promise.resolve(entry.run()))));
  return results.every((result) => result.status === "fulfilled");
}
