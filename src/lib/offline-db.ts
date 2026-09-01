/**
 * تخزين دائم للعمل الميداني بدون إنترنت (IndexedDB).
 *
 * لا يوجد اعتماد على حزم خارجية — غلاف صغير حول IndexedDB يوفّر:
 *  - `queue`  : طابور القراءات المؤجلة (المفتاح clientId) مع حالته وعدد المحاولات.
 *  - `blobs`  : صور العدادات كـ Blob دائم (لا يفنى بإغلاق التطبيق).
 *  - `cache`  : لقطة صغيرة من بيانات العمل الميداني (مشتركون/عدادات/آخر قراءة).
 *
 * لا يتم تنزيل قاعدة البيانات كاملة — فقط الحقول اللازمة للقارئ في الميدان.
 */

const DB_NAME = "mizan-offline";
const DB_VERSION = 1;
export const STORE_QUEUE = "queue";
export const STORE_BLOBS = "blobs";
export const STORE_CACHE = "cache";

let dbPromise: Promise<IDBDatabase> | null = null;

export function idbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  if (!idbAvailable()) return Promise.reject(new Error("IndexedDB غير متاح"));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_QUEUE)) db.createObjectStore(STORE_QUEUE, { keyPath: "clientId" });
        if (!db.objectStoreNames.contains(STORE_BLOBS)) db.createObjectStore(STORE_BLOBS);
        if (!db.objectStoreNames.contains(STORE_CACHE)) db.createObjectStore(STORE_CACHE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("تعذّر فتح قاعدة البيانات المحلية"));
    });
  }
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("عملية تخزين محلي فاشلة"));
      }),
  );
}

export async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  try {
    return (await tx<T>(store, "readonly", (s) => s.get(key) as IDBRequest<T>)) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function idbGetAll<T>(store: string): Promise<T[]> {
  try {
    return (await tx<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>)) ?? [];
  } catch {
    return [];
  }
}

export async function idbPut(store: string, value: unknown, key?: IDBValidKey): Promise<void> {
  try {
    await tx(store, "readwrite", (s) => (key === undefined ? s.put(value as never) : s.put(value as never, key)));
  } catch {
    /* المساحة ممتلئة أو الوضع الخاص — غير قاتل */
  }
}

export async function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  try {
    await tx(store, "readwrite", (s) => s.delete(key));
  } catch {
    /* ignore */
  }
}

/** طلب تخزين دائم من المتصفح حتى لا يمسح النظام بيانات الميدان. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

// ─── لقطة بيانات العمل الميداني ─────────────────────────────────────────────
export interface FieldSnapshot<T = unknown> {
  savedAt: string;
  data: T;
}

export async function saveFieldCache<T>(key: string, data: T): Promise<void> {
  await idbPut(STORE_CACHE, { savedAt: new Date().toISOString(), data } satisfies FieldSnapshot<T>, key);
}

export async function readFieldCache<T>(key: string): Promise<FieldSnapshot<T> | undefined> {
  return idbGet<FieldSnapshot<T>>(STORE_CACHE, key);
}

// ─── مسودة القراءة الجارية (لا تضيع عند إعادة تحميل الصفحة أو إغلاقها) ──────
export interface ReadingDraft {
  customerId: string | null;
  meterId: string | null;
  current: string;
  readingDate: string;
  lat?: number;
  lng?: number;
  accuracy?: number;
  hasPhoto?: boolean;
  photoType?: string;
  savedAt: string;
}

const draftKey = (tenantId: string) => `draft:reading:${tenantId}`;
const draftBlobKey = (tenantId: string) => `draft-photo:${tenantId}`;

export async function saveReadingDraft(
  tenantId: string,
  draft: Omit<ReadingDraft, "savedAt">,
  photo?: Blob | null,
): Promise<void> {
  await idbPut(STORE_CACHE, { ...draft, savedAt: new Date().toISOString() } satisfies ReadingDraft, draftKey(tenantId));
  if (photo) await idbPut(STORE_BLOBS, photo, draftBlobKey(tenantId));
  else await idbDelete(STORE_BLOBS, draftBlobKey(tenantId));
}

export async function readReadingDraft(
  tenantId: string,
): Promise<{ draft: ReadingDraft; photo?: Blob } | undefined> {
  const draft = await idbGet<ReadingDraft>(STORE_CACHE, draftKey(tenantId));
  if (!draft) return undefined;
  const photo = draft.hasPhoto ? await idbGet<Blob>(STORE_BLOBS, draftBlobKey(tenantId)) : undefined;
  return { draft, photo };
}

export async function clearReadingDraft(tenantId: string): Promise<void> {
  await idbDelete(STORE_CACHE, draftKey(tenantId));
  await idbDelete(STORE_BLOBS, draftBlobKey(tenantId));
}
