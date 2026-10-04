import { useLayoutEffect, useRef, useSyncExternalStore } from "react";

export type Page = "scan" | "batches" | "collection" | "transfers" | "decks" | "admin" | "account";
export type Route = { page: Page; batch?: string; deck?: string; account?: string; view?: "edit" | "import" | "scan"; card?: string; overlay?: "menu" | "camera"; targetDeck?: string; fromBatch?: string; collect?: boolean; collectionQuery?: string };
type Entry = { paktrak: 1; chain: string; index: number; route: Route; y: number };
type Guard = (from: Route, to: Route) => boolean;
const pages: Page[] = ["scan", "batches", "collection", "transfers", "decks", "admin", "account"];
const identifier = (value: string | null | undefined) => value && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : undefined;

function parse(): Route {
  if (new URLSearchParams(location.search).has("account")) return { page: "account" };
  const [path, query] = location.hash.replace(/^#\/?/, "").split("?");
  const [page, id, view] = path.split("/");
  const route: Route = { page: pages.includes(page as Page) ? page as Page : "scan" };
  if (route.page === "batches" && identifier(id)) route.batch = id;
  if (route.page === "decks") {
    if (id === "import" || id === "scan") route.view = id;
    else if (identifier(id)) { route.deck = id; if (view === "edit" || view === "import" || view === "scan") route.view = view; }
  }
  if (route.page === "admin" && identifier(id)) route.account = id;
  const params = new URLSearchParams(query);
  if (route.page === "scan") { route.targetDeck = identifier(params.get("deck")); if (route.targetDeck && params.get("collection") === "1") route.collect = true; }
  if (route.page === "decks" && route.view === "scan") route.fromBatch = identifier(params.get("batch"));
  if (route.page === "collection" || route.deck) route.card = identifier(params.get("card"));
  if (route.page === "collection" && (params.get("filters")?.length || 0) <= 2400) route.collectionQuery = params.get("filters") || undefined;
  if (params.get("overlay") === "menu") route.overlay = "menu";
  if (params.get("overlay") === "camera" && route.page === "scan") route.overlay = "camera";
  return route;
}

function hash(route: Route) {
  let path = route.page as string;
  if (route.batch || route.deck || route.account) path += "/" + (route.batch || route.deck || route.account);
  if (route.view) path += "/" + route.view;
  const params = new URLSearchParams();
  if (route.targetDeck) params.set("deck", route.targetDeck);
  if (route.collect) params.set("collection", "1");
  if (route.fromBatch) params.set("batch", route.fromBatch);
  if (route.card) params.set("card", route.card);
  if (route.overlay) params.set("overlay", route.overlay);
  if (route.page === "collection" && route.collectionQuery) params.set("filters", route.collectionQuery);
  const query = params.toString();
  return "#/" + path + (query ? "?" + query : "");
}
const same = (a: Route, b: Route) => hash(a) === hash(b);
export const sameScreen = (a: Route, b: Route) => same({ ...a, overlay: undefined, card: undefined, collectionQuery: undefined }, { ...b, overlay: undefined, card: undefined, collectionQuery: undefined });
function isEntry(value: unknown): value is Entry {
  const item = value as Entry | null;
  return !!item && item.paktrak === 1 && typeof item.chain === "string" && Number.isSafeInteger(item.index) && item.index >= 0 && !!item.route && pages.includes(item.route.page);
}

// Navigation identifiers and collection filters enter browser history, never drafts,
// session tokens or the temporary password shown after an administrator reset.
const saved = isEntry(history.state) ? history.state : null;
let current: Entry = { paktrak: 1, chain: saved?.chain || crypto.randomUUID(), index: saved?.index || 0, route: parse(), y: saved?.y || 0 };
const entries = new Map<number, Entry>([[current.index, current]]);
const listeners = new Set<() => void>();
const guards = new Set<Guard>();
let restoring = false;
let approved: number | null = null;
let travelling = false;
let scrollTarget: number | null = null;
let scrollFrame = 0;
history.scrollRestoration = "manual";
history.replaceState(current, "", location.pathname + location.search + hash(current.route));

function allowed(to: Route) { return [...guards].every((guard) => guard(current.route, to)); }
function rememberScroll() {
  current = { ...current, y: window.scrollY };
  entries.set(current.index, current);
  history.replaceState(current, "", location.href);
}
function publish(entry: Entry, restore: boolean) {
  current = entry; entries.set(entry.index, entry);
  const sameRecord = sameScreen({ ...snapshot, view: undefined }, { ...entry.route, view: undefined });
  // Editing/foil shortcuts manage their own focus inside the current record.
  scrollTarget = restore ? entry.y : sameRecord ? null : 0;
  snapshot = entry.route;
  listeners.forEach((notify) => notify());
  requestAnimationFrame(() => requestAnimationFrame(restoreScroll));
}
let snapshot = current.route;
export function restoreScroll() {
  if (scrollTarget === null) return;
  window.scrollTo(0, scrollTarget);
  // Retry after loading only when the record is still too short to reach the
  // saved position. Ordinary background refreshes must not move the reader.
  if (Math.abs(window.scrollY - scrollTarget) < 2) scrollTarget = null;
}
window.addEventListener("pointerdown", () => { scrollTarget = null; }, { passive: true });
window.addEventListener("touchstart", () => { scrollTarget = null; }, { passive: true });
window.addEventListener("wheel", () => { scrollTarget = null; }, { passive: true });
window.addEventListener("keydown", (event) => {
  if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", "Tab"].includes(event.key)) scrollTarget = null;
});
window.addEventListener("scroll", () => {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    // Keep scrolling cheap and avoid Safari's history-mutation rate limit.
    // The browser entry is persisted only when leaving or hiding the page.
    if (!travelling && isEntry(history.state) && history.state.index === current.index) {
      current = { ...current, y: window.scrollY }; entries.set(current.index, current);
    }
  });
}, { passive: true });
window.addEventListener("pagehide", () => { if (!travelling) rememberScroll(); });

