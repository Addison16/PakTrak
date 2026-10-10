import { useEffect, useState } from "react";
import { money, mutation, providers, request, type PriceSource, type Session } from "./api";
import usePriceSource from "./usePriceSource";
import { sectionOrder, sections, type DeckValuation, type FinishPreference, type Section } from "./deckTypes";
import "./deck-value.css";

const finishes = { nonfoil: "Nonfoil", foil: "Foil", etched: "Etched foil" };
type Choice = { printing_id: string; section: Section; quantity: number };
export default function DeckValue({ session, cards, saved, live, paused, busy, onCard, compact = false }: {
  session: Session; cards: Choice[]; saved: DeckValuation; live: boolean; paused: boolean; busy: boolean;
  onCard: (id: string, section: Section) => void; compact?: boolean;
}) {
  const preference = usePriceSource(session);
  const [finish, setFinish] = useState<FinishPreference>("nonfoil");
  const [answer, setAnswer] = useState<{ key: string; report?: DeckValuation; error?: string } | null>(null);
  const [retry, setRetry] = useState(0), [onlyUnpriced, setOnlyUnpriced] = useState(false);
  const payload = JSON.stringify({ cards, provider: preference.provider, finish_preference: finish });
  const key = payload + ":" + saved.checked_at;
  const needsRequest = live || saved.provider !== preference.provider || saved.finish_preference !== finish || retry > 0;
  useEffect(() => {
    if (!needsRequest || paused || !preference.ready) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void request<DeckValuation>("/api/v1/decks/value", { ...mutation(session, JSON.parse(payload)), signal: controller.signal, action: "Calculate deck value" })
        .then((report) => { if (!controller.signal.aborted) setAnswer({ key, report }); })
        .catch((reason: Error) => { if (!controller.signal.aborted) setAnswer({ key, error: reason.message }); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [needsRequest, paused, preference.ready, payload, key, session.csrf_token, retry]);
  const report = paused || !preference.ready ? undefined : needsRequest ? answer?.key === key ? answer.report : undefined : saved;
  const error = !paused && preference.ready && needsRequest && answer?.key === key ? answer.error : undefined;
  const reload = () => { setAnswer(null); setRetry(value => value + 1); };
  const rows = report?.items.filter(item => !onlyUnpriced || item.unit_amount === null) || [];
  const controls = <>
    <div className="deck-value-heading"><div><span className="eyebrow">EVERY COPY COUNTS</span><h3>Deck value</h3></div><button className="text-button" disabled={busy || paused || !preference.ready || !!needsRequest && !report && !error} onClick={reload}>Refresh value</button></div>
    <div className="deck-value-controls">
      <label>Deck price source<select value={preference.provider} disabled={busy || !preference.ready || preference.saving} onChange={event => void preference.change(event.target.value as PriceSource)}>{Object.entries(providers).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Finish for estimate<select value={finish} disabled={busy} onChange={event => setFinish(event.target.value as FinishPreference)}><option value="nonfoil">Nonfoil where available</option><option value="foil">Foil where available</option><option value="etched">Etched where available</option></select></label>
    </div>
    {preference.preferenceError ? <p className="fine row-error" role="status">{preference.preferenceError} <button className="text-button" onClick={() => void preference.retrySave()}>Retry price preference</button></p> : <p className="fine deck-value-source-status">{preference.saving ? "Remembering price source…" : "Price source is shared with your collection."}</p>}
  </>;
  const estimate = <>
    {paused ? <p role="status">Finish entering card quantities to update this estimate.</p> : error ? <p className="message error" role="status">Deck value unavailable. {error} <button className="text-button" onClick={reload}>Retry deck value</button></p> : !report ? <p role="status">Calculating deck value…</p> : <>
      <div className="deck-value-total"><strong aria-label="Estimated deck value">{money(report.amount)}</strong><span>{report.copies === 0 ? "Add cards to see your deck’s value" : report.priced_copies === 0 ? "No prices available" : report.unpriced_copies ? "Partial estimate · USD" : "Estimated value · USD"}</span></div>
      <p className="deck-value-coverage" role="status">{report.priced_copies} of {report.copies} copies priced{report.unpriced_copies > 0 && ` · ${report.unpriced_copies} unpriced`}{live && " · Unsaved deck changes"}</p>
    </>}
  </>;
  const breakdown = report && <>
      {report.unpriced_copies > 0 && <p className="fine">Unpriced cards are excluded from the total. Open the breakdown to see which cards need a quote.</p>}
      <p className="fine">{providers[report.provider]} · {report.price_kind}. {report.feed?.updated_at ? `Prices updated ${new Date(report.feed.updated_at).toLocaleString()}.` : "No dated price update available."}{(!report.feed || report.feed.stale) && " Cached prices may be out of date."}</p>
      {report.feed?.error && <p className="fine row-error">The latest source update failed. Showing the last saved prices.</p>}
      <details className="deck-value-breakdown"><summary>Card values and sections</summary>
        <div className="deck-value-sections" aria-label="Value by deck section">{sectionOrder.filter(section => (report.sections[section]?.copies || 0) > 0).map(section => <div key={section}><span>{sections[section]}</span><strong>{money(report.sections[section].amount)}</strong><small>{report.sections[section].copies} {report.sections[section].copies === 1 ? "copy" : "copies"}{report.sections[section].unpriced_copies > 0 && ` · ${report.sections[section].unpriced_copies} unpriced`}</small></div>)}</div>
        <p className="fine">Prices use the editions saved in this deck and include every requested copy, whether or not it is in your collection.</p>
        <label className="checkbox"><input type="checkbox" checked={onlyUnpriced} onChange={event => setOnlyUnpriced(event.target.checked)} />Only unpriced cards</label>
        <ul className="plain-list">{rows.map(item => <li key={item.printing_id + item.section}>
          <div><button className="text-button" onClick={() => onCard(item.printing_id, item.section)}>{item.name}</button><small>{item.set_code.toUpperCase()} #{item.collector_number} · {sections[item.section]} · {item.finish ? finishes[item.finish] : "Finish unavailable"}</small><small>{item.unit_amount === null ? item.unpriced_reason === "unknown_finish" ? "No supported finish recorded for this edition" : "No quote for this edition and finish" : `${item.quantity} × ${money(item.unit_amount)}`}</small></div>
          <strong>{item.amount === null ? "Unpriced" : money(item.amount)}</strong>
        </li>)}</ul>
        {rows.length === 0 && <p className="fine">{onlyUnpriced && report.copies ? "Every card has a price for this estimate." : "No cards to show."}</p>}
      </details>
      <p className="fine deck-value-note">Decks do not record each copy’s finish. This estimate prefers {finishes[finish].toLowerCase()}; editions without that finish use one they offer.{report.fallback_copies > 0 && ` ${report.fallback_copies} copies use another available finish.`} Missing quotes never use a different finish’s price. Daily reference prices exclude shipping and tax.</p>
  </>;
  return <section className={`deck-value${compact ? " deck-value--compact" : ""}`} aria-label="Deck value" aria-busy={!paused && !error && !report}>
    {compact ? <>
      <span className="deck-value-label">Deck value</span>
      {estimate}
      <details className="deck-value-options"><summary>Price details</summary><div className="deck-value-options-body">{controls}{breakdown}</div></details>
    </> : <>{controls}{estimate}{breakdown}</>}
  </section>;
}
