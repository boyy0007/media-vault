/// <reference path="../pb_data/types.d.ts" />
// The app's own files (pb_public: index.html, app.js, the modules it imports…) are sent with "no-cache", so a
// browser or the Android WebView always checks for a newer copy (a cheap 304 when nothing changed) instead of
// guessing how long to keep one and running stale code after an update. API routes and uploaded files
// (/api/files/…, which never change under the same name) keep their own caching; routes that set their own
// Cache-Control (share pages) override this.
routerUse((e) => {
  const p = e.request.url.path;
  if (!p.startsWith("/api/") && p !== "/_" && !p.startsWith("/_/")) e.response.header().set("Cache-Control", "no-cache");
  return e.next();
});
