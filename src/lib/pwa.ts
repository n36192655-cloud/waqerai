/**
 * تسجيل Service Worker الخاص بالـApp Shell.
 *
 * التسجيل ممنوع في التطوير وفي معاينة Lovable وداخل iframe، ويوجد مفتاح
 * إيقاف `?sw=off` يلغي التسجيل ويزيله من المتصفح.
 */
const SW_URL = "/sw.js";

function blockedHost(hostname: string): boolean {
  return (
    hostname.startsWith("id-preview--") ||
    hostname.startsWith("preview--") ||
    hostname === "lovableproject.com" ||
    hostname.endsWith(".lovableproject.com") ||
    hostname === "lovableproject-dev.com" ||
    hostname.endsWith(".lovableproject-dev.com") ||
    hostname === "beta.lovable.dev" ||
    hostname.endsWith(".beta.lovable.dev")
  );
}

async function unregisterAppSw() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(
    regs
      .filter((r) => (r.active?.scriptURL ?? r.installing?.scriptURL ?? "").endsWith(SW_URL))
      .map((r) => r.unregister()),
  );
}

/** المسارات الميدانية التي يجب أن تُفتح بعد Refresh دون إنترنت. */
const FIELD_ROUTES = ["/", "/readings"];

const PAGES_CACHE = "mizan-pages";

/**
 * تسخين كاش التنقّل: يجلب نسخة SSR لكل مسار ميداني ويضعها في نفس الكاش الذي
 * يقرأ منه Service Worker (NetworkFirst → cache)، فيصبح Refresh أوفلاين
 * لهذه المسارات مخدوماً محلياً بدل offline.html.
 */
async function warmFieldRoutes(): Promise<void> {
  if (typeof caches === "undefined" || !navigator.onLine) return;
  try {
    const cache = await caches.open(PAGES_CACHE);
    for (const path of FIELD_ROUTES) {
      try {
        const res = await fetch(path, {
          credentials: "same-origin",
          headers: { accept: "text/html" },
        });
        if (res.ok && (res.headers.get("content-type") ?? "").includes("text/html")) {
          await cache.put(path, res.clone());
        }
      } catch {
        /* بلا شبكة أو مسار غير متاح — يُتجاهل بصمت */
      }
    }
  } catch {
    /* الكاش غير متاح — لا يؤثر على التطبيق */
  }
}

export function registerAppServiceWorker(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

  const refused =
    !import.meta.env.PROD ||
    window.self !== window.top ||
    blockedHost(window.location.hostname) ||
    new URL(window.location.href).searchParams.get("sw") === "off";

  if (refused) {
    void unregisterAppSw();
    return;
  }

  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register(SW_URL, { scope: "/" })
      .then(() => navigator.serviceWorker.ready)
      .then(() => warmFieldRoutes())
      .catch((err) => {
        console.warn("[Mizan] service worker registration failed:", err);
      });
  });
}
