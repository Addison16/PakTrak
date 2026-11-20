import { useEffect, useState } from "react";
import type { Printing } from "./api";
import "./shared-page.css";

type Card = { printing: Printing; quantity: number; section?: "commander" | "main" | "sideboard"; finish?: string };
type Shared = { kind: "deck" | "wishlist"; name?: string; format?: string; copies: number; cards: Card[] };
const sectionNames = { commander: "Commander", main: "Mainboard", sideboard: "Sideboard" } as const;
const finishNames: Record<string, string> = { nonfoil: "Nonfoil", foil: "Foil", etched: "Etched foil" };
const count = (cards: Card[]) => cards.reduce((sum, card) => sum + card.quantity, 0);

/** A deck or wishlist someone shared by link. Opens without an account and shows only the list. */
export default function SharedPage({ token }: { token: string }) {
  const [data, setData] = useState<Shared | null>(null);
  const [problem, setProblem] = useState("");
  const [copied, setCopied] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setProblem("");
    fetch(`/api/public/shares/${encodeURIComponent(token)}`, { signal: controller.signal, credentials: "omit", cache: "no-store" })
      .then(async (response) => {
        if (response.ok) setData(await response.json());
        else setProblem(response.status === 404 ? "This link isn’t active. Ask the person who sent it for a new one." : "This list couldn’t be loaded right now. Try again in a moment.");
      })
      .catch(() => { if (!controller.signal.aborted) setProblem("This list couldn’t be loaded right now. Check your connection and try again."); });
    return () => controller.abort();
  }, [token]);
  useEffect(() => { document.title = data ? `${data.kind === "deck" ? data.name : "Wishlist"} · PakTrak` : "PakTrak"; }, [data]);

  const groups = !data ? [] : data.kind === "deck"
    ? (["commander", "main", "sideboard"] as const).map((section) => ({ title: sectionNames[section], cards: data.cards.filter((card) => card.section === section) })).filter((group) => group.cards.length)
    : [{ title: "", cards: data.cards }];
  const text = groups.map((group) => [...(group.title && groups.length > 1 ? [group.title] : []), ...group.cards.map((card) => `${card.quantity} ${card.printing.name}`)].join("\n")).join("\n\n");
  const copy = () => { void (navigator.clipboard ? navigator.clipboard.writeText(text).then(() => setCopied("List copied."), () => setCopied("Copying isn’t available here.")) : Promise.resolve(setCopied("Copying isn’t available here."))); };

  return <div className="app shared-app">
    <header className="topbar"><a className="brand" href="/" aria-label="PakTrak home"><img src="/brand/paktrak-mark.svg" width="42" height="42" alt="" /><span className="brand-wordmark"><strong>Pak<span>Trak</span></strong><small>Every card. In reach.</small></span></a></header>
    <main>
      <section className="panel shared-page" aria-labelledby="shared-title">
        {problem ? <><h1 id="shared-title">Nothing to show</h1><p role="alert">{problem}</p></> : !data ? <p role="status" id="shared-title">Opening the shared list…</p> : <>
          <div className="eyebrow">{data.kind === "deck" ? "SHARED DECK" : "SHARED WISHLIST"}</div>
          <h1 id="shared-title">{data.kind === "deck" ? data.name : "Wishlist"}</h1>
          <p className="shared-summary">{data.copies.toLocaleString()} {data.copies === 1 ? "card" : "cards"}{data.kind === "deck" && data.format ? ` · ${data.format[0].toUpperCase()}${data.format.slice(1)}` : ""}</p>
          {data.cards.length === 0 ? <p className="fine">This list is empty right now.</p> : <>
            <div className="actions"><button type="button" className="button secondary" onClick={copy}>Copy list as text</button></div>
            {copied && <p className="fine" role="status">{copied}</p>}
            {groups.map((group) => <div key={group.title || "all"}>
              {group.title && <h2>{group.title} <small>{count(group.cards)}</small></h2>}
              <ul className="plain-list shared-cards">{group.cards.map((card, index) => <li key={card.printing.id + (card.finish || "") + index}>
                {card.printing.image_url ? <img src={card.printing.image_url} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} /> : <span className="printing-art-placeholder" aria-hidden="true" />}
                <span className="shared-quantity">{card.quantity}×</span>
                <span className="shared-name"><strong>{card.printing.display_name || card.printing.name}</strong><small>{card.printing.set_name ? `${card.printing.set_name} · ` : ""}{card.printing.set_code.toUpperCase()} #{card.printing.collector_number}{card.finish && card.finish !== "any" ? ` · ${finishNames[card.finish] || card.finish}` : ""}</small></span>
              </li>)}</ul>
            </div>)}
          </>}
        </>}
        <p className="fine shared-foot">Shared read-only from a PakTrak server. Card imagery © Wizards of the Coast · Card data and images via Scryfall</p>
      </section>
    </main>
  </div>;
}
