import { ApiError, request, type Session } from "./api";
import { connection, countQueue, onReconnect, putQueued, queuedActions, removeQueued, setSending, setSignInNeeded, type QueuedAction } from "./offline";

// Sends queued edits in the order they were made once the server answers again.
// A failed edit stays in the list with the server's reason; later edits still go.
let running: Promise<void> | null = null;
export function flushQueue() {
  running ||= flush().finally(() => { running = null; });
  return running;
}

const stillOffline = (error: unknown) => error instanceof ApiError && (error.code === "network_error" || error.code === "server_unreachable" || [502, 503, 504].includes(error.status || 0));

async function flush() {
  const { owner, reachable } = connection();
  if (!owner || !reachable) return;
  // An edit still marked as sending was cut off when the page closed; the
  // Idempotency-Key makes sending it again safe.
  for (const item of await queuedActions(owner)) if (item.state === "sending") await putQueued({ ...item, state: "waiting" });
  if (!(await queuedActions(owner)).some((item) => item.state === "waiting")) return;
  setSending(true);
  let sent = 0;
  try {
    let session: Session;
    try { session = await request<Session>("/api/auth/session", { quiet: true, cache: "no-store" }); }
    catch (error) { if (error instanceof ApiError && error.status === 401) setSignInNeeded(true); return; }
    // A saved copy of the session means the server didn't answer after all.
    if (!connection().reachable || session.owner_id !== owner) return;
    setSignInNeeded(false);
    let refreshed = false;
    for (;;) {
      const action = (await queuedActions(owner)).find((item) => item.state === "waiting");
      if (!action) break;
      await putQueued({ ...action, state: "sending", error: undefined });
      try {
        const result = await replay(action, session.csrf_token);
        await removeQueued(action.id); sent++;
        await carryVersion(action, result);
      } catch (error) {
        if (stillOffline(error)) { await putQueued({ ...action, state: "waiting" }); break; }
        if (error instanceof ApiError && error.status === 401) { await putQueued({ ...action, state: "waiting" }); setSignInNeeded(true); break; }
        if (error instanceof ApiError && error.code === "csrf_mismatch" && !refreshed) {
          refreshed = true;
          try { session = await request<Session>("/api/auth/session", { quiet: true, cache: "no-store" }); await putQueued({ ...action, state: "waiting" }); continue; }
          catch { await putQueued({ ...action, state: "waiting" }); break; }
        }
        await putQueued({ ...action, state: "failed", error: error instanceof ApiError ? error.userMessage : (error as Error).message || "The server didn’t accept this change." });
      }
    }
  } finally {
    setSending(false);
    await countQueue();
    if (sent) window.dispatchEvent(new CustomEvent("paktrak:synced", { detail: { owner, sent } }));
  }
}

function replay(action: QueuedAction, csrf: string) {
  const headers: Record<string, string> = { "X-CSRF-Token": csrf, "Idempotency-Key": action.idempotencyKey };
  if (action.contentType) headers["Content-Type"] = action.contentType;
  return request<unknown>(action.path, { method: action.method, headers, body: action.body, quiet: true, action: action.label });
}

// Two offline edits to the same copy or deck were both made against the version
// last seen; give the later one the version the earlier one produced.
async function carryVersion(action: QueuedAction, result: unknown) {
  const version = result && typeof result === "object" ? (result as { version?: unknown }).version : undefined;
  if (!action.resource || typeof version !== "number") return;
  for (const later of await queuedActions(action.owner)) {
    if (later.resource !== action.resource || later.state === "sending" || !later.body) continue;
    try {
      const body = JSON.parse(later.body);
      if (typeof body?.expected_version !== "number") continue;
      await putQueued({ ...later, body: JSON.stringify({ ...body, expected_version: version }) });
    } catch { /* Leave bodies that aren't JSON unchanged. */ }
  }
}

export function retryQueued(action: QueuedAction) {
  return putQueued({ ...action, state: "waiting", error: undefined }).then(flushQueue);
}

onReconnect(() => void flushQueue());
window.addEventListener("paktrak:queued", () => { if (connection().reachable) void flushQueue(); });
