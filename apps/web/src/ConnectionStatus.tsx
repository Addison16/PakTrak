import { Icon } from "./Icon";
import { useConnection } from "./offline";

// Plain text in the header; shown only when something is different from normal.
export default function ConnectionStatus({ onOpen }: { onOpen: () => void }) {
  const status = useConnection();
  const pending = status.waiting + status.failed;
  const announcement = <span className="sr-only" role="status">{status.reachable ? "" : "PakTrak is offline. Changes you can make offline are queued."}</span>;
  if (status.reachable && !pending && !status.signInNeeded) return announcement;
  const label = !status.reachable ? "Offline" : status.signInNeeded ? "Sign in to send" : status.failed ? `${status.failed} not sent` : status.sending ? "Sending…" : "Queued";
  const count = !status.reachable && pending ? ` · ${pending}` : status.reachable && !status.failed && pending ? ` · ${pending}` : "";
  const description = (!status.reachable ? "Offline. PakTrak can’t be reached." : status.signInNeeded ? "Sign in again to send queued changes." : status.failed ? `${status.failed} queued ${status.failed === 1 ? "change was" : "changes were"} not accepted.` : status.sending ? "Sending queued changes." : "Changes waiting to send.")
    + (status.waiting ? ` ${status.waiting} ${status.waiting === 1 ? "change" : "changes"} waiting.` : "") + " Open queued actions.";
  return <>{announcement}<button type="button" className="connection-status" data-offline={!status.reachable || undefined} aria-label={description} onClick={onOpen}>
    <Icon name={status.reachable ? "queue" : "offline"} /><span aria-hidden="true">{label}{count}</span>
  </button></>;
}
