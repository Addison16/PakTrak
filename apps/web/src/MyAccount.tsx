import { useEffect, useRef, useState } from "react";
import { mutation, request, type Session } from "./api";
import { accountRole, type Account, type AccountNavigation } from "./accountTypes";
import { AccountActivity, AccountUsage } from "./AccountSummary";
import ErrorNotice from "./ErrorNotice";
import Appearance from "./Appearance";
import { PriceAlertSettingsForm } from "./PriceAlerts";

export default function MyAccount({ session, onChange, navigationRef }: { session: Session; onChange: (account: Account) => void; navigationRef: AccountNavigation }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | string>("");
  const [notice, setNotice] = useState("");
  const [alertsDirty, setAlertsDirty] = useState(false);
  const profileDirty = !!account && name !== account.display_name;
  const dirty = profileDirty || alertsDirty;
  function fill(value: Account) { setAccount(value); setName(value.display_name); onChange(value); }
  // Set once a discard is confirmed, so the browser's own "Leave site?" prompt doesn't ask a second time.
  const leaving = useRef(false);
  function canLeave() {
    if (busy) { setNotice("Please wait for the account update to finish."); return false; }
    if (dirty && !window.confirm(profileDirty && alertsDirty ? "Discard your unsaved display name and price alert changes?" : profileDirty ? "Discard your unsaved display name?" : "Discard your unsaved price alert changes?")) return false;
    if (dirty) {
      leaving.current = true;
      // Still here and interacting means the navigation didn't happen, so the prompt comes back.
      const stay = () => { leaving.current = false; window.removeEventListener("pointerdown", stay); window.removeEventListener("keydown", stay); };
      window.addEventListener("pointerdown", stay); window.addEventListener("keydown", stay);
    }
    return true;
  }
  useEffect(() => { navigationRef.current = canLeave; return () => { navigationRef.current = null; }; }, [dirty, profileDirty, alertsDirty, busy]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { if (leaving.current) return; e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    const controller = new AbortController();
    void request<Account>("/api/auth/me", { signal: controller.signal }).then(fill).catch((e: Error) => { if (!controller.signal.aborted) setError(e); });
    return () => controller.abort();
  }, []);
  async function act(work: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await work(); } catch (e) { setError(e as Error); } finally { setBusy(false); }
  }
  return <section className="panel my-account" aria-labelledby="my-account-title">
    <div className="section-heading"><div><div className="eyebrow">YOUR PAKTRAK</div><h2 id="my-account-title">My account</h2></div><span className="badge">{accountRole(session.role)}</span></div>
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} onRetry={() => { if (!busy && (!profileDirty || window.confirm("Discard your unsaved display name?"))) void act(async () => fill(await request<Account>("/api/auth/me"))); }} retryLabel="Reload account" />}
    {notice && <p className="message success" role="status">{notice}</p>}
    {!account && !error && <p role="status">Loading your account…</p>}
    {account && <>
      <AccountUsage account={{ ...account, scan_cards_used: session.scan_cards_used, scan_card_limit: session.scan_card_limit, scan_cards_remaining: session.scan_cards_remaining, scans_paused: !!session.scans_paused }} />
      {session.role === "guest" && <p className="fine">An administrator can approve you as a standard member. Members start with unlimited card scans; your administrator can set a custom allowance later.</p>}
      <dl className="account-stats"><div><dt>Collection cards</dt><dd>{account.collection_copies?.toLocaleString()}</dd></div><div><dt>Saved decks</dt><dd>{account.saved_decks?.toLocaleString()}</dd></div><div><dt>Photo batches</dt><dd>{account.saved_batches?.toLocaleString()}</dd></div></dl>
      <form className="account-section" onSubmit={(e) => { e.preventDefault(); void act(async () => { fill(await request<Account>("/api/auth/me", { ...mutation(session, { display_name: name.trim(), expected_version: account.account_version }), method: "PATCH" })); setNotice("Your display name is saved."); }); }}>
        <h3>Profile</h3><label>Display name<input autoComplete="nickname" maxLength={80} required disabled={busy} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <p className="fine">The name shown in PakTrak. Continue using your existing username to sign in.</p>
        <button className="button primary" disabled={busy || !profileDirty || !name.trim()}>Save profile</button>
      </form>
      <PriceAlertSettingsForm session={session} onDirtyChange={setAlertsDirty} />
      <section className="account-section" aria-label="Account security"><h3>Sign-in & security</h3><p className="fine">{account.active_sessions} active sign-in {account.active_sessions === 1 ? "session" : "sessions"} · Joined {new Date(account.created_at).toLocaleDateString()}</p>
        <div className="actions"><a className="button secondary" href="/api/auth/password" onClick={(e) => { if (!canLeave()) e.preventDefault(); }}>Change password</a>
          <button className="button secondary" disabled={busy || (account.active_sessions ?? 0) <= 1} onClick={() => {
            if (!window.confirm("Sign out other devices?\n\nOther PakTrak sessions will end. This device stays signed in, and those devices can sign in again.")) return;
            void act(async () => { const result = await request<{ account: Account; sessions_ended: number }>("/api/auth/me/signout-others", mutation(session, { expected_version: account.account_version })); setAccount(result.account); setNotice(`${result.sessions_ended} other sign-in sessions ended.`); });
          }}>Sign out other devices</button></div><p className="fine">Password changes open the secure sign-in screen. Passwords must contain at least 8 characters.</p>
      </section>
      <section className="account-section" aria-label="Appearance"><h3>Appearance</h3><Appearance /></section>
      <AccountActivity account={account} />
    </>}
  </section>;
}
