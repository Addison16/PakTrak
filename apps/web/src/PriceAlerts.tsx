import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { money, mutation, providers, request, type Session } from "./api";
import ErrorNotice from "./ErrorNotice";
import { Icon } from "./Icon";
import "./price-alerts.css";
import { usePullReload } from "./pullRefresh";
import { reducedMotion } from "./motion";

export type PriceAlertSettings = { enabled: boolean; percent: number | null; amount: string | null };
type Mover = { printing_id: string; name: string; set_code: string; collector_number: string; finish: "nonfoil" | "foil" | "etched"; quantity: number; image_url: string | null; old_amount: string; new_amount: string; change: string; percent: number; since: string };
type CollectionChange = { change: string; percent: number; since: string };
type Alerts = { settings: PriceAlertSettings; provider: string; rises: Mover[]; drops: Mover[]; rise_count: number; drop_count: number; rise_total?: string; drop_total?: string; collection?: CollectionChange | null };

const PREVIEW = 3;
// Set when Home's notice opens My account, so the settings scroll into view once loaded.
let revealSettings = false;
const finishLabel = { nonfoil: "", foil: "Foil", etched: "Etched" };

function signed(value: string | number) { const amount = Number(value); return (amount > 0 ? "+" : amount < 0 ? "−" : "") + money(Math.abs(amount)); }
const signedPercent = (percent: number) => (percent > 0 ? "+" : percent < 0 ? "−" : "") + Math.abs(percent) + "%";
const plural = (count: number) => `${count.toLocaleString()} ${count === 1 ? "card" : "cards"}`;
const shortDate = (day: string) => new Date(day + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });

// The banner names the cards that moved, so no figure on it reads like the whole collection's.
function moverSummary({ rises, drops, rise_count, drop_count }: Alerts) {
  // Each list is sorted by the change across every copy held; the bigger of the two leads.
  const held = (item?: Mover) => item ? Math.abs(Number(item.change)) * item.quantity : -1;
  const up = held(rises[0]) >= held(drops[0]);
  const top = up ? rises[0] : drops[0];
  const ups = rise_count - (up ? 1 : 0), downs = drop_count - (up ? 0 : 1);
  const rest = [ups && `${ups.toLocaleString()} ${up ? "more " : ""}up`, downs && `${downs.toLocaleString()} ${up ? "" : "more "}down`];
  return [`${top.name} ${signedPercent(top.percent)}`, ...(up ? rest : rest.reverse())].filter(Boolean).join(" · ");
}

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
  const banner = useRef<HTMLButtonElement>(null);
  const { reload, setReload, settle } = usePullReload(true);
  useEffect(() => {
    const controller = new AbortController();
    // Alerts are a bonus on Home; a failed check stays quiet and retries next visit.
    void request<Alerts>("/api/v1/price-alerts", { signal: controller.signal, quiet: true }).then((value) => { setAlerts(value); settle(); }).catch(() => { if (!controller.signal.aborted) settle(); });
    return () => controller.abort();
  }, [session.owner_id, reload]);
  useEffect(() => {
    const element = sheet.current;
    if (!open || !element) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element.showModal();
    return () => {
      element.close(); document.body.style.overflow = overflow;
      // Closed while Home is still showing: focus returns to the banner, and a refused "Change alert amounts" doesn't scroll a later My account visit.
      if (banner.current?.isConnected) { revealSettings = false; banner.current.focus({ preventScroll: true }); }
    };
  }, [open]);
  if (!alerts || !alerts.rises.length && !alerts.drops.length) return null;
  const reduced = reducedMotion;
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
  const listed = (items: Mover[]) => items.reduce((sum, item) => sum + Math.abs(Number(item.change)) * item.quantity, 0);
  const rose = Number(alerts.rise_total ?? listed(alerts.rises));
  const fell = Number(alerts.drop_total ?? listed(alerts.drops));
  const moverCount = alerts.rise_count + alerts.drop_count;
  const collection = alerts.collection;
  return <>
    <button ref={banner} type="button" className={"price-alert-banner" + (alerts.rises.length ? " up" : " down") + (leaving ? " leaving" : "")} disabled={leaving} aria-haspopup="dialog"
      onClick={() => setOpen(true)} onAnimationEnd={(event) => { if (leaving && event.target === event.currentTarget) setAlerts(null); }}>
      <span className="price-alert-banner-icon" aria-hidden="true"><Icon name="spark" /></span>
      <span className="price-alert-banner-copy"><strong>{alerts.rises.length ? "Your cards are on the move!" : "Price alerts"}</strong><small>{moverSummary(alerts)}</small></span>
      <Icon name="arrow" />
    </button>
    {open && <dialog ref={sheet} className="price-alert-sheet" aria-labelledby="price-alerts-title" onCancel={(event) => { event.preventDefault(); setOpen(false); }} onClick={(event) => {
      // Only the backdrop closes the sheet; its own padding and scrollbar are inside its rect.
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) setOpen(false);
    }}>
      <div className="price-alert-sheet-heading">
        <div><div className="eyebrow">PRICE ALERTS</div><h2 id="price-alerts-title">{alerts.rises.length && alerts.drops.length ? "Some of your cards moved" : alerts.rises.length ? "Your cards went up" : "Some cards lost value"}</h2></div>
        <button type="button" className="price-alert-close" aria-label="Close" onClick={() => setOpen(false)}><Icon name="close" /></button>
      </div>
      <p className="fine">Since you last checked · {providers[alerts.provider] ?? alerts.provider} prices</p>
      <dl className="price-alert-totals">
        <div><dt>{moverCount === 1 ? "This card" : `These ${plural(moverCount)}`}<small>{[rose && `${money(rose)} up`, fell && `${money(fell)} down`].filter(Boolean).join(" · ")}{[...alerts.rises, ...alerts.drops].some((item) => item.quantity > 1) ? ", all copies counted" : ""}</small></dt><dd>{signed((rose - fell).toFixed(2))}</dd></div>
        {collection && <div><dt>Whole collection<small>Price changes since {shortDate(collection.since)}</small></dt><dd>{signed(collection.change)}<small>{signedPercent(collection.percent)}</small></dd></div>}
      </dl>
      <MoverList title="Went up" items={alerts.rises} total={alerts.rise_count} direction="up" />
      <MoverList title="Went down" items={alerts.drops} total={alerts.drop_count} direction="down" />
      {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
      <div className="actions"><button type="button" className="button primary" disabled={leaving} onClick={() => void dismiss()}>Got it</button><button type="button" className="text-button" onClick={() => { revealSettings = true; setOpen(false); onSettings(); }}>Change alert amounts</button></div>
    </dialog>}
  </>;
}


