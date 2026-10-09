import { useSyncExternalStore } from "react";
import { clearPendingPhotos } from "./pendingPhoto";
import { clearDrafts } from "./recovery";

// Offline layer: saved copies of server reads, a queue of edits made while the
// server can't be reached, and the connection state shown in the header.
// Screens opt in per endpoint, so new features can join without changes here.

export type QueuedAction = {
  id: string; owner: string; label: string; detail?: string;
  path: string; method: string; body?: string; contentType?: string; idempotencyKey: string;
  // Edits to the same item replay in order; each success updates the next one's expected_version.
  resource?: string;
  // What the screen showed after the edit, so it can show it again until the edit is sent.
  preview?: unknown;
  createdAt: number; state: "waiting" | "sending" | "failed"; error?: string;
};
export type Connection = {
  reachable: boolean; savedCopy: boolean; checking: boolean; sending: boolean; signInNeeded: boolean;
  waiting: number; failed: number; owner: string;
};

const databaseName = "paktrak-offline";
const deviceScope = "device";
// Reads cached for the signed-in account. Paths are matched without their query.
const readable: RegExp[] = [
  /^\/api\/v1\/collection$/, /^\/api\/v1\/collection\/cards(\/[\w-]+)?$/, /^\/api\/v1\/collection\/filters$/,
  /^\/api\/v1\/collection\/printings\/[\w-]+$/, /^\/api\/v1\/binders$/,
  /^\/api\/v1\/decks$/, /^\/api\/v1\/decks\/[\w-]+$/, /^\/api\/v1\/scans$/, /^\/api\/auth\/me$/,
];
// Reads needed to open the app at all, kept for the device rather than one account.
const deviceReads = new Set(["/api/auth/session", "/api/auth/status", "/api/v1/capabilities"]);
const maxSavedResponses = 600;

/** Lets a screen keep its server reads for offline viewing. */
export function allowOfflineRead(pattern: RegExp) { if (!readable.some((item) => item.source === pattern.source)) readable.push(pattern); }
export function offlineReadable(path: string) {
  const endpoint = path.split("?")[0];
  return deviceReads.has(endpoint) || readable.some((pattern) => pattern.test(endpoint));
}

let state: Connection = { reachable: typeof navigator === "undefined" || navigator.onLine, savedCopy: false, checking: false, sending: false, signInNeeded: false, waiting: 0, failed: 0, owner: "" };
const listeners = new Set<() => void>();
const reconnectListeners = new Set<() => void>();
function set(change: Partial<Connection>) {
  const next = { ...state, ...change };
  if ((Object.keys(next) as (keyof Connection)[]).every((key) => next[key] === state[key])) return;
  const recovered = !state.reachable && next.reachable;
  state = next; listeners.forEach((listener) => listener());
  if (recovered) reconnectListeners.forEach((listener) => listener());
}
export const connection = () => state;
export function useConnection() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, connection);
}
/** Runs whenever the server becomes reachable again. */
export function onReconnect(listener: () => void) { reconnectListeners.add(listener); return () => { reconnectListeners.delete(listener); }; }

