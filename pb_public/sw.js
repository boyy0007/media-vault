// Media Vault has no service worker. If an older app on this address registered /sw.js, browsers that still have it
// fetch this as its update, which wipes its caches, unregisters itself and reloads open tabs onto Media Vault.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: "window" })) c.navigate(c.url).catch(() => {});
})()));
