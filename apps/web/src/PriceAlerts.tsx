import { useEffect, useRef, useState } from "react";
import { money, mutation, providers, request, type Session } from "./api";
import ErrorNotice from "./ErrorNotice";
import { Icon } from "./Icon";
import "./price-alerts.css";

export type PriceAlertSettings = { enabled: boolean; percent: number | null; amount: string | null };
type Mover = { printing_id: string; name: string; set_code: string; collector_number: string; finish: "nonfoil" | "foil" | "etched"; quantity: number; image_url: string | null; old_amount: string; new_amount: string; change: string; percent: number; since: string };
type Alerts = { settings: PriceAlertSettings; provider: string; rises: Mover[]; drops: Mover[]; rise_count: number; drop_count: number };

const PREVIEW = 3;
// Set when Home's notice opens My account, so the settings scroll into view once loaded.
let revealSettings = false;
const finishLabel = { nonfoil: "", foil: "Foil", etched: "Etched" };

function signed(value: string) { const amount = Number(value); return (amount > 0 ? "+" : "−") + money(Math.abs(amount)); }

function MoverList({ title, items, total, direction }: { title: string; items: Mover[]; total: number; direction: "up" | "down" }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, PREVIEW);
  return <div className={"price-alert-group " + direction}>
    <h3>{title} <span>{total.toLocaleString()}</span></h3>
    <ul>{shown.map((item) => <li key={item.printing_id + item.finish}>
      {item.image_url ? <img src={item.image_url} alt="" width="40" height="56" loading="lazy" /> : <span className="price-alert-thumb" aria-hidden="true" />}
      <div className="price-alert-card"><strong>{item.name}</strong><small>{item.set_code.toUpperCase()} · #{item.collector_number}{finishLabel[item.finish] ? " · " + finishLabel[item.finish] : ""}{item.quantity > 1 ? ` · ${item.quantity} copies` : ""}</small></div>
      <div className="price-alert-change"><strong>{signed(item.change)}</strong><small>{money(item.old_amount)} → {money(item.new_amount)} · {item.percent > 0 ? "+" : ""}{item.percent}%</small></div>
    </li>)}</ul>
    {items.length > PREVIEW && <button type="button" className="text-button" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${items.length}`}</button>}
    {total > items.length && all && <p className="fine">{(total - items.length).toLocaleString()} smaller changes will show after you dismiss these.</p>}
  </div>;
}

export default function PriceAlerts({ session, onSettings }: { session: Session; onSettings: () => void }) {
  const [alerts, setAlerts] = useState<Alerts | null>(null);
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<Error | string>("");
  const sheet = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    // Alerts are a bonus on Home; a failed check stays quiet and retries next visit.
    void request<Alerts>("/api/v1/price-alerts", { signal: controller.signal, quiet: true }).then(setAlerts).catch(() => {});
    return () => controller.abort();
  }, [session.owner_id]);
  useEffect(() => {
    const element = sheet.current;
    if (!open || !element) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element.showModal();
    return () => { element.close(); document.body.style.overflow = overflow; };
  }, [open]);
  if (!alerts || !alerts.rises.length && !alerts.drops.length) return null;
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  async function dismiss() {
    if (!alerts) return;
    setError("");
    const cards = [...alerts.rises, ...alerts.drops].map(({ printing_id, finish }) => ({ printing_id, finish }));
    try {
      await request("/api/v1/price-alerts/seen", mutation(session, { cards }));
      setOpen(false);
      if (reduced()) setAlerts(null);
      else setLeaving(true);
    } catch (e) { setError(e as Error); }
  }
  const rose = alerts.rises.reduce((sum, item) => sum + Number(item.change) * item.quantity, 0);
  const fell = alerts.drops.reduce((sum, item) => sum + Number(item.change) * item.quantity, 0);
  const counts = [alerts.rise_count && `${alerts.rise_count} ${alerts.rise_count === 1 ? "card" : "cards"} went up`, alerts.drop_count && `${alerts.drop_count}${alerts.rise_count ? "" : alerts.drop_count === 1 ? " card" : " cards"} went down`].filter(Boolean).join(" · ");
  return <>
    <button type="button" className={"price-alert-banner" + (alerts.rises.length ? " up" : " down") + (leaving ? " leaving" : "")} disabled={leaving} aria-haspopup="dialog"
      onClick={() => setOpen(true)} onAnimationEnd={(event) => { if (leaving && event.target === event.currentTarget) setAlerts(null); }}>
      <span className="price-alert-banner-icon" aria-hidden="true"><Icon name="spark" /></span>
      <span className="price-alert-banner-copy"><strong>{alerts.rises.length ? "Your cards are on the move!" : "Price alerts"}</strong><small>{counts}{rose ? ` · ${money(rose)} up` : ""}</small></span>
      <Icon name="arrow" />
    </button>
    {open && <dialog ref={sheet} className="price-alert-sheet" aria-labelledby="price-alerts-title" onCancel={(event) => { event.preventDefault(); setOpen(false); }} onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div className="price-alert-sheet-heading">
        <div><div className="eyebrow">PRICE ALERTS</div><h2 id="price-alerts-title">{alerts.rises.length && alerts.drops.length ? "Some of your cards moved" : alerts.rises.length ? "Your cards went up" : "Some cards lost value"}</h2></div>
        <button type="button" className="price-alert-close" aria-label="Close" onClick={() => setOpen(false)}><Icon name="close" /></button>
      </div>
      <p className="fine">Since you last checked · {providers[alerts.provider] ?? alerts.provider} prices{rose ? ` · ${money(rose)} up` : ""}{fell ? ` · ${money(-fell)} down` : ""}</p>
      <MoverList title="Went up" items={alerts.rises} total={alerts.rise_count} direction="up" />
      <MoverList title="Went down" items={alerts.drops} total={alerts.drop_count} direction="down" />
      {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
      <div className="actions"><button type="button" className="button primary" disabled={leaving} onClick={() => void dismiss()}>Got it</button><button type="button" className="text-button" onClick={() => { revealSettings = true; setOpen(false); onSettings(); }}>Change alert amounts</button></div>
    </dialog>}
  </>;
}

export function PriceAlertSettingsForm({ session, onDirtyChange }: { session: Session; onDirtyChange: (dirty: boolean) => void }) {
  const form = useRef<HTMLFormElement>(null);
  const [saved, setSaved] = useState<PriceAlertSettings | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [percent, setPercent] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | string>("");
  const [notice, setNotice] = useState("");
  function fill(value: PriceAlertSettings) { setSaved(value); setEnabled(value.enabled); setPercent(value.percent == null ? "" : String(value.percent)); setAmount(value.amount ?? ""); }
  useEffect(() => {
    const controller = new AbortController();
    void request<Alerts>("/api/v1/price-alerts", { signal: controller.signal }).then((result) => fill(result.settings)).catch((e: Error) => { if (!controller.signal.aborted) setError(e); });
    return () => controller.abort();
  }, [session.owner_id]);
  useEffect(() => {
    if (!saved || !revealSettings) return;
    revealSettings = false;
    form.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [saved]);
  const dirty = !!saved && (enabled !== saved.enabled || percent !== (saved.percent == null ? "" : String(saved.percent)) || amount !== (saved.amount ?? ""));
  useEffect(() => { onDirtyChange(dirty); }, [dirty]);
  useEffect(() => () => onDirtyChange(false), []);
  const missing = enabled && !percent.trim() && !amount.trim();
  async function save() {
    setBusy(true); setError(""); setNotice("");
    try {
      const amountValue = amount.trim() ? Number(amount).toFixed(2) : null;
      fill(await request<PriceAlertSettings>("/api/v1/price-alerts/settings", { ...mutation(session, { enabled, percent: percent.trim() ? Math.round(Number(percent)) : null, amount: amountValue }), method: "PUT" }));
      setNotice(enabled ? "Price alerts are saved." : "Price alerts are off.");
    } catch (e) { setError(e as Error); } finally { setBusy(false); }
  }
  return <form ref={form} className="account-section price-alert-settings" aria-label="Price alerts" onSubmit={(e) => { e.preventDefault(); void save(); }}>
    <h3>Price alerts</h3>
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
    {notice && <p className="message success" role="status">{notice}</p>}
    {!saved && !error ? <p role="status">Loading price alerts…</p> : saved && <>
      <label className="checkbox"><input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => setEnabled(e.target.checked)} />Show my cards’ price changes on Home</label>
      <div className="price-alert-fields">
        <label>Percent change<span className="price-alert-input unit-end"><input type="number" inputMode="numeric" min={1} max={1000} step={1} placeholder="Any" disabled={busy || !enabled} value={percent} onChange={(e) => setPercent(e.target.value)} /><span aria-hidden="true">%</span></span></label>
        <label>Dollar change<span className="price-alert-input unit-start"><span aria-hidden="true">$</span><input type="number" inputMode="decimal" min={0.01} max={100000} step={0.01} placeholder="Any" disabled={busy || !enabled} value={amount} onChange={(e) => setAmount(e.target.value)} /></span></label>
      </div>
      <p className="fine">A card shows when its price rises or drops by at least {percent.trim() && amount.trim() ? "both amounts" : "this amount"} since you last dismissed it. Leave one empty to use only the other. Prices come from your chosen price source.</p>
      {missing && <p className="fine" role="status">Enter a percent, a dollar amount or both.</p>}
      <button className="button primary" disabled={busy || !dirty || missing}>Save price alerts</button>
    </>}
  </form>;
}
