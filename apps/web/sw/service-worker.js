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

// A page that was already open keeps running the build it loaded until it
// reloads, and its screens load on demand from that build's files. So each
// open page is noted with its build, and only shell caches no open page can
// still need are removed.
const META = "paktrak-meta";
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const meta = await caches.open(META);
    const previous = await meta.match("/current").then((saved) => saved ? saved.text() : "", () => "");
    const noted = await meta.match("/pages").then((saved) => saved ? saved.json() : {}, () => ({}));
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // A page open now runs the previous build, unless an earlier update already noted an older one for it.
    const pages = {};
    for (const client of open) { const build = noted[client.id] || previous; if (build) pages[client.id] = build; }
    const keep = new Set([SHELL, ...Object.values(pages)]);
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith("paktrak-shell-") && !keep.has(name)).map((name) => caches.delete(name)));
    await meta.put("/current", new Response(SHELL));
    await meta.put("/pages", new Response(JSON.stringify(pages)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/v1/card-images/")) event.respondWith(cardImage(request));
  else if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/identity/")) return;
  else if (request.mode === "navigate") event.respondWith(page(request));
  else event.respondWith(asset(request, url, event.clientId));
});

// Pages: the server first so updates show right away; the saved app when the
// server doesn't answer within a few seconds, or when something in front of it
// answers that it's down (a 5xx page from Cloudflare or another proxy while
// the server restarts). The app then shows its saved copies and queues edits.
async function page(request) {
  const cache = await caches.open(SHELL);
  const network = fetch(request).then((response) => {
    if (response.ok && response.headers.get("Content-Type")?.includes("text/html")) void cache.put("/", response.clone());
    return response;
  });
  const saved = await cache.match("/");
  if (!saved) return network;
  const answer = network.then((response) => response.status >= 500 ? saved : response, () => saved);
  return Promise.race([answer, new Promise((resolve) => setTimeout(() => resolve(saved), PAGE_WAIT))]);
}

// Built files have content hashes in their names, so a saved copy never goes
// stale. Other public files are refreshed in the background.
async function asset(request, url, clientId) {
  const saved = await caches.match(request, { ignoreVary: true });
  const network = fetch(request).then(async (response) => {
    if (response.ok && response.type === "basic") await (await caches.open(SHELL)).put(request, response.clone());
    return response;
  });
  if (saved) { if (!url.pathname.startsWith("/assets/")) network.catch(() => {}); return saved; }
  if (url.pathname.startsWith("/assets/")) return network.then((response) => response.status === 404 ? reloadStalePage(response, clientId) : response);
  return network;
}

// A built file that neither the cache nor the server has belongs to a build
// the asking page no longer matches: that page, and only that page, reloads
// so it gets the current build.
async function reloadStalePage(response, clientId) {
  const client = clientId ? await self.clients.get(clientId) : null;
  if (client && "navigate" in client) client.navigate(client.url).catch(() => {});
  return response;
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
