/// <reference path="../../pb_data/types.d.ts" />
// The sites server: a second PocketBase on port 8092 (started by start.bat) with its own empty pb_sites/pb_data.
// It serves the static projects published from Media Vault (Sites) out of pb_sites/www/{slug}/ at /{slug}/.
// Being on its own port makes it another origin, so a hosted page can't read the Media Vault login or library.
// It doesn't write the sites: uploads are handled by the main app (pb_hooks/sites.pb.js). The one thing it writes is
// what clients do in a public gallery, into its own database (pubshare_lib.js). Helpers: serve_lib.js.

// Flood protection, before anything else: too many requests from one visitor get a short "slow down" page.
routerUse(new Middleware((e) => {
  const L = require(`${__hooks}/serve_lib.js`);
  if (!L.overLimit(e)) return e.next();
  e.response.header().set("Retry-After", String(L.RATE.window));
  return e.string(429, "Too many requests - wait a few seconds and try again.");
}, -99000, "mediavault_flood"));
cronAdd("floodCounters", "* * * * *", () => {
  require(`${__hooks}/serve_lib.js`).clearOldCounts();
  require(`${__hooks}/sitepage_lib.js`).clearSeen();
});

// Nothing but the sites: no dashboard and no API, apart from the health check the app uses to see it's running and the
// galleries' activity, which only Media Vault on this PC can collect (it needs the key; pubshare_lib.js activity()).
routerUse((e) => {
  const p = e.request.url.path;
  if (p === "/_" || p.startsWith("/_/") || (p.startsWith("/api/") && p !== "/api/health" && p !== "/api/mv/activity" && p !== "/api/mv/sites")) {
    return e.string(404, "Not found");
  }
  return e.next();
});

routerAdd("POST", "/api/mv/activity", (e) => require(`${__hooks}/pubshare_lib.js`).activity(e));
// The sites' views, plays, downloads and key uses, for Media Vault's Sites page (sitepage_lib.js activity()).
routerAdd("POST", "/api/mv/sites", (e) => require(`${__hooks}/sitepage_lib.js`).activity(e));

routerAdd("GET", "/{path...}", (e) => {
  return require(`${__hooks}/serve_lib.js`).serve(e);
});

// The password page of a password-protected site posts back to the address it was shown on; a password-protected
// share link posts to /s/{token}/api/unlock (pubshare_lib.js).
routerAdd("POST", "/{path...}", (e) => {
  const share = /^s\/([a-zA-Z0-9]{24})\/api\/(unlock|pick)$/.exec(e.request.pathValue("path") || "");
  if (share) return require(`${__hooks}/pubshare_lib.js`)[share[2] === "pick" ? "pick" : "unlock"](e, share[1]);
  return require(`${__hooks}/serve_lib.js`).login(e);
});
