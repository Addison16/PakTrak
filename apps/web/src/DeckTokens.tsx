import { useEffect, useRef, useState } from "react";
import { mutation, request, type Session } from "./api";
import { CardArt } from "./CardDetail";
import type { DeckToken, DeckTokens as Report, Section, TokenFace } from "./deckTypes";

const colors: Record<string, string> = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green" };
function characteristics(face: TokenFace) {
  return [face.power !== null && face.toughness !== null ? `${face.power}/${face.toughness}` : "", face.colors ? face.colors.map((color) => colors[color] || color).join(" / ") || "Colorless" : "", face.type_line].filter(Boolean).join(" · ");
}

function TokenPreview({ token, onClose }: { token: DeckToken; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [faceIndex, setFaceIndex] = useState(0);
  useEffect(() => {
    dialog.current?.showModal();
    const overflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = overflow; };
  }, []);
  const face = token.faces[faceIndex];
  return <dialog ref={dialog} className="card-dialog deck-preview-dialog token-preview-dialog" aria-labelledby="token-preview-title" onClose={onClose}>
    <div className="dialog-heading"><span className="eyebrow">{token.kind === "emblem" ? "EMBLEM" : "DECK TOKEN"}</span><button autoFocus className="text-button" aria-label="Close token preview" onClick={() => dialog.current?.close()}>Close ×</button></div>
    <div className="deck-preview-art"><CardArt url={face.detail_image_url || face.image_url} name={face.name} eager /></div>
    <h2 id="token-preview-title">{face.name}</h2>
    <p className="fine">{characteristics(face)}</p>
    {face.oracle_text && <p className="token-rules">{face.oracle_text}</p>}
    {!token.details_available && <p className="fine">The token is linked to your deck, but its full details are not available yet.</p>}
    <div className="token-preview-actions">
      {token.faces.length > 1 && <button className="button secondary" onClick={() => setFaceIndex((faceIndex + 1) % token.faces.length)}>View other face</button>}
      <button className="button secondary" onClick={() => dialog.current?.close()}>Back to token list</button>
    </div>
  </dialog>;
}

export default function DeckTokens({ session, cards, saved, live, paused, format, onCard }: {
  session: Session; cards: { printing_id: string; section: Section; quantity: number }[];
  saved?: Report; live: boolean; paused: boolean; format: string; onCard: (id: string) => void;
}) {
  const [answer, setAnswer] = useState<{ key: string; report?: Report; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const payload = JSON.stringify({ cards });
  useEffect(() => {
    if (!live || paused) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void request<Report>("/api/v1/decks/tokens", { ...mutation(session, JSON.parse(payload)), signal: controller.signal })
        .then((report) => { if (!controller.signal.aborted) setAnswer({ key: payload, report }); })
        .catch((e: Error) => { if (!controller.signal.aborted) setAnswer({ key: payload, error: e.message }); });
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [live, paused, payload, session.csrf_token, retry]);
  const report = paused ? undefined : live ? answer?.key === payload ? answer.report : undefined : saved;
  const error = !paused && live && answer?.key === payload ? answer.error : undefined;
  const preview = report?.items.find((token) => token.id === selected);
  if (!live && !saved) return null;
  return <section className="deck-tokens" aria-label="Tokens for this deck" aria-busy={!paused && !error && !report}>
    <div className="token-list-heading"><div><span className="eyebrow">BRING TO THE TABLE</span><h3>Tokens for this deck</h3></div>{report && <span className="badge">{report.items.length} {report.items.length === 1 ? "type" : "types"}</span>}</div>
    <p className="fine">Tokens and emblems linked to your cards. Bring extra copies as needed; the amount you make depends on play.</p>
    {live && !paused && <p className="fine">Previewing your unsaved deck changes.</p>}
    {paused ? <p className="fine" role="status">Finish entering card quantities to update the token list.</p> : error ? <p className="message error" role="status">Token list unavailable. {error} <button className="text-button" onClick={() => { setAnswer(null); setRetry((value) => value + 1); }}>Retry token list</button></p> : !report ? <p className="fine" role="status">Checking deck tokens…</p> : <>
      {report.items.length === 0 ? <p className="token-empty">{cards.length ? "No linked tokens or emblems found for these cards." : "Add cards to see which tokens this deck uses."}</p> : <ul className="plain-list token-list">{report.items.map((token) => <li key={token.id} className="token-row">
        <button className="deck-card-art deck-art-button token-art" aria-label={`Preview ${token.name} token`} onClick={() => setSelected(token.id)}><CardArt url={token.faces[0].image_url} name={token.name} /></button>
        <div className="token-copy"><h4>{token.name}</h4>
          <div className="token-badges">{token.kind === "emblem" && <span className="badge">Emblem</span>}{token.sideboard_only && <span className="badge">{format === "commander" ? "Extras only" : "Sideboard only"}</span>}</div>
          {token.faces.map((face, index) => <p className="fine" key={index}>{token.faces.length > 1 ? `${face.name} · ` : ""}{characteristics(face)}</p>)}
          {!token.details_available && <p className="fine">Full token details unavailable.</p>}
          <div className="token-sources"><span className="fine">Used by</span>{token.sources.filter((source, index, all) => all.findIndex((other) => other.name === source.name) === index).map((source) => <button className="text-button" key={source.printing_id} aria-label={`View ${source.name} in deck`} onClick={() => onCard(source.printing_id)}>{source.name}</button>)}</div>
          {token.faces.some((face) => face.oracle_text) && <details className="token-abilities"><summary>Token abilities</summary>{token.faces.filter((face) => face.oracle_text).map((face, index) => <p className="token-rules" key={index}>{token.faces.length > 1 && <strong>{face.name}<br /></strong>}{face.oracle_text}</p>)}</details>}
        </div>
      </li>)}</ul>}
      <p className="fine token-list-note">Copy effects and tokens without a listed match may need additional markers.</p>
    </>}
    {preview && <TokenPreview key={preview.id} token={preview} onClose={() => setSelected(null)} />}
  </section>;
}
