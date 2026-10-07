import ErrorNotice from "./ErrorNotice";
import usePriceSource from "./usePriceSource";
import useBackgroundError from "./useBackgroundError";
import { useEffect, useRef, useState } from "react";
import { navigation, restoreScroll, useRoute } from "./navigation";
import ValueChart, { changeText } from "./ValueChart";
import "./social.css";
import { ApiError, isPriceSource, money, providers, request, type HistoryChange, type HistoryPoint, type CollectionCard, type DataFeed, type Location, type PricingIssues, type Session } from "./api";
import CardDetail, { CardArt } from "./CardDetail";
import { captureCardFlight, preloadCardBack, type CardFlightOrigin } from "./CardArrival";
import DataUpdates from "./DataUpdates";
import Locations from "./Locations";
import { Icon } from "./Icon";
import BulkCollection from "./BulkCollection";
import CountUp from "./CountUp";
import "./collection-qol.css";
import "./card-foil.css";

type Result = { copies: number; cards: number; items: CollectionCard[]; next_offset: number | null; valuation: { provider: string; amount: string | null; priced_copies: number; unpriced_copies: number; pricing_issues?: PricingIssues; feed: DataFeed | null } };
const colors = [["", "All"], ["W", "White"], ["U", "Blue"], ["B", "Black"], ["R", "Red"], ["G", "Green"], ["M", "Multi"], ["C", "Colorless"]];
const initial = { binder: "", color: "", rarity: "", card_type: "", set_code: "", finish: "", min_price: "", max_price: "" };
type View = { query: string; filters: typeof initial; sort: string; seed: string; view: string };
type SavedView = { name: string; value: string };
function readSetting<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; }
}
function remember(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
function decodeView(value: string | undefined): View {
  const params = new URLSearchParams(typeof value === "string" ? value.slice(0, 2400) : "");
  const filters = { ...initial };
  for (const key of Object.keys(filters) as (keyof typeof initial)[]) filters[key] = (params.get(key) || "").slice(0, 255);
  if (!colors.some(([color]) => color === filters.color)) filters.color = "";
  if (!["", "nonfoil", "foil", "etched", "unknown"].includes(filters.finish)) filters.finish = "";
  for (const key of ["min_price", "max_price"] as const) if (filters[key] && (!Number.isFinite(Number(filters[key])) || Number(filters[key]) < 0)) filters[key] = "";
  const sort = params.get("sort") || "name";
  return { query: (params.get("q") || "").slice(0, 255), filters, sort: ["name", "price_asc", "price_desc", "quantity", "newest", "mana", "shuffle"].includes(sort) ? sort : "name", seed: (params.get("seed") || "").slice(0, 80), view: params.get("view") === "list" ? "list" : "gallery" };
}
function encodeView(value: View) {
  return new URLSearchParams(Object.entries({ q: value.query, ...value.filters, sort: value.sort, seed: value.seed, view: value.view }).filter(([, entry]) => entry)).toString();
}

function ownedSheen(card: CollectionCard) {
  function count(finish: "foil" | "etched") {
    const value = card.finish_counts?.[finish];
    return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= card.quantity ? value : 0;
  }
  const foil = count("foil"), etched = count("etched");
  if (!foil && !etched) return undefined;
  const amount = foil + etched;
  const label = foil && etched ? "Foil finishes" : `${foil ? "Foil" : "Etched"}${amount < card.quantity ? ` · ×${amount.toLocaleString()}` : ""}`;
  const description = [foil && `${foil.toLocaleString()} foil ${foil === 1 ? "copy" : "copies"}`, etched && `${etched.toLocaleString()} etched ${etched === 1 ? "copy" : "copies"}`].filter(Boolean).join(" and ");
  return { finish: foil ? "foil" : "etched", label, description };
}


export default function Gallery({ session }: { session: Session }) {
  return <AccountGallery key={session.owner_id} session={session} />;
}

function AccountGallery({ session }: { session: Session }) {
  const route = useRoute();
  useEffect(preloadCardBack, []);
  const active = route.page === "collection";
  const settingsKey = "paktrak.collection." + session.owner_id;
  const [start] = useState(() => decodeView(route.collectionQuery ?? readSetting<string>(settingsKey, "")));
  const [data, setData] = useState<Result | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [sets, setSets] = useState<{ code: string; name: string }[]>([]);
  const [query, setQuery] = useState(start.query); const [search, setSearch] = useState(start.query);
  const [filters, setFilters] = useState(start.filters);
  const { provider, ready: sourceReady, saving: sourceSaving, preferenceError, retry, change: changeSource, retrySave } = usePriceSource(session);
  const [minPrice, setMinPrice] = useState(start.filters.min_price); const [maxPrice, setMaxPrice] = useState(start.filters.max_price);
  const [priceError, setPriceError] = useState("");
  const [sort, setSort] = useState(start.sort); const [seed, setSeed] = useState(start.seed);
  const [offset, setOffset] = useState(0); const [view, setView] = useState(start.view);
  // "More cards" adds the next page below the cards already shown instead of replacing them.
  const [kept, setKept] = useState<CollectionCard[]>([]);
  useEffect(() => { if (offset === 0) setKept([]); }, [offset]);
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => {
    const values = readSetting<unknown>(settingsKey + ".saved", []);
    return Array.isArray(values) ? values.filter((item): item is SavedView => item && typeof item.name === "string" && typeof item.value === "string" && item.value.length <= 2400).slice(0, 20) : [];
  });
  const [viewName, setViewName] = useState("");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [organizing, setOrganizing] = useState(false);
  const [selectedCard, setSelectedCard] = useState<CollectionCard | null>(null);
  const [cardFlight, setCardFlight] = useState<{ cardKey: string; origin: CardFlightOrigin } | null>(null);
  const [cardError, setCardError] = useState<Error | null>(null);
  const [cardRetry, setCardRetry] = useState(0);
  const encoded = encodeView({ query: search, filters, sort, seed, view });
  const lastEncoded = useRef(route.collectionQuery);
  const hydrating = useRef(false);
  const selected = active ? route.card : undefined;
  function setSelected(id: string | null, source?: HTMLElement) {
    const origin = id && source ? captureCardFlight(source, id) : null;
    setCardFlight(id && origin ? { cardKey: id, origin } : null);
    if (id) navigation.go({ ...navigation.route, page: "collection", card: id });
    else if (navigation.route.page === "collection" && navigation.route.card) navigation.close({ ...navigation.route, card: undefined });
  }
  const [notice, setNotice] = useState("");
  const backgroundError = useBackgroundError(); const [loading, setLoading] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [shownProvider, setShownProvider] = useState(provider);
  const priceFiltered = Boolean(filters.min_price || filters.max_price);
  const filterCount = Object.entries(filters).filter(([key, value]) => !["min_price", "max_price"].includes(key) && value).length + Number(priceFiltered);
  function loadView(value: string | undefined) {
    const next = decodeView(value);
    setQuery(next.query); setSearch(next.query); setFilters(next.filters); setSort(next.sort); setSeed(next.seed); setView(next.view); setOffset(0); setMinPrice(next.filters.min_price); setMaxPrice(next.filters.max_price); setPriceError("");
  }
  useEffect(() => {
    if (!active || route.collectionQuery === undefined || route.collectionQuery === lastEncoded.current) return;
    lastEncoded.current = route.collectionQuery; hydrating.current = true; loadView(route.collectionQuery);
  }, [route.collectionQuery, active]);
  useEffect(() => {
    if (!active) return;
    if (hydrating.current) { hydrating.current = false; return; }
    remember(settingsKey, encoded); lastEncoded.current = encoded;
    navigation.go({ ...navigation.route, collectionQuery: encoded }, { replace: true });
  }, [encoded, active, settingsKey]);
  function saveView() {
    const name = viewName.trim(); if (!name) return;
    const next = [...savedViews.filter((item) => item.name !== name), { name, value: encoded }].slice(-20);
    setSavedViews(next); setViewName("");
    setNotice(remember(settingsKey + ".saved", next) ? "Collection view saved on this device. Its URL can also be bookmarked." : "Browser storage is unavailable. Bookmark this view’s URL to keep it.");
  }
  useEffect(() => { setSelection([]); }, [filters.binder]);
  useEffect(() => {
    setCardFlight((current) => current && current.cardKey !== selected ? null : current);
  }, [selected]);
  useEffect(() => {
    setSelectedCard(null); setCardError(null);
    if (!selected || !sourceReady) return;
    let cancelled = false;
    request<CollectionCard>(`/api/v1/collection/cards/${selected}?provider=${provider}`).then((value) => { if (!cancelled) setSelectedCard(value); }).catch((error: Error) => { if (!cancelled) setCardError(error); });
    return () => { cancelled = true; };
  }, [selected, provider, sourceReady, cardRetry]);

  useEffect(() => { setOffset(0); }, [provider]);
  useEffect(() => { const timer = setTimeout(() => { setSearch(query.trim()); setOffset(0); }, 300); return () => clearTimeout(timer); }, [query]);
  const metaLoaded = useRef(0);
  // After an edit, locations and sets may have changed too.
  const refreshAll = () => { metaLoaded.current = 0; return refresh(); };
  async function refresh(isCurrent = () => true) {
    const params = new URLSearchParams({ q: search, offset: String(offset), provider, sort, seed, ...filters });
    params.delete("binder"); if (filters.binder) params.set("binder_id", filters.binder);
    if (!filters.min_price) params.delete("min_price"); if (!filters.max_price) params.delete("max_price");
    // Locations and the set list rarely change; refresh them with the cards about once a minute.
    const meta = Date.now() - metaLoaded.current > 60000;
    const [result, bins, options] = await Promise.all([
      request<Result>("/api/v1/collection/cards?" + params), meta ? request<{ items: Location[] }>("/api/v1/binders") : null, meta ? request<{ sets: { code: string; name: string }[] }>("/api/v1/collection/filters") : null,
    ]);
    if (!isCurrent()) return;
    if (bins && options) { metaLoaded.current = Date.now(); setLocations(bins.items); setSets(options.sets); }
    setData(result); setShownProvider(provider); setLoading(false); backgroundError.recovered();
    requestAnimationFrame(restoreScroll);
    if (selected) {
      try {
        const detail = await request<CollectionCard>(`/api/v1/collection/cards/${selected}?provider=${provider}`);
        if (isCurrent() && navigation.route.card === selected) setSelectedCard(detail);
      } catch (error) {
        if (isCurrent() && navigation.route.card === selected) {
          if (error instanceof ApiError && error.status === 404) { setSelectedCard(null); navigation.go({ ...navigation.route, card: undefined }, { replace: true, force: true }); }
          else setCardError(error as Error);
        }
      }
    }
  }
  useEffect(() => {
    if (!sourceReady || !active) return;
    let stopped = false; let busy = false; setLoading(true);
    async function poll() {
      if (busy || document.hidden || !navigator.onLine) return;
      busy = true;
      try { await refresh(() => !stopped); } catch (e) { if (!stopped) { backgroundError.failed(e as Error); setLoading(false); } } finally { busy = false; }
    }
    void poll(); const timer = window.setInterval(() => void poll(), 15000);
    document.addEventListener("visibilitychange", poll); window.addEventListener("online", poll);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", poll); window.removeEventListener("online", poll); };
  }, [search, filters, provider, sourceReady, sort, seed, offset, active]);
  function filter(key: keyof typeof initial, value: string) { setFilters({ ...filters, [key]: value }); setOffset(0); }
  function clearFilters() { setFilters(initial); setQuery(""); setSearch(""); setOffset(0); setMinPrice(""); setMaxPrice(""); setPriceError(""); }
  function clearPrice() { setFilters({ ...filters, min_price: "", max_price: "" }); setMinPrice(""); setMaxPrice(""); setPriceError(""); setOffset(0); }
  function applyPrice() {
    if (minPrice && maxPrice && Number(minPrice) > Number(maxPrice)) { setPriceError("Minimum price must not exceed maximum price."); return; }
    setPriceError(""); setFilters({ ...filters, min_price: minPrice, max_price: maxPrice }); setOffset(0);
  }
  const shown = [...kept.filter((item) => !data?.items.some((row) => row.printing.id === item.printing.id)), ...(data?.items || [])];
  // Previous/next card in the order shown; replaces the history entry so Back still closes the card.
  function stepCard(delta: number) {
    const index = shown.findIndex((item) => item.printing.id === selected), target = index < 0 ? undefined : shown[index + delta];
    return target ? () => { setCardFlight(null); navigation.go({ ...navigation.route, page: "collection", card: target.printing.id }, { replace: true }); } : null;
  }
  const card = selectedCard?.printing.id === selected ? selectedCard : shown.find((item) => item.printing.id === selected);
  const value = data?.valuation;
  return <section className="panel gallery-panel">
    <div className="collection-heading"><div><span className="eyebrow">A place for every pull</span><h2>Your collection</h2></div><span className="badge">{(data?.copies || 0).toLocaleString()} copies</span></div>
    <p className="gallery-intro">Follow a favorite. Find your next deck.</p>
    {notice && <p className="message" role="status">{notice}</p>}
    <div className="library-stats"><div><strong>{(data?.cards || 0).toLocaleString()}</strong><span>unique printings</span></div><div><strong>{value?.amount == null ? money(null) : <CountUp value={Number(value.amount)} format={money} />}</strong><span>{providers[shownProvider]} reference value</span></div></div>
    <label className="gallery-price-source">Price source<select value={provider} disabled={!sourceReady || sourceSaving} aria-describedby="price-source-status" onChange={(e) => { if (isPriceSource(e.target.value)) void changeSource(e.target.value); }}>{Object.entries(providers).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
    <p id="price-source-status" className={sourceSaving || !sourceReady || preferenceError ? "fine" : "sr-only"} role="status">{sourceSaving ? "Saving your price source…" : !sourceReady ? preferenceError ? "Retry to load your saved price source." : "Loading your saved price source…" : preferenceError ? "Your choice is not saved to your account yet." : "Price source is remembered for your account."}</p>
    {preferenceError && <p className="message error" role="alert">{preferenceError} <button className="text-button" disabled={sourceSaving} onClick={() => void retrySave()}>{retry ? "Retry saving price source" : "Retry loading price source"}</button></p>}
    <p className="fine value-note">{value ? `${value.priced_copies.toLocaleString()} priced · ${value.unpriced_copies.toLocaleString()} unpriced copies` : "Loading your library…"}{value?.feed?.updated_at ? ` · ${value.feed.stale ? "Older prices · " : "Updated "}${new Date(value.feed.updated_at).toLocaleDateString()}` : " · Prices update daily"}. {filterCount || search ? "Totals match your filters." : ""}</p>
    {active && sourceReady && <ValueOverTime provider={provider} />}
    {value?.pricing_issues && value.unpriced_copies > 0 && <details className="pricing-help"><summary>Why are some copies unpriced?</summary>
      {value.pricing_issues.unknown_finish > 0 && <p className="fine">{value.pricing_issues.unknown_finish.toLocaleString()} copies have no recorded finish. Normal, foil and etched copies have different prices. <button className="text-button" onClick={() => { filter("finish", "unknown"); setFiltersOpen(true); }}>Show copies needing a finish</button></p>}
      {value.pricing_issues.missing_price > 0 && <p className="fine">{value.pricing_issues.missing_price.toLocaleString()} copies have no {providers[shownProvider]} quote for their printing and finish. Another price source may have one.</p>}
      {value.pricing_issues.custom_value > 0 && <p className="fine">{value.pricing_issues.custom_value.toLocaleString()} altered or misprinted copies need an individual valuation.</p>}
    </details>}
    <form className="gallery-search" role="search" onSubmit={(e) => { e.preventDefault(); setSearch(query.trim()); setOffset(0); }}><label className="sr-only" htmlFor="collection-query">Find a card</label><input id="collection-query" type="search" value={query} maxLength={255} placeholder="Name, rules text or Plains #287" onChange={(e) => setQuery(e.target.value)} /><button className="button primary" aria-label="Search collection">Search</button></form>
    <div className="color-filters" aria-label="Color identity">{colors.map(([id, name]) => <button key={id} className={"filter-chip color-" + id} aria-pressed={filters.color === id} onClick={() => filter("color", id)}>{id && <span className="color-dot" aria-hidden="true" />}{name}</button>)}</div>
    <div className="gallery-toolbar"><button className="filter-chip" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>Filters{filterCount ? " · " + filterCount : ""} <span aria-hidden="true">⌄</span></button><button className="text-button" onClick={() => { setSort("shuffle"); setSeed(crypto.randomUUID()); setOffset(0); }}>Shuffle cards ↝</button><div className="view-switch" aria-label="Collection layout"><button aria-pressed={view === "gallery"} onClick={() => setView("gallery")}>Gallery</button><button aria-pressed={view === "list"} onClick={() => setView("list")}>List</button></div></div>
    <div className="gallery-sort"><label>Sort by<select value={sort} onChange={(e) => { setSort(e.target.value); setOffset(0); }}><option value="name">Name</option><option value="price_asc">Price: Low to high</option><option value="price_desc">Price: High to low</option><option value="quantity">Most copies</option><option value="newest">Recently added</option><option value="mana">Mana value</option><option value="shuffle">Shuffled</option></select></label></div>
    <details className="saved-collection-views"><summary>Saved collection views{savedViews.length ? ` · ${savedViews.length}` : ""}</summary><p className="fine">Keep favorite searches, filters, sorting and layout on this device. Bookmark this page to share the view.</p><form className="gallery-search" onSubmit={(event) => { event.preventDefault(); saveView(); }}><label className="sr-only" htmlFor="view-name">View name</label><input id="view-name" value={viewName} maxLength={60} placeholder="e.g. Blue cards for Commander" onChange={(event) => setViewName(event.target.value)} /><button className="button secondary" disabled={!viewName.trim()}>Save view</button></form><div className="saved-view-list">{savedViews.map((item) => <span key={item.name}><button onClick={() => loadView(item.value)}>{item.name}</button><button aria-label={`Remove saved view ${item.name}`} onClick={() => { const next = savedViews.filter((value) => value.name !== item.name); setSavedViews(next); remember(settingsKey + ".saved", next); }}>×</button></span>)}</div></details>
    {priceFiltered && <div className="active-price-filter"><span>{filters.min_price && filters.max_price ? `${money(filters.min_price)}–${money(filters.max_price)}` : filters.min_price ? `${money(filters.min_price)} and up` : `Up to ${money(filters.max_price)}`} per copy</span><button type="button" className="text-button" aria-label="Clear price filter" onClick={clearPrice}>Clear ×</button></div>}
    {filtersOpen && <form className="price-range-filter" onSubmit={(e) => { e.preventDefault(); applyPrice(); }}><h3>Price range</h3><p className="fine">USD per copy from {providers[provider]}. Only copies with a listed price are included.</p><div className="form-grid">
      <label>Minimum price ($)<input type="number" inputMode="decimal" min="0" step="0.01" placeholder="No minimum" value={minPrice} onChange={(e) => { setMinPrice(e.target.value); setPriceError(""); }} /></label>
      <label>Maximum price ($)<input type="number" inputMode="decimal" min="0" step="0.01" placeholder="No maximum" value={maxPrice} onChange={(e) => { setMaxPrice(e.target.value); setPriceError(""); }} /></label>
    </div>{priceError && <p className="message error" role="alert">{priceError}</p>}<div className="actions"><button className="button secondary">Apply price range</button>{priceFiltered && <button type="button" className="text-button" onClick={clearPrice}>Clear price range</button>}</div></form>}
    {filtersOpen && <div className="gallery-filters"><div className="form-grid">
      <label>Storage location<select value={filters.binder} onChange={(e) => filter("binder", e.target.value)}><option value="">All locations</option>{locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}</select></label>
      <label>Card type<select value={filters.card_type} onChange={(e) => filter("card_type", e.target.value)}><option value="">All types</option>{["Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Planeswalker", "Land", "Battle"].map((type) => <option key={type}>{type}</option>)}</select></label>
      <label>Rarity<select value={filters.rarity} onChange={(e) => filter("rarity", e.target.value)}><option value="">All rarities</option>{["common", "uncommon", "rare", "mythic", "special", "bonus"].map((rarity) => <option key={rarity} value={rarity}>{rarity[0].toUpperCase() + rarity.slice(1)}</option>)}</select></label>
      <label>Set<select value={filters.set_code} onChange={(e) => filter("set_code", e.target.value)}><option value="">All sets</option>{sets.map((set) => <option key={set.code} value={set.code}>{set.name}</option>)}</select></label>
      <label>Owned finish<select value={filters.finish} onChange={(e) => filter("finish", e.target.value)}><option value="">All finishes</option><option value="nonfoil">Nonfoil</option><option value="foil">Foil</option><option value="etched">Etched foil</option><option value="unknown">Unknown finish</option></select></label>
    </div><button className="text-button" onClick={clearFilters}>Clear search & filters</button></div>}
    {backgroundError.error && <ErrorNotice error={backgroundError.error} onDismiss={backgroundError.dismiss} />}
    <div className="gallery-result-note" role="status">{loading ? "Finding your cards…" : data?.cards ? `${data.cards.toLocaleString()} printings${search ? " matching “" + search + "”" : " to explore"}` : "No cards in this view"}</div>
    <div className="collection-selection-toolbar"><button className="button secondary" aria-pressed={selectionMode} onClick={() => { setSelectionMode(!selectionMode); setSelection([]); }}>{selectionMode ? "Done selecting" : "Select cards"}</button>{selectionMode && <><button className="text-button" disabled={loading} onClick={() => setSelection((current) => [...new Set([...current, ...(data?.items.map((item) => item.printing.id) || [])])].slice(0, 100))}>Select this page</button><button className="text-button" disabled={!selection.length} onClick={() => setSelection([])}>Clear selection</button><span className="fine" role="status">{selection.length} / 100 selected</span><button className="button primary" disabled={!selection.length} onClick={() => setOrganizing(true)}>Organize selected</button></>}</div>
    {!loading && data?.cards === 0 && <div className="gallery-empty"><span aria-hidden="true">✧</span><h3>{filterCount || search ? "Try another discovery" : "A collection worth exploring"}</h3><p>{filterCount || search ? "Clear a filter or try a different card name or ability." : "Import your card list or add cards from a scan. Their artwork, details and locations will be waiting here."}</p>{(filterCount > 0 || search) && <button className="button secondary" onClick={clearFilters}>Show all my cards</button>}</div>}
    <ul className={"gallery-grid " + (view === "list" ? "gallery-list" : "")} aria-label="Your cards" aria-busy={loading}>{shown.map((item) => { const sheen = ownedSheen(item); return <li className="collection-card" data-selected={selection.includes(item.printing.id)} key={item.printing.id}>{selectionMode && <label className="collection-select"><input type="checkbox" aria-label={`Select ${item.printing.name}`} checked={selection.includes(item.printing.id)} disabled={!selection.includes(item.printing.id) && selection.length >= 100} onChange={(event) => setSelection((current) => event.target.checked ? [...current, item.printing.id] : current.filter((id) => id !== item.printing.id))} /><span>Select</span></label>}<button className="gallery-card" disabled={loading} aria-label={"Open " + item.printing.name + " · " + item.printing.set_code.toUpperCase() + " #" + item.printing.collector_number + (sheen ? " · Includes " + sheen.description : "")} onClick={(event) => setSelected(item.printing.id, event.currentTarget)}>
      <div className="card-finish-art" data-owned-finish={sheen?.finish}><CardArt url={item.printing.image_url} name={item.printing.name} />{sheen && <span className="card-finish-label" aria-hidden="true" title={"Includes " + sheen.description}><span>✧</span>{sheen.label}</span>}</div><div className="gallery-card-info"><div className="gallery-card-title"><strong>{item.printing.name}</strong><span className="quantity-badge">×{item.quantity.toLocaleString()}</span></div><span className="gallery-card-set">{item.printing.set_code.toUpperCase()} · #{item.printing.collector_number} <span className={"rarity-dot rarity-" + item.printing.rarity} title={item.printing.rarity} /></span>
        <span className="gallery-card-price">{item.price_min ? money(item.price_min) + (item.price_max !== item.price_min ? "–" + money(item.price_max) : "") : item.pricing_issues?.unknown_finish ? "Finish not set" : item.pricing_issues?.custom_value ? "Custom value" : "No price available"}<small>{item.price_min ? item.priced_copies < item.quantity ? "per priced copy" : "per copy" : item.pricing_issues?.unknown_finish ? "Normal, foil or etched?" : item.pricing_issues?.custom_value ? "Altered or misprinted" : "No quote from " + providers[shownProvider]}</small></span><span className="gallery-card-location"><Icon name="pin" /><span>{item.locations[0]?.name}{item.location_count > 1 ? ` +${item.location_count - 1}` : ""}</span></span>
      </div></button></li>; })}</ul>
    <div className="pagination">{data?.next_offset != null && <button className="button secondary" disabled={loading} onClick={() => { setKept((current) => [...current, ...data.items]); setOffset(data.next_offset!); }}>More cards</button>}{offset > 0 && <button className="text-button" disabled={loading} onClick={() => { setOffset(0); window.scrollTo(0, 0); }}>Back to the first cards</button>}</div>
    <Locations locations={locations} session={session} onSaved={refreshAll} />
    <DataUpdates />
    <p className="fine gallery-credit">Card imagery © Wizards of the Coast · Card data and images via Scryfall</p>
    {selected && !card && <div className="message" role="status">{cardError ? <><ErrorNotice error={cardError} onDismiss={() => setSelected(null)} /><button className="text-button" onClick={() => setCardRetry((value) => value + 1)}>Retry opening card</button><button className="text-button" onClick={() => setSelected(null)}>Close card</button></> : "Opening card details…"}</div>}
    {organizing && <BulkCollection ids={selection} binder={filters.binder} locations={locations} session={session} onClose={() => setOrganizing(false)} onSaved={async (copies) => { setNotice(`${copies} copies updated. Import history and notes are preserved.`); setSelection([]); try { await refreshAll(); } catch (error) { backgroundError.failed(error as Error); } }} />}
    {card && <CardDetail key={card.printing.id} card={card} origin={cardFlight?.cardKey === card.printing.id ? cardFlight.origin : null} binder={filters.binder} locations={locations} session={session} onSaved={refreshAll} onCorrected={async () => { await refreshAll(); setSelected(null); setNotice("Card details saved. Your collection and prices are updated."); }} onClose={() => setSelected(null)} onStep={stepCard} />}
  </section>;
}

/** The collection's value on each day PakTrak saved prices, plus today's live value. */
function ValueOverTime({ provider }: { provider: string }) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(90);
  const [history, setHistory] = useState<{ points: HistoryPoint[]; change: HistoryChange } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setFailed(false);
    request<{ points: HistoryPoint[]; change: HistoryChange }>(`/api/v1/collection/value-history?provider=${provider}&days=${days}`, { signal: controller.signal, quiet: true })
      .then(setHistory).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [open, provider, days]);
  const change = history && changeText(history.change);
  return <details className="value-history" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Value over time{change ? ` · ${change}` : ""}</summary>
    <label className="value-history-range">Show<select value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last year</option></select></label>
    {failed ? <p className="fine">The value history couldn’t load. Try again later.</p> : !history ? <p role="status" className="fine">Loading value history…</p>
      : <ValueChart points={history.points} label={`Collection value, ${providers[provider]}`} empty="PakTrak saves your collection’s value once a day when prices update. The chart appears after the second day." />}
  </details>;
}
