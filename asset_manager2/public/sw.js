/*
 * Kill switch — NOT an app shell.
 *
 * asset_manager2 started life as a copy of asset_manager, which registers a
 * PWA worker at `sw.js` relative to the portal base. Anyone who opened the
 * service in those first minutes still has that worker installed with scope
 * /pp/asset_manager2/<project>/, serving the app stale-while-revalidate: they
 * keep running whatever bundle was cached that day, so neither a rebuild nor a
 * no-store header on index.html can reach them.
 *
 * A worker is only replaced by another worker, and the SPA fallback was handing
 * the browser index.html for sw.js — HTML is not a module, so the install
 * failed and the old worker stayed forever. This file is the replacement that
 * empties the caches and unregisters itself. Keep it: the next person to open
 * a stale tab still needs it. It has no fetch handler, so once it is gone the
 * network is the network again.
 */
self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.map((k) => caches.delete(k)))
    await self.registration.unregister()
    const windows = await self.clients.matchAll({ type: 'window' })
    windows.forEach((c) => c.navigate(c.url))
  })())
})
