import { useEffect, useState } from "react";
import { money, mutation, providers, request, type OfferCard, type Session, type TradeOffer } from "./api";
import ErrorNotice from "./ErrorNotice";
import { Icon } from "./Icon";
import { navigation } from "./navigation";
import { appliedMessage, applyTrade, finishNames } from "./tradeApply";
import "./social.css";

type Offers = { items: TradeOffer[]; attention: number };
const count = (cards: OfferCard[]) => cards.reduce((sum, card) => sum + card.quantity, 0);
const cardsText = (cards: OfferCard[]) => `${count(cards)} ${count(cards) === 1 ? "card" : "cards"}`;
const OFFERS_EVENT = "paktrak:offers-changed";

// Progress is kept per offer in this tab, so a retry after a failure never repeats a finished part.
type Progress = { received?: boolean; removed?: Record<string, number> };
const progressKey = (id: string) => "paktrak:offer-progress:" + id;
function readProgress(id: string): Progress {
  try { return JSON.parse(sessionStorage.getItem(progressKey(id)) || "{}") as Progress; } catch { return {}; }
}
function saveProgress(id: string, progress: Progress) {
  try { sessionStorage.setItem(progressKey(id), JSON.stringify(progress)); } catch { /* Retries still check the collection first. */ }
}

/** Update this account's collection for an accepted offer, then record it on the server. */
async function applyOffer(session: Session, offer: TradeOffer, onStep: (label: string) => void) {
  const progress = readProgress(offer.id);
  const lineKey = (card: OfferCard) => `${card.printing.id}:${card.finish}`;
  const give = offer.give.map((card) => ({ ...card, quantity: card.quantity - (progress.removed?.[lineKey(card)] || 0) })).filter((card) => card.quantity > 0);
  const result = await applyTrade(session, give, progress.received ? [] : offer.get, {
    // The note, file and key come from the offer, so another tab or device resumes the same import.
    note: `Trade with ${offer.friend.name}, ${new Date(offer.created_at).toLocaleDateString()}`, onStep,
    receipt: { key: `trade-offer-${offer.id}`, day: offer.created_at.slice(0, 10) },
    onReceived: () => { progress.received = true; saveProgress(offer.id, progress); },
    onRemoved: (card, take) => { progress.removed = { ...progress.removed, [lineKey(card)]: (progress.removed?.[lineKey(card)] || 0) + take }; saveProgress(offer.id, progress); },
  });
  await request(`/api/v1/trade-offers/${offer.id}/applied`, { ...mutation(session), action: "Save trade offer" });
  try { sessionStorage.removeItem(progressKey(offer.id)); } catch { /* Nothing to clean up. */ }
  return appliedMessage(result.added, result.removed);
}

function CardLines({ cards, label }: { cards: OfferCard[]; label: string }) {
  if (!cards.length) return <p className="fine">Nothing</p>;
  return <ul className="plain-list offer-cards" aria-label={label}>{cards.map((card) => <li key={card.printing.id + card.finish}>
    {card.printing.image_url ? <img src={card.printing.image_url} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} /> : <span className="printing-art-placeholder" aria-hidden="true" />}
    <span><strong>{card.quantity} × {card.printing.display_name || card.printing.name}</strong><small>{card.printing.set_code.toUpperCase()} #{card.printing.collector_number} · {finishNames[card.finish]}</small></span>
    <span className="offer-price">{card.unit_amount ? money(Number(card.unit_amount) * card.quantity) : "No price"}</span>
  </li>)}</ul>;
}

const stateText: Record<TradeOffer["state"], string> = { pending: "Waiting", accepted: "Accepted", declined: "Declined", cancelled: "Cancelled" };

