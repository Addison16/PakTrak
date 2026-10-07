import { useEffect, useRef, useState } from "react";
import { money, mutation, providers, request, type CollectionCard, type DataFeed, type Friend, type Lot, type PriceSource, type Printing, type Session } from "./api";
import CountUp from "./CountUp";
import ErrorNotice from "./ErrorNotice";
import PrintingPicker from "./PrintingPicker";
import usePriceSource from "./usePriceSource";
import { navigation } from "./navigation";
import { appliedMessage, applyTrade, finishNames, TRADE_BINDER, type PickedLot } from "./tradeApply";
import "./trade-value.css";

type Side = "give" | "get";
type Source = "collection" | "catalog" | "friend";
type Finish = "nonfoil" | "foil" | "etched";
// Lots record which collection copies a row was picked from, so ownership is never shown as a total.
type TradeCard = { key: string; printing: Printing; finish: Finish; quantity: number; lots?: PickedLot[] };
const joinLots = (a: PickedLot[] = [], b: PickedLot[] = []) => [...a, ...b.filter((lot) => !a.some((known) => known.id === lot.id))];
type TradeFriend = { id: string; name: string };
type Trade = Record<Side, TradeCard[]> & { friend?: TradeFriend | null };
type Quote = { unit_amount: string | null; finish: string | null; printing_id: string };
type Valuation = { items: Quote[]; feed: DataFeed | null; price_kind: string };
const sideNames: Record<Side, string> = { give: "You give", get: "You get" };
const MAX_ROWS = 100;
const LOAD_EVENT = "paktrak:trade-load";
const finishesOf = (printing: Printing) => (["nonfoil", "foil", "etched"] as Finish[]).filter((finish) => printing.finishes.includes(finish));
const priceKey = (provider: string, printing: string, finish: Finish) => `${provider}:${printing}:${finish}`;

/** Open Trade value with cards already listed, such as cards a friend has that you want. */
export function openTrade(owner: string, trade: Trade) {
  try { sessionStorage.setItem("paktrak:trade:" + owner, JSON.stringify(trade)); } catch { /* The event below still reaches an open page. */ }
  window.dispatchEvent(new CustomEvent(LOAD_EVENT, { detail: { owner, trade } }));
  navigation.go({ page: "trade" });
}

// A trade is a scratch comparison: it lives in this browser tab only and never changes the collection.
function readTrade(key: string): Trade {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || "null") as Trade | null;
    if (saved && Array.isArray(saved.give) && Array.isArray(saved.get)) return saved;
  } catch { /* Start empty when tab storage is blocked or unreadable. */ }
  return { give: [], get: [] };
}

function tradeVerdict(give: number, get: number) {
  const difference = get - give, larger = Math.max(give, get), share = larger ? Math.abs(difference) / larger : 0;
  if (!larger) return null;
  // Small gaps read as even; reference prices move by more than a few percent day to day.
  const level = Math.abs(difference) < 1 || share <= 0.05 ? "even" : share <= 0.15 ? "slight" : "uneven";
  const favour = difference > 0 ? "your" : "their";
  return {
    level, difference, share,
    title: level === "even" ? "Even trade" : level === "slight" ? `Slightly in ${favour} favor` : `Uneven, in ${favour} favor`,
    detail: Math.abs(difference) < 0.005 ? "Both sides are worth the same." : `You ${difference > 0 ? "get" : "give"} ${money(Math.abs(difference))} more (${Math.round(share * 100)}% of the bigger side).`,
  };
}

