import type { LocalActiveDay, LocalMasteryItem } from "./types.ts";

export type StorageBackendMode = "indexeddb" | "localstorage" | "memory";

const prefMemoryFallback = new Map<string, string>();

/**
 * Safely reads a string preference from localStorage with an in-memory Map fallback.
 */
export function readPrefStorage(key: string): string | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage.getItem(key);
    }
  } catch {
    // Fall back to in-memory preference map when localStorage throws or is blocked
  }
  return prefMemoryFallback.get(key) ?? null;
}

/**
 * Safely writes a string preference to localStorage with an in-memory Map fallback.
 */
export function writePrefStorage(key: string, value: string): void {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(key, value);
      return;
    }
  } catch {
    // Fall back to in-memory preference map when localStorage throws or is blocked
  }
  prefMemoryFallback.set(key, value);
}

export const DATA_NOTICE_STORAGE_KEY = "prb005_data_notice_v1";

export function isDataNoticeDismissed(): boolean {
  return readPrefStorage(DATA_NOTICE_STORAGE_KEY) === "1";
}

export function dismissDataNotice(): void {
  writePrefStorage(DATA_NOTICE_STORAGE_KEY, "1");
}

const DB_NAME = "prb005-brainplay";
const DB_VERSION = 1;
const STORE_MASTERY = "mastery";
const STORE_DAYS = "active_days";
const LS_KEY = "prb005_brainplay_state_v1";

interface LocalStateBlob {
  schema_version: 1;
  mastery: LocalMasteryItem[];
  active_days: LocalActiveDay[];
}

export interface LocalStore {
  mode: StorageBackendMode;
  loadAll(): Promise<{ mastery: LocalMasteryItem[]; activeDays: LocalActiveDay[] }>;
  saveMasteryItems(items: LocalMasteryItem[]): Promise<void>;
  saveActiveDay(day: LocalActiveDay): Promise<void>;
  replaceAll(mastery: LocalMasteryItem[], activeDays: LocalActiveDay[]): Promise<void>;
}

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_MASTERY)) {
        db.createObjectStore(STORE_MASTERY, { keyPath: "item_id" });
      }
      if (!db.objectStoreNames.contains(STORE_DAYS)) {
        db.createObjectStore(STORE_DAYS, { keyPath: "local_date" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function idbGetAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result as T[]) ?? []);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB read failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    } catch (err) {
      reject(err);
    }
  });
}

function idbPutBatch<T>(db: IDBDatabase, storeName: string, items: T[], clearFirst = false): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      if (clearFirst) store.clear();
      for (const item of items) store.put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    } catch (err) {
      reject(err);
    }
  });
}

function mergeIntoMemory(
  memMastery: LocalMasteryItem[],
  items: LocalMasteryItem[]
): LocalMasteryItem[] {
  const map = new Map(memMastery.map((m) => [m.item_id, m]));
  for (const it of items) map.set(it.item_id, it);
  return Array.from(map.values());
}

function upsertDayMemory(memDays: LocalActiveDay[], day: LocalActiveDay): LocalActiveDay[] {
  const map = new Map(memDays.map((d) => [d.local_date, d]));
  map.set(day.local_date, day);
  return Array.from(map.values());
}

