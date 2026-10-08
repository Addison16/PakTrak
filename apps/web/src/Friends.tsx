import { useEffect, useState } from "react";
import { money, mutation, request, type CollectionCard, type Finish, type Friend, type Printing, type Session, type Wishlist } from "./api";
import ErrorNotice from "./ErrorNotice";
import { navigation } from "./navigation";
import { openTrade } from "./TradeValue";
import "./trade-value.css";
import "./social.css";
import { usePullReload } from "./pullRefresh";

type FriendsData = { code: string | null; share_collection: boolean; share_wishlist: boolean; friends: Friend[]; incoming: { id: string; name: string; created_at: string }[]; outgoing: { id: string; created_at: string }[] };
type Match = { printing: Printing; finish: Finish; finish_recorded: boolean; quantity: number; wanted: number; unit_amount: string | null };
type Matches = { name: string; they_have: Match[]; you_have: Match[]; shares_collection: boolean; shares_wishlist: boolean };
const date = (value: string | null) => value ? new Date(value).toLocaleDateString() : "";

export default function Friends({ session, active, friendId }: { session: Session; active: boolean; friendId?: string }) {
  const [data, setData] = useState<FriendsData | null>(null);
  const [error, setError] = useState<Error | string>("");
  const [notice, setNotice] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const { reload, setReload, settle } = usePullReload(active);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    request<FriendsData>("/api/v1/friends", { signal: controller.signal }).then((value) => { setData(value); settle(); }).catch((reason: Error) => { if (!controller.signal.aborted) { setError(reason); settle(reason); } });
    return () => controller.abort();
  }, [active, reload]);

  async function act(work: () => Promise<string | void>) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { const message = await work(); if (message) setNotice(message); setReload((value) => value + 1); }
    catch (reason) { setError(reason as Error); }
    finally { setBusy(false); }
  }
  const post = (path: string, body?: unknown) => request<Record<string, unknown>>(path, mutation(session, body));
  const remove = (id: string) => request(`/api/v1/friends/${id}`, { method: "DELETE", headers: { "X-CSRF-Token": session.csrf_token }, action: "Remove friend" });

  const friend = friendId ? data?.friends.find((person) => person.user_id === friendId) : undefined;
  if (friendId) return friend ? <FriendView key={friend.user_id} session={session} friend={friend} reload={reload} /> : <section className="panel social-page">
    <button type="button" className="button secondary" onClick={() => navigation.go({ page: "friends" })}>← Back to friends</button>
    {error ? <ErrorNotice error={error} onDismiss={() => setError("")} /> : <p role="status">{data ? "This friend is no longer connected." : "Opening your friend…"}</p>}
  </section>;

  return <section className="panel social-page" aria-labelledby="friends-title">
    <div className="eyebrow">SHARE WITH PEOPLE YOU KNOW</div>
    <h2 id="friends-title">Friends</h2>
    <p>Friends can see each other’s cards and wishlists and send trade offers. PakTrak never lists who has an account here: you add someone only with the code they give you.</p>
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
    {notice && <p className="message success" role="status">{notice}</p>}
    {!data ? !error && <p role="status">Loading friends…</p> : <>
      {data.incoming.length > 0 && <div className="social-block" aria-label="Friend requests">
        <h3>Friend requests</h3>
        <ul className="plain-list social-rows">{data.incoming.map((request) => <li key={request.id}>
          <div><strong>{request.name}</strong><small>Sent {date(request.created_at)}</small></div>
          <div className="actions"><button type="button" className="button primary" disabled={busy} onClick={() => void act(async () => { await post(`/api/v1/friends/requests/${request.id}/accept`); return `You and ${request.name} are now friends.`; })}>Accept</button>
            <button type="button" className="text-button" disabled={busy} onClick={() => void act(async () => { await post(`/api/v1/friends/requests/${request.id}/decline`); })}>Decline</button></div>
        </li>)}</ul>
      </div>}

      <div className="social-block">
        <h3>Your friends</h3>
        {data.friends.length === 0 ? <p className="fine">No friends yet. Share your code, or enter someone else’s below.</p>
          : <ul className="plain-list social-rows">{data.friends.map((person) => <li key={person.id}>
            <button type="button" className="social-open" onClick={() => navigation.go({ page: "friends", friend: person.user_id })}><strong>{person.name}</strong><small>Friends since {date(person.since)}</small></button>
            <button type="button" className="text-button" disabled={busy} onClick={() => { if (window.confirm(`Remove ${person.name} as a friend?\n\nYou’ll stop seeing each other’s cards, and offers still waiting are cancelled.`)) void act(async () => { await remove(person.id); return `Removed ${person.name}.`; }); }}>Remove</button>
          </li>)}</ul>}
        {data.outgoing.length > 0 && <ul className="plain-list social-rows">{data.outgoing.map((request) => <li key={request.id}>
          <div><strong>Request sent</strong><small>Waiting for them to accept · {date(request.created_at)}</small></div>
          <button type="button" className="text-button" disabled={busy} onClick={() => void act(async () => { await remove(request.id); return "Request withdrawn."; })}>Withdraw</button>
        </li>)}</ul>}
      </div>

      <form className="social-block social-code-entry" onSubmit={(event) => { event.preventDefault(); void act(async () => {
        const result = await post("/api/v1/friends/requests", { code });
        setCode("");
        return result.state === "accepted" ? `You and ${result.name} are now friends.` : "Request sent. You’ll see them here once they accept.";
      }); }}>
        <h3>Add a friend</h3>
        <label>Their friend code<input value={code} maxLength={32} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="ABCDE-23456" onChange={(event) => setCode(event.target.value)} /></label>
        <button className="button primary" disabled={busy || code.replace(/[^a-z0-9]/gi, "").length < 4}>Send request</button>
      </form>

      <div className="social-block">
        <h3>Your friend code</h3>
        {data.code ? <>
          <p className="social-code" aria-label="Your friend code">{data.code}</p>
          <div className="actions">
            <button type="button" className="button secondary" onClick={() => { if (!navigator.clipboard) { setNotice("Select the code to copy it."); return; } void navigator.clipboard.writeText(data.code!).then(() => setNotice("Code copied."), () => setNotice("Select the code to copy it.")); }}>Copy code</button>
            <button type="button" className="text-button" disabled={busy} onClick={() => { if (window.confirm("Make a new code? The old one stops working. Current friends stay connected.")) void act(async () => { await post("/api/v1/friends/code", { action: "new" }); return "New code ready."; }); }}>Get a new code</button>
            <button type="button" className="text-button" disabled={busy} onClick={() => void act(async () => { await post("/api/v1/friends/code", { action: "off" }); return "Code turned off. No one can send you a request until you make a new one."; })}>Turn off code</button>
          </div>
          <p className="fine">Give it only to people you want to add. Anyone with it can send you a request, which you still have to accept.</p>
        </> : <>
          <p className="fine">You don’t have a code, so no one can send you a request.</p>
          <button type="button" className="button secondary" disabled={busy} onClick={() => void act(async () => { await post("/api/v1/friends/code", { action: "new" }); })}>Create my friend code</button>
        </>}
      </div>

      <fieldset className="social-block social-sharing" disabled={busy}>
        <legend>What friends can see</legend>
        <label className="checkbox"><input type="checkbox" checked={data.share_collection} onChange={(event) => void act(async () => { await post("/api/v1/friends/settings", { share_collection: event.target.checked, share_wishlist: data.share_wishlist }); })} />My collection (cards and counts, never storage locations or notes)</label>
        <label className="checkbox"><input type="checkbox" checked={data.share_wishlist} onChange={(event) => void act(async () => { await post("/api/v1/friends/settings", { share_collection: data.share_collection, share_wishlist: event.target.checked }); })} />My wishlist</label>
      </fieldset>
    </>}
  </section>;
}

