import ErrorNotice from "./ErrorNotice";
import usePriceSource from "./usePriceSource";
import useBackgroundError from "./useBackgroundError";
import { useEffect, useRef, useState } from "react";
import { navigation, restoreScroll, useRoute } from "./navigation";
import { isPriceSource, money, providers, request, type PriceSource, type CollectionCard, type DataFeed, type Location, type PricingIssues, type Session } from "./api";
import CardDetail, { CardArt } from "./CardDetail";
import DataUpdates from "./DataUpdates";
import Locations from "./Locations";
import { Icon } from "./Icon";

type Result = { copies: number; cards: number; items: CollectionCard[]; next_offset: number | null; valuation: { provider: string; amount: string | null; priced_copies: number; unpriced_copies: number; pricing_issues?: PricingIssues; feed: DataFeed | null } };
const colors = [["", "All"], ["W", "White"], ["U", "Blue"], ["B", "Black"], ["R", "Red"], ["G", "Green"], ["M", "Multi"], ["C", "Colorless"]];
const initial = { binder: "", color: "", rarity: "", card_type: "", set_code: "", finish: "", min_price: "", max_price: "" };


export default function Gallery({ session }: { session: Session }) {
  return <AccountGallery key={session.owner_id} session={session} />;
}

function AccountGallery({ session }: { session: Session }) {
  const route = useRoute();
  const active = route.page === "collection";
  const [data, setData] = useState<Result | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [sets, setSets] = useState<{ code: string; name: string }[]>([]);
  const [query, setQuery] = useState(""); const [search, setSearch] = useState("");
  const [filters, setFilters] = useState(initial);
  const { provider, ready: sourceReady, saving: sourceSaving, preferenceError, retry, change: changeSource, retrySave } = usePriceSource(session);
  const [minPrice, setMinPrice] = useState(""); const [maxPrice, setMaxPrice] = useState("");
  const [priceError, setPriceError] = useState("");
  const [sort, setSort] = useState("name"); const [seed, setSeed] = useState("");
  const [offset, setOffset] = useState(0); const [view, setView] = useState("gallery");
  const selected = active ? route.card : undefined;
  function setSelected(id: string | null) {
    if (id) navigation.go({ page: "collection", card: id });
    else if (navigation.route.page === "collection" && navigation.route.card) navigation.close({ page: "collection" });
  }
  const [notice, setNotice] = useState("");
  const backgroundError = useBackgroundError(); const [loading, setLoading] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [shownProvider, setShownProvider] = useState(provider);
  const priceFiltered = Boolean(filters.min_price || filters.max_price);
  const filterCount = Object.entries(filters).filter(([key, value]) => !["min_price", "max_price"].includes(key) && value).length + Number(priceFiltered);

  useEffect(() => { setOffset(0); }, [provider]);
  useEffect(() => { const timer = setTimeout(() => { setSearch(query.trim()); setOffset(0); }, 300); return () => clearTimeout(timer); }, [query]);
  async function refresh(isCurrent = () => true) {
    const params = new URLSearchParams({ q: search, offset: String(offset), provider, sort, seed, ...filters });
    params.delete("binder"); if (filters.binder) params.set("binder_id", filters.binder);
    if (!filters.min_price) params.delete("min_price"); if (!filters.max_price) params.delete("max_price");
    const [result, bins, options] = await Promise.all([
      request<Result>("/api/v1/collection/cards?" + params), request<{ items: Location[] }>("/api/v1/binders"), request<{ sets: { code: string; name: string }[] }>("/api/v1/collection/filters"),
    ]);
    if (!isCurrent()) return;
    setData(result); setLocations(bins.items); setSets(options.sets); setShownProvider(provider); setLoading(false); backgroundError.recovered();
    requestAnimationFrame(restoreScroll);
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
  const card = data?.items.find((item) => item.printing.id === selected);
  useEffect(() => {
    if (selected && data && !loading && !card) {
      setNotice("That card is not in this collection view. Search your collection to find it again.");
      navigation.go({ page: "collection" }, { replace: true, force: true });
    }
  }, [selected, data, loading, card]);
  const value = data?.valuation;
  return <section className="panel gallery-panel">
    <div className="collection-heading"><div><span className="eyebrow">A place for every pull</span><h2>Your collection</h2></div><span className="badge">{(data?.copies || 0).toLocaleString()} copies</span></div>
    <p className="gallery-intro">Follow a favorite. Find your next deck.</p>
    {notice && <p className="message" role="status">{notice}</p>}
    <div className="library-stats"><div><strong>{(data?.cards || 0).toLocaleString()}</strong><span>unique printings</span></div><div><strong>{money(value?.amount)}</strong><span>{providers[shownProvider]} reference value</span></div></div>
    <label className="gallery-price-source">Price source<select value={provider} disabled={!sourceReady || sourceSaving} aria-describedby="price-source-status" onChange={(e) => { if (isPriceSource(e.target.value)) void changeSource(e.target.value); }}>{Object.entries(providers).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
    <p id="price-source-status" className={sourceSaving || !sourceReady || preferenceError ? "fine" : "sr-only"} role="status">{sourceSaving ? "Saving your price source…" : !sourceReady ? preferenceError ? "Retry to load your saved price source." : "Loading your saved price source…" : preferenceError ? "Your choice is not saved to your account yet." : "Price source is remembered for your account."}</p>
    {preferenceError && <p className="message error" role="alert">{preferenceError} <button className="text-button" disabled={sourceSaving} onClick={() => void retrySave()}>{retry ? "Retry saving price source" : "Retry loading price source"}</button></p>}
    <p className="fine value-note">{value ? `${value.priced_copies.toLocaleString()} priced · ${value.unpriced_copies.toLocaleString()} unpriced copies` : "Loading your library…"}{value?.feed?.updated_at ? ` · ${value.feed.stale ? "Older prices · " : "Updated "}${new Date(value.feed.updated_at).toLocaleDateString()}` : " · Prices update daily"}. {filterCount || search ? "Totals match your filters." : ""}</p>
    {value?.pricing_issues && value.unpriced_copies > 0 && <details className="pricing-help"><summary>Why are some copies unpriced?</summary>
      {value.pricing_issues.unknown_finish > 0 && <p className="fine">{value.pricing_issues.unknown_finish.toLocaleString()} copies have no recorded finish. Normal, foil and etched copies have different prices. <button className="text-button" onClick={() => { filter("finish", "unknown"); setFiltersOpen(true); }}>Show copies needing a finish</button></p>}
      {value.pricing_issues.missing_price > 0 && <p className="fine">{value.pricing_issues.missing_price.toLocaleString()} copies have no {providers[shownProvider]} quote for their printing and finish. Another price source may have one.</p>}
      {value.pricing_issues.custom_value > 0 && <p className="fine">{value.pricing_issues.custom_value.toLocaleString()} altered or misprinted copies need an individual valuation.</p>}
    </details>}
    <form className="gallery-search" role="search" onSubmit={(e) => { e.preventDefault(); setSearch(query.trim()); setOffset(0); }}><label className="sr-only" htmlFor="collection-query">Find a card</label><input id="collection-query" type="search" value={query} maxLength={255} placeholder="Name, rules text or Plains #287" onChange={(e) => setQuery(e.target.value)} /><button className="button primary" aria-label="Search collection">Search</button></form>
    <div className="color-filters" aria-label="Color identity">{colors.map(([id, name]) => <button key={id} className={"filter-chip color-" + id} aria-pressed={filters.color === id} onClick={() => filter("color", id)}>{id && <span className="color-dot" aria-hidden="true" />}{name}</button>)}</div>
    <div className="gallery-toolbar"><button className="filter-chip" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>Filters{filterCount ? " · " + filterCount : ""} <span aria-hidden="true">⌄</span></button><button className="text-button" onClick={() => { setSort("shuffle"); setSeed(crypto.randomUUID()); setOffset(0); }}>Shuffle cards ↝</button><div className="view-switch" aria-label="Collection layout"><button aria-pressed={view === "gallery"} onClick={() => setView("gallery")}>Gallery</button><button aria-pressed={view === "list"} onClick={() => setView("list")}>List</button></div></div>
    <div className="gallery-sort"><label>Sort by<select value={sort} onChange={(e) => { setSort(e.target.value); setOffset(0); }}><option value="name">Name</option><option value="price_asc">Price: Low to high</option><option value="price_desc">Price: High to low</option><option value="quantity">Most copies</option><option value="newest">Recently added</option><option value="mana">Mana value</option><option value="shuffle">Shuffled</option></select></label></div>
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
    {!loading && data?.cards === 0 && <div className="gallery-empty"><span aria-hidden="true">✧</span><h3>{filterCount || search ? "Try another discovery" : "A collection worth exploring"}</h3><p>{filterCount || search ? "Clear a filter or try a different card name or ability." : "Import your card list or add cards from a scan. Their artwork, details and locations will be waiting here."}</p>{(filterCount > 0 || search) && <button className="button secondary" onClick={clearFilters}>Show all my cards</button>}</div>}
    <ul className={"gallery-grid " + (view === "list" ? "gallery-list" : "")} aria-label="Your cards" aria-busy={loading}>{data?.items.map((item) => <li className="collection-card" key={item.printing.id}><button className="gallery-card" disabled={loading} aria-label={"Open " + item.printing.name + " · " + item.printing.set_code.toUpperCase() + " #" + item.printing.collector_number} onClick={() => setSelected(item.printing.id)}>
      <CardArt url={item.printing.image_url} name={item.printing.name} /><div className="gallery-card-info"><div className="gallery-card-title"><strong>{item.printing.name}</strong><span className="quantity-badge">×{item.quantity.toLocaleString()}</span></div><span className="gallery-card-set">{item.printing.set_code.toUpperCase()} · #{item.printing.collector_number} <span className={"rarity-dot rarity-" + item.printing.rarity} title={item.printing.rarity} /></span>
        <span className="gallery-card-price">{item.price_min ? money(item.price_min) + (item.price_max !== item.price_min ? "–" + money(item.price_max) : "") : item.pricing_issues?.unknown_finish ? "Finish not set" : item.pricing_issues?.custom_value ? "Custom value" : "No price available"}<small>{item.price_min ? item.priced_copies < item.quantity ? "per priced copy" : "per copy" : item.pricing_issues?.unknown_finish ? "Normal, foil or etched?" : item.pricing_issues?.custom_value ? "Altered or misprinted" : "No quote from " + providers[shownProvider]}</small></span><span className="gallery-card-location"><Icon name="pin" /><span>{item.locations[0]?.name}{item.location_count > 1 ? ` +${item.location_count - 1}` : ""}</span></span>
      </div></button></li>)}</ul>
    <div className="pagination">{offset > 0 && <button className="button secondary" disabled={loading} onClick={() => setOffset(Math.max(0, offset - 40))}>Previous cards</button>}{data?.next_offset != null && <button className="button secondary" disabled={loading} onClick={() => setOffset(data.next_offset!)}>More cards</button>}</div>
    <Locations locations={locations} session={session} onSaved={refresh} />
    <DataUpdates />
    <p className="fine gallery-credit">Card imagery © Wizards of the Coast · Card data and images via Scryfall</p>
    {card && <CardDetail key={card.printing.id} card={card} binder={filters.binder} locations={locations} session={session} onSaved={refresh} onCorrected={async () => { await refresh(); setSelected(null); setNotice("Card details saved. Your collection and prices are updated."); }} onClose={() => setSelected(null)} />}
  </section>;
}
