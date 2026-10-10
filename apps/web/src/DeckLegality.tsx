import { useEffect, useState } from "react";
import { mutation, request, type Session } from "./api";
import type { DeckLegality as Report, Section } from "./deckTypes";

type Choice = { printing_id: string; section: Section; quantity: number };
export default function DeckLegality({ session, format, cards, saved, live = false, onCard }: {
  session: Session; format: string; cards: Choice[]; saved?: Report; live?: boolean; onCard?: (id: string) => void;
}) {
  const [answer, setAnswer] = useState<{ key: string; report?: Report; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const payload = JSON.stringify({ format, cards });
  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void request<Report>("/api/v1/decks/legality", { ...mutation(session, JSON.parse(payload)), signal: controller.signal })
        .then((report) => { if (!controller.signal.aborted) setAnswer({ key: payload, report }); })
        .catch((e: Error) => { if (!controller.signal.aborted) setAnswer({ key: payload, error: e.message }); });
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [live, payload, session.csrf_token, retry]);
  const report = live ? answer?.key === payload ? answer.report : undefined : saved;
  const error = live && answer?.key === payload ? answer.error : undefined;
  const errors = report?.issues.filter((item) => item.severity === "error").length || 0;
  const fixed = !["casual", "other"].includes(format);
  const name = report?.archenemy ? fixed ? `${format[0].toUpperCase() + format.slice(1)} Archenemy` : "Archenemy" : format[0].toUpperCase() + format.slice(1);
  const title = error ? "Legality check unavailable" : !report ? "Checking format rules…"
    : report.status === "legal" ? `✓ Passes ${name} checks`
    : report.status === "issues" ? `${errors} ${errors === 1 ? "issue" : "issues"} to fix for ${name}`
    : report.status === "incomplete" ? "Legality needs a closer look" : "Choose a format to check legality";
  if (!live && !saved) return null;
  return <section className={`deck-legality ${report?.status || "checking"}`} aria-label="Deck legality">
    <p className="legality-title" role="status">{title}</p>
    {error && <p className="fine">{error} <button className="text-button" onClick={() => { setAnswer(null); setRetry((n) => n + 1); }}>Try again</button></p>}
    {report && <>
      <p className="fine">{report.counts.commander > 0 && `${report.counts.commander} commander · `}{report.counts.main} mainboard · {report.counts.sideboard} {format === "commander" ? "extras" : "sideboard"}{report.counts.schemes > 0 && ` · ${report.counts.schemes} ${report.counts.schemes === 1 ? "scheme" : "schemes"}`}{live && " · Unsaved list"}</p>
      {report.status === "not_checked" ? <p className="fine">Casual and Other have no fixed rules. Choose a format in the deck settings to check legality.</p> : <details open={report.status === "issues" || report.status === "incomplete"}>
        <summary>Legality details</summary>
        {report.issues.length > 0 && <ul className="plain-list legality-issues">{report.issues.map((item, index) => <li key={item.code + index} className={item.severity === "error" ? "row-error" : ""}>
          <span>{item.severity === "error" ? "! " : item.severity === "warning" ? "Review: " : ""}{item.message}</span>
          {onCard && item.printing_ids.length > 0 && <button className="text-button" onClick={() => onCard(item.printing_ids[0])}>View card</button>}
        </li>)}</ul>}
        <p className="fine">Checks: {report.checks.join(" · ")}. You can save and keep working on a deck with issues.</p>
        <p className="fine">{report.catalog_updated_at ? `Card data updated ${new Date(report.catalog_updated_at).toLocaleString()}.` : "No dated card data available."} Card legality follows the server’s daily catalog updates.</p>
        <p className="fine">{report.limitations.join(" ")} <a href="https://magic.wizards.com/en/rules" target="_blank" rel="noreferrer">Official rules</a> · <a href="https://magic.wizards.com/en/banned-restricted-list" target="_blank" rel="noreferrer">Banned and restricted cards</a></p>
      </details>}
    </>}
  </section>;
}
