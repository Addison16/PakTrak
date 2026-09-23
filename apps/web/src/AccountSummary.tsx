import type { Account } from "./accountTypes";

export function AccountUsage({ account }: { account: Account }) {
  return <section className="account-usage" aria-label="Card scan allowance">
    <div className="eyebrow">CARD SCAN ALLOWANCE</div>
    <div className="account-usage-heading"><strong>{account.scan_cards_used.toLocaleString()} <span>cards scanned</span></strong><span className="badge">{account.scans_paused ? "Paused" : account.scan_card_limit === null ? "Unlimited" : account.scan_cards_remaining === 0 ? "Limit reached" : "Available"}</span></div>
    <p>{account.scan_card_limit === null ? "Unlimited card scans" : `${account.scan_cards_remaining?.toLocaleString()} remaining of ${account.scan_card_limit.toLocaleString()} lifetime card scans`}</p>
    {account.scan_card_limit !== null && account.scan_card_limit > 0 && <progress value={Math.min(account.scan_cards_used, account.scan_card_limit)} max={account.scan_card_limit} aria-label="Lifetime card scans used" />}
    {account.scans_paused && <p className="account-pause-note">New scans are paused. An administrator can resume them. You can still use your collection and decks.</p>}
    <p className="fine">Counts individual cards found in photos, including manually added card outlines. CSV/text imports do not use this allowance. Deleting cards or batches does not reset it.</p>
  </section>;
}

const activityLabels: Record<string, string> = { PASSWORD_RESET_STARTED: "Administrator started a password reset", PASSWORD_RESET: "Administrator reset the password", PASSWORD_RESET_FAILED: "Password reset was not confirmed", APPROVED: "Approved as a standard member", ACCESS_UPDATED: "Account access or scan allowance updated", SESSIONS_ENDED: "Administrator ended sign-in sessions", OTHER_SESSIONS_ENDED: "Other sign-in sessions ended", PROFILE_UPDATED: "Display name updated" };
export function AccountActivity({ account }: { account: Account }) {
  if (!account.activity?.length) return null;
  return <details className="account-activity"><summary>Recent account activity</summary><ul className="plain-list">{account.activity.map((event, index) => <li key={event.created_at + index}><strong>{activityLabels[event.kind] || "Account updated"}</strong><time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString()}</time></li>)}</ul></details>;
}