window.addEventListener("popstate", (event: PopStateEvent) => {
  const stored = isEntry(event.state) && event.state.chain === current.chain ? event.state : null;
  if (!stored) {
    // An address-bar hash change is a normal new destination, not a trap at
    // the beginning of history. Cross-document Back remains browser-owned.
    const route = parse();
    if (!allowed(route)) { history.replaceState(current, "", location.pathname + hash(current.route)); return; }
    const entry: Entry = { ...current, index: current.index + 1, route, y: 0 };
    history.replaceState(entry, "", location.pathname + hash(route)); publish(entry, true); return;
  }
  if (restoring) {
    if (stored.index !== current.index) { history.go(current.index - stored.index); return; }
    restoring = false; travelling = false; approved = null; restoreScroll(); return;
  }
  const entry = { ...(entries.get(stored.index) || stored), route: parse() };
  if (approved !== entry.index && !allowed(entry.route)) {
    // popstate cannot be cancelled. Return to the original entry without
    // unmounting its editor, preserving both the draft and Forward history.
    restoring = true; travelling = true; scrollTarget = current.y;
    history.go(current.index - entry.index); return;
  }
  approved = null; travelling = false;
  publish(entry, true);
});

export const navigation = {
  get route() { return snapshot; },
  go(route: Route, options: { replace?: boolean; force?: boolean } = {}) {
    if (travelling) return false;
    if (same(current.route, route)) return true;
    if (!options.force && !allowed(route)) return false;
    rememberScroll();
    const entry: Entry = { ...current, index: current.index + (options.replace ? 0 : 1), route, y: 0 };
    if (!options.replace) for (const index of entries.keys()) if (index > current.index) entries.delete(index);
    history[options.replace ? "replaceState" : "pushState"](entry, "", location.pathname + hash(route));
    publish(entry, false); return true;
  },
  close(route: Route, force = false) {
    if (travelling || (!force && !allowed(route))) return false;
    const previous = [...entries.values()].filter((entry) => entry.index < current.index && same(entry.route, route)).sort((a, b) => b.index - a.index)[0];
    if (!previous) return this.go(route, { replace: true, force: true });
    rememberScroll(); approved = previous.index; travelling = true;
    history.go(previous.index - current.index); return true;
  },
  cleanQuery() { history.replaceState(current, "", location.pathname + hash(current.route)); },
};

export function useRoute() {
  return useSyncExternalStore((notify) => { listeners.add(notify); return () => { listeners.delete(notify); }; }, () => snapshot);
}
export function useNavigationGuard(guard: Guard) {
  const latest = useRef(guard); latest.current = guard;
  useLayoutEffect(() => {
    const handler: Guard = (from, to) => latest.current(from, to);
    guards.add(handler); return () => { guards.delete(handler); };
  }, []);
}