export default function TradeOffers({ session, active, onCount }: { session: Session; active: boolean; onCount?: (count: number) => void }) {
  const [data, setData] = useState<Offers | null>(null);
  const [error, setError] = useState<Error | string>("");
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState<{ id: string; label: string } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    request<Offers>("/api/v1/trade-offers", { signal: controller.signal }).then((value) => { setData(value); onCount?.(value.attention); }).catch((reason: Error) => { if (!controller.signal.aborted) setError(reason); });
    return () => controller.abort();
  }, [active, reload]);

  async function act(offer: TradeOffer, work: () => Promise<string | void>) {
    if (working) return;
    setWorking({ id: offer.id, label: "Saving…" }); setError(""); setNotice("");
    try { const message = await work(); if (message) setNotice(message); }
    catch (reason) { setError(reason as Error); }
    finally { setWorking(null); setReload((value) => value + 1); window.dispatchEvent(new Event(OFFERS_EVENT)); }
  }
  const post = (offer: TradeOffer, action: string) => request<TradeOffer>(`/api/v1/trade-offers/${offer.id}/${action}`, { ...mutation(session), action: "Save trade offer" });
  const step = (offer: TradeOffer) => (label: string) => setWorking({ id: offer.id, label });

  function accept(offer: TradeOffer) {
    const summary = [offer.give.length && `remove ${cardsText(offer.give)} you give`, offer.get.length && `add ${cardsText(offer.get)} you get to your “Trades” binder`].filter(Boolean).join(" and ");
    if (!window.confirm(`Accept ${offer.friend.name}’s offer?\n\nPakTrak will ${summary}. ${offer.friend.name}’s app updates their collection when they next open it.`)) return;
    void act(offer, async () => { await post(offer, "accept"); return await applyOffer(session, offer, step(offer)); });
  }

  const items = data?.items || [];
  const groups: [string, TradeOffer[]][] = [
    ["Waiting for you", items.filter((offer) => offer.attention === "respond" || offer.attention === "apply")],
    ["Sent and waiting", items.filter((offer) => offer.direction === "outgoing" && offer.state === "pending")],
    ["Finished", items.filter((offer) => !(offer.attention === "respond" || offer.attention === "apply") && !(offer.direction === "outgoing" && offer.state === "pending"))],
  ];
  return <section className="panel social-page" aria-labelledby="offers-title">
    <div className="eyebrow">TRADES WITH FRIENDS</div>
    <h2 id="offers-title">Trade offers</h2>
    <p>Offers you send and receive. Accepting updates your own collection; your friend’s app updates theirs.</p>
    <button type="button" className="button secondary" onClick={() => navigation.go({ page: "trade" })}><Icon name="trade" />Make an offer in Trade value</button>
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
    {notice && <p className="message success" role="status">{notice}</p>}
    {!data ? !error && <p role="status">Loading trade offers…</p> : items.length === 0 ? <p className="fine">No offers yet. Add a friend, then choose them under “Trading with” on Trade value.</p>
      : groups.map(([title, offers]) => offers.length > 0 && <div key={title} className="social-block">
        <h3>{title}</h3>
        <ul className="plain-list offer-list">{offers.map((offer) => {
          const busy = working?.id === offer.id;
          return <li key={offer.id} className="offer" data-state={offer.state}>
            <div className="offer-heading"><strong>{offer.direction === "incoming" ? `From ${offer.friend.name}` : `To ${offer.friend.name}`}</strong><span>{stateText[offer.state]} · {new Date(offer.responded_at || offer.created_at).toLocaleDateString()}</span></div>
            {offer.message && <p className="offer-message">“{offer.message}”</p>}
            <div className="offer-sides">
              <div><h4>You give <span>{money(offer.give_amount)}</span></h4><CardLines cards={offer.give} label="Cards you give" /></div>
              <div><h4>You get <span>{money(offer.get_amount)}</span></h4><CardLines cards={offer.get} label="Cards you get" /></div>
            </div>
            <p className="fine">{providers[offer.provider]} reference prices{offer.give_unpriced + offer.get_unpriced ? `; ${offer.give_unpriced + offer.get_unpriced} without a price` : ""}.</p>
            {busy && <p role="status">{working!.label}</p>}
            <div className="actions">
              {offer.attention === "respond" && <><button type="button" className="button primary" disabled={!!working} onClick={() => accept(offer)}>Accept trade</button>
                <button type="button" className="button secondary" disabled={!!working} onClick={() => void act(offer, async () => { await post(offer, "decline"); return "Offer declined."; })}>Decline</button></>}
              {offer.attention === "apply" && <><button type="button" className="button primary" disabled={!!working} onClick={() => void act(offer, () => applyOffer(session, offer, step(offer)))}>Update my collection</button>
                <button type="button" className="text-button" disabled={!!working} onClick={() => { if (window.confirm("Mark this trade as done without changing your collection?")) void act(offer, async () => { await post(offer, "applied"); }); }}>I already updated it</button></>}
              {offer.direction === "outgoing" && offer.state === "pending" && <button type="button" className="button secondary" disabled={!!working} onClick={() => void act(offer, async () => { await post(offer, "cancel"); return "Offer cancelled."; })}>Cancel offer</button>}
              {(offer.attention === "declined" || offer.attention === "cancelled") && <button type="button" className="text-button" disabled={!!working} onClick={() => void act(offer, async () => { await post(offer, "close"); })}>Dismiss</button>}
            </div>
          </li>;
        })}</ul>
      </div>)}
  </section>;
}

