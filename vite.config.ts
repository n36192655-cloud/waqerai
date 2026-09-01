// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    plugins: [
      // App Shell أوفلاين للعمل الميداني — التسجيل يتم فقط من src/lib/pwa.ts
      // (لا تسجيل في المعاينة أو التطوير).
      VitePWA({
        strategies: "generateSW",
        registerType: "autoUpdate",
        injectRegister: null,
        filename: "sw.js",
        manifest: false,
        // مخرجات عميل TanStack Start تذهب إلى dist/client — يجب أن يُخدَم /sw.js من هناك.
        outDir: "dist/client",
        devOptions: { enabled: false },
        workbox: {
          globPatterns: ["**/*.{js,css,woff2,png,svg,ico,html}"],
          // مهم: لا نستخدم navigateFallback هنا. في generateSW يُسجَّل NavigationRoute
          // الخاص به قبل runtimeCaching، فيبتلع كل تنقّل أوفلاين ويعرض offline.html
          // حتى لو كانت نسخة الصفحة محفوظة. بدلاً من ذلك نتعامل مع التنقّل عبر
          // NetworkFirst أدناه، وoffline.html يبقى fallback أخيراً فقط.
          // "" يمنع vite-plugin-pwa من حقن navigateFallback الافتراضي (index.html)
          // وهو غير موجود أصلاً في تطبيق SSR.
          navigateFallback: "",
          additionalManifestEntries: [{ url: "/offline.html", revision: null }],
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          skipWaiting: true,
          runtimeCaching: [
            {
              urlPattern: ({ request, url, sameOrigin }) =>
                request.mode === "navigate" &&
                !!sameOrigin &&
                !url.pathname.startsWith("/api/") &&
                !url.pathname.startsWith("/~oauth"),
              handler: "NetworkFirst",
              options: {
                cacheName: "mizan-pages",
                networkTimeoutSeconds: 5,
                expiration: { maxEntries: 50 },
                cacheableResponse: { statuses: [200] },
                matchOptions: { ignoreVary: true },
                plugins: [
                  {
                    // لا توجد نسخة محفوظة لهذا المسار ولا شبكة → offline.html.
                    handlerDidError: async () =>
                      (await caches.match("/offline.html", { ignoreSearch: true })) ??
                      Response.error(),
                  },
                ],
              },
            },
            {
              urlPattern: ({ url, sameOrigin }) =>
                sameOrigin && /\.(?:js|css|woff2|png|svg|ico)$/.test(url.pathname),
              handler: "CacheFirst",
              options: {
                cacheName: "mizan-assets",
                expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
              },
            },
          ],
        },
      }),
    ],
  },
});
