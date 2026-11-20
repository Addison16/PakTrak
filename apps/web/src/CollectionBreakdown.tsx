import { useEffect, useState } from "react";
import { foilName, money, providers, request, type Printing } from "./api";

type Row = { key: string; label: string; copies: number; value: string | null };
type Breakdown = {
  provider: string; copies: number; value: string;
  colors: Row[]; rarities: Row[]; types: Row[]; sets: Row[]; locations: Row[];
  top_cards: { printing: Printing; finish: string; quantity: number; amount: string }[];
  paid: { copies: number; unpriced_copies: number; paid: string; value: string; change: string } | null;
};
const groups = [["colors", "Color"], ["rarities", "Rarity"], ["types", "Card type"], ["sets", "Set"], ["locations", "Storage location"]] as const;
type Group = typeof groups[number][0];
const copiesText = (count: number) => `${count.toLocaleString()} ${count === 1 ? "copy" : "copies"}`;

/** Where the collection's cards and value sit, the most valuable cards, and what was paid. */
export default function CollectionBreakdown({ provider, onOpen }: { provider: string; onOpen: (printingId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState<Group>("colors");
  const [data, setData] = useState<Breakdown | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setFailed(false);
    request<Breakdown>(`/api/v1/collection/breakdown?provider=${provider}`, { signal: controller.signal, quiet: true })
      .then(setData).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [open, provider]);
  const rows = data?.[group] || [];
  // Bars compare value when anything is priced, and copies otherwise.
  const byValue = rows.some((row) => Number(row.value) > 0);
  const largest = Math.max(1, ...rows.map((row) => byValue ? Number(row.value) || 0 : row.copies));
  const change = data?.paid ? Number(data.paid.change) : 0;
  return <details className="value-history collection-breakdown" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Collection breakdown</summary>
    {failed ? <p className="fine">The breakdown couldn’t load. Try again later.</p> : !data ? <p role="status" className="fine">Loading your breakdown…</p> : data.copies === 0 ? <p className="fine">Add some cards and their breakdown appears here.</p> : <>
      <label className="value-history-range">Group by<select value={group} onChange={(event) => setGroup(event.target.value as Group)}>{groups.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <table className="breakdown-table">
        <thead><tr><th scope="col">{groups.find(([key]) => key === group)?.[1]}</th><th scope="col">Copies</th><th scope="col">Value</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.key || row.label}>
          <th scope="row">{row.label}<span className="breakdown-bar" aria-hidden="true"><span style={{ width: `${Math.max(1, Math.round((byValue ? Number(row.value) || 0 : row.copies) / largest * 100))}%` }} /></span></th>
          <td>{row.copies.toLocaleString()}</td>
          <td>{money(row.value)}</td>
        </tr>)}</tbody>
      </table>
      <p className="fine">{providers[data.provider as keyof typeof providers] || data.provider} reference prices. Cards with several colors count as Multicolor, and a card with several types counts once.</p>
      {data.paid && <>
        <h3>What you paid</h3>
        <p className="breakdown-paid">You paid <strong>{money(data.paid.paid)}</strong> for {copiesText(data.paid.copies)} worth <strong>{money(data.paid.value)}</strong> today{Math.abs(change) < 0.005 ? "." : <>, {change > 0 ? "up" : "down"} <strong>{money(Math.abs(change))}</strong>.</>}</p>
        <p className="fine">Only copies with a recorded price count.{data.paid.unpriced_copies > 0 ? ` ${copiesText(data.paid.unpriced_copies)} with a recorded price ${data.paid.unpriced_copies === 1 ? "has" : "have"} no price today and ${data.paid.unpriced_copies === 1 ? "is" : "are"} left out.` : ""}</p>
      </>}
      {data.top_cards.length > 0 && <>
        <h3>Most valuable cards</h3>
        <ol className="plain-list breakdown-top">{data.top_cards.map((card) => <li key={card.printing.id + card.finish}>
          <button type="button" onClick={() => onOpen(card.printing.id)}>
            {card.printing.image_url ? <img src={card.printing.image_url} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} /> : <span className="printing-art-placeholder" aria-hidden="true" />}
            <span><strong>{card.printing.display_name || card.printing.name}</strong><small>{card.printing.set_code.toUpperCase()} #{card.printing.collector_number} · {card.finish === "foil" ? foilName(card.printing) : card.finish === "etched" ? "Etched foil" : "Nonfoil"}{card.quantity > 1 ? ` · ×${card.quantity}` : ""}</small></span>
            <span className="breakdown-price">{money(card.amount)}</span>
          </button>
        </li>)}</ol>
      </>}
    </>}
  </details>;
}
