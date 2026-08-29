import { useCallback, useEffect, useState } from "react";
import { useStore } from "./store";
import { supabase } from "./supabase";
import { toast } from "sonner";
import type { Database } from "@/integrations/supabase/types";
import {
  STORE_BLOBS,
  STORE_QUEUE,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
  requestPersistentStorage,
} from "./offline-db";

type ReadingInsert = Database["public"]["Tables"]["water_readings"]["Insert"];

const PHOTO_BUCKET = "meter-readings";

/** حالات العنصر في طابور المزامنة — تُعرض للمستخدم كما هي. */
export type QueueStatus = "pending" | "syncing" | "synced" | "failed";

/**
 * قراءة ميدانية مؤجلة. تُخزَّن في IndexedDB (دائمة عبر إغلاق التطبيق) مع
 * صورة العداد كـ Blob منفصل. `clientId` يُرسل كـ `client_uuid` وهو UNIQUE
 * لكل مؤسسة — أي إعادة مزامنة لا تُنشئ تكراراً.
 */
export interface PendingReading {
  clientId: string;
  /** customer uuid */
  customerId: string;
  /** meters.id uuid */
  meterId: string;
  meterNumber: string;
  current: number;
  readingDate?: string;
  createdAt: string;
  by?: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  tenantId?: string;
  /** توجد صورة عداد محفوظة محلياً لهذا العنصر. */
  hasPhoto?: boolean;
  photoType?: string;
  /** مسار الصورة بعد رفعها بنجاح (يمنع إعادة الرفع عند إعادة المحاولة). */
  photoPath?: string;
  status: QueueStatus;
  attempts: number;
  lastError?: string;
  lastAttemptAt?: string;
  syncedAt?: string;
}

const LEGACY_KEY = "mizan-pending-readings-v3";
const EVENT = "mizan-pending-updated";

function notify() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

