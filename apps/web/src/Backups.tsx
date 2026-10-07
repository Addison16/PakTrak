import { useEffect, useState } from "react";
import { mutation, request, type Session } from "./api";
import ErrorNotice from "./ErrorNotice";

type Backup = { name: string; created_at: string; kind: "automatic" | "manual" | "before-restore" | "imported"; bytes: number; problem?: string };
type Restore = { name: string; saved?: string | null; at: string; error?: string };
type Status = { available: false } | {
  available: true; settings: { enabled: boolean; keep: number }; running: boolean; requested: boolean;
  last_success_at: string | null; last_error: string | null; last_error_at: string | null; next_at: string | null;
  restore_requested: string | null; last_restore: Restore | null; backups: Backup[];
};
const kinds: Record<Backup["kind"], string> = { automatic: "Daily", manual: "Backed up by hand", "before-restore": "Saved before a restore", imported: "Restored from a file" };
const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`;
const when = (value: string) => new Date(value).toLocaleString();

export default function Backups({ session }: { session: Session }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [keep, setKeep] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | string>("");
  const [notice, setNotice] = useState("");
  async function refresh() {
    const value = await request<Status>("/api/v1/backups", { action: "Load backups" });
    setStatus(value);
    if (value.available) setKeep((current) => current || String(value.settings.keep));
  }
  useEffect(() => { void refresh().catch((e: Error) => setError(e)); }, []);
  const working = status?.available && (status.running || status.requested);
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => void refresh().catch(() => {}), 4000);
    return () => clearInterval(timer);
  }, [working]);
  async function act(work: () => Promise<Status>, done: string) {
    setBusy(true); setError(""); setNotice("");
    try { setStatus(await work()); setNotice(done); }
    catch (e) { setError(e as Error); await refresh().catch(() => {}); }
    finally { setBusy(false); }
  }
  const post = (path: string, data?: unknown, action = "Save backup settings") => request<Status>(path, { ...mutation(session, data), action });
  const remove = (path: string, action: string) => request<Status>(path, { ...mutation(session), method: "DELETE", action });

  return <section className="signup-setting backups" aria-label="Backups">
    <h3>Backups</h3>
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
    {notice && <p className="message success" role="status">{notice}</p>}
    {status && !status.available && <p className="fine">Automatic backups are part of the single-container install. Compose installs back up with scripts/backup.sh; see the operations guide.</p>}
    {status?.available && <>
      <p className="fine">PakTrak copies every collection, deck, account and setting into the backups folder inside its data folder. Download a backup to keep a copy somewhere else, or to move PakTrak to another server.</p>
      {status.restore_requested && <div className="backup-notice" role="status">
        <p><strong>Restart PakTrak to restore the backup from {when(status.backups.find((item) => item.name === status.restore_requested)?.created_at || status.restore_requested)}.</strong> On Unraid, open the Docker page, tap the PakTrak icon and choose Restart. PakTrak saves the current data as a new backup before it restores.</p>
        <div className="actions"><button className="button secondary" disabled={busy} onClick={() => void act(() => remove("/api/v1/backups/restore/request", "Cancel restore"), "Restore cancelled. Nothing changed.")}>Cancel restore</button></div>
      </div>}
      {status.last_restore && !status.restore_requested && (status.last_restore.error
        ? <p className="fine">The restore asked for on {when(status.last_restore.at)} was skipped: {status.last_restore.error}</p>
        : <p className="fine">Restored {status.last_restore.name} on {when(status.last_restore.at)}.{status.last_restore.saved ? " The data from before the restore is saved as a backup below." : ""}</p>)}
      <form onSubmit={(e) => {
        e.preventDefault();
        const count = Number(keep);
        if (!Number.isInteger(count) || count < 1 || count > 60) { setError("Keep between 1 and 60 backups."); return; }
        void act(() => post("/api/v1/backups/settings", { enabled: status.settings.enabled, keep: count }), `Saved. PakTrak keeps the newest ${count} backup${count === 1 ? "" : "s"}.`);
      }}>
        <label className="checkbox"><input type="checkbox" checked={status.settings.enabled} disabled={busy} onChange={(e) => {
          const enabled = e.target.checked;
          void act(() => post("/api/v1/backups/settings", { enabled, keep: status.settings.keep }), enabled ? "Daily backups are on." : "Daily backups are off. Existing backups are kept.");
        }} />Back up every day</label>
        <label>Backups to keep<input type="number" inputMode="numeric" min={1} max={60} value={keep} disabled={busy} onChange={(e) => setKeep(e.target.value)} /></label>
        <p className="fine">When a new backup is saved, the oldest ones beyond this number are deleted.</p>
        <div className="actions">
          <button className="button secondary" disabled={busy || keep === String(status.settings.keep)}>Save</button>
          <button type="button" className="button secondary" disabled={busy || !!working} onClick={() => void act(() => post("/api/v1/backups/run", undefined, "Start backup"), "Backing up now. This page updates when it finishes.")}>{working ? "Backing up…" : "Back up now"}</button>
        </div>
      </form>
      {status.last_error && <p className="fine">The last backup on {when(status.last_error_at || "")} failed: {status.last_error} PakTrak tries again within an hour.</p>}
      {status.next_at && !working && <p className="fine">Next daily backup {new Date(status.next_at) <= new Date() ? "in a few moments" : when(status.next_at)}.</p>}
      {status.backups.length === 0 ? <p className="fine">No backups yet.</p> : <ul className="plain-list backup-list">{status.backups.map((item) => <li key={item.name}>
        <div className="holding-title"><strong>{when(item.created_at)}</strong><span className="badge">{kinds[item.kind]}</span></div>
        <p className="fine">{item.problem ? item.problem : size(item.bytes)}</p>
        <div className="actions">
          <a className="button secondary" href={`/api/v1/backups/${encodeURIComponent(item.name)}/download`} download={item.name}>Download</a>
          {!item.problem && <button className="button secondary" disabled={busy || status.restore_requested === item.name} onClick={() => {
            if (!window.confirm(`Restore the backup from ${when(item.created_at)}?\n\nAfter you restart PakTrak, every account, collection and deck goes back to how it was then. The current data is saved as a backup first, so you can switch back.`)) return;
            void act(() => post(`/api/v1/backups/${encodeURIComponent(item.name)}/restore`, undefined, "Choose backup to restore"), "");
          }}>Restore</button>}
          <button className="text-button" disabled={busy || status.restore_requested === item.name} onClick={() => {
            if (!window.confirm(`Delete the backup from ${when(item.created_at)}?`)) return;
            void act(() => remove(`/api/v1/backups/${encodeURIComponent(item.name)}`, "Delete backup"), "Backup deleted.");
          }}>Delete</button>
        </div>
      </li>)}</ul>}
      <p className="fine">Moving to another server: download the newest backup, install PakTrak there, put the file in a folder named restore inside its data folder, then start or restart the container. Backups include the server’s private passwords, so keep downloaded copies private.</p>
    </>}
  </section>;
}
