import { useEffect, useState } from "react";
import { money, providers, request, type Printing, type Session } from "./api";
import ErrorNotice from "./ErrorNotice";
import { navigation } from "./navigation";
import { addToWishlist } from "./Wishlist";
import "./social.css";
import { usePullRefresh } from "./pullRefresh";

type OwnedSet = { code: string; name: string; released_at: string | null; set_type: string | null; owned: number; total: number; copies: number };
type SetCard = { printing: Printing; owned: number; price_finish: string | null; unit_amount: string | null };
type SetDetail = { code: string; name: string; released_at: string | null; provider: string; owned: number; total: number; cost_to_finish: string; missing_unpriced: number; cards: SetCard[] };

const percent = (owned: number, total: number) => total ? Math.floor(owned / total * 100) : 0;

export default function Sets({ session, setCode }: { session: Session; setCode?: string }) {
  return setCode ? <SetView key={setCode} session={session} code={setCode} /> : <SetList />;
}

function SetList() {
  const [sets, setSets] = useState<OwnedSet[] | null>(null);
  const [error, setError] = useState<Error | string>("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"closest" | "newest" | "name">("closest");
  const [reload, setReload] = useState(0);
  usePullRefresh(true, () => setReload((value) => value + 1));
  useEffect(() => {
    const controller = new AbortController();
    request<{ items: OwnedSet[] }>("/api/v1/collection/sets", { signal: controller.signal }).then((data) => setSets(data.items)).catch((reason: Error) => { if (!controller.signal.aborted) setError(reason); });
    return () => controller.abort();
  }, [reload]);
  const needle = query.trim().toLowerCase();
  const shown = (sets || []).filter((set) => !needle || set.name.toLowerCase().includes(needle) || set.code.includes(needle)).sort((a, b) =>
    sort === "name" ? a.name.localeCompare(b.name) : sort === "newest" ? (b.released_at || "").localeCompare(a.released_at || "") : b.owned / b.total - a.owned / a.total || b.owned - a.owned);
  return <section className="panel social-page" aria-labelledby="sets-title">
    <div className="eyebrow">SET COMPLETION</div>
    <h2 id="sets-title">Sets you collect</h2>
    <p>How much of each set you own, counting one copy of each collector number. Open a set to see what’s missing and what it costs to finish.</p>
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
    {!sets ? !error && <p role="status">Loading your sets…</p> : sets.length === 0 ? <p className="fine">Add cards to your collection and their sets show up here.</p> : <>
      <div className="set-filter">
        <label>Find a set<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Set name or code" /></label>
        <label>Sort<select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="closest">Closest to complete</option><option value="newest">Newest</option><option value="name">Name</option></select></label>
      </div>
      {shown.length === 0 ? <p className="fine">No sets match.</p> : <ul className="plain-list set-list">{shown.map((set) => <li key={set.code}>
        <button type="button" className="set-open" onClick={() => navigation.go({ page: "sets", set: set.code })}>
          <strong>{set.name}</strong>
          <span>{set.owned} / {set.total}</span>
          <small>{set.code.toUpperCase()}{set.released_at ? ` · ${set.released_at.slice(0, 4)}` : ""} · {percent(set.owned, set.total)}%</small>
          <span className="set-progress" aria-hidden="true"><i style={{ width: `${percent(set.owned, set.total)}%` }} /></span>
        </button>
      </li>)}</ul>}
    </>}
  </section>;
}

function SetView({ session, code }: { session: Session; code: string }) {
  const [data, setData] = useState<SetDetail | null>(null);
  const [error, setError] = useState<Error | string>("");
  const [notice, setNotice] = useState("");
  const [show, setShow] = useState<"missing" | "owned" | "all">("missing");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  usePullRefresh(true, () => setReload((value) => value + 1));
  useEffect(() => {
    const controller = new AbortController();
    request<SetDetail>(`/api/v1/collection/sets/${encodeURIComponent(code)}`, { signal: controller.signal }).then(setData).catch((reason: Error) => { if (!controller.signal.aborted) setError(reason); });
    return () => controller.abort();
  }, [code, reload]);
  const missing = data?.cards.filter((card) => !card.owned) || [];
  const cards = !data ? [] : show === "missing" ? missing : show === "owned" ? data.cards.filter((card) => card.owned) : data.cards;
  async function wishlistMissing() {
    if (busy || !missing.length) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const added = await addToWishlist(session, missing.map((card) => ({ printing_id: card.printing.id, quantity: 1 })));
      setNotice(`Added ${added} ${added === 1 ? "card" : "cards"} to your wishlist.`);
    } catch (reason) { setError(reason as Error); } finally { setBusy(false); }
  }
  return <section className="panel social-page" aria-labelledby="set-title">
    <button type="button" className="text-button" onClick={() => navigation.go({ page: "sets" })}>← All sets</button>
    <div className="eyebrow">{code.toUpperCase()}{data?.released_at ? ` · ${data.released_at.slice(0, 4)}` : ""}</div>
    <h2 id="set-title">{data?.name || "Opening set…"}</h2>
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
    {notice && <p className="message success" role="status">{notice}</p>}
    {!data ? !error && <p role="status">Loading the set…</p> : <>
      <div className="social-total">
        <span>{data.owned} of {data.total} owned · {percent(data.owned, data.total)}%</span>
        <strong>{data.owned === data.total ? "Complete" : money(data.cost_to_finish)}</strong>
        {data.owned < data.total && <small>Cost to finish with the cheapest finish of each missing card, {providers[data.provider]}{data.missing_unpriced ? `. ${data.missing_unpriced} missing ${data.missing_unpriced === 1 ? "card has" : "cards have"} no price` : ""}.</small>}
      </div>
      <span className="set-progress" aria-hidden="true" style={{ display: "block" }}><i style={{ width: `${percent(data.owned, data.total)}%` }} /></span>
      <div className="set-filter">
        <label>Show<select value={show} onChange={(event) => setShow(event.target.value as typeof show)}><option value="missing">Missing ({missing.length})</option><option value="owned">Owned ({data.owned})</option><option value="all">All ({data.total})</option></select></label>
        {missing.length > 0 && <button type="button" className="button secondary" disabled={busy} onClick={() => void wishlistMissing()}>Add missing cards to wishlist</button>}
      </div>
      {cards.length === 0 ? <p className="fine">{show === "missing" ? "You own every card in this set." : "Nothing to show."}</p>
        : <ul className="plain-list set-cards" aria-label={`${show === "missing" ? "Missing" : show === "owned" ? "Owned" : "All"} cards`}>{cards.map((card) => <li key={card.printing.id} data-owned={card.owned > 0}>
          <span>#{card.printing.collector_number}</span>
          <strong>{card.printing.display_name || card.printing.name}{card.owned > 0 ? ` · own ${card.owned}` : ""}</strong>
          <span>{card.unit_amount ? money(card.unit_amount) : "No price"}</span>
        </li>)}</ul>}
    </>}
  </section>;
}
