import { useEffect, useState } from "react";
import { mutation, request, type Session } from "./api";
import ErrorNotice from "./ErrorNotice";

type Server = { id: string; url: string; host: string; state: "requested" | "pending" | "connected"; created_at: string; connected_at: string | null; last_seen_at: string | null; friendships: number };
type Status = { enabled: boolean; address: string; secure: boolean; servers: Server[] };
const when = (value: string) => new Date(value).toLocaleDateString();

export default function Servers({ session }: { session: Session }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | string>("");
  const [notice, setNotice] = useState("");
  async function refresh() { setStatus(await request<Status>("/api/v1/servers", { action: "Load server connections" })); }
  useEffect(() => { void refresh().catch((e: Error) => setError(e)); }, []);
  async function act(work: () => Promise<Status>, done: (value: Status) => string) {
    setBusy(true); setError(""); setNotice("");
    try { const value = await work(); setStatus(value); setNotice(done(value)); }
    catch (e) { setError(e as Error); await refresh().catch(() => {}); }
    finally { setBusy(false); }
  }
  const post = (path: string, data: unknown, action: string) => request<Status>(path, { ...mutation(session, data), action });
  const remove = (server: Server, action: string) => request<Status>(`/api/v1/servers/${server.id}`, { ...mutation(session), method: "DELETE", action });
  const asking = status?.servers.filter((item) => item.state === "pending") ?? [];
  const connected = status?.servers.filter((item) => item.state === "connected") ?? [];
  const waiting = status?.servers.filter((item) => item.state === "requested") ?? [];

  return <section className="signup-setting servers" aria-label="Other PakTrak servers">
    <h3>Other PakTrak servers</h3>
    {error && <ErrorNotice error={error} onDismiss={() => setError("")} />}
    {notice && <p className="message success" role="status">{notice}</p>}
    {status && <>
      <p className="fine">Connect with PakTrak servers run by people you know, so people on both servers can add each other as friends. Each server stays in charge of its own accounts. Neither server can list or search the other’s accounts, and friends see only what each person shares.</p>
      <label className="checkbox"><input type="checkbox" checked={status.enabled} disabled={busy} onChange={(e) => {
        const enabled = e.target.checked;
        void act(() => post("/api/v1/servers/settings", { enabled }, "Change server connections"), () => enabled ? "Other servers can now ask to connect. You approve each one." : "Connections are paused. Friends on other servers are hidden until you turn this back on.");
      }} />Allow connections with other servers</label>
      {status.enabled && <>
        <p className="fine">This server’s address is <strong className="server-address">{status.address}</strong>. Give it to the other server’s administrator.{status.secure ? "" : " It starts with http://, so only servers on your own network can connect. Set PakTrak up at an https:// address to connect over the internet."}</p>
        <form onSubmit={(e) => {
          e.preventDefault();
          const url = address.trim();
          if (!url) return;
          void act(() => post("/api/v1/servers", { url }, "Connect to server"), (value) => {
            setAddress("");
            const server = value.servers.find((item) => item.url === url.replace(/\/+$/, "") || item.host === url.replace(/^https?:\/\//, "").replace(/\/+$/, ""));
            return server?.state === "connected" ? `Connected to ${server.host}.` : "Request sent. The connection starts when their administrator approves it.";
          });
        }}>
          <label>Connect to a server<input value={address} maxLength={255} disabled={busy} inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="https://cards.example.com" onChange={(e) => setAddress(e.target.value)} /></label>
          <div className="actions"><button className="button secondary" disabled={busy || !address.trim()}>Send request</button></div>
        </form>
      </>}
      {asking.length > 0 && <div aria-label="Asking to connect">
        <h4>Asking to connect</h4>
        <ul className="plain-list server-list">{asking.map((server) => <li key={server.id}>
          <div><strong>{server.host}</strong><small>Asked {when(server.created_at)}. Approve only servers you recognize.</small></div>
          <div className="actions">
            <button type="button" className="button primary" disabled={busy || !status.enabled} onClick={() => void act(() => post(`/api/v1/servers/${server.id}/approve`, undefined, "Approve server"), () => `Connected to ${server.host}.`)}>Approve</button>
            <button type="button" className="text-button" disabled={busy} onClick={() => void act(() => remove(server, "Decline server"), () => `Declined ${server.host}.`)}>Decline</button>
          </div>
        </li>)}</ul>
      </div>}
      {connected.length > 0 && <div aria-label="Connected servers">
        <h4>Connected</h4>
        <ul className="plain-list server-list">{connected.map((server) => <li key={server.id}>
          <div><strong>{server.host}</strong><small>Connected {when(server.connected_at || server.created_at)} · {server.friendships === 1 ? "1 friendship" : `${server.friendships} friendships`}{server.last_seen_at ? ` · last heard from ${when(server.last_seen_at)}` : ""}</small></div>
          <div className="actions"><button type="button" className="text-button" disabled={busy} onClick={() => {
            if (window.confirm(`Disconnect ${server.host}? Friendships between people here and there end.`)) void act(() => remove(server, "Disconnect server"), () => `Disconnected ${server.host}.`);
          }}>Disconnect</button></div>
        </li>)}</ul>
      </div>}
      {waiting.length > 0 && <div aria-label="Waiting for approval">
        <h4>Waiting for their approval</h4>
        <ul className="plain-list server-list">{waiting.map((server) => <li key={server.id}>
          <div><strong>{server.host}</strong><small>Requested {when(server.created_at)}</small></div>
          <div className="actions"><button type="button" className="text-button" disabled={busy} onClick={() => void act(() => remove(server, "Cancel request"), () => `Request to ${server.host} cancelled.`)}>Cancel request</button></div>
        </li>)}</ul>
      </div>}
      {status.enabled && status.servers.length === 0 && <p className="fine">No other servers yet.</p>}
    </>}
  </section>;
}
