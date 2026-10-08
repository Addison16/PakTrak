// Local recovery stores unfinished inputs only; never credentials or approvals.
const lifetime = 7 * 24 * 60 * 60 * 1000;
const prefix = "paktrak.draft.";

export function readDraft<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(prefix + key);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || saved.version !== 1 || typeof saved.expires !== "number" || saved.expires <= Date.now() || !("value" in saved)) {
      removeDraft(key); return null;
    }
    return saved.value as T;
  } catch { return null; }
}

export function writeDraft(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(prefix + key, JSON.stringify({ version: 1, expires: Date.now() + lifetime, value }));
    return true;
  } catch { return false; }
}

export function removeDraft(key: string): void {
  try { localStorage.removeItem(prefix + key); } catch { /* Blocked storage must not interrupt editing. */ }
}

/** Removes every saved draft on this device, as on sign out. */
export function clearDrafts(): void {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
    for (const key of Object.keys(sessionStorage)) if (key.startsWith("paktrak:")) sessionStorage.removeItem(key);
  } catch { /* Blocked storage holds no drafts to remove. */ }
}
