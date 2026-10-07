import ErrorNotice from "./ErrorNotice";
import DataUpdates from "./DataUpdates";
import ErrorLogs from "./ErrorLogs";
import Backups from "./Backups";
import { useEffect, useState } from "react";
import { mutation, request, type Session } from "./api";

import AccountManager from "./AccountManager";
import type { Account, AccountNavigation } from "./accountTypes";
import { useRoute } from "./navigation";
import { storeNames, type Store, type StoreLinks } from "./storeLinks";
type Settings = { guest_signup_enabled: boolean; enhanced_scanning_enabled: boolean; store_links: StoreLinks; version: number };
const stores: Store[] = ["tcgplayer", "cardkingdom", "manapool"];

export default function Admin({ session, navigationRef }: { session: Session; navigationRef: AccountNavigation }) {
  const route = useRoute();
  const [managedAccount, setManagedAccount] = useState<Account | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<Error | string>("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [referrals, setReferrals] = useState<Record<Store, string> | null>(null);
  async function refresh() {
    const saved = await request<Settings>("/api/auth/settings");
    setSettings(saved);
    setReferrals((current) => current ?? Object.fromEntries(stores.map((store) => [store, saved.store_links?.[store] || ""])) as Record<Store, string>);
  }
  useEffect(() => { void refresh().catch((e: Error) => setError(e)); }, []);
  async function act(work: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await work(); await refresh(); }
    catch (e) { setError(e as Error); await refresh().catch(() => {}); }
    finally { setBusy(false); }
  }
  return <section className="panel">
    <div className="eyebrow">YOUR PAKTRAK</div><h2>Account administration</h2>
    <AccountManager session={session} navigationRef={navigationRef} selected={managedAccount} onSelect={setManagedAccount} />
    {!route.account && !managedAccount && <>
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
    {notice && <p className="message success" role="status">{notice}</p>}
    {settings && <div className="signup-setting">
      <label className="checkbox"><input type="checkbox" checked={settings.guest_signup_enabled} disabled={busy} onChange={(e) => {
        const enabled = e.target.checked;
        setSettings({ ...settings, guest_signup_enabled: enabled });
        void act(async () => { setSettings(await request<Settings>("/api/auth/settings", mutation(session, { guest_signup_enabled: enabled, expected_version: settings.version }))); setNotice(enabled ? "Guest signup is open." : "Guest signup is closed. Existing accounts can still sign in."); });
      }} />Allow guest signup</label>
      <p className="fine">New guests can scan 100 cards. Approve them as standard members to remove that allowance. Turning signup off keeps existing accounts and collections.</p>
    </div>}
    {settings && <section className="signup-setting" aria-label="Scan processing">
      <h3>Scan processing</h3>
      <label className="checkbox"><input type="checkbox" checked={!!settings.enhanced_scanning_enabled} disabled={busy} onChange={(e) => {
        const enabled = e.target.checked;
        void act(async () => { setSettings(await request<Settings>("/api/auth/settings", mutation(session, { enhanced_scanning_enabled: enabled, expected_version: settings.version }))); setNotice(enabled ? "Enhanced scanning is on for upcoming scans and card checks." : "Enhanced scanning is off. Upcoming card checks use standard processing."); });
      }} />Enhanced scanning</label>
      <p className="fine">Read finer detail from your photos and retry difficult text with extra cleanup. Uses more server CPU and memory; scanning may take longer. No GPU is required.</p>
      <p className="fine">Off by default for smaller servers. Original photos are preserved, and the extra recognition pass falls back to the normal result if it fails. Changing this setting applies to upcoming processing steps; saved cards are not reimported.</p>
    </section>}
    {settings && referrals && <form className="signup-setting" aria-label="Store referral links" onSubmit={(e) => {
      e.preventDefault();
      void act(async () => {
        const saved = await request<Settings>("/api/auth/settings", mutation(session, { ...Object.fromEntries(stores.map((store) => [`${store}_affiliate`, referrals[store].trim() || null])), expected_version: settings.version }));
        setSettings(saved);
        setReferrals(Object.fromEntries(stores.map((store) => [store, saved.store_links?.[store] || ""])) as Record<Store, string>);
        setNotice("Store referral links saved. Everyone on this PakTrak gets them after reloading the page.");
      });
    }}>
      <h3>Store referral links</h3>
      <p className="fine">Optional. When filled in, every store button and listing link on this PakTrak uses it, for every account. Leave a store empty to link to it normally.</p>
      {stores.map((store) => <label key={store}>{storeNames[store]}<input value={referrals[store]} maxLength={500} disabled={busy} placeholder="Referral code or https:// tracking link" autoComplete="off" spellCheck={false} onChange={(e) => setReferrals({ ...referrals, [store]: e.target.value })} /></label>)}
      <p className="fine">Enter a referral code, or an https:// tracking link from the store’s affiliate program. Codes are added as {"partner="} (TCGplayer, Card Kingdom) or {"ref="} (ManaPool). In a tracking link, {"{url}"} marks where the store page goes. People see a short note that store links include a referral.</p>
      <div className="actions"><button className="button secondary" disabled={busy}>Save referral links</button></div>
    </form>}
    <Backups session={session} />
    <DataUpdates />
    <ErrorLogs />
    </>}
  </section>;
}
