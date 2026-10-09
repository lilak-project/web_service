/*
 * Service worker — offline app shell for the portal-served PWA.
 *
 * Registered per-project (script lives at /pp/asset_manager/<project>/sw.js, so
 * its scope is that project only). Strategy:
 *  - navigations: network-first; the last good page is cached as '__shell__' and
 *    served when offline. Redirected responses (portal login) are never cached.
 *  - other GETs (hashed assets, seed/hwpx scripts, icons, CDN fonts):
 *    stale-while-revalidate.
 * Asset data itself lives in localStorage, so a cached shell = a working app.
 */
const CACHE = 'cens-assets-v3'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req)
        // Cache only a real, non-redirected page (not the portal login redirect).
        if (res.ok && !res.redirected) {
          const cache = await caches.open(CACHE)
          cache.put('__shell__', res.clone())
          return res
        }
        // Backend down / project not startable (5xx or the portal's error JSON):
        // serve the cached shell instead of stranding the standalone app on a raw
        // error page. Auth responses (302 login redirect, 401/403) pass through.
        if (res.status >= 500) {
          const cache = await caches.open(CACHE)
          const shell = await cache.match('__shell__')
          if (shell) return shell
        }
        return res
      } catch {
        const cache = await caches.open(CACHE)
        const shell = await cache.match('__shell__')
        return shell || Response.error()
      }
    })())
    return
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    const url = new URL(req.url)
    // Un-hashed same-origin files (hwpx-export.js, template.hwpx, seed, icons)
    // change under the same name on deploy → network-first so clients never run
    // a stale copy; cache is the offline fallback. Hashed bundles (/assets/)
    // and CDN files are immutable → stale-while-revalidate.
    const hashed = url.origin !== self.location.origin || url.pathname.includes('/assets/')
    if (!hashed) {
      try {
        const res = await fetch(req)
        if (res.ok) cache.put(req, res.clone())
        return res
      } catch {
        return (await cache.match(req)) || Response.error()
      }
    }
    const cached = await cache.match(req)
    const network = fetch(req)
      .then((res) => {
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone())
        return res
      })
      .catch(() => null)
    return cached || (await network) || Response.error()
  })())
})