function MatchList({ items, label }: { items: Match[]; label: string }) {
  return <ul className="plain-list trade-cards" aria-label={label}>{items.map((item) => <li key={item.printing.id + item.finish} className="trade-card">
    {item.printing.image_url ? <img src={item.printing.image_url} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} /> : <span className="printing-art-placeholder" aria-hidden="true" />}
    <div className="trade-card-body"><strong>{item.printing.display_name || item.printing.name}</strong>
      <small>{item.printing.set_code.toUpperCase()} #{item.printing.collector_number} · {item.quantity} {item.finish_recorded ? item.finish : ""} available · {item.wanted} wanted</small></div>
    <div className="trade-card-price"><strong>{money(item.unit_amount)}</strong></div>
  </li>)}</ul>;
}

// reload changes when the screen is pulled down, so the open friend reloads too.
function FriendView({ session, friend, reload }: { session: Session; friend: Friend; reload: number }) {
  const [matches, setMatches] = useState<Matches | null>(null);
  const [wishlist, setWishlist] = useState<Wishlist | null>(null);
  const [cards, setCards] = useState<{ items: CollectionCard[]; next_offset: number | null; copies: number } | null>(null);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<Error | string>("");
  const base = `/api/v1/friends/${friend.user_id}`;
  useEffect(() => {
    const controller = new AbortController();
    const fail = (reason: Error) => { if (!controller.signal.aborted) setError(reason); };
    request<Matches>(base + "/matches", { signal: controller.signal }).then(setMatches).catch(fail);
    if (friend.shares_wishlist) request<Wishlist>(base + "/wishlist", { signal: controller.signal }).then(setWishlist).catch(fail);
    return () => controller.abort();
  }, [base, reload]);
  useEffect(() => {
    if (!friend.shares_collection) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => request<{ items: CollectionCard[]; next_offset: number | null; copies: number }>(`${base}/collection?q=${encodeURIComponent(query.trim())}&offset=${offset}`, { signal: controller.signal })
      .then(setCards).catch((reason: Error) => { if (!controller.signal.aborted) setError(reason); }), 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [base, query, offset, reload]);

  const partner = { id: friend.user_id, name: friend.name };
  const line = (item: Match, take: number) => ({ key: crypto.randomUUID(), printing: item.printing, finish: item.finish, quantity: Math.max(1, Math.min(take, 999)) });
  return <section className="panel social-page" aria-labelledby="friend-title">
    <button type="button" className="button secondary" onClick={() => navigation.go({ page: "friends" })}>← Back to friends</button>
    <div className="eyebrow">FRIEND</div>
    <h2 id="friend-title">{friend.name}</h2>
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
    <button type="button" className="button primary" onClick={() => openTrade(session.owner_id, { give: [], get: [], friend: partner })}>Make a trade offer</button>

    {matches && matches.they_have.length > 0 && <div className="social-block">
      <h3>They have cards you want</h3>
      <MatchList items={matches.they_have} label={`Cards ${friend.name} has that you want`} />
      <button type="button" className="button secondary" onClick={() => openTrade(session.owner_id, { give: [], get: matches.they_have.map((item) => line(item, Math.min(item.quantity, item.wanted))), friend: partner })}>Ask for these in an offer</button>
    </div>}
    {matches && matches.you_have.length > 0 && <div className="social-block">
      <h3>You have cards they want</h3>
      <MatchList items={matches.you_have} label={`Cards you have that ${friend.name} wants`} />
      <button type="button" className="button secondary" onClick={() => openTrade(session.owner_id, { give: matches.you_have.map((item) => line(item, Math.min(item.quantity, item.wanted))), get: [], friend: partner })}>Offer these</button>
    </div>}
    {matches && !matches.they_have.length && !matches.you_have.length && <p className="fine">No matches between your wishlists and collections right now.</p>}

    {wishlist && <div className="social-block">
      <h3>Their wishlist</h3>
      {wishlist.items.length === 0 ? <p className="fine">Their wishlist is empty.</p> : <ul className="plain-list social-rows">{wishlist.items.map((item) => <li key={item.id}>
        <div><strong>{item.quantity} × {item.printing.display_name || item.printing.name}</strong><small>{item.printing.set_code.toUpperCase()} #{item.printing.collector_number}{item.finish !== "any" ? ` · ${item.finish}` : ""}{item.owned ? ` · You own ${item.owned}` : ""}</small></div>
        <span>{money(item.unit_amount)}</span>
      </li>)}</ul>}
    </div>}

    {friend.shares_collection ? <div className="social-block">
      <h3>Their collection{cards ? ` · ${cards.copies} cards` : ""}</h3>
      <label>Search their cards<input type="search" value={query} maxLength={255} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} placeholder="Card name" /></label>
      {!cards ? <p role="status">Loading their cards…</p> : cards.items.length === 0 ? <p className="fine">No cards match.</p>
        : <ul className="plain-list social-rows">{cards.items.map((card) => <li key={card.printing.id}>
          <div><strong>{card.quantity} × {card.printing.display_name || card.printing.name}</strong><small>{card.printing.set_code.toUpperCase()} #{card.printing.collector_number}{card.finish_counts?.foil ? ` · ${card.finish_counts.foil} foil` : ""}</small></div>
          <span>{money(card.price_max)}</span>
        </li>)}</ul>}
      <div className="pagination">{offset > 0 && <button className="text-button" onClick={() => setOffset(Math.max(0, offset - 40))}>Previous cards</button>}{cards?.next_offset != null && <button className="text-button" onClick={() => setOffset(cards.next_offset!)}>More cards</button>}</div>
    </div> : <p className="fine">{friend.name} isn’t sharing their collection.</p>}
  </section>;
}
