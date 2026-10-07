/* PakTrak service worker: keeps the app and card pictures so PakTrak opens
   without a connection. Collection and deck data are saved by the app itself
   (src/offline.ts); this worker never stores API responses other than card
   pictures. Built by sw/plugin.js, which fills in the values below. */
const VERSION = "__VERSION__";
const PRECACHE = __PRECACHE__;
const IMAGE_LIMIT = __IMAGE_LIMIT__;
const SHELL = "paktrak-shell-" + VERSION;
const IMAGES = "paktrak-card-images";
const PAGE_WAIT = 5000;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((names) => Promise.all(names.filter((name) => name.startsWith("paktrak-shell-") && name !== SHELL).map((name) => caches.delete(name))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/v1/card-images/")) event.respondWith(cardImage(request));
  else if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/identity/")) return;
  else if (request.mode === "navigate") event.respondWith(page(request));
  else event.respondWith(asset(request, url));
});

// Pages: the server first so updates show right away; the saved app when the
// server doesn't answer within a few seconds.
async function page(request) {
  const cache = await caches.open(SHELL);
  const network = fetch(request).then((response) => {
    if (response.ok && response.headers.get("Content-Type")?.includes("text/html")) void cache.put("/", response.clone());
    return response;
  });
  const saved = await cache.match("/");
  if (!saved) return network;
  return Promise.race([network.catch(() => saved), new Promise((resolve) => setTimeout(() => resolve(saved), PAGE_WAIT))]);
}

// Built files have content hashes in their names, so a saved copy never goes
// stale. Other public files are refreshed in the background.
async function asset(request, url) {
  const saved = await caches.match(request, { ignoreVary: true });
  const network = fetch(request).then(async (response) => {
    if (response.ok && response.type === "basic") await (await caches.open(SHELL)).put(request, response.clone());
    return response;
  });
  if (saved) { if (!url.pathname.startsWith("/assets/")) network.catch(() => {}); return saved; }
  return network;
}

let added = 0;
async function cardImage(request) {
  const cache = await caches.open(IMAGES);
  const saved = await cache.match(request, { ignoreVary: true });
  if (saved) return saved;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    await cache.put(request, response.clone());
    if (++added % 25 === 0) await trim(cache);
  }
  return response;
}
// Keeps the newest pictures; the oldest are dropped first.
async function trim(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - IMAGE_LIMIT)).map((key) => cache.delete(key)));
}
