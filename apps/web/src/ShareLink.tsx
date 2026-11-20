import { useEffect, useState } from "react";
import { request, type Session } from "./api";
import ErrorNotice from "./ErrorNotice";

type Link = { id: string; kind: "deck" | "wishlist"; deck_id: string | null; token: string };
export const shareAddress = (token: string) => `${location.origin}/#/shared/${token}`;

/** The folded share section; it asks the server about a link only once it is opened. */
export function ShareSection({ summary, className, ...props }: { summary: string; className: string; session: Session; kind: "deck" | "wishlist"; deckId?: string }) {
  const [open, setOpen] = useState(false);
  return <details className={className} onToggle={(event) => setOpen(event.currentTarget.open)}><summary>{summary}</summary>{open && <ShareLink {...props} />}</details>;
}

/** Create, copy and turn off the read-only link for one deck or for the wishlist. */
export default function ShareLink({ session, kind, deckId }: { session: Session; kind: "deck" | "wishlist"; deckId?: string }) {
  const [link, setLink] = useState<Link | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | string>("");
  const [message, setMessage] = useState("");
  const what = kind === "deck" ? "deck list" : "wishlist";
  useEffect(() => {
    const controller = new AbortController();
    setLink(undefined);
    request<{ items: Link[] }>("/api/v1/shares", { signal: controller.signal, quiet: true })
      .then((data) => setLink(data.items.find((item) => item.kind === kind && (item.deck_id || undefined) === deckId) || null))
      .catch((reason: Error) => { if (!controller.signal.aborted) { setLink(null); setError(reason); } });
    return () => controller.abort();
  }, [kind, deckId]);
  async function act(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { await work(); } catch (reason) { setError(reason as Error); } finally { setBusy(false); }
  }
  const headers = { "Content-Type": "application/json", "X-CSRF-Token": session.csrf_token };
  const create = () => act(async () => setLink(await request<Link>("/api/v1/shares", { method: "POST", headers, body: JSON.stringify({ kind, ...(deckId ? { deck_id: deckId } : {}) }), action: "Create share link" })));
  const remove = () => act(async () => {
    if (!link || !window.confirm(`Turn off this link? Anyone who has it will no longer see your ${what}.`)) return;
    await request(`/api/v1/shares/${link.id}`, { method: "DELETE", headers, action: "Turn off share link" });
    setLink(null); setMessage("The link is off.");
  });
  const address = link ? shareAddress(link.token) : "";
  return <div className="share-link">
    <p className="fine">{link ? `Anyone with this link can see this ${what}, and nothing else. It shows card names and quantities only: not your name, notes, prices or collection.` : `Make a link to show this ${what} to someone without a PakTrak account. Nothing is shared until you create one, and you can turn it off at any time.`}</p>
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
    {link === undefined ? <p className="fine" role="status">Checking for a link…</p> : link ? <>
      <label>Share link<input readOnly value={address} onFocus={(event) => event.target.select()} /></label>
      <div className="actions">
        <button type="button" className="button secondary" disabled={busy} onClick={() => { void (navigator.clipboard ? navigator.clipboard.writeText(address).then(() => setMessage("Link copied."), () => setMessage("Select the link above and use Copy.")) : Promise.resolve(setMessage("Select the link above and use Copy."))); }}>Copy link</button>
        <button type="button" className="text-button" disabled={busy} onClick={() => void remove()}>Turn off link</button>
      </div>
    </> : <button type="button" className="button secondary" disabled={busy} onClick={() => void create()}>{busy ? "Creating…" : "Create share link"}</button>}
    {message && <p className="fine" role="status">{message}</p>}
  </div>;
}