// ---- Storage ----
let opening: Promise<IDBDatabase | null> | null = null;
const memory = { responses: new Map<string, unknown>(), queue: new Map<string, QueuedAction>() };
function database() {
  opening ||= new Promise<IDBDatabase | null>((resolve) => {
    try {
      const open = indexedDB.open(databaseName, 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("responses", { keyPath: "key" }).createIndex("owner", "owner");
        open.result.createObjectStore("queue", { keyPath: "id" }).createIndex("owner", "owner");
      };
      open.onsuccess = () => { open.result.onversionchange = () => { open.result.close(); opening = null; }; resolve(open.result); };
      // Private browsing and blocked storage fall back to this tab's memory.
      open.onerror = open.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return opening;
}
type Saved = { key: string; owner: string; path: string; data: unknown; savedAt: number };
function run<T>(storeName: "responses" | "queue", mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest | void): Promise<T | undefined> {
  return database().then((db) => new Promise<T | undefined>((resolve) => {
    if (!db) { resolve(undefined); return; }
    try {
      const transaction = db.transaction(storeName, mode);
      const request = work(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request ? request.result as T : undefined);
      transaction.onerror = transaction.onabort = () => resolve(undefined);
    } catch { resolve(undefined); }
  }));
}
const fallbackStore = async () => !(await database());

// Query order and empty values don't change what the server returns.
function normalize(path: string) {
  const [endpoint, query = ""] = path.split("?");
  const params = [...new URLSearchParams(query)].filter(([, value]) => value !== "").sort(([a], [b]) => a.localeCompare(b));
  return params.length ? endpoint + "?" + new URLSearchParams(params) : endpoint;
}
function responseKey(path: string) {
  const scope = deviceReads.has(path.split("?")[0]) ? deviceScope : state.owner;
  return scope ? { key: scope + " " + normalize(path), owner: scope } : null;
}

let writes = 0;
export async function saveResponse(path: string, data: unknown) {
  const key = responseKey(path); if (!key) return;
  const value: Saved = { ...key, path: normalize(path), data, savedAt: Date.now() };
  if (await fallbackStore()) { memory.responses.set(key.key, value); return; }
  await run("responses", "readwrite", (store) => { store.put(value); });
  if (++writes % 40 === 0) void pruneResponses();
}
export async function savedResponse<T>(path: string): Promise<{ data: T; savedAt: number } | undefined> {
  const key = responseKey(path); if (!key) return;
  if (await fallbackStore()) return memory.responses.get(key.key) as Saved & { data: T } | undefined;
  return run<Saved & { data: T }>("responses", "readonly", (store) => store.get(key.key));
}
// Builds a reply from other saved copies when the exact request was never saved,
// for example one card's copies from the saved pages of the whole collection.
type Fallback = { pattern: RegExp; build: (path: string) => Promise<unknown | undefined> };
const fallbacks: Fallback[] = [];
export function addOfflineFallback(pattern: RegExp, build: Fallback["build"]) { fallbacks.push({ pattern, build }); }
export async function savedOrDerived<T>(path: string): Promise<{ data: T; savedAt: number } | undefined> {
  const copy = await savedResponse<T>(path);
  if (copy) return copy;
  const endpoint = path.split("?")[0];
  for (const fallback of fallbacks) {
    if (!fallback.pattern.test(endpoint)) continue;
    try { const data = await fallback.build(path); if (data !== undefined) return { data: data as T, savedAt: 0 }; } catch { /* Try the next one. */ }
  }
}
/** Saved copies for this account whose path starts with the prefix. */
export async function savedResponses<T>(prefix: string): Promise<{ path: string; data: T }[]> {
  const owner = state.owner; if (!owner) return [];
  const all = await fallbackStore() ? [...memory.responses.values()] as Saved[] : await run<Saved[]>("responses", "readonly", (store) => store.index("owner").getAll(owner)) || [];
  return all.filter((item) => item.owner === owner && item.path.startsWith(prefix)).map((item) => ({ path: item.path, data: item.data as T }));
}
export async function forgetResponse(path: string) {
  const key = responseKey(path); if (!key) return;
  memory.responses.delete(key.key);
  await run("responses", "readwrite", (store) => { store.delete(key.key); });
}
async function pruneResponses() {
  const all = await run<Saved[]>("responses", "readonly", (store) => store.getAll()) || [];
  if (all.length <= maxSavedResponses) return;
  const old = all.filter((item) => item.owner !== deviceScope).sort((a, b) => a.savedAt - b.savedAt).slice(0, all.length - maxSavedResponses);
  await run("responses", "readwrite", (store) => { old.forEach((item) => store.delete(item.key)); });
}
export async function savedResponseCount() {
  if (await fallbackStore()) return memory.responses.size;
  const owner = state.owner;
  return owner ? await run<number>("responses", "readonly", (store) => store.index("owner").count(owner)) || 0 : 0;
}

// ---- Queue ----
export async function queuedActions(owner = state.owner): Promise<QueuedAction[]> {
  if (!owner) return [];
  const items = await fallbackStore() ? [...memory.queue.values()].filter((item) => item.owner === owner)
    : await run<QueuedAction[]>("queue", "readonly", (store) => store.index("owner").getAll(owner)) || [];
  return items.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
export async function putQueued(action: QueuedAction) {
  if (await fallbackStore()) memory.queue.set(action.id, action);
  else await run("queue", "readwrite", (store) => { store.put(action); });
  await countQueue();
}
export async function removeQueued(id: string) {
  if (await fallbackStore()) memory.queue.delete(id);
  else await run("queue", "readwrite", (store) => { store.delete(id); });
  await countQueue();
}
/** The latest unsent preview for each resource starting with the prefix, merged in order. */
export async function pendingPreviews<T extends object>(prefix: string): Promise<Map<string, Partial<T>>> {
  const result = new Map<string, Partial<T>>();
  if (!state.waiting) return result;
  for (const item of await queuedActions()) {
    if (item.state === "failed" || !item.resource?.startsWith(prefix) || !item.preview || typeof item.preview !== "object") continue;
    result.set(item.resource, { ...result.get(item.resource), ...item.preview as Partial<T> });
  }
  return result;
}
let createdLast = 0;
export async function enqueue(action: Omit<QueuedAction, "id" | "owner" | "createdAt" | "state">) {
  // Strictly increasing times keep two quick edits in the order they were made.
  createdLast = Math.max(Date.now(), createdLast + 1);
  const queued: QueuedAction = { ...action, id: crypto.randomUUID(), owner: state.owner, createdAt: createdLast, state: "waiting" };
  await putQueued(queued);
  return queued;
}
export async function countQueue() {
  const items = await queuedActions();
  set({ waiting: items.filter((item) => item.state !== "failed").length, failed: items.filter((item) => item.state === "failed").length });
  window.dispatchEvent(new CustomEvent("paktrak:queue"));
}
export function setSending(sending: boolean) { set({ sending }); }
export function setSignInNeeded(signInNeeded: boolean) { set({ signInNeeded }); }

// ---- Connection ----
export function setOfflineOwner(owner: string) {
  if (owner === state.owner) return;
  set({ owner }); void countQueue();
}
const ownerKey = "paktrak.offline.owner";
/** Records who last signed in on this device; a different account's sign-in
    first removes everything the previous account kept here. */
export async function adoptOfflineOwner(owner: string) {
  let previous = "";
  try { previous = localStorage.getItem(ownerKey) || ""; } catch { /* Nothing was remembered. */ }
  if (previous && previous !== owner) { await clearOfflineData(); clearDrafts(); }
  try { localStorage.setItem(ownerKey, owner); } catch { /* The copies are still cleared above. */ }
  setOfflineOwner(owner);
}
// An answer from the server is the final word: some desktop browsers report
// being offline (a VPN or virtual adapter) while requests still go through.
export function markReachable(reachable: boolean, savedCopy = false) {
  set({ reachable, savedCopy: reachable ? false : savedCopy || state.savedCopy });
  if (!reachable) schedule();
}
export function markSavedCopy() { set({ savedCopy: true }); }

let probeTimer = 0;
function schedule() {
  window.clearTimeout(probeTimer);
  probeTimer = window.setTimeout(() => void checkConnection(), 15000);
}
// A plain request to the server's health check; works on HTTP and HTTPS alike.
let lastCheck = 0;
export async function checkConnection(force = true) {
  if (state.checking || !force && Date.now() - lastCheck < 5000) return state.reachable;
  lastCheck = Date.now();
  set({ checking: true });
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 6000);
  let ok = false;
  try { ok = (await fetch("/api/health/live", { cache: "no-store", credentials: "same-origin", signal: controller.signal })).ok; }
  catch { ok = false; }
  finally { window.clearTimeout(timer); set({ checking: false }); }
  markReachable(ok);
  return ok;
}
if (typeof window !== "undefined") {
  window.addEventListener("online", () => { if (!state.reachable) void checkConnection(); });
  window.addEventListener("offline", () => markReachable(false));
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !state.reachable) void checkConnection(); });
}

/** Removes every saved copy and queued edit on this device, as on sign out. */
export async function clearOfflineData() {
  try { localStorage.removeItem(ownerKey); } catch { /* Nothing was remembered. */ }
  memory.responses.clear(); memory.queue.clear();
  await run("responses", "readwrite", (store) => { store.clear(); });
  await run("queue", "readwrite", (store) => { store.clear(); });
  try { await globalThis.caches?.delete("paktrak-card-images"); } catch { /* Not available over plain HTTP. */ }
  await clearPendingPhotos();
  await countQueue();
}