/** ترحيل الطابور القديم (localStorage) إلى التخزين الدائم مرة واحدة. */
async function migrateLegacy(): Promise<void> {
  if (typeof window === "undefined") return;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(LEGACY_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const old = JSON.parse(raw) as Partial<PendingReading>[];
    for (const p of old) {
      if (!p?.clientId) continue;
      const existing = await idbGet<PendingReading>(STORE_QUEUE, p.clientId);
      if (existing) continue;
      await idbPut(STORE_QUEUE, {
        ...p,
        status: "pending",
        attempts: 0,
        createdAt: p.createdAt ?? new Date().toISOString(),
      } as PendingReading);
    }
  } catch {
    /* بيانات تالفة — تُتجاهل */
  }
  try {
    window.localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
  notify();
}

let migrated: Promise<void> | null = null;
function ensureMigrated(): Promise<void> {
  if (!migrated) migrated = migrateLegacy();
  return migrated;
}

export async function getPending(): Promise<PendingReading[]> {
  await ensureMigrated();
  const all = await idbGetAll<PendingReading>(STORE_QUEUE);
  return all.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

/** العناصر التي ما زالت بحاجة إلى مزامنة. */
export function isUnsynced(p: PendingReading): boolean {
  return p.status !== "synced";
}

export async function addPending(
  p: Omit<PendingReading, "clientId" | "createdAt" | "status" | "attempts"> & { clientId?: string },
  photo?: Blob | null,
): Promise<PendingReading> {
  await ensureMigrated();
  void requestPersistentStorage();
  const clientId = p.clientId ?? `${crypto.randomUUID()}`;
  const item: PendingReading = {
    ...p,
    clientId,
    createdAt: new Date().toISOString(),
    status: "pending",
    attempts: 0,
    hasPhoto: !!photo,
    photoType: photo?.type,
  };
  if (photo) await idbPut(STORE_BLOBS, photo, clientId);
  await idbPut(STORE_QUEUE, item);
  notify();
  return item;
}

export async function removePending(clientId: string): Promise<void> {
  await idbDelete(STORE_QUEUE, clientId);
  await idbDelete(STORE_BLOBS, clientId);
  notify();
}

/** إعادة محاولة يدوية لعنصر فاشل — يعيده إلى الطابور فوراً دون انتظار المهلة. */
export async function retryPending(clientId: string): Promise<void> {
  const item = await idbGet<PendingReading>(STORE_QUEUE, clientId);
  if (!item || item.status === "synced") return;
  await idbPut(STORE_QUEUE, { ...item, status: "pending", lastError: undefined, lastAttemptAt: undefined });
  notify();
  await syncPending(true);
}

export async function getPendingPhoto(clientId: string): Promise<Blob | undefined> {
  return idbGet<Blob>(STORE_BLOBS, clientId);
}

async function setStatus(item: PendingReading, patch: Partial<PendingReading>) {
  await idbPut(STORE_QUEUE, { ...item, ...patch });
  notify();
}

/** مهلة تصاعدية بين المحاولات الفاشلة (30ث، 1د، 2د … بحد أقصى 15د). */
function readyForRetry(p: PendingReading): boolean {
  if (p.status === "synced") return false;
  if (p.status !== "failed" || !p.lastAttemptAt) return true;
  const wait = Math.min(15 * 60_000, 30_000 * 2 ** Math.min(p.attempts, 5));
  return Date.now() - +new Date(p.lastAttemptAt) >= wait;
}

/**
 * فشل ناتج عن انقطاع الشبكة (وليس رفضاً من الخادم) — عندها تُحفظ العملية
 * محلياً بدل اعتبارها خطأً نهائياً. `navigator.onLine` وحده غير كافٍ.
 */
export function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  const msg = (e instanceof Error ? e.message : String(e ?? "")).toLowerCase();
  return (
    e instanceof TypeError ||
    msg.includes("failed to fetch") ||
    msg.includes("network") ||
    msg.includes("networkerror") ||
    msg.includes("load failed") ||
    msg.includes("timeout") ||
    msg.includes("aborted")
  );
}

let syncing = false;


export async function syncPending(force = false): Promise<{ synced: number; failed: number }> {
  if (syncing) return { synced: 0, failed: 0 };
  if (typeof navigator !== "undefined" && !navigator.onLine) return { synced: 0, failed: 0 };
  syncing = true;
  try {
    const list = (await getPending()).filter((p) => isUnsynced(p) && (force || readyForRetry(p)));
    if (!list.length) return { synced: 0, failed: 0 };

    let synced = 0;
    let failed = 0;

    for (const p of list) {
      await setStatus(p, { status: "syncing" });
      try {
        let tenantId = p.tenantId ?? null;
        if (!tenantId) {
          const { data: tenantRow } = await supabase.rpc("current_tenant_id");
          tenantId = (tenantRow as unknown as string | null);
        }
        if (!tenantId) throw new Error("تعذّر تحديد المؤسسة الحالية");

        // 1) رفع صورة العداد المحفوظة محلياً (مرة واحدة فقط لكل عنصر).
        let photoPath = p.photoPath ?? null;
        if (!photoPath && p.hasPhoto) {
          const blob = await getPendingPhoto(p.clientId);
          if (blob) {
            const path = `tenants/${tenantId}/readings/${p.clientId}.jpg`;
            const up = await supabase.storage
              .from(PHOTO_BUCKET)
              .upload(path, blob, { contentType: blob.type || "image/jpeg", upsert: true });
            if (up.error) throw new Error(`رفع الصورة فشل: ${up.error.message}`);
            photoPath = path;
            await setStatus(p, { status: "syncing", photoPath });
          }
        }

        // 2) إدراج القراءة — client_uuid يمنع التكرار على مستوى قاعدة البيانات.
        const { error } = await supabase.from("water_readings").insert({
          tenant_id: tenantId,
          customer_id: p.customerId,
          meter_id: p.meterId,
          current_reading: p.current,
          reading_date: p.readingDate,
          client_uuid: p.clientId,
          reader_id: p.by,
          photo_url: photoPath,
          lat: p.latitude ?? null,
          lng: p.longitude ?? null,
          accuracy: p.accuracy ?? null,
          gps_verified: p.latitude != null,
        } as ReadingInsert);

        // 23505 = مسجلة مسبقاً بنفس client_uuid → العنصر منتهٍ فعلاً.
        if (error && error.code !== "23505") throw new Error(error.message);

        await setStatus(p, {
          status: "synced",
          photoPath: photoPath ?? undefined,
          syncedAt: new Date().toISOString(),
          lastError: undefined,
        });
        await idbDelete(STORE_BLOBS, p.clientId);
        synced++;

        if (p.tenantId) {
          void broadcastTenantEvent(p.tenantId, "reading", {
            customerId: p.customerId,
            meterNumber: p.meterNumber,
            current: p.current,
            by: p.by,
            at: new Date().toISOString(),
          });
        }
      } catch (e) {
        failed++;
        await setStatus(p, {
          status: "failed",
          attempts: p.attempts + 1,
          lastAttemptAt: new Date().toISOString(),
          lastError: (e as Error).message,
        });
      }
    }

    await pruneSynced();
    if (synced > 0) {
      // فشل التحديث من السحابة لا يمس الطابور ولا اللقطة المحلية.
      void useStore.getState().hydrateFromSupabase().catch((err) => {
        console.warn("[Mizan] hydrate after sync failed (offline data kept):", err);
      });
    }
    return { synced, failed };
  } finally {
    syncing = false;
  }
}

/** حذف العناصر المزامنة بعد 24 ساعة (تبقى ظاهرة للمستخدم كإثبات قبل ذلك). */
async function pruneSynced() {
  const all = await idbGetAll<PendingReading>(STORE_QUEUE);
  const cutoff = Date.now() - 24 * 60 * 60_000;
  for (const p of all) {
    if (p.status === "synced" && p.syncedAt && +new Date(p.syncedAt) < cutoff) {
      await removePending(p.clientId);
    }
  }
}

// ─── Supabase Realtime broadcast ────────────────────────────────────────────
// Cheap tenant-scoped broadcasts (no DB write per message). Managers and
// collectors listening to `tenant:<id>` receive updates instantly.
export type TenantEventType = "reading" | "bill" | "payment";

export async function broadcastTenantEvent(
  tenantId: string,
  type: TenantEventType,
  payload: Record<string, unknown>,
) {
  try {
    const channel = supabase.channel(`tenant:${tenantId}`);
    await channel.subscribe();
    await channel.send({ type: "broadcast", event: type, payload });
    await supabase.removeChannel(channel);
  } catch (err) {
    console.warn("[Mizan] broadcast failed:", err);
  }
}

export function subscribeToTenantEvents(
  tenantId: string,
  onEvent: (type: TenantEventType, payload: Record<string, unknown>) => void,
) {
  const channel = supabase.channel(`tenant:${tenantId}`);
  (["reading", "bill", "payment"] as const).forEach((event) => {
    channel.on("broadcast", { event }, (msg) =>
      onEvent(event, (msg.payload ?? {}) as Record<string, unknown>),
    );
  });
  channel.subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}

export function useOnlineStatus() {
  const [online, setOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );

  useEffect(() => {
    const on = () => {
      setOnline(true);
      setTimeout(() => {
        void syncPending(true).then((result) => {
          if (result.synced > 0) {
            toast.success(`تمت مزامنة ${result.synced} قراءة مؤجلة`);
          }
        });
      }, 1000);
    };
    const off = () => setOnline(false);
    // إعادة المحاولة أيضاً عند عودة التطبيق للواجهة وبشكل دوري — قد يعود
    // الاتصال دون إطلاق حدث online (تغيّر شبكة، خروج من وضع الطيران…).
    const retry = () => {
      if (!navigator.onLine) return;
      setOnline(true);
      void syncPending().then((r) => {
        if (r.synced > 0) toast.success(`تمت مزامنة ${r.synced} قراءة مؤجلة`);
      });
    };
    const onVisible = () => { if (document.visibilityState === "visible") retry(); };
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", retry);
    const timer = setInterval(retry, 60_000);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", retry);
      clearInterval(timer);
    };

  }, []);

  return online;
}

/** الطابور الحيّ للواجهة مع تحديث فوري عند أي تغيير. */
export function useOfflineQueue() {
  const [items, setItems] = useState<PendingReading[]>([]);
  const refresh = useCallback(() => {
    void getPending().then(setItems);
  }, []);
  useEffect(() => {
    refresh();
    window.addEventListener(EVENT, refresh);
    window.addEventListener("storage", refresh);
    const t = setInterval(refresh, 5000);
    return () => {
      window.removeEventListener(EVENT, refresh);
      window.removeEventListener("storage", refresh);
      clearInterval(t);
    };
  }, [refresh]);
  return { items, refresh };
}

export function usePendingCount() {
  const { items } = useOfflineQueue();
  return items.filter(isUnsynced).length;
}