/** The popup at the top of Home for offers that need this person. The session carries the count, so offers load only when one is waiting. */
export function OfferNotice({ session, show = true }: { session: Session; show?: boolean }) {
  const [offers, setOffers] = useState<TradeOffer[]>([]);
  const [hidden, setHidden] = useState<string[]>(() => { try { return JSON.parse(sessionStorage.getItem("paktrak:hidden-offers") || "[]") as string[]; } catch { return []; } });
  const [reload, setReload] = useState(0);
  const waiting = session.trade_offers_waiting || 0;
  useEffect(() => {
    const refresh = () => setReload((value) => value + 1);
    window.addEventListener(OFFERS_EVENT, refresh);
    return () => window.removeEventListener(OFFERS_EVENT, refresh);
  }, []);
  useEffect(() => {
    if (!show || !waiting) { if (!waiting) setOffers([]); return; }
    const controller = new AbortController();
    request<Offers>("/api/v1/trade-offers", { signal: controller.signal, quiet: true }).then((data) => setOffers(data.items.filter((offer) => offer.attention)))
      .catch(() => { /* The notice is a shortcut; Trade offers shows errors. */ });
    return () => controller.abort();
  }, [show, waiting, reload, session.owner_id]);
  const shown = offers.filter((offer) => !hidden.includes(offer.id + offer.attention));
  if (!show || !shown.length) return null;
  function hide(offer: TradeOffer) {
    const next = [...hidden, offer.id + offer.attention];
    setHidden(next);
    try { sessionStorage.setItem("paktrak:hidden-offers", JSON.stringify(next)); } catch { /* Hidden for this view only. */ }
    if (offer.attention === "declined" || offer.attention === "cancelled") void request(`/api/v1/trade-offers/${offer.id}/close`, { ...mutation(session), quiet: true }).catch(() => {});
  }
  const text = (offer: TradeOffer) => offer.attention === "respond" ? `${offer.friend.name} sent you a trade offer`
    : offer.attention === "apply" ? (offer.direction === "outgoing" ? `${offer.friend.name} accepted your trade offer` : `Finish the trade with ${offer.friend.name}`)
    : `${offer.friend.name} ${offer.attention === "declined" ? "declined" : "cancelled"} the trade offer`;
  return <aside className="offer-notice" aria-label="Trade offers">{shown.slice(0, 3).map((offer) => <div key={offer.id} className="offer-notice-item">
    <Icon name="offers" />
    <div><strong>{text(offer)}</strong><span>You give {cardsText(offer.give)} ({money(offer.give_amount)}) · You get {cardsText(offer.get)} ({money(offer.get_amount)})</span>
      {offer.attention === "apply" && <span>Update your collection to finish it.</span>}</div>
    <div className="offer-notice-actions">
      <button type="button" className="button primary" onClick={() => navigation.go({ page: "offers" })}>{offer.attention === "respond" ? "View offer" : offer.attention === "apply" ? "Update collection" : "View"}</button>
      <button type="button" className="text-button" aria-label="Hide this notice" onClick={() => hide(offer)}><Icon name="close" /></button>
    </div>
  </div>)}{shown.length > 3 && <button type="button" className="text-button" onClick={() => navigation.go({ page: "offers" })}>{shown.length - 3} more in Trade offers</button>}</aside>;
}
