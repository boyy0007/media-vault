/// <reference path="../pb_data/types.d.ts" />
// The admin dashboard (/_/) and superuser accounts only work on this PC: http://localhost:{port}/_/ (the status
// window's and setup's "Admin dashboard" buttons). From the home network or Tailscale the dashboard isn't there, the
// _superusers collection can't be signed in to, and a superuser token is refused - so a stolen or guessed admin
// password is no use from another device. (Two-step login would need an email server for the codes; this needs none.)
// Requests through `tailscale serve` also come from 127.0.0.1; they're told apart by the Host and X-Forwarded-*
// headers Tailscale sets. The same check guards public site backends (mediavault_guard.pb.js, mv-common.ps1).
routerUse(new Middleware((e) => {
  const h = e.request.header;
  const host = (e.request.host || "").toLowerCase().replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
  const direct = (host === "127.0.0.1" || host === "localhost" || host === "::1") &&
    !h.get("X-Forwarded-For") && !h.get("X-Forwarded-Host") && !h.get("Tailscale-Funnel-Request");
  if (direct) return e.next();

  const path = e.request.url.path;
  if (path === "/_" || path.startsWith("/_/")) {
    return e.html(404, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin dashboard</title><body style="font:15px/1.5 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px">
<h1 style="font-size:20px">The admin dashboard only opens on the Media Vault PC</h1>
<p>Open <b>http://localhost:${require(`${__hooks}/sites_lib.js`).VAULT_PORT}/_/</b> on that PC (the Media Vault window's "Admin dashboard" button).</p></body>`);
  }
  const m = path.match(/^\/api\/collections\/([^/]+)/);
  if (m) {
    const c = decodeURIComponent(m[1]).toLowerCase();
    if (c === "_superusers" || c === $app.findCollectionByNameOrId("_superusers").id.toLowerCase()) throw new NotFoundError();
  }
  for (const t of [(h.get("Authorization") || "").replace(/^Bearer\s+/i, ""), e.request.url.query().get("token")]) {
    if (!t) continue;
    let rec = null;
    try { rec = $app.findAuthRecordByToken(t); } catch (_) {}
    if (rec && rec.isSuperuser()) throw new ForbiddenError("Superusers can only sign in on the Media Vault PC.");
  }
  return e.next();
}, -99999, "mediavault_admin_guard"));
