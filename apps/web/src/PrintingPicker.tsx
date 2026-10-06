import { useEffect, useId, useState } from "react";
import { request, type Printing } from "./api";
import { splitCollectorSearch } from "./cardSearch";
import "./scan-qol.css";

type Options = { sets: { code: string; name: string }[]; rarities: string[]; languages: string[] };

export default function PrintingPicker({ onSelect, initialPrinting, initialQuery, selectedId, quickSets = [] }: { onSelect: (printing: Printing) => void; initialPrinting?: Printing; initialQuery?: string; selectedId?: string; quickSets?: { code: string; name: string }[] }) {
  const [query, setQuery] = useState(initialPrinting?.name || initialQuery || "");
  const [results, setResults] = useState<Printing[]>([]);
  const [message, setMessage] = useState("");
  const [offset, setOffset] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({ set_code: "", rarity: "", language: initialPrinting?.language || "", collector_number: "" });
  const [options, setOptions] = useState<Options>({ sets: [], rarities: [], languages: [] });
  const search = splitCollectorSearch(query);
  const hintId = useId();
  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); setMessage(""); setNext(null); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      setMessage("Searching catalog…");
      const params = new URLSearchParams({ q: query.trim(), offset: String(offset), ...filters, facets: "true", exact_name: String(!!initialPrinting && splitCollectorSearch(query).text.toLowerCase() === initialPrinting.name.toLowerCase()) });
      request<{ items: Printing[]; next_offset: number | null; filters?: Options }>("/api/v1/catalog/search?" + params, { signal: controller.signal })
        .then((data) => { if (controller.signal.aborted) return; setResults(data.items); setNext(data.next_offset); if (data.filters) setOptions(data.filters); setMessage(data.items.length ? "Check the set, collector number, rarity and language before choosing." : "No matching printing. Check the name and collector number, or clear the printing filters."); })
        .catch((e: Error) => { if (!controller.signal.aborted) { setResults([]); setNext(null); setMessage(e.message); } })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, offset, filters, initialPrinting]);
  function filter(key: keyof typeof filters, value: string) {
    // Editing the separate number field replaces the shortcut instead of combining two numbers.
    if (key === "collector_number" && search.collectorNumber) setQuery(search.text);
    setFilters({ ...filters, [key]: value }); setOffset(0);
  }
  return <div className="printing-picker">
    <label>Find an exact printing<input type="search" value={query} maxLength={255} onChange={(e) => { setQuery(e.target.value); setOffset(0); }} placeholder="e.g. Plains #287" autoComplete="off" aria-describedby={hintId} /></label>
    <p className="fine" id={hintId}>Search by the name printed on the card or its original name. Add <strong># and the collector number</strong> to narrow it down. Use <strong>Set / expansion</strong> to choose the edition. Scryfall IDs also work.</p>
    {quickSets.length > 0 && <div className="printing-quick-sets" role="group" aria-label="Sets in this batch"><span>Sets in this batch</span>{quickSets.map((set) => <button type="button" key={set.code} aria-pressed={filters.set_code === set.code} onClick={() => filter("set_code", filters.set_code === set.code ? "" : set.code)}>{set.name} <small>{set.code.toUpperCase()}</small></button>)}</div>}
    {(initialPrinting || query.trim().length >= 2) && <><div className="form-grid">
      <label>Set / expansion<select value={filters.set_code} onChange={(e) => filter("set_code", e.target.value)}><option value="">All sets</option>{options.sets.map((set) => <option key={set.code} value={set.code}>{set.name} ({set.code.toUpperCase()})</option>)}</select></label>
      <label>Rarity<select value={filters.rarity} onChange={(e) => filter("rarity", e.target.value)}><option value="">All rarities</option>{options.rarities.map((rarity) => <option key={rarity} value={rarity}>{rarity[0].toUpperCase() + rarity.slice(1)}</option>)}</select></label>
      <label>Collector number<input value={search.collectorNumber || filters.collector_number} maxLength={32} placeholder="Number at the bottom of the card" onChange={(e) => filter("collector_number", e.target.value)} /></label>
      <label>Printing language<select value={filters.language} onChange={(e) => filter("language", e.target.value)}><option value="">All languages</option>{[...new Set([...options.languages, ...(initialPrinting ? [initialPrinting.language] : [])])].sort().map((language) => <option key={language} value={language}>{language.toUpperCase()}</option>)}</select></label>
    </div><button type="button" className="text-button" onClick={() => { if (search.collectorNumber) setQuery(search.text); setFilters({ set_code: "", rarity: "", language: "", collector_number: "" }); setOffset(0); }}>Clear printing filters</button></>}
    {message && <p className="fine" role="status">{message}</p>}
    <ul className="plain-list printing-options" aria-label="Matching printings" aria-busy={loading}>{results.map((card) => <li key={card.id}><button type="button" className="printing-choice printing-choice-art" disabled={loading} aria-pressed={selectedId ? selectedId === card.id : undefined} onClick={() => onSelect(card)}>{card.image_url ? <img src={card.image_url} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} /> : <span className="printing-art-placeholder" aria-hidden="true" />}<div><strong>{card.display_name || card.name}</strong>{card.display_name && card.display_name !== card.name && <span>{card.name}</span>}<span>{card.set_name} ({card.set_code.toUpperCase()}) · #{card.collector_number} · <span className="rarity-text">{card.rarity}</span> · {card.language.toUpperCase()} · {card.finishes.join(" / ")}</span></div></button></li>)}</ul>
    <div className="pagination">{offset > 0 && <button type="button" className="text-button" disabled={loading} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous printings</button>}{next !== null && results.length > 0 && <button type="button" className="text-button" disabled={loading} onClick={() => setOffset(next)}>More printings</button>}</div>
  </div>;
}