export async function createLocalStore(
  onStorageError?: (reason: string) => void
): Promise<LocalStore> {
  let memMastery: LocalMasteryItem[] = [];
  let memDays: LocalActiveDay[] = [];

  // Try IndexedDB first; fall back to localStorage, then in-memory (BR-02 / UX-004)
  try {
    const db = await openIdb();
    let idbDegraded = false;
    return {
      mode: "indexeddb",
      async loadAll() {
        if (idbDegraded) {
          return { mastery: [...memMastery], activeDays: [...memDays] };
        }
        try {
          const [mastery, activeDays] = await Promise.all([
            idbGetAll<LocalMasteryItem>(db, STORE_MASTERY),
            idbGetAll<LocalActiveDay>(db, STORE_DAYS),
          ]);
          memMastery = mastery;
          memDays = activeDays;
          return { mastery, activeDays };
        } catch {
          idbDegraded = true;
          onStorageError?.("Browser IndexedDB read failed; using temporary session memory.");
          return { mastery: [...memMastery], activeDays: [...memDays] };
        }
      },
      async saveMasteryItems(items) {
        if (items.length === 0) return;
        memMastery = mergeIntoMemory(memMastery, items);
        if (idbDegraded) return;
        try {
          await idbPutBatch(db, STORE_MASTERY, items, false);
        } catch {
          idbDegraded = true;
          onStorageError?.("Could not persist mastery to IndexedDB; keeping progress in session memory.");
        }
      },
      async saveActiveDay(day) {
        memDays = upsertDayMemory(memDays, day);
        if (idbDegraded) return;
        try {
          await idbPutBatch(db, STORE_DAYS, [day], false);
        } catch {
          idbDegraded = true;
          onStorageError?.("Could not persist activity to IndexedDB; keeping progress in session memory.");
        }
      },
      async replaceAll(mastery, activeDays) {
        memMastery = [...mastery];
        memDays = [...activeDays];
        if (idbDegraded) return;
        try {
          await Promise.all([
            idbPutBatch(db, STORE_MASTERY, mastery, true),
            idbPutBatch(db, STORE_DAYS, activeDays, true),
          ]);
        } catch {
          idbDegraded = true;
          onStorageError?.("Could not persist imported backup to IndexedDB; keeping progress in session memory.");
        }
      },
    };
  } catch {
    // Fallback to localStorage if available
    try {
      const testKey = "__prb005_ls_probe__";
      localStorage.setItem(testKey, "1");
      localStorage.removeItem(testKey);

      let lsDegraded = false;
      const readLs = (): LocalStateBlob => {
        if (lsDegraded) {
          return { schema_version: 1, mastery: [...memMastery], active_days: [...memDays] };
        }
        try {
          const raw = localStorage.getItem(LS_KEY);
          if (!raw) return { schema_version: 1, mastery: [], active_days: [] };
          const parsed = JSON.parse(raw) as Partial<LocalStateBlob>;
          if (parsed.schema_version !== 1) return { schema_version: 1, mastery: [], active_days: [] };
          const mastery = Array.isArray(parsed.mastery) ? parsed.mastery : [];
          const active_days = Array.isArray(parsed.active_days) ? parsed.active_days : [];
          memMastery = mastery;
          memDays = active_days;
          return { schema_version: 1, mastery, active_days };
        } catch {
          lsDegraded = true;
          onStorageError?.("Local storage read failed; using temporary session memory.");
          return { schema_version: 1, mastery: [...memMastery], active_days: [...memDays] };
        }
      };

      const writeLs = (blob: LocalStateBlob) => {
        memMastery = [...blob.mastery];
        memDays = [...blob.active_days];
        if (lsDegraded) return;
        try {
          localStorage.setItem(LS_KEY, JSON.stringify(blob));
        } catch {
          lsDegraded = true;
          onStorageError?.("Local storage quota reached; keeping progress in session memory.");
        }
      };

      return {
        mode: "localstorage",
        async loadAll() {
          const b = readLs();
          return { mastery: b.mastery, activeDays: b.active_days };
        },
        async saveMasteryItems(items) {
          const b = readLs();
          writeLs({ ...b, mastery: mergeIntoMemory(b.mastery, items) });
        },
        async saveActiveDay(day) {
          const b = readLs();
          writeLs({ ...b, active_days: upsertDayMemory(b.active_days, day) });
        },
        async replaceAll(mastery, activeDays) {
          writeLs({ schema_version: 1, mastery, active_days: activeDays });
        },
      };
    } catch {
      onStorageError?.("Browser storage unavailable; progress is stored in session memory only.");
      return {
        mode: "memory",
        async loadAll() {
          return { mastery: [...memMastery], activeDays: [...memDays] };
        },
        async saveMasteryItems(items) {
          memMastery = mergeIntoMemory(memMastery, items);
        },
        async saveActiveDay(day) {
          memDays = upsertDayMemory(memDays, day);
        },
        async replaceAll(mastery, activeDays) {
          memMastery = [...mastery];
          memDays = [...activeDays];
        },
      };
    }
  }
}
