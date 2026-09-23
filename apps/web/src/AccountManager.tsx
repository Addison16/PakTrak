import { useEffect, useRef, useState } from "react";
import { mutation, request, type Session } from "./api";
import { accountRole, type Account, type AccountNavigation } from "./accountTypes";
import { AccountActivity, AccountUsage } from "./AccountSummary";
import ErrorNotice from "./ErrorNotice";
import { navigation, restoreScroll, useRoute } from "./navigation";

export default function AccountManager({ session, navigationRef, selected, onSelect }: { session: Session; navigationRef: AccountNavigation; selected: Account | null; onSelect: (account: Account | null) => void }) {
  const route = useRoute();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [guestsOnly, setGuestsOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | string>("");
  const [notice, setNotice] = useState("");
  const [suspended, setSuspended] = useState(false);
  const [paused, setPaused] = useState(false);
  const [custom, setCustom] = useState(false);
  const [limit, setLimit] = useState("");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [resetUsername, setResetUsername] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [copyNotice, setCopyNotice] = useState("");
  const passwordInput = useRef<HTMLInputElement>(null);
  function clearPassword() { setTemporaryPassword(""); setResetUsername(""); setShowPassword(false); setCopyNotice(""); }

  const requestSequence = useRef(0);
  const validLimit = /^\d+$/.test(limit) && Number.isSafeInteger(Number(limit)) && Number(limit) <= 1_000_000_000;
  const dirty = !!selected && (suspended !== selected.suspended || paused !== selected.scans_paused || custom !== (selected.scan_card_limit_override !== null) || (custom && (!validLimit || Number(limit) !== selected.scan_card_limit_override)));
  function canLeave() {
    if (busy) { setNotice("Please wait for the account update to finish."); return false; }
    if (dirty && !window.confirm("Discard unsaved account settings?")) return false;
    if (temporaryPassword) {
      if (!window.confirm("Have you saved the temporary password?\n\nLeaving this account hides it permanently. You can reset the password again if needed.")) return false;
      clearPassword();
    }
    return true;
  }
  useEffect(() => {
    const clear = () => { if (passwordInput.current) passwordInput.current.value = ""; clearPassword(); };
    window.addEventListener("pagehide", clear);
    return () => window.removeEventListener("pagehide", clear);
  }, []);
  useEffect(() => { navigationRef.current = canLeave; return () => { navigationRef.current = null; }; }, [dirty, busy, temporaryPassword]);
  useEffect(() => {
    if (!dirty && !temporaryPassword) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, temporaryPassword]);
  useEffect(() => { const timer = window.setTimeout(() => { setSearch(q.trim()); setOffset(0); }, 250); return () => window.clearTimeout(timer); }, [q]);
  const path = `/api/auth/accounts?guests_only=${guestsOnly}&offset=${offset}&q=${encodeURIComponent(search)}`;
  async function refresh(signal?: AbortSignal) {
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      const result = await request<{ items: Account[]; next_offset: number | null }>(path, { signal });
      if (sequence === requestSequence.current && !signal?.aborted) { setAccounts(result.items); setNext(result.next_offset); }
    } finally { if (sequence === requestSequence.current && !signal?.aborted) setLoading(false); }
  }
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((e: Error) => { if (!controller.signal.aborted) setError(e); });
    return () => controller.abort();
  }, [path]);
  function fill(account: Account) {
    onSelect(account); setSuspended(account.suspended); setPaused(account.scans_paused);
    setCustom(account.scan_card_limit_override !== null);
    setLimit(String(account.scan_card_limit_override ?? account.scan_card_limit ?? Math.max(account.scan_cards_used, 1000)));
  }
  async function act(work: () => Promise<void>, reload = true) {
    setBusy(true); setError(""); setNotice("");
    try { await work(); if (reload) await refresh(); } catch (e) { setError(e as Error); } finally { setBusy(false); }
  }
  function approve(account: Account) {
    void act(async () => {
      await request(`/api/auth/accounts/${account.id}/approve`, mutation(session));
      if (selected?.id === account.id) fill(await request<Account>(`/api/auth/accounts/${account.id}`));
      setNotice(account.display_name + " is now a standard member.");
    });
  }
  function open(account: Account) {
    navigation.go({ page: "admin", account: account.id });
  }
  useEffect(() => {
    clearPassword(); setError(""); setNotice("");
    onSelect(null);
    if (!route.account) return;
    const controller = new AbortController();
    void request<Account>(`/api/auth/accounts/${route.account}`, { signal: controller.signal }).then((account) => {
      if (!controller.signal.aborted) { fill(account); requestAnimationFrame(() => { document.getElementById("managed-account-title")?.focus({ preventScroll: true }); restoreScroll(); }); }
    }).catch((e: Error) => { if (!controller.signal.aborted) setError(e); });
    return () => controller.abort();
  }, [route.account]);
  return <section className="account-manager" aria-labelledby="account-manager-title">
    <div className="section-heading"><div><div className="eyebrow">PEOPLE & ACCESS</div><h3 id="account-manager-title">User management</h3></div></div>
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} onRetry={() => {
      if (!canLeave()) return;
      void act(async () => { if (selected) fill(await request<Account>(`/api/auth/accounts/${selected.id}`)); else await refresh(); }, false);
    }} retryLabel={selected ? "Reload account" : "Reload accounts"} />}
    {notice && <p className="message success" role="status">{notice}</p>}
    {route.account && !selected ? <><button className="text-button" onClick={() => navigation.close({ page: "admin" })}>← Back to users</button>{!error && <p role="status">Opening account…</p>}</> : selected ? <>
      <button className="text-button" disabled={busy} onClick={() => navigation.close({ page: "admin" })}>← Back to users</button>
      <div className="managed-account-heading"><h3 id="managed-account-title" tabIndex={-1}>{selected.display_name}</h3><span className="badge">{accountRole(selected.role)}</span>{selected.suspended && <span className="badge account-suspended">Suspended</span>}</div>
      <AccountUsage account={selected} />
      <p className="fine">{selected.collection_copies?.toLocaleString()} collection cards · {selected.saved_decks} saved decks · {selected.active_sessions} active sign-in sessions</p>
      {selected.role === "admin" ? <p className="message">Administrator accounts are protected from these access controls. Use My account to manage your profile and other sign-in sessions.</p> : <>
        {selected.role === "guest" && <div className="account-approval"><p>Approving this guest gives them the default unlimited member allowance.</p><button className="button primary" disabled={busy || dirty || selected.suspended} onClick={() => approve(selected)}>Approve as standard member</button></div>}
        <form onSubmit={(e) => {
          e.preventDefault();
          if (suspended && !selected.suspended && !window.confirm(`Suspend ${selected.display_name}?\n\nThey will be signed out and blocked from signing in until you restore access. Their cards and decks will be kept.`)) return;
          void act(async () => {
            fill(await request<Account>(`/api/auth/accounts/${selected.id}/access`, mutation(session, { expected_version: selected.account_version, suspended, scans_paused: paused, scan_card_limit_override: custom ? Number(limit) : null })));
            setNotice("Account settings saved.");
          });
        }}>
          <fieldset className="account-controls" disabled={busy}>
            <legend>Access & scanning</legend>
            <label>Account access<select value={suspended ? "suspended" : "active"} onChange={(e) => setSuspended(e.target.value === "suspended")}><option value="active">Active · allow sign-in</option><option value="suspended">Suspended · block sign-in</option></select></label>
            <label className="checkbox"><input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} />Pause new scans</label>
            <p className="fine">Pausing stops new uploads and new card outlines. Accepted scans finish on the server, within the card limit. Collections, decks and review of existing cards stay available.</p>
            <fieldset className="account-limit-options"><legend>Card scan allowance</legend>
              <label className="checkbox"><input type="radio" name="scan-limit-mode" checked={!custom} onChange={() => setCustom(false)} />{selected.role === "guest" ? "Default guest allowance · 100 cards" : "Unlimited card scans"}</label>
              <label className="checkbox"><input type="radio" name="scan-limit-mode" checked={custom} onChange={() => setCustom(true)} />Set a lifetime card limit</label>
              {custom && <label>Lifetime card limit<input type="number" inputMode="numeric" min={0} max={1_000_000_000} step={1} value={limit} aria-invalid={!validLimit} required onFocus={(e) => e.currentTarget.select()} onChange={(e) => setLimit(e.target.value)} onBlur={() => { if (validLimit) setLimit(String(Number(limit))); }} /></label>}
              {custom && !validLimit && <p className="row-error">Enter a whole number from 0 to 1,000,000,000.</p>}
              <p className="fine">{selected.scan_cards_used.toLocaleString()} cards already scanned. {custom && validLimit ? `This limit leaves ${Math.max(0, Number(limit) - selected.scan_cards_used).toLocaleString()} card scans available.` : "Usage history is kept when you change the allowance."} Limits do not reset each month. Imports do not count.</p>
            </fieldset>
            <div className="actions"><button className="button primary" disabled={!dirty || (custom && !validLimit)}>Save account settings</button><button type="button" className="text-button" disabled={!dirty} onClick={() => fill(selected)}>Discard changes</button></div>
          </fieldset>
        </form>
        <section className="account-section" aria-label="Reset user password"><h4>Reset password</h4>
          <p className="fine">Create a temporary password for this person and sign them out on all devices. They’ll choose a new password the next time they sign in.</p>
          {selected.suspended && <p className="fine">This account is suspended. Restore its access before the person can sign in.</p>}
          {selected.password_reset_pending && <p className="message">A password reset hasn’t finished. Reload this account to check it, or retry the reset.</p>}
          <button className="button secondary" disabled={busy || dirty || !!temporaryPassword} onClick={() => {
            if (!window.confirm(`Reset the password for ${selected.display_name}?\n\nTheir current password will be replaced and all sign-in sessions will end. Share the temporary password with them so they can choose a new one. Their cards and decks will be kept.`)) return;
            void act(async () => {
              const result = await request<{ account: Account; temporary_password: string; username: string }>(`/api/auth/accounts/${selected.id}/reset-password`, mutation(session, { expected_version: selected.account_version }));
              fill(result.account); setTemporaryPassword(result.temporary_password); setResetUsername(result.username); setShowPassword(false); setCopyNotice("");
              setNotice("Password reset. Share the temporary password below; this person must change it at their next sign-in.");
              window.setTimeout(() => document.getElementById("temporary-password-title")?.focus(), 0);
            }, false);
          }}>Reset password</button>
          {temporaryPassword && <section className="password-reset-result" aria-labelledby="temporary-password-title">
            <h4 id="temporary-password-title" tabIndex={-1}>Temporary sign-in password</h4>
            <p className="fine">Sign-in username: <strong>{resetUsername}</strong></p>
            <label>Temporary password<input ref={passwordInput} type={showPassword ? "text" : "password"} value={temporaryPassword} readOnly autoComplete="off" spellCheck={false} autoCapitalize="none" onFocus={(e) => e.currentTarget.select()} /></label>
            <div className="actions"><button type="button" className="text-button" aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)}>{showPassword ? "Hide password" : "Show password"}</button><button type="button" className="button secondary" onClick={() => {
              void navigator.clipboard?.writeText(temporaryPassword).then(() => setCopyNotice("Password copied.")).catch(() => { setShowPassword(true); passwordInput.current?.focus(); passwordInput.current?.select(); setCopyNotice("Copy wasn’t available. Select and copy the password above."); });
              if (!navigator.clipboard) { setShowPassword(true); setCopyNotice("Copy wasn’t available. Select and copy the password above."); }
            }}>Copy password</button></div>
            {copyNotice && <p className="fine" role="status">{copyNotice}</p>}
            <p className="fine">Save it now and share it privately. It won’t be shown again after you close this account.</p>
            <button type="button" className="button primary" onClick={clearPassword}>I’ve saved the password</button>
          </section>}
        </section>
        <section className="account-section" aria-label="End user sessions"><h4>Sign out this user</h4><p className="fine">Ends their PakTrak sessions on all devices. They can sign in again; suspend the account above to block access.</p><button className="button secondary" disabled={busy || dirty || !selected.active_sessions} onClick={() => {
          if (!window.confirm(`Sign out ${selected.display_name} on all devices?\n\nThey can sign in again. Their saved cards and decks will be kept.`)) return;
          void act(async () => { const result = await request<{ account: Account; sessions_ended: number }>(`/api/auth/accounts/${selected.id}/signout`, mutation(session, { expected_version: selected.account_version })); fill(result.account); setNotice(`${result.sessions_ended} sign-in sessions ended.`); });
        }}>Sign out all devices</button></section>
      </>}
      <AccountActivity account={selected} />
    </> : <>
      <label>Find an account<input type="search" placeholder="Search by name" maxLength={128} value={q} disabled={busy} onChange={(e) => setQ(e.target.value)} /></label>
      <div className="actions"><button className="text-button" disabled={busy} onClick={() => { setGuestsOnly(!guestsOnly); setOffset(0); }}>{guestsOnly ? "Show all accounts" : "Show guests awaiting approval"}</button><button className="text-button" disabled={busy || loading} onClick={() => void act(refresh, false)}>Refresh accounts</button></div>
      {loading && <p role="status">Loading accounts…</p>}
      {!loading && accounts.length === 0 && <p>{search ? "No accounts match that name." : guestsOnly ? "No guests are awaiting approval." : "No accounts in this view."}</p>}
      <ul className="plain-list account-list" aria-label="User accounts" aria-busy={loading}>{accounts.map((account) => <li key={account.id}>
        <div className="account-row-title"><strong>{account.display_name}</strong><span className="badge">{accountRole(account.role)}</span></div>
        <p className="fine">{account.scan_cards_used.toLocaleString()} cards scanned · {account.suspended ? "Access suspended" : account.scans_paused ? "Scanning paused" : account.scan_card_limit === null ? "Unlimited scans" : `${account.scan_cards_remaining?.toLocaleString()} remaining`}</p>
        <div className="actions"><button className="button secondary" disabled={busy || loading} onClick={() => open(account)} aria-label={`Manage ${account.display_name}`}>Manage account</button>{account.role === "guest" && <button className="text-button" disabled={busy || loading || account.suspended} onClick={() => approve(account)}>Approve as standard member</button>}</div>
      </li>)}</ul>
      <div className="pagination">{offset > 0 && <button className="text-button" disabled={busy || loading} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous accounts</button>}{next !== null && <button className="text-button" disabled={busy || loading} onClick={() => setOffset(next)}>More accounts</button>}</div>
    </>}
  </section>;
}
