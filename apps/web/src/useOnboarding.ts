import { useCallback, useEffect, useRef, useState } from "react";
import { mutation, request, type Session } from "./api";

const storageKey = (owner: string) => "paktrak:tour-dismissed:" + owner;
function dismissedLocally(owner: string) {
  try { return localStorage.getItem(storageKey(owner)) === "1"; }
  catch { return false; }
}

export function useOnboarding(session: Session | null | undefined) {
  const [tour, setTour] = useState<{ owner: string; replay: boolean } | null>(null);
  const [save, setSave] = useState<{ owner: string; busy: boolean; error: string } | null>(null);
  const shown = useRef(new Set<string>());
  const pending = useRef(new Map<string, Promise<void>>());

  const persist = useCallback((account: Session) => {
    const owner = account.owner_id;
    const underway = pending.current.get(owner);
    if (underway) return underway;
    setSave({ owner, busy: true, error: "" });
    const attempt = request<{ tour_dismissed: boolean }>("/api/auth/onboarding/dismiss", mutation(account))
      .then((result) => {
        if (result.tour_dismissed !== true) throw new Error("Please try again.");
        setSave((current) => current?.owner === owner ? { owner, busy: false, error: "" } : current);
      })
      .catch((error: Error) => {
        setSave((current) => current?.owner === owner ? {
          owner, busy: false, error: "Your tour is closed, but we couldn’t save that to your account. " + error.message,
        } : current);
      })
      .finally(() => { pending.current.delete(owner); });
    pending.current.set(owner, attempt);
    return attempt;
  }, []);

  useEffect(() => {
    if (!session) return;
    const owner = session.owner_id;
    if (session.tour_dismissed === true) {
      setTour((current) => current?.owner === owner && !current.replay ? null : current);
      setSave((current) => current?.owner === owner && current.error ? null : current);
      return;
    }
    // An older server without the flag must not trigger a tour on every login.
    if (session.tour_dismissed !== false || shown.current.has(owner)) return;
    shown.current.add(owner);
    if (dismissedLocally(owner)) void persist(session);
    else setTour({ owner, replay: false });
  }, [session, persist]);

  useEffect(() => {
    if (!session) return;
    const account = session;
    const resume = () => {
      if (account.tour_dismissed === false && dismissedLocally(account.owner_id)) void persist(account);
    };
    const sync = (event: StorageEvent) => {
      if (event.key !== storageKey(account.owner_id) || event.newValue !== "1") return;
      shown.current.add(account.owner_id);
      setTour((current) => current?.owner === account.owner_id && !current.replay ? null : current);
    };
    window.addEventListener("online", resume);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener("online", resume); window.removeEventListener("storage", sync); };
  }, [session, persist]);

  const active = session && tour?.owner === session.owner_id ? tour : null;
  return {
    active,
    saving: save?.owner === session?.owner_id && save?.busy,
    error: save?.owner === session?.owner_id ? save?.error : "",
    replay: () => { if (session) setTour({ owner: session.owner_id, replay: true }); },
    dismiss: () => {
      if (!session || !active) return;
      setTour(null);
      shown.current.add(session.owner_id);
      try { localStorage.setItem(storageKey(session.owner_id), "1"); } catch { /* The account save works without local storage. */ }
      if (!active.replay && session.tour_dismissed !== true) void persist(session);
    },
    retry: () => { if (session) void persist(session); },
  };
}
