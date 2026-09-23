import { useState, type ReactNode } from "react";
import { ApiError } from "./api";

export default function ErrorNotice({ error, onDismiss, onRetry, retryLabel = "Try again", children }: {
  error: Error | string; onDismiss: () => void; onRetry?: () => void; retryLabel?: string; children?: ReactNode;
}) {
  const [copyState, setCopyState] = useState("");
  const [seen] = useState(() => new Date().toISOString());
  const api = error instanceof ApiError ? error : null;
  const message = api?.userMessage || (typeof error === "string" ? error : error.message);
  const details = [message, `Time: ${api?.occurredAt || seen}`, api?.status && `HTTP status: ${api.status}`, api?.code && `Code: ${api.code}`, api?.requestId && `Reference: ${api.requestId}`].filter(Boolean).join("\n");
  return <div className="message error error-notice" role="alert">
    <div className="error-notice-heading"><p>{message}</p><button type="button" className="text-button" aria-label="Dismiss error" onClick={onDismiss}>Dismiss</button></div>
    <div className="actions">
      {(api?.status === 401 || api?.code?.startsWith("login_") || api?.code === "identity_unavailable") && <a className="text-button" href="/api/auth/login">Sign in again</a>}
      {api?.code === "account_changed" && <a className="text-button" href="/">Reload PakTrak</a>}
      {onRetry && <button type="button" className="text-button" onClick={onRetry}>{retryLabel}</button>}
      {!onRetry && api?.code === "csrf_mismatch" && <button type="button" className="text-button" onClick={() => window.dispatchEvent(new Event("paktrak:refresh-sign-in"))}>Refresh sign-in</button>}
      {children}
    </div>
    <details><summary>Error details</summary><pre>{details}</pre>
      <button type="button" className="text-button" onClick={() => {
        setCopyState("");
        void navigator.clipboard?.writeText(details).then(() => setCopyState("Copied."), () => setCopyState("Select and copy the details above."));
        if (!navigator.clipboard) setCopyState("Select and copy the details above.");
      }}>Copy error details</button>{copyState && <span className="fine" role="status">{copyState}</span>}
    </details>
  </div>;
}
