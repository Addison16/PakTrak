import { useEffect, useState } from "react";
import { ApiError, type Session } from "./api";
import { Icon } from "./Icon";
import { checkConnection, queuedActions, removeQueued, savedResponseCount, useConnection, type QueuedAction } from "./offline";
import { flushQueue, retryQueued } from "./offlineSync";
import { saveForOffline } from "./offlineSave";
import { offlineImagesReady } from "./serviceWorker";

const time = (value: number) => new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const megabytes = (bytes: number) => bytes >= 1024 * 1024 * 1024 ? (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB" : Math.max(1, Math.round(bytes / 1024 / 1024)) + " MB";

export default function QueuedActions({ session, active }: { session: Session; active: boolean }) {
  const status = useConnection();
  const [items, setItems] = useState<QueuedAction[]>([]);
  const [saved, setSaved] = useState<{ pages: number; images: number | null; usage: number | null }>({ pages: 0, images: null, usage: null });
  const [download, setDownload] = useState<{ busy: boolean; message: string; error?: Error }>({ busy: false, message: "" });

  async function load() {
    setItems(await queuedActions(session.owner_id));
    const [pages, images, estimate] = await Promise.all([savedResponseCount(), countImages(), navigator.storage?.estimate?.().catch(() => undefined)]);
    setSaved({ pages, images, usage: estimate?.usage ?? null });
  }
  useEffect(() => {
    if (!active) return;
    void load();
    const refresh = () => void load();
    window.addEventListener("paktrak:queue", refresh);
    return () => window.removeEventListener("paktrak:queue", refresh);
  }, [active, session.owner_id]);

  async function remove(item: QueuedAction) {
    if (!window.confirm(`Remove “${item.label}” from the queue?\n\nThis change won’t be sent to PakTrak.`)) return;
    await removeQueued(item.id);
  }
  async function saveEverything() {
    setDownload({ busy: true, message: "Saving your collection…" });
    try {
      await navigator.storage?.persist?.().catch(() => false);
      const result = await saveForOffline(session, { images: true, progress: (message) => setDownload({ busy: true, message }) });
      setDownload({ busy: false, message: result });
    } catch (error) { setDownload({ busy: false, message: "", error: error as Error }); }
    void load();
  }

  const waiting = items.filter((item) => item.state !== "failed").length;
  return <section className="panel queued-actions" aria-labelledby="queue-title">
    <div className="eyebrow">WORK WITHOUT A CONNECTION</div>
    <h2 id="queue-title">Queued actions</h2>
    <p className="queue-connection" role="status"><Icon name={status.reachable ? "cloud" : "offline"} />
      <span>{!status.reachable ? "Offline. PakTrak can’t be reached, so you’re seeing copies saved on this device. Changes you can make offline wait here."
        : status.sending ? "Connected. Sending your changes…" : "Connected to PakTrak."}</span></p>
    {status.signInNeeded && <div className="message" role="alert">Sign in again to send your queued changes. They stay on this device until then. <a className="text-button" href="/api/auth/login">Sign in</a></div>}
    <div className="actions">
      {!status.reachable && <button type="button" className="button secondary" disabled={status.checking} onClick={() => void checkConnection()}>{status.checking ? "Checking…" : "Check connection"}</button>}
      {status.reachable && waiting > 0 && <button type="button" className="button primary" disabled={status.sending} onClick={() => void flushQueue()}>Send now</button>}
    </div>

    {items.length === 0 ? <p className="queue-empty">Nothing is waiting. Changes you make while offline show up here until they reach PakTrak.</p>
      : <ol className="queue-list" aria-label="Queued changes">{items.map((item) => <li key={item.id} data-state={item.state}>
        <div className="queue-item-text">
          <strong>{item.label}</strong>
          {item.detail && <span>{item.detail}</span>}
          <span className="fine">Queued {time(item.createdAt)} · {item.state === "sending" ? "Sending…" : item.state === "failed" ? "Not sent" : "Waiting"}</span>
          {item.error && <span className="queue-error">{item.error}</span>}
        </div>
        <div className="queue-item-actions">
          {item.state === "failed" && <button type="button" className="text-button" disabled={!status.reachable} onClick={() => void retryQueued(item)}>Try again</button>}
          <button type="button" className="text-button" disabled={item.state === "sending"} aria-label={`Remove from queue: ${item.label}`} onClick={() => void remove(item)}>Remove</button>
        </div>
      </li>)}</ol>}
    <p className="fine">Queued changes run in the order you made them. If PakTrak turns one down, for example because the card changed on another device, it stays here with the reason so you can try again or remove it.</p>

    <h3>Saved on this device</h3>
    <p>{saved.pages.toLocaleString()} saved {saved.pages === 1 ? "page" : "pages"} of collection and deck data{saved.images !== null ? ` · ${saved.images.toLocaleString()} card ${saved.images === 1 ? "picture" : "pictures"}` : ""}{saved.usage !== null ? ` · about ${megabytes(saved.usage)} in total` : ""}.</p>
    <p className="fine">Anything you open while connected is kept for offline viewing. Save everything now to keep your whole collection and every deck before you leave.</p>
    <div className="actions"><button type="button" className="button secondary" disabled={download.busy || !status.reachable} onClick={() => void saveEverything()}>{download.busy ? "Saving…" : "Save collection for offline"}</button></div>
    {download.message && <p className="fine" role="status">{download.message}</p>}
    {download.error && <p className="message error" role="alert">{download.error instanceof ApiError ? download.error.userMessage : download.error.message}</p>}
    {!offlineImagesReady() && <p className="fine">Card pictures and opening PakTrak with no connection need an HTTPS address. On a plain http:// address, saved lists and queued changes still work while PakTrak stays open.</p>}

    <details className="queue-help"><summary>What works offline</summary>
      <p><strong>View:</strong> your collection, card details, storage locations, decks and the batch list, once opened or saved while connected.</p>
      <p><strong>Queued until you’re back:</strong> removing copies, editing a copy’s finish, condition or notes, moving copies to another location, renaming or editing a storage location, and saving deck changes.</p>
      <p><strong>Needs a connection:</strong> uploading photos (a photo you take is kept on this device so you can resume the upload), reviewing scans, card search, imports and exports, trade value, price updates and account settings.</p>
      <p>Signing out removes the saved copies and any queued changes from this device. Safari may clear saved data after about a week without opening PakTrak, unless it’s added to the Home Screen.</p>
    </details>
  </section>;
}

async function countImages() {
  try { return globalThis.caches ? (await (await caches.open("paktrak-card-images")).keys()).length : null; }
  catch { return null; }
}
