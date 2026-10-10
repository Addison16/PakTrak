import { useEffect, useState } from "react";
import { ApiError, request } from "./api";
import { allowOfflineRead } from "./offline";
import "./card-rules.css";

type Ruling = { source: string; published_at: string; comment: string };
type Rules = { legalities: Record<string, string>; rulings: Ruling[]; rulings_saved: boolean };

// Paper formats, in the order most players look for them.
const formats: [string, string][] = [
  ["standard", "Standard"], ["pioneer", "Pioneer"], ["modern", "Modern"], ["legacy", "Legacy"],
  ["vintage", "Vintage"], ["commander", "Commander"], ["oathbreaker", "Oathbreaker"], ["pauper", "Pauper"],
  ["paupercommander", "Pauper Commander"], ["premodern", "Premodern"], ["duel", "Duel Commander"], ["brawl", "Brawl"],
];
const states: Record<string, string> = { legal: "Legal", not_legal: "Not legal", banned: "Banned", restricted: "Restricted" };
const shown = 3;

// Saved like the card pages, so cards opened once still show their rulings offline.
allowOfflineRead(/^\/api\/v1\/catalog\/printings\/[\w-]+\/rulings$/);

function day(value: string) {
  const [year, month, date] = value.split("-").map(Number);
  return new Date(year, month - 1, date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Format legality and official rulings, listed under the card. */
export default function CardRules({ printingId }: { printingId: string }) {
  const [rules, setRules] = useState<Rules | null>(null);
  const [failed, setFailed] = useState(false);
  const [all, setAll] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setRules(null); setFailed(false); setAll(false);
    request<Rules>(`/api/v1/catalog/printings/${printingId}/rulings`, { signal: controller.signal, quiet: true })
      // A partial answer should never break the rest of the card page.
      .then((value) => setRules({ legalities: value?.legalities || {}, rulings: Array.isArray(value?.rulings) ? value.rulings : [], rulings_saved: !!value?.rulings_saved })).catch((e: Error) => {
        // A card missing from this server's catalog simply has nothing to show.
        if (e.name !== "AbortError" && !(e instanceof ApiError && e.status === 404)) setFailed(true);
      });
    return () => controller.abort();
  }, [printingId]);
  if (failed) return <section className="card-rules" aria-label="Legality and rulings"><p className="fine">Legality and rulings show once PakTrak’s server can be reached.</p></section>;
  if (!rules) return null;
  const legal = formats.filter(([key]) => rules.legalities[key]);
  const rulings = all ? rules.rulings : rules.rulings.slice(0, shown);
  return <section className="card-rules" aria-label="Legality and rulings">
    {legal.length > 0 && <>
      <h3>Format legality</h3>
      <dl className="card-legality">{legal.map(([key, label]) => { const value = rules.legalities[key]; return <div key={key} className={"legality-" + value}>
        <dt>{label}</dt><dd>{states[value] || value.replaceAll("_", " ")}</dd>
      </div>; })}</dl>
    </>}
    <h3>Rulings</h3>
    {rules.rulings.length === 0 ? <p className="fine">{rules.rulings_saved ? "This card has no official rulings." : "Rulings arrive with the server’s next daily catalog update."}</p> : <>
      <ol className="plain-list card-rulings">{rulings.map((ruling, index) => <li key={index}>
        <p className="ruling-date"><time dateTime={ruling.published_at}>{day(ruling.published_at)}</time>{ruling.source === "scryfall" && " · Scryfall note"}</p>
        <p>{ruling.comment}</p>
      </li>)}</ol>
      {rules.rulings.length > shown && <button type="button" className="text-button rulings-more" aria-expanded={all} onClick={() => setAll(!all)}>{all ? "Show fewer rulings" : `Show all ${rules.rulings.length} rulings`}</button>}
    </>}
    <p className="fine">Legality and rulings from Scryfall’s saved catalog.</p>
  </section>;
}
