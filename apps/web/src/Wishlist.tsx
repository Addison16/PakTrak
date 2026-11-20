import { useEffect, useState } from "react";
import { money, mutation, priceInput, providers, request, type Printing, type Session, type WantedFinish, type Wishlist as WishlistData, type WishlistItem } from "./api";
import ErrorNotice from "./ErrorNotice";
import PrintingPicker from "./PrintingPicker";
import { ShareSection } from "./ShareLink";
import StoreButtons, { ReferralNote } from "./StoreButtons";
import "./trade-value.css";
import "./social.css";
import { usePullReload } from "./pullRefresh";

const finishNames: Record<WantedFinish, string> = { any: "Any finish", nonfoil: "Nonfoil", foil: "Foil", etched: "Etched foil" };
const finishOptions = (printing: Printing): WantedFinish[] => ["any", ...(["nonfoil", "foil", "etched"] as const).filter((finish) => printing.finishes.includes(finish))];

/** Add cards to the wishlist from anywhere (deck buy lists, set completion). */
export async function addToWishlist(session: Session, items: { printing_id: string; quantity: number; finish?: WantedFinish }[]) {
  let added = 0;
  for (let start = 0; start < items.length; start += 300) {
    const result = await request<{ added: number }>("/api/v1/wishlist", { ...mutation(session, { items: items.slice(start, start + 300) }), action: "Add to wishlist" });
    added += result.added;
  }
  return added;
}