export default function TradeValue({ session, active }: { session: Session; active: boolean }) {
  const storageKey = "paktrak:trade:" + session.owner_id;
  const preference = usePriceSource(session);
  const [trade, setTrade] = useState<Trade>(() => readTrade(storageKey));
  const [adding, setAdding] = useState<Side | null>(null);
  const [source, setSource] = useState<Record<Side, Source>>({ give: "collection", get: "catalog" });
  const [prices, setPrices] = useState<Record<string, string | null>>({});
  const [feed, setFeed] = useState<{ provider: string; feed: DataFeed | null; kind: string } | null>(null);
  const [priceError, setPriceError] = useState("");
  const [retry, setRetry] = useState(0);
  const pricedAt = useRef(0);
  const offerReceipt = useRef<{ body: string; key: string } | null>(null);
  const [error, setError] = useState<Error | string>("");
  const [accepting, setAccepting] = useState("");
  const [accepted, setAccepted] = useState("");
  const [friends, setFriends] = useState<Friend[]>([]);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const provider = preference.provider;
  const partner = trade.friend || null;

  useEffect(() => {
    const load = (event: Event) => {
      const detail = (event as CustomEvent<{ owner: string; trade: Trade }>).detail;
      if (detail?.owner !== session.owner_id) return;
      setTrade(detail.trade); setAdding(null); setAccepted(""); setError("");
      if (detail.trade.friend) setSource((current) => ({ ...current, get: "friend" }));
    };
    window.addEventListener(LOAD_EVENT, load);
    return () => window.removeEventListener(LOAD_EVENT, load);
  }, [session.owner_id]);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    request<{ friends: Friend[] }>("/api/v1/friends", { quiet: true }).then((data) => { if (!stopped) setFriends(data.friends); }).catch(() => { /* Trading with a friend is optional. */ });
    return () => { stopped = true; };
  }, [active]);

  useEffect(() => { try { sessionStorage.setItem(storageKey, JSON.stringify(trade)); } catch { /* The trade still works without tab storage. */ } }, [trade, storageKey]);

  // The page stays mounted between visits; price again on return so a feed update reaches the totals.
  useEffect(() => { if (active && pricedAt.current && Date.now() - pricedAt.current > 5 * 60 * 1000) setPrices({}); }, [active]);

  const rows = [...trade.give, ...trade.get];
  const missing = [...new Set(rows.map((card) => priceKey(provider, card.printing.id, card.finish)).filter((key) => !(key in prices)))];
  const missingKey = missing.join(",");
  useEffect(() => {
    if (!active || !preference.ready || !missing.length) return;
    const controller = new AbortController();
    const groups = new Map<Finish, string[]>();
    for (const key of missing) { const [, id, finish] = key.split(":") as [string, string, Finish]; groups.set(finish, [...(groups.get(finish) || []), id]); }
    const timer = window.setTimeout(() => {
      // The deck value check prices exact printings from the server's local price cache, one finish per request.
      const calls = [...groups].flatMap(([finish, ids]) => Array.from({ length: Math.ceil(ids.length / 300) }, (_, i) => ({ finish, ids: ids.slice(i * 300, i * 300 + 300) })))
        .map(({ finish, ids }) => request<Valuation>("/api/v1/decks/value", { ...mutation(session, { cards: ids.map((printing_id) => ({ printing_id, section: "main", quantity: 1 })), provider, finish_preference: finish }), signal: controller.signal, action: "Check trade prices" })
          .then((report) => ({ finish, ids, report })));
      void Promise.all(calls).then((answers) => {
        if (controller.signal.aborted) return;
        const found: Record<string, string | null> = {};
        for (const { finish, ids, report } of answers) {
          for (const id of ids) found[priceKey(provider, id, finish)] = null;
          for (const item of report.items) if (item.finish === finish) found[priceKey(provider, item.printing_id, finish)] = item.unit_amount;
          setFeed({ provider, feed: report.feed, kind: report.price_kind });
        }
        setPrices((current) => ({ ...current, ...found })); setPriceError(""); pricedAt.current = Date.now();
      }).catch((reason: Error) => { if (!controller.signal.aborted) setPriceError(reason.message); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [active, preference.ready, provider, missingKey, retry, session.csrf_token]);

  const price = (card: TradeCard) => prices[priceKey(provider, card.printing.id, card.finish)];
  function total(side: Side) {
    let amount = 0, unpriced = 0, pending = 0, copies = 0;
    for (const card of trade[side]) {
      const unit = price(card); copies += card.quantity;
      if (unit === undefined) pending += card.quantity; else if (unit === null) unpriced += card.quantity; else amount += Number(unit) * card.quantity;
    }
    return { amount: Math.round(amount * 100) / 100, unpriced, pending, copies };
  }
  const give = total("give"), get = total("get");
  const loading = give.pending + get.pending > 0 && !priceError;
  const verdict = tradeVerdict(give.amount, get.amount);
  const share = give.amount + get.amount ? give.amount / (give.amount + get.amount) : 0.5;

  function update(side: Side, change: (cards: TradeCard[]) => TradeCard[]) { setTrade((current) => ({ ...current, [side]: change(current[side]) })); }
  function add(side: Side, printing: Printing, finish: Finish, lot?: PickedLot) {
    const existing = trade[side].find((card) => card.printing.id === printing.id && card.finish === finish);
    if (!existing && trade[side].length >= MAX_ROWS) { setError(`A trade side can list up to ${MAX_ROWS} different cards.`); return; }
    setError(""); setAccepted("");
    update(side, (cards) => existing ? cards.map((card) => card === existing ? { ...card, quantity: Math.min(999, card.quantity + 1), lots: lot ? joinLots(card.lots, [lot]) : card.lots } : card) : [...cards, { key: crypto.randomUUID(), printing, finish, quantity: 1, lots: lot && [lot] }]);
  }
  function addLot(side: Side, lot: Lot) {
    const available = finishesOf(lot.printing);
    const finish = available.includes(lot.finish as Finish) ? lot.finish as Finish : available[0] || "nonfoil";
    add(side, lot.printing, finish, { id: lot.id, binder: lot.binder, quantity: lot.quantity });
  }
  function addPrinting(side: Side, printing: Printing) { add(side, printing, finishesOf(printing)[0] || "nonfoil"); }
  function setQuantity(side: Side, key: string, quantity: number) {
    update(side, (cards) => quantity < 1 ? cards.filter((card) => card.key !== key) : cards.map((card) => card.key === key ? { ...card, quantity: Math.min(999, quantity) } : card));
  }
  function setFinish(side: Side, key: string, finish: Finish) {
    update(side, (cards) => {
      const moving = cards.find((card) => card.key === key)!;
      const twin = cards.find((card) => card.key !== key && card.printing.id === moving.printing.id && card.finish === finish);
      if (twin) return cards.filter((card) => card.key !== key).map((card) => card === twin ? { ...card, quantity: Math.min(999, card.quantity + moving.quantity), lots: joinLots(card.lots, moving.lots) } : card);
      return cards.map((card) => card.key === key ? { ...card, finish } : card);
    });
  }
  function clear() {
    if (!rows.length || window.confirm("Clear both sides of this trade?")) { setTrade({ give: [], get: [] }); setAdding(null); }
  }

  async function accept() {
    if (accepting || !rows.length) return;
    setError(""); setAccepted("");
    const plural = (n: number) => `${n} ${n === 1 ? "copy" : "copies"}`;
    const summary = [give.copies && `remove ${plural(give.copies)} you give from your collection`, get.copies && `add ${plural(get.copies)} you get to a binder named “${TRADE_BINDER}”`].filter(Boolean).join(" and ");
    if (!window.confirm(`Accept this trade?\n\nThis will ${summary}. Cards you get can be undone later from Import / export.`)) return;
    try {
      const { added, removed } = await applyTrade(session, trade.give, trade.get, {
        note: `Trade accepted ${new Date().toLocaleDateString()}`, onStep: setAccepting,
        // The received side is done; retrying after a later failure must not add it twice.
        onReceived: () => setTrade((current) => ({ ...current, get: [] })),
        onRemoved: (card, take) => update("give", (cards) => cards.flatMap((row) => row.key !== card.key ? [row] : row.quantity > take ? [{ ...row, quantity: row.quantity - take }] : [])),
      });
      setAdding(null);
      setAccepted(appliedMessage(added, removed));
    } catch (reason) { setError(reason as Error); }
    finally { setAccepting(""); }
  }
  async function sendOffer() {
    if (!partner || sending || !rows.length) return;
    setError(""); setAccepted(""); setSending(true);
    const lines = (cards: TradeCard[]) => cards.map((card) => ({ printing_id: card.printing.id, finish: card.finish, quantity: card.quantity }));
    try {
      // A retry of the same offer reuses its key, so a lost reply can't send it twice.
      const body = { friend_id: partner.id, give: lines(trade.give), get: lines(trade.get), message: message.trim() };
      const encoded = JSON.stringify(body);
      if (offerReceipt.current?.body !== encoded) offerReceipt.current = { body: encoded, key: crypto.randomUUID() };
      await request("/api/v1/trade-offers", { ...mutation(session, body, offerReceipt.current.key), action: "Send trade offer" });
      offerReceipt.current = null;
      setTrade({ give: [], get: [], friend: partner }); setMessage(""); setAdding(null);
      setAccepted(`Offer sent to ${partner.name}. Their answer shows on Home and in Trade offers.`);
    } catch (reason) { setError(reason as Error); }
    finally { setSending(false); }
  }
  function choosePartner(id: string) {
    const person = friends.find((item) => item.user_id === id);
    setTrade((current) => ({ ...current, friend: person ? { id: person.user_id, name: person.name } : null }));
    setSource((current) => ({ ...current, get: person?.shares_collection ? "friend" : "catalog" }));
    setAccepted("");
  }

  const sideTotals = { give, get };
  return <section className="panel trade-value" aria-labelledby="trade-title">
    <div className="eyebrow">TRADE CHECK</div>
    <h2 id="trade-title">Trade value</h2>
    <p>Add the cards on each side to see whether a trade is fair. Nothing here changes your collection.</p>
    {friends.length > 0 && <label className="trade-partner">Trading with<select value={partner?.id || ""} onChange={(event) => choosePartner(event.target.value)}>
      <option value="">Someone else (just checking)</option>
      {friends.map((person) => <option key={person.user_id} value={person.user_id}>{person.name}</option>)}
      {partner && !friends.some((person) => person.user_id === partner.id) && <option value={partner.id}>{partner.name}</option>}
    </select></label>}
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}

    <div className="trade-summary" aria-label="Trade balance" role="group">
      <div className="trade-totals">
        {(["give", "get"] as Side[]).map((side) => <div key={side} className={"trade-total trade-total--" + side}>
          <span>{sideNames[side]}</span>
          <strong aria-label={`${sideNames[side]} total`}><CountUp value={sideTotals[side].amount} format={(n) => money(n)} /></strong>
          <small>{sideTotals[side].copies} {sideTotals[side].copies === 1 ? "card" : "cards"}{sideTotals[side].unpriced > 0 && ` · ${sideTotals[side].unpriced} unpriced`}</small>
        </div>)}
      </div>
      <div className={"trade-balance" + (verdict ? "" : " trade-balance--empty")} aria-hidden="true">
        <i className="trade-balance-give" style={{ flexGrow: share }} /><i className="trade-balance-get" style={{ flexGrow: 1 - share }} />
      </div>
      <div className="trade-verdict" role="status" aria-live="polite" data-level={verdict?.level}>
        {loading ? <p>Checking prices…</p> : priceError ? <p className="row-error">Prices unavailable. {priceError} <button className="text-button" onClick={() => setRetry((value) => value + 1)}>Retry prices</button></p>
          : !verdict ? <p>{rows.length ? "No prices yet for these cards." : "Add cards to both sides to compare them."}</p>
          : <><strong key={verdict.title}>{verdict.title}</strong><p>{verdict.detail}</p></>}
        {!loading && (give.unpriced + get.unpriced) > 0 && <p className="fine">Cards without a price are left out of the totals.</p>}
      </div>
      <label className="trade-source">Price source<select value={provider} disabled={!preference.ready || preference.saving} onChange={(event) => void preference.change(event.target.value as PriceSource)}>{Object.entries(providers).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {preference.preferenceError && <p className="fine row-error" role="status">{preference.preferenceError} <button className="text-button" onClick={() => void preference.retrySave()}>Retry price preference</button></p>}
    </div>

    {(["give", "get"] as Side[]).map((side) => <section key={side} className={"trade-side trade-side--" + side} aria-labelledby={`trade-${side}-title`}>
      <div className="trade-side-heading">
        <h3 id={`trade-${side}-title`}>{sideNames[side]}</h3>
        <strong>{money(sideTotals[side].amount)}</strong>
      </div>
      {trade[side].length === 0 ? <p className="fine">{side === "give" ? "No cards yet. Add the cards you’re handing over." : "No cards yet. Add the cards you’re receiving."}</p>
        : <ul className="plain-list trade-cards">{trade[side].map((card) => {
          const unit = price(card), options = finishesOf(card.printing);
          return <li key={card.key} className="trade-card">
            {card.printing.image_url ? <img src={card.printing.image_url} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} /> : <span className="printing-art-placeholder" aria-hidden="true" />}
            <div className="trade-card-body">
              <strong>{card.printing.display_name || card.printing.name}</strong>
              <small>{card.printing.set_name ? `${card.printing.set_name} · ` : ""}{card.printing.set_code.toUpperCase()} #{card.printing.collector_number}{card.lots?.length ? ` · You have ${card.lots.map((lot) => `${lot.quantity} in ${lot.binder}`).join(", ")}` : ""}</small>
              <div className="trade-card-controls">
                {options.length > 1 ? <label className="trade-finish">Finish<select value={card.finish} aria-label={`Finish for ${card.printing.name}`} onChange={(event) => setFinish(side, card.key, event.target.value as Finish)}>{options.map((finish) => <option key={finish} value={finish}>{finishNames[finish]}</option>)}</select></label>
                  : <span className="trade-finish-fixed">{finishNames[card.finish]}</span>}
                <div className="trade-quantity" role="group" aria-label={`Copies of ${card.printing.name}`}>
                  <button type="button" aria-label={card.quantity === 1 ? `Remove ${card.printing.name}` : `One fewer ${card.printing.name}`} onClick={() => setQuantity(side, card.key, card.quantity - 1)}>−</button>
                  <span aria-live="polite">{card.quantity}</span>
                  <button type="button" aria-label={`One more ${card.printing.name}`} disabled={card.quantity >= 999} onClick={() => setQuantity(side, card.key, card.quantity + 1)}>+</button>
                </div>
              </div>
            </div>
            <div className="trade-card-price">
              <strong>{unit === undefined ? "…" : unit === null ? "No price" : money(Number(unit) * card.quantity)}</strong>
              {unit != null && card.quantity > 1 && <small>{card.quantity} × {money(unit)}</small>}
              <button type="button" className="text-button" onClick={() => setQuantity(side, card.key, 0)} aria-label={`Remove ${card.printing.name} from ${sideNames[side].toLowerCase()}`}>Remove</button>
            </div>
          </li>;
        })}</ul>}
      {adding === side ? <TradeAdder side={side} source={source[side]} onSource={(value) => setSource({ ...source, [side]: value })} partner={side === "get" ? partner : null}
        onLot={(lot) => addLot(side, lot)} onPrinting={(printing, finish) => finish ? add(side, printing, finish) : addPrinting(side, printing)} onDone={() => setAdding(null)} />
        : <button type="button" className="button secondary trade-add" onClick={() => setAdding(side)}>Add a card you {side}</button>}
    </section>)}

    <div className="trade-accept">
      {accepted && <p className="message success" role="status">{accepted}</p>}
      {partner && <>
        <label className="trade-message">Message for {partner.name} (optional)<input value={message} maxLength={500} onChange={(event) => setMessage(event.target.value)} /></label>
        <button type="button" className="button primary" disabled={!rows.length || sending || !!accepting} onClick={() => void sendOffer()}>{sending ? "Sending offer…" : `Send offer to ${partner.name}`}</button>
        <p className="fine">{partner.name} sees the offer on their Home screen. Nothing changes in either collection until they accept.</p>
      </>}
      <button type="button" className={partner ? "button secondary" : "button primary"} disabled={!rows.length || !!accepting || sending} onClick={() => void accept()}>{accepting || (partner ? "Accept now in person" : "Accept trade")}</button>
      <p className="fine">Accepting removes the cards you give from your collection and adds the cards you get to a “{TRADE_BINDER}” binder.</p>
    </div>

    <div className="trade-footer">
      {feed && <p className="fine">{providers[feed.provider]} · {feed.kind}. {feed.feed?.updated_at ? `Prices updated ${new Date(feed.feed.updated_at).toLocaleString()}.` : "No dated price update available."}{(!feed.feed || feed.feed.stale) && " Cached prices may be out of date."} Reference prices don’t account for card condition, shipping or tax.</p>}
      {rows.length > 0 && <button type="button" className="text-button" onClick={clear}>Clear trade</button>}
    </div>
  </section>;
}

function TradeAdder({ side, source, onSource, partner, onLot, onPrinting, onDone }: {
  side: Side; source: Source; onSource: (value: Source) => void; partner: TradeFriend | null;
  onLot: (lot: Lot) => void; onPrinting: (printing: Printing, finish?: Finish) => void; onDone: () => void;
}) {
  const shown = source === "friend" && !partner ? "catalog" : source;
  const [added, setAdded] = useState("");
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  function confirm(name: string) { setAdded(`Added ${name}.`); clearTimeout(timer.current); timer.current = window.setTimeout(() => setAdded(""), 2500); }
  return <div className="trade-adder" aria-label={`Add a card you ${side}`} role="group">
    <div className="trade-adder-heading">
      <div className="view-switch" aria-label="Where to find the card">
        {partner ? <button type="button" aria-pressed={shown === "friend"} onClick={() => onSource("friend")}>{partner.name}’s cards</button>
          : <button type="button" aria-pressed={shown === "collection"} onClick={() => onSource("collection")}>My collection</button>}
        <button type="button" aria-pressed={shown === "catalog"} onClick={() => onSource("catalog")}>All cards</button>
      </div>
      <button type="button" className="text-button" onClick={onDone}>Done adding</button>
    </div>
    <p className="fine trade-added" role="status">{added}</p>
    {shown === "friend" && partner ? <FriendSearch friend={partner} onPick={(printing, finish) => { onPrinting(printing, finish); confirm(printing.name); }} />
      : shown === "collection" ? <CollectionSearch onPick={(lot) => { onLot(lot); confirm(lot.printing.name); }} />
      : <PrintingPicker onSelect={(printing) => { onPrinting(printing); confirm(printing.name); }} />}
  </div>;
}

function CollectionSearch({ onPick }: { onPick: (lot: Lot) => void }) {
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [answer, setAnswer] = useState<{ query: string; items: Lot[]; next: number | null; error?: string } | null>(null);
  useEffect(() => {
    if (query.trim().length < 2) { setAnswer(null); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      request<{ items: Lot[]; next_offset: number | null }>(`/api/v1/collection?q=${encodeURIComponent(query.trim())}&offset=${offset}`, { signal: controller.signal })
        .then((data) => { if (!controller.signal.aborted) setAnswer({ query, items: data.items, next: data.next_offset }); })
        .catch((reason: Error) => { if (!controller.signal.aborted) setAnswer({ query, items: [], next: null, error: reason.message }); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, offset]);
  const current = answer?.query === query ? answer : null;
  return <div className="trade-collection-search">
    <label>Search your collection<input type="search" value={query} maxLength={255} autoComplete="off" placeholder="Card name" onChange={(event) => { setQuery(event.target.value); setOffset(0); }} /></label>
    {query.trim().length >= 2 && <p className="fine" role="status">{!current ? "Searching your collection…" : current.error ? current.error : current.items.length ? "Tap a card to add it." : "No cards in your collection match that name."}</p>}
    <ul className="plain-list printing-options" aria-label="Cards in your collection">{current?.items.map((lot) => <li key={lot.id}>
      <button type="button" className="printing-choice printing-choice-art" onClick={() => onPick(lot)}>
        {lot.printing.image_url ? <img src={lot.printing.image_url} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} /> : <span className="printing-art-placeholder" aria-hidden="true" />}
        <div><strong>{lot.printing.display_name || lot.printing.name}</strong><span>{lot.printing.set_code.toUpperCase()} #{lot.printing.collector_number} · {finishNames[lot.finish as Finish] || "Finish not recorded"} · {lot.quantity} in {lot.binder}</span></div>
      </button>
    </li>)}</ul>
    <div className="pagination">{offset > 0 && <button type="button" className="text-button" onClick={() => setOffset(Math.max(0, offset - 40))}>Previous cards</button>}{current?.next != null && <button type="button" className="text-button" onClick={() => setOffset(current.next!)}>More cards</button>}</div>
  </div>;
}

// A friend's shared collection, grouped by printing; storage locations stay private.
function FriendSearch({ friend, onPick }: { friend: TradeFriend; onPick: (printing: Printing, finish: Finish) => void }) {
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [answer, setAnswer] = useState<{ key: string; items: CollectionCard[]; next: number | null; error?: string } | null>(null);
  const key = `${friend.id}:${query}:${offset}`;
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      request<{ items: CollectionCard[]; next_offset: number | null }>(`/api/v1/friends/${friend.id}/collection?q=${encodeURIComponent(query.trim())}&offset=${offset}`, { signal: controller.signal })
        .then((data) => { if (!controller.signal.aborted) setAnswer({ key, items: data.items, next: data.next_offset }); })
        .catch((reason: Error) => { if (!controller.signal.aborted) setAnswer({ key, items: [], next: null, error: reason.message }); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key]);
  const current = answer?.key === key ? answer : null;
  const finishOf = (card: CollectionCard): Finish => (["nonfoil", "foil", "etched"] as Finish[]).find((finish) => (card.finish_counts?.[finish] || 0) > 0) || finishesOf(card.printing)[0] || "nonfoil";
  return <div className="trade-collection-search">
    <label>Search {friend.name}’s cards<input type="search" value={query} maxLength={255} autoComplete="off" placeholder="Card name" onChange={(event) => { setQuery(event.target.value); setOffset(0); }} /></label>
    <p className="fine" role="status">{!current ? "Loading their cards…" : current.error ? current.error : current.items.length ? "Tap a card to add it." : "No cards match that name."}</p>
    <ul className="plain-list printing-options" aria-label={`${friend.name}’s cards`}>{current?.items.map((card) => <li key={card.printing.id}>
      <button type="button" className="printing-choice printing-choice-art" onClick={() => onPick(card.printing, finishOf(card))}>
        {card.printing.image_url ? <img src={card.printing.image_url} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} /> : <span className="printing-art-placeholder" aria-hidden="true" />}
        <div><strong>{card.printing.display_name || card.printing.name}</strong><span>{card.printing.set_code.toUpperCase()} #{card.printing.collector_number} · They have {card.quantity}{(card.finish_counts?.foil || 0) > 0 ? ` (${card.finish_counts!.foil} foil)` : ""}</span></div>
      </button>
    </li>)}</ul>
    <div className="pagination">{offset > 0 && <button type="button" className="text-button" onClick={() => setOffset(Math.max(0, offset - 40))}>Previous cards</button>}{current?.next != null && <button type="button" className="text-button" onClick={() => setOffset(current.next!)}>More cards</button>}</div>
  </div>;
}