// Shows the unit as part of the value ("20%", "$1.00") the way a spreadsheet cell does, while the state keeps only the number.
function UnitInput({ unit, side, decimals, value, onChange, disabled }: { unit: string; side: "start" | "end"; decimals: number; value: string; onChange: (value: string) => void; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const shown = value ? (side === "start" ? unit + value : value + unit) : "";
  function keepCaretOffUnit() {
    const el = input.current;
    if (!el || !value || document.activeElement !== el) return;
    const low = side === "start" ? unit.length : 0, high = side === "start" ? shown.length : value.length;
    const clamp = (at: number | null) => Math.min(Math.max(at ?? high, low), high);
    const start = clamp(el.selectionStart), end = clamp(el.selectionEnd);
    if (start !== el.selectionStart || end !== el.selectionEnd) el.setSelectionRange(start, end);
  }
  useLayoutEffect(keepCaretOffUnit);
  function clean(text: string) {
    // A comma before the last one or two digits is a decimal comma from the keyboard ("1,50"); other commas are thousands separators.
    if (decimals && !text.includes(".")) text = text.replace(/,(\d{0,2})$/, ".$1");
    // A whole number drops any fraction typed ("2.5" stays 2), rather than folding its digits in.
    if (!decimals) return text.split(/[.,]/)[0].replace(/\D/g, "");
    const digits = text.replace(/[^\d.]/g, "");
    const [whole, ...rest] = digits.split(".");
    return rest.length ? `${whole}.${rest.join("").slice(0, decimals)}` : whole;
  }
  function tidy() {
    if (!value || !Number.isFinite(Number(value))) return;
    const tidied = decimals ? Number(value).toFixed(decimals) : String(Number(value));
    if (tidied !== value) onChange(tidied);
  }
  return <input ref={input} type="text" inputMode={decimals ? "decimal" : "numeric"} autoComplete="off" placeholder="Any" disabled={disabled} value={shown} onSelect={keepCaretOffUnit} onChange={(e) => onChange(clean(e.target.value))} onBlur={tidy} />;
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
    form.current?.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
  }, [saved]);
  const dirty = !!saved && (enabled !== saved.enabled || percent !== (saved.percent == null ? "" : String(saved.percent)) || amount !== (saved.amount ?? ""));
  useEffect(() => { onDirtyChange(dirty); }, [dirty]);
  useEffect(() => () => onDirtyChange(false), []);
  const missing = enabled && !percent.trim() && !amount.trim();
  const badPercent = enabled && !!percent && !(Number(percent) >= 1 && Number(percent) <= 1000);
  const badAmount = enabled && !!amount && !(Number(amount) >= 0.01 && Number(amount) <= 100000);
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
        <label>Percent change<UnitInput unit="%" side="end" decimals={0} value={percent} onChange={setPercent} disabled={busy || !enabled} /></label>
        <label>Dollar change<UnitInput unit="$" side="start" decimals={2} value={amount} onChange={setAmount} disabled={busy || !enabled} /></label>
      </div>
      <p className="fine">A card shows when its price rises or drops by at least {percent.trim() && amount.trim() ? "both amounts" : "this amount"} since you last dismissed it. Leave one empty to use only the other. Prices come from your chosen price source.</p>
      {missing && <p className="fine" role="status">Enter a percent, a dollar amount or both.</p>}
      {badPercent && <p className="fine" role="status">Use a percent from 1% to 1000%.</p>}
      {badAmount && <p className="fine" role="status">Use a dollar amount from $0.01 to $100,000.</p>}
      <button className="button primary" disabled={busy || !dirty || missing || badPercent || badAmount}>Save price alerts</button>
    </>}
  </form>;
}