/** The most you'd pay for one copy. Saved when you leave the box or press Enter. */
function TargetPrice({ item, disabled, onSave }: { item: WishlistItem; disabled: boolean; onSave: (target: string | null) => void }) {
  const saved = item.target_price || "";
  const [text, setText] = useState(saved);
  useEffect(() => setText(saved), [saved]);
  const parsed = priceInput(text);
  const invalid = parsed === null || parsed === "0.00";
  const commit = () => { if (invalid) return; if ((parsed || "") !== saved) onSave(parsed || null); else setText(saved); };
  return <label className="wish-target">Pay up to
    <input inputMode="decimal" placeholder="$" value={text} disabled={disabled} aria-label={`Most you’d pay for one ${item.printing.name}`} aria-invalid={invalid || undefined}
      onChange={(event) => setText(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} />
  </label>;
}

export default function Wishlist({ session, active }: { session: Session; active: boolean }) {
  const [data, setData] = useState<WishlistData | null>(null);
  const [error, setError] = useState<Error | string>("");
  const [notice, setNotice] = useState("");
  const [adding, setAdding] = useState<"search" | "paste" | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const { reload, setReload, settle } = usePullReload(active);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    request<WishlistData>("/api/v1/wishlist", { signal: controller.signal }).then((value) => { setData(value); settle(); }).catch((reason: Error) => { if (!controller.signal.aborted) { setError(reason); settle(reason); } });
    return () => controller.abort();
  }, [active, reload]);

  async function act(work: () => Promise<string | void>) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { const message = await work(); if (message) setNotice(message); setReload((value) => value + 1); }
    catch (reason) { setError(reason as Error); }
    finally { setBusy(false); }
  }
  const save = (item: WishlistItem, change: Partial<Pick<WishlistItem, "quantity" | "finish" | "target_price">>) => act(async () => {
    const next = { quantity: item.quantity, finish: item.finish, notes: item.notes || "", ...change };
    if (next.quantity < 1) await request(`/api/v1/wishlist/${item.id}`, { method: "DELETE", headers: { "X-CSRF-Token": session.csrf_token }, action: "Remove from wishlist" });
    else await request(`/api/v1/wishlist/${item.id}`, mutation(session, next));
    // Show the saved quantity right away so a quick second tap counts from it, not from the stale item.
    setData((current) => current && { ...current, items: next.quantity < 1 ? current.items.filter((row) => row.id !== item.id) : current.items.map((row) => row.id === item.id ? { ...row, quantity: next.quantity, finish: next.finish } : row) });
  });

  const items = data?.items || [];
  return <section className="panel social-page" aria-labelledby="wishlist-title">
    <div className="eyebrow">CARDS YOU WANT</div>
    <h2 id="wishlist-title">Wishlist</h2>
    <p>Keep track of cards you’re looking for. Friends you’ve added can see this list when you share it, and the stores below can fill a cart from it. Set “Pay up to” on a card to see when its price gets there; only you see that amount.</p>
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
    {notice && <p className="message success" role="status">{notice}</p>}

    {data && items.length > 0 && <div className="social-total">
      <span>{data.copies} {data.copies === 1 ? "card" : "cards"} wanted</span>
      <strong>{money(data.amount)}</strong>
      <small>{providers[data.provider]}{data.priced_copies < data.copies ? ` · ${data.copies - data.priced_copies} without a price` : ""}</small>
    </div>}

    {!!data?.at_target && <p className="wish-reached-note" role="status">{data.at_target === 1 ? "1 card is" : `${data.at_target} cards are`} at or under the price you set.</p>}

    {!data && !error ? <p role="status">Loading your wishlist…</p> : items.length === 0 ? <p className="fine">Your wishlist is empty. Add cards below, paste a list, or use “Add missing cards to wishlist” on a deck.</p>
      : <ul className="plain-list trade-cards">{items.map((item) => <li key={item.id} className="trade-card">
        {item.printing.image_url ? <img src={item.printing.image_url} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} /> : <span className="printing-art-placeholder" aria-hidden="true" />}
        <div className="trade-card-body">
          <strong>{item.printing.display_name || item.printing.name}</strong>
          <small>{item.printing.set_name ? `${item.printing.set_name} · ` : ""}{item.printing.set_code.toUpperCase()} #{item.printing.collector_number}{item.owned ? ` · You own ${item.owned}` : ""}</small>
          <div className="trade-card-controls">
            <label className="trade-finish">Finish<select value={item.finish} disabled={busy} aria-label={`Finish for ${item.printing.name}`} onChange={(event) => void save(item, { finish: event.target.value as WantedFinish })}>{finishOptions(item.printing).map((finish) => <option key={finish} value={finish}>{finishNames[finish]}</option>)}</select></label>
            <div className="trade-quantity" role="group" aria-label={`Copies of ${item.printing.name} wanted`}>
              <button type="button" disabled={busy} aria-label={item.quantity === 1 ? `Remove ${item.printing.name}` : `One fewer ${item.printing.name}`} onClick={() => void save(item, { quantity: item.quantity - 1 })}>−</button>
              <span>{item.quantity}</span>
              <button type="button" disabled={busy || item.quantity >= 999} aria-label={`One more ${item.printing.name}`} onClick={() => void save(item, { quantity: item.quantity + 1 })}>+</button>
            </div>
            <TargetPrice item={item} disabled={busy} onSave={(target) => void save(item, { target_price: target })} />
          </div>
        </div>
        <div className="trade-card-price">
          <strong>{item.unit_amount ? money(Number(item.unit_amount) * item.quantity) : "No price"}</strong>
          {item.unit_amount && item.quantity > 1 && <small>{item.quantity} × {money(item.unit_amount)}</small>}
          {item.at_target && <small className="wish-reached">At your price</small>}
          <button type="button" className="text-button" disabled={busy} onClick={() => void save(item, { quantity: 0 })} aria-label={`Remove ${item.printing.name} from wishlist`}>Remove</button>
        </div>
      </li>)}</ul>}

    <div className="actions social-add">
      <button type="button" className="button secondary" aria-pressed={adding === "search"} onClick={() => setAdding(adding === "search" ? null : "search")}>Add a card</button>
      <button type="button" className="button secondary" aria-pressed={adding === "paste"} onClick={() => setAdding(adding === "paste" ? null : "paste")}>Paste a list</button>
    </div>
    {adding === "search" && <PrintingPicker onSelect={(printing) => void act(async () => { await addToWishlist(session, [{ printing_id: printing.id, quantity: 1 }]); return `Added ${printing.name}.`; })} />}
    {adding === "paste" && <form className="social-paste" onSubmit={(event) => { event.preventDefault(); void act(async () => {
      const result = await request<{ added: number; unresolved: { line: number; name: string }[] }>("/api/v1/wishlist/paste", { ...mutation(session, { content: pasted }), action: "Add list to wishlist" });
      setPasted(result.unresolved.map((row) => row.name).join("\n"));
      return `Added ${result.added} ${result.added === 1 ? "card" : "cards"}.${result.unresolved.length ? ` ${result.unresolved.length} ${result.unresolved.length === 1 ? "line wasn’t" : "lines weren’t"} recognized and ${result.unresolved.length === 1 ? "is" : "are"} left in the box.` : ""}`;
    }); }}>
      <label>One card per line, like “2 Lightning Bolt” or “1 Sol Ring (C21) 263”<textarea rows={6} value={pasted} onChange={(event) => setPasted(event.target.value)} /></label>
      <button className="button primary" disabled={busy || !pasted.trim()}>Add to wishlist</button>
    </form>}

    {data && <ShareSection className="value-history" summary="Share your wishlist" session={session} kind="wishlist" />}

    {items.length > 0 && <div className="social-stores">
      <h3>Buy your wishlist</h3>
      <StoreButtons stores={["tcgplayer", "cardkingdom", "manapool"]} cards={items.map((item) => ({ printing: item.printing, quantity: item.quantity }))} exact={false} links={session.store_links} short />
      <ReferralNote links={session.store_links} />
    </div>}
  </section>;
}
