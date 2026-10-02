export type PendingPhoto = {
  owner: string; file: Blob; filename: string; savedAt: number; foilCount: number;
  targetDeck?: string; collect?: boolean;
};
type StoredPendingPhoto = Omit<PendingPhoto, "file"> & {
  file: ArrayBuffer | Blob;
  mimeType?: string;
};

const databaseName = "paktrak-pending-photos";
const maxAge = 7 * 24 * 60 * 60 * 1000;
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error("Photo recovery is unavailable.")); return; }
    const open = indexedDB.open(databaseName, 1);
    open.onupgradeneeded = () => open.result.createObjectStore("photos", { keyPath: "owner" });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error("Photo recovery storage is busy."));
  });
}

export async function savePendingPhoto(value: PendingPhoto): Promise<boolean> {
  let db: IDBDatabase | undefined;
  try {
    // WebKit private contexts cannot put Blob/File values in IndexedDB.
    // Read the bytes before opening the transaction so it stays active.
    const stored: StoredPendingPhoto = { ...value, file: await value.file.arrayBuffer(), mimeType: value.file.type };
    db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db!.transaction("photos", "readwrite");
      transaction.objectStore("photos").put(stored);
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(transaction.error);
    });
    return true;
  } catch { return false; }
  finally { db?.close(); }
}

export async function readPendingPhoto(owner: string): Promise<PendingPhoto | null> {
  let db: IDBDatabase | undefined;
  try {
    db = await database();
    const value = await new Promise<StoredPendingPhoto | undefined>((resolve, reject) => {
      const request = db!.transaction("photos").objectStore("photos").get(owner);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!value || value.owner !== owner || typeof value.filename !== "string") return null;
    const { file: storedFile, mimeType, ...metadata } = value;
    // Keep older recovery photos readable without changing the database schema.
    const file = storedFile instanceof Blob ? storedFile : storedFile instanceof ArrayBuffer && typeof mimeType === "string" ? new Blob([storedFile], { type: mimeType }) : null;
    if (!file) return null;
    if (!Number.isFinite(value.savedAt) || Date.now() - value.savedAt > maxAge) {
      db.close(); db = undefined; await removePendingPhoto(owner, value.savedAt); return null;
    }
    return { ...metadata, file };
  } catch { return null; }
  finally { db?.close(); }
}

export async function removePendingPhoto(owner: string, expectedSavedAt?: number): Promise<void> {
  let db: IDBDatabase | undefined;
  try {
    db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db!.transaction("photos", "readwrite");
      const photos = transaction.objectStore("photos");
      const current = photos.get(owner);
      current.onsuccess = () => {
        if (expectedSavedAt === undefined || current.result?.savedAt === expectedSavedAt) photos.delete(owner);
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(transaction.error);
    });
  } catch { /* A storage failure must not imply that server acceptance failed. */ }
  finally { db?.close(); }
}
