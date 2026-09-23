import { useEffect, useRef, useState } from "react";
import { mutation, request, type Session } from "./api";
import { Icon } from "./Icon";

export default function MembershipWelcome({ session, onDismiss }: { session: Session; onDismiss: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closed = useRef(false);
  const storageKey = `paktrak-member-welcome:${session.owner_id}:${session.approved_at}`;
  const [seen] = useState(() => { try { return localStorage.getItem(storageKey) === "1"; } catch { return false; } });

  function persist() {
    void request("/api/auth/membership-welcome/dismiss", mutation(session)).catch(() => {
      // The local receipt prevents another interruption; a subsequent mount retries.
    });
  }
  function dismiss() {
    if (closed.current) return;
    closed.current = true;
    try { localStorage.setItem(storageKey, "1"); } catch { /* Server acknowledgement still works. */ }
    persist(); onDismiss();
  }
  useEffect(() => {
    if (seen) { persist(); return; }
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element.showModal();
    return () => { element.close(); document.body.style.overflow = overflow; previous?.focus({ preventScroll: true }); };
  }, []);
  if (seen) return null;
  return <dialog ref={dialog} className="membership-welcome" aria-labelledby="membership-title" aria-describedby="membership-description" onCancel={(event) => { event.preventDefault(); dismiss(); }}>
    <div className="membership-emblem" aria-hidden="true"><Icon name="spark" /></div>
    <span className="eyebrow">MORE ROOM TO COLLECT</span>
    <h2 id="membership-title">You’re approved!</h2>
    <p id="membership-description">Congratulations! Your administrator approved you as a standard PakTrak member.</p>
    <ul className="membership-features">
      <li><strong>{session.scans_paused ? "Your membership is ready" : session.scan_card_limit === null ? "Unlimited card scans" : "Your updated scan allowance"}</strong><span>{session.scans_paused ? "Your collection and decks are ready. New scans are currently paused by your administrator." : session.scan_card_limit === null ? "Your 100-card guest limit is removed. Scan as many cards as you like." : `Your administrator set a lifetime allowance of ${session.scan_card_limit.toLocaleString()} card scans. ${session.scan_cards_remaining?.toLocaleString()} remain.`}</span></li>
      <li><strong>Your collection comes with you</strong><span>Your cards, decks, binders and boxes are ready to keep growing.</span></li>
      <li><strong>Keep building</strong><span>Import decks, see what you own and export missing-card buy lists.</span></li>
    </ul>
    <button className="button primary" autoFocus onClick={dismiss}>Let’s keep collecting</button>
  </dialog>;
}
