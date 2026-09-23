import ErrorNotice from "./ErrorNotice";
import useBackgroundError from "./useBackgroundError";
import { useEffect, useState } from "react";
import { request, type DataFeed, type WorkProgress } from "./api";

export function ProgressView({ value }: { value?: Partial<WorkProgress> | null }) {
  if (!value?.phase) return <p className="fine" role="status">Waiting for a server worker. Time estimate available when processing starts.</p>;
  const stale = value.measured_at && Date.now() - new Date(value.measured_at).getTime() > 30_000;
  const total = value.total; const done = value.done || 0;
  const count = (n: number) => value.unit === "bytes" ? (n / 1024 / 1024).toFixed(1) + " MB" : n.toLocaleString() + " rows";
  const eta = stale ? "Waiting for a progress update…" : value.eta_seconds == null ? "Estimating this step…" : value.eta_seconds < 60 ? "About a minute or less left in this step" : `About ${Math.ceil(value.eta_seconds / 60)} min left in this step`;
  return <div className="work-progress" role="status"><div><strong>{value.phase}</strong><span>{count(done)}{total ? " / " + count(total) : ""}</span></div>
    <progress aria-label={value.phase} value={total ? Math.min(done, total) : undefined} max={total || 1} />
    <p className="fine">{total && done >= total ? "Finishing this step…" : eta}</p>
  </div>;
}

export default function DataUpdates() {
  const [feeds, setFeeds] = useState<DataFeed[]>([]);
  const backgroundError = useBackgroundError();
  useEffect(() => {
    let stopped = false; let busy = false;
    async function refresh() {
      if (busy || document.hidden || !navigator.onLine) return;
      busy = true;
      try { const data = await request<{ feeds: DataFeed[] }>("/api/v1/data/status"); if (!stopped) { setFeeds(data.feeds); backgroundError.recovered(); } }
      catch (e) { if (!stopped) backgroundError.failed(e as Error); }
      finally { busy = false; }
    }
    void refresh(); const timer = window.setInterval(() => void refresh(), 5000);
    document.addEventListener("visibilitychange", refresh);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  const active = feeds.some((feed) => feed.state === "RUNNING" || feed.state === "WAITING");
  return <details className="data-updates"><summary>Card data & prices <span>{active ? "Updating on the server" : feeds.some((feed) => feed.stale || feed.error) ? "Some sources need an update" : "Daily updates"}</span></summary>
    <p className="fine">Card details and artwork come from Scryfall. Prices update daily in USD. Your server keeps working when you close this page. Times are estimates for the current step.</p>
    {backgroundError.error && <ErrorNotice error={backgroundError.error} onDismiss={backgroundError.dismiss} />}
    <ul className="plain-list">{feeds.map((feed) => <li key={feed.name}><div className="holding-title"><strong>{feed.name === "scryfall" ? "Scryfall · TCGplayer" : feed.name === "cardkingdom" ? "Card Kingdom" : "ManaPool"}</strong><span className="badge">{feed.state === "READY" ? feed.stale ? "Older data" : "Ready" : feed.state === "FAILED" ? "Retry scheduled" : feed.state === "RUNNING" ? "Updating" : "Scheduled"}</span></div>
      {feed.updated_at && <p className="fine">Saved {new Date(feed.updated_at).toLocaleString()} · {feed.records?.toLocaleString()} prices</p>}
      {feed.source_time && <p className="fine">Source snapshot: {feed.source_time.replace("T", " ")}{feed.name === "cardkingdom" ? " (provider time; timezone unspecified)" : ""}</p>}
      {feed.error && <p className="fine">{feed.error}</p>}
      {feed.state === "RUNNING" && <ProgressView value={feed.progress} />}
      {feed.next_at && feed.state !== "RUNNING" && <p className="fine">Next check {new Date(feed.next_at).toLocaleString()}</p>}
    </li>)}</ul>
    <p className="fine">TCGplayer market prices arrive through Scryfall. Card Kingdom shows a near-mint retail reference; ManaPool shows the lowest near-mint listing. These are estimates before shipping and tax, not sale offers for your copies.</p>
  </details>;
}
