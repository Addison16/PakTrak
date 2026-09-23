import { useCallback, useEffect, useRef, useState } from "react";
import { isPriceSource, providers, request, savePriceSource, waitForPriceSourceSave, type PriceSource, type Session } from "./api";

// The account is authoritative; the old device setting is only a one-time migration
// candidate and a signal for other tabs to refresh their account preference.
export default function usePriceSource(session: Session) {
  const key = "collection-price-source:" + session.owner_id;
  const [provider, setProvider] = useState<PriceSource>(session.preferred_price_source || "tcgplayer");
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preferenceError, setPreferenceError] = useState("");
  const [retry, setRetry] = useState<{ source: PriceSource; migration: boolean } | null>(null);
  const control = useRef({ active: false, version: 0, reading: false, saving: false, unsaved: false, ready: false });
  const remember = useCallback((source: PriceSource) => {
    try { localStorage.setItem(key, source); } catch { /* The account preference still persists without device storage. */ }
  }, [key]);
  const persist = useCallback(async (source: PriceSource, migration = false) => {
    const state = control.current;
    if (!state.active || state.saving) return;
    const version = ++state.version;
    state.reading = false; state.saving = true; state.unsaved = true;
    setProvider(source); setSaving(true); setPreferenceError(""); setRetry(null);
    try {
      const saved = await savePriceSource(session, source, migration);
      if (!state.active || state.version !== version) return;
      if (!isPriceSource(saved.preferred_price_source)) throw new Error("The saved price source could not be verified.");
      state.unsaved = false;
      setProvider(saved.preferred_price_source); remember(saved.preferred_price_source);
    } catch (error) {
      if (!state.active || state.version !== version) return;
      setPreferenceError(`This view uses ${providers[source]}, but your account preference could not be saved. ${(error as Error).message}`);
      setRetry({ source, migration });
    } finally {
      if (state.active && state.version === version) {
        state.saving = false; state.ready = true;
        setSaving(false); setReady(true);
      }
    }
  }, [session.owner_id, session.csrf_token, remember]);
  const refreshPreference = useCallback(async () => {
    const state = control.current;
    if (!state.active || state.reading || state.saving || state.unsaved) return;
    const version = ++state.version;
    state.reading = true;
    try {
      await waitForPriceSourceSave(session.owner_id);
      if (!state.active || state.version !== version) return;
      const account = await request<Session>("/api/auth/session");
      if (!state.active || state.version !== version) return;
      if (account.owner_id !== session.owner_id) throw new Error("Your signed-in account changed. Reload before choosing a price source.");
      const saved = account.preferred_price_source;
      if (saved != null && !isPriceSource(saved)) throw new Error("Your saved price source could not be read.");
      if (saved == null) {
        let legacy: string | null = null;
        try { legacy = localStorage.getItem(key); } catch { /* No device preference to migrate. */ }
        if (isPriceSource(legacy)) { await persist(legacy, true); return; }
      }
      setProvider(saved || "tcgplayer");
      if (saved) remember(saved);
      state.ready = true; setReady(true); setPreferenceError("");
    } catch (error) {
      if (state.active && state.version === version && !state.ready) setPreferenceError(`Your saved price source could not be loaded. ${(error as Error).message}`);
    } finally {
      if (state.version === version) state.reading = false;
    }
  }, [session.owner_id, key, persist, remember]);
  useEffect(() => {
    const state = control.current;
    state.active = true;
    void refreshPreference();
    const resume = () => { if (!document.hidden && navigator.onLine) void refreshPreference(); };
    const savedHere = (event: Event) => { if ((event as CustomEvent<{ owner: string }>).detail?.owner === session.owner_id) resume(); };
    const changed = (event: StorageEvent) => { if (event.key === key || event.key === null) resume(); };
    const timer = window.setInterval(resume, 15000);
    window.addEventListener("paktrak:price-source", savedHere);
    window.addEventListener("storage", changed); window.addEventListener("focus", resume); window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      state.active = false; ++state.version; state.reading = false; state.saving = false;
      window.removeEventListener("paktrak:price-source", savedHere);
      clearInterval(timer); window.removeEventListener("storage", changed); window.removeEventListener("focus", resume); window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [key, refreshPreference]);
  return { provider, ready, saving, preferenceError, retry, change: persist, retrySave: () => retry ? persist(retry.source, retry.migration) : refreshPreference() };
}

