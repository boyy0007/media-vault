/// <reference path="../../pb_data/types.d.ts" />
// How the sites server answers a request. Keep SLUG in step with pb_hooks/sites_lib.js.
//
//   /{slug}             → redirect to /{slug}/ (so relative links work)
//   /{slug}/a/b.css     → the file; folders show their index.html, or a file list if they have none
//   /{slug}/some/route  → no such file and no extension: the site's index.html (single-page apps)
//   /assets/x.js        → asked for by a page of /{slug}/ (root-relative link): redirect to /{slug}/assets/x.js
// Missing files get the site's own 404.html if it has one. Everything is sent with "no-cache", so a new upload
// shows up on the next reload. A site's store page, its pictures and downloads (/{slug}/__mv/…, so a site's own __mv
// folder can't be reached) and keys are sitepage_lib.js's.

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const www = () => $filepath.join(__hooks, "..", "www");

// Set explicitly: on Windows Go asks the registry for these, which sometimes says text/plain for .js
// (and browsers then refuse to run module scripts).
const TYPES = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8", ".json": "application/json", ".map": "application/json",
  ".webmanifest": "application/manifest+json", ".wasm": "application/wasm", ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".bmp": "image/bmp",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".pdf": "application/pdf", ".zip": "application/zip",
  ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
};

function stat(p) {
  try { return $os.stat(p); } catch (_) { return null; }
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const enc = (segs) => segs.map(encodeURIComponent).join("/");
// Path segments that may be served: nothing that climbs out of the site, and no hidden files (.git, .env…).
const segsOk = (segs) => segs.every((s) => s && s !== "." && s !== ".." && !/[\\:\x00-\x1f]/.test(s) && (!s.startsWith(".") || s === ".well-known"));

function serve(e) {
  // PocketBase sends X-Frame-Options: SAMEORIGIN by default; Media Vault shows sites in a frame (another port).
  // frame-ancestors overrides X-Frame-Options, including one a browser cached before this was added (a 304 keeps the
  // cached headers but takes on this one).
  const h = e.response.header();
  h.del("X-Frame-Options");
  h.set("Content-Security-Policy", "frame-ancestors *");
  const raw = e.request.pathValue("path") || "";
  // Public share links (the "s" address is reserved for them in pb_hooks/sites_lib.js).
  const share = /^s\/([a-zA-Z0-9]{24})(\/.*)?$/.exec(raw);
  if (share) return require(`${__hooks}/pubshare_lib.js`).serveShare(e, share[1], share[2] || "");
  const q = e.request.url.rawQuery ? "?" + e.request.url.rawQuery : "";
  const slash = raw.indexOf("/");
  const slug = slash < 0 ? raw : raw.slice(0, slash);
  const site = SLUG.test(slug) ? $filepath.join(www(), slug) : "";
  const st = site ? stat(site) : null;
  if (st && st.isDir()) {
    if (slash < 0) return e.redirect(302, `/${slug}/${q}`);
    const rest = raw.slice(slash + 1);
    const ok = gate(e, slug, rest);
    if (ok !== true) return ok;
    // The store page, its pictures and downloads, and counting plays (sitepage_lib.js).
    const P = require(`${__hooks}/sitepage_lib.js`), a = readAccess()[slug] || {};
    if (rest.startsWith("__mv/")) return P.serveExtra(e, slug, a, rest.slice(5));
    if (rest === "") {
      const pg = P.maybePage(e, slug, a); // (null = the site, else { res }, see gate())
      if (pg) return pg.res;
    }
    if (rest === "" || rest === "index.html") P.countPlay(e, a);
    return serveIn(e, slug, site, rest, q);
  }

  // A root-relative link (/assets/app.js, as Vite and others build by default) from a page of one of the sites.
  const from = refererSite(e);
  if (from && raw) {
    const segs = raw.split("/");
    if (segsOk(segs) && stat($filepath.join(www(), from, ...segs))) return e.redirect(302, `/${from}/${enc(segs)}${q}`);
  }
  if (!raw) {
    const vault = vaultAddress(e);
    if (vault) return e.redirect(302, vault);
    return nothingHere(e);
  }
  return nothingHere(e);
}

// https://{this tailnet name}/ used to be Media Vault itself; it moved to port 8443 when the sites took over 443.
// The Android app (its user agent says MediaVaultApp/) and browsers of signed-in tailnet users (`tailscale serve`
// adds Tailscale-User-Login; Funnel visitors never have it) are sent there. Everyone else gets the plain page.
const VAULT_HTTPS_PORT = 8443;
function vaultAddress(e) {
  const h = e.request.header;
  const host = (h.get("X-Forwarded-Host") || e.request.host || "").split(",")[0].trim().replace(/:443$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/i.test(host)) return "";
  if (!(h.get("User-Agent") || "").includes("MediaVaultApp/") && !h.get("Tailscale-User-Login")) return "";
  return `https://${host}:${VAULT_HTTPS_PORT}/`;
}

// ---------- who may open a site ----------
// pb_sites/access.json, written by the main app (writeAccess() in pb_hooks/sites_lib.js; keep the ticket, cookie
// and hash formats in step): { slug: { mode: "public" | "password" | "private", key, salt, hash, + id, keys, keyDl,
// page for sitepage_lib.js } }. A site that
// isn't in it is private. Getting in sets the cookie mvs-{slug} = "{kind}.{expiry}.{signature}" for /{slug}/ only:
// kind "o" = the owner (from a ticket the app adds as ?__mv=), "p" = typed the password. Changing the access or the
// password in the app makes a new key, which signs everyone out.
const PASS_DAYS = 30;
function readAccess() {
  const store = $app.store();
  try {
    const raw = toString($os.readFile($filepath.join(__hooks, "..", "access.json")));
    const v = JSON.parse(raw);
    store.set("access", raw);
    return v;
  } catch (_) {
    // Being rewritten right now (or not written yet): the last copy read, else nothing (= everything private).
    try { return JSON.parse(store.get("access") || "{}"); } catch (_) { return {}; }
  }
}
const now = () => Math.floor(Date.now() / 1000);
const sign = (key, text) => $security.hs256(text, key);

function passHash(password, salt) {
  let h = salt;
  for (let i = 0; i < 5000; i++) h = $security.hs256(h + password, salt);
  return h;
}

// Every value sent under this name: cookies don't keep ports apart, so a page on another port of this host (e.g. a site
// backend) can set one too, and the browser then sends both - a made-up one mustn't hide the real one.
function cookieValues(e, name) {
  const out = [];
  for (const part of (e.request.header.get("Cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) out.push(part.slice(i + 1).trim());
  }
  return out;
}

// Over https (tailscale serve) the cookie is SameSite=None + Partitioned, so it also works when Media Vault shows the
// site in a frame from another address (the LAN one); plain http can't have that, and gets Lax.
function isHttps(e) {
  const h = e.request.header;
  const host = (h.get("X-Forwarded-Host") || e.request.host || "").split(",")[0].trim();
  return h.get("X-Forwarded-Proto") === "https" || /\.ts\.net(:\d+)?$/i.test(host);
}
function setPass(e, slug, a, kind) {
  const exp = now() + PASS_DAYS * 86400;
  const v = `${kind}.${exp}.${sign(a.key, `pass|${slug}|${kind}|${exp}`)}`;
  e.response.header().add("Set-Cookie", `mvs-${slug}=${v}; Path=/${slug}/; Max-Age=${PASS_DAYS * 86400}; HttpOnly; `
    + (isHttps(e) ? "SameSite=None; Secure; Partitioned" : "SameSite=Lax"));
}

function hasPass(e, slug, a) {
  return cookieValues(e, `mvs-${slug}`).some((v) => {
    const [kind, exp, sig] = v.split(".");
    if (!sig || !(+exp > now()) || !$security.equal(sig, sign(a.key, `pass|${slug}|${kind}|${exp}`))) return false;
    return kind === "o" || (kind === "p" && a.mode === "password");
  });
}

// The query string without the owner's ticket.
function withoutTicket(e) {
  const rest = (e.request.url.rawQuery || "").split("&").filter((p) => p && !p.startsWith("__mv="));
  return rest.length ? "?" + rest.join("&") : "";
}

// true when this request may see the site; otherwise the response to send instead. A key (?key=, then the mvk-{slug}
// cookie; sitepage_lib.js) lets its holder in whatever the access setting.
function gate(e, slug, rest) {
  const a = readAccess()[slug];
  const P = require(`${__hooks}/sitepage_lib.js`);
  // (null = nothing to do, else { res } = what sending the answer returned - e.redirect() and e.html() return nothing
  // useful to test.)
  if (a) {
    const k = P.redeem(e, slug, a, rest);
    if (k) return k.res;
  }
  if (a && a.mode === "public") return true;
  if (a && a.key) {
    const m = /(?:^|&)__mv=(\d+)\.([0-9a-f]+)(?:&|$)/.exec(e.request.url.rawQuery || "");
    if (m && +m[1] > now() && +m[1] < now() + 900 && $security.equal(m[2], sign(a.key, `enter|${slug}|${m[1]}`))) {
      setPass(e, slug, a, "o");
      return e.redirect(302, `/${slug}/${rest}${withoutTicket(e)}`);
    }
    if (hasPass(e, slug, a)) return true;
  }
  if (a && P.heldKey(e, slug, a)) return true;
  if (a && a.mode === "password") return passwordPage(e, 401, "");
  return page(e, 403, "This site is private", "<p>Only its owner can open it. If that's you, open it from Media Vault.</p>");
}

function passwordPage(e, status, error) {
  return page(e, status, "This site is password-protected", `<p>Enter the password to continue.</p>
<form method="post"><input type="password" name="password" required autofocus autocomplete="current-password" aria-label="Password">
<button>Enter</button></form>${error ? `<p class="err">${esc(error)}</p>` : ""}`);
}

// POST /{slug}/… from the password page. At most 10 wrong tries a minute per visitor (clientIp(), so one stranger
// can't lock everyone else out) and 300 per site from everyone together, each one slowed down.
const FAILS = { visitor: 10, site: 300, window: 60 };
function login(e) {
  const raw = e.request.pathValue("path") || "";
  const slug = raw.split("/")[0];
  const a = SLUG.test(slug) ? readAccess()[slug] : null;
  const st = a ? stat($filepath.join(www(), slug)) : null;
  if (!a || a.mode !== "password" || !a.key || !st || !st.isDir() || !raw.includes("/")) return nothingHere(e);
  const back = `/${raw.split("/").map(encodeURIComponent).join("/")}${withoutTicket(e)}`;
  const store = $app.store(), win = Math.floor(Date.now() / 1000 / FAILS.window);
  const vk = `fail:${win}:${slug}:${clientIp(e)}`, sk = `fail:${win}:${slug}`;
  if ((store.get(vk) || 0) >= FAILS.visitor || (store.get(sk) || 0) >= FAILS.site) {
    return passwordPage(e, 429, "Too many wrong tries. Wait a minute and try again.");
  }
  if ($security.equal(passHash(e.request.formValue("password") || "", a.salt), a.hash)) {
    setPass(e, slug, a, "p");
    return e.redirect(303, back);
  }
  if (store.length() < 50000 || store.has(vk)) store.setFunc(vk, (old) => (old || 0) + 1);
  store.setFunc(sk, (old) => (old || 0) + 1);
  sleep(700);
  return passwordPage(e, 401, "That password isn't right.");
}

function refererSite(e) {
  const m = /^https?:\/\/([^/]+)\/([a-z0-9-]+)\//.exec(e.request.header.get("Referer") || "");
  if (!m || m[1] !== e.request.host || !SLUG.test(m[2])) return "";
  const st = stat($filepath.join(www(), m[2]));
  return st && st.isDir() ? m[2] : "";
}

function serveIn(e, slug, site, rest, q) {
  const dirReq = rest === "" || rest.endsWith("/");
  const segs = rest.split("/").filter((s) => s !== "");
  if (!segsOk(segs)) return notFound(e, site);
  const path = segs.length ? $filepath.join(site, ...segs) : site;
  const st = stat(path);
  if (st && st.isDir()) {
    if (!dirReq) return e.redirect(302, `/${slug}/${enc(segs)}/${q}`);
    if (stat($filepath.join(path, "index.html"))) return send(e, site, [...segs, "index.html"]);
    return listing(e, slug, path, segs);
  }
  if (st && !dirReq) return send(e, site, segs);
  // Single-page apps route in the browser: a page address with no file behind it gets the app's index.html.
  const last = segs[segs.length - 1] || "";
  const wantsPage = (e.request.header.get("Accept") || "").includes("text/html");
  if (segs.length && !last.includes(".") && wantsPage && stat($filepath.join(site, "index.html"))) return send(e, site, ["index.html"]);
  return notFound(e, site);
}

function send(e, site, segs) {
  const name = segs.join("/");
  const type = TYPES[$filepath.ext(name).toLowerCase()];
  const h = e.response.header();
  if (type) h.set("Content-Type", type);
  h.set("Cache-Control", "no-cache");
  h.set("X-Content-Type-Options", "nosniff");
  return e.fileFS($os.dirFS(site), name);
}

function notFound(e, site) {
  const own = $filepath.join(site, "404.html");
  if (stat(own)) {
    e.response.header().set("Cache-Control", "no-cache");
    return e.html(404, toString($os.readFile(own)));
  }
  return page(e, 404, "Not found", "<p>This site has no file at this address.</p>");
}

function fmtBytes(n) {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : n) + " " + u[i];
}

// A folder without an index.html: list what's in it.
function listing(e, slug, dir, segs) {
  const items = $os.readDir(dir)
    .filter((d) => !d.name().startsWith("."))
    .map((d) => ({ name: d.name(), dir: d.isDir(), size: d.isDir() ? 0 : d.info().size() }))
    .sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
  if (!items.length && !segs.length) {
    return nothingHere(e);
  }
  const rows = (segs.length ? `<li><a href="../">../</a></li>` : "") + items.map((it) =>
    `<li><a href="${esc(encodeURIComponent(it.name))}${it.dir ? "/" : ""}">${esc(it.name)}${it.dir ? "/" : ""}</a><span>${it.dir ? "" : fmtBytes(it.size)}</span></li>`).join("");
  const where = "/" + [slug, ...segs].join("/") + "/";
  return page(e, 200, where, `<p>No index.html here, so this is the list of files.</p><ul>${rows}</ul>`);
}

// The bare address, an address with no site behind it, and a site with nothing uploaded yet: a plain 404 that
// doesn't say what runs here (the sites can be public).
function nothingHere(e) {
  return page(e, 404, "This page can't be displayed", "<p>Check the address and try again.</p>");
}

function page(e, status, title, body) {
  e.response.header().set("Cache-Control", "no-store");
  return e.html(status, `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
:root { --bg: #0e0f13; --panel: #1a1c23; --text: #eceef3; --muted: #9097a7; --line: #2c303b; --link: #a78bfa; color-scheme: dark; }
@media (prefers-color-scheme: light) { :root { --bg: #f5f6f8; --panel: #fff; --text: #14161b; --muted: #5c6370; --line: #e4e7ec; --link: #6d28d9; color-scheme: light; } }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 720px; margin: 0 auto; padding: 48px 16px; }
h1 { font-size: 20px; margin: 0 0 8px; word-break: break-all; }
p { color: var(--muted); margin: 0 0 20px; }
ul { list-style: none; margin: 0; padding: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
li { display: flex; gap: 12px; justify-content: space-between; padding: 10px 16px; border-top: 1px solid var(--line); }
li:first-child { border-top: 0; }
li span { color: var(--muted); font-size: 13px; white-space: nowrap; }
a { color: var(--link); text-decoration: none; word-break: break-all; }
a:hover { text-decoration: underline; }
form { display: flex; gap: 8px; max-width: 420px; }
input, button { font: inherit; border-radius: 10px; padding: 10px 14px; border: 1px solid var(--line); }
input { flex: 1; min-width: 0; background: var(--panel); color: var(--text); }
input:focus { outline: 2px solid var(--link); outline-offset: -1px; }
button { background: var(--link); color: #fff; border-color: transparent; font-weight: 600; cursor: pointer; }
.err { color: #f87171; margin-top: 14px; }
</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`);
}

// ---------- flood protection ----------
// At most RATE.max requests per RATE.window seconds from one visitor (a page with many files, or a share page
// scrolling through thumbnails, stays well under it). Visitors through Tailscale (Funnel or serve) all arrive from
// 127.0.0.1, so for those it's the address Tailscale adds last to X-Forwarded-For - a visitor can't fake that one,
// anything they send themselves comes before it. Counts live in the app store (shared by every hook VM), one key per
// visitor per window, counted under the store's lock (setFunc) so a burst of parallel requests isn't undercounted; a
// cron clears old windows, and a full store stops counting rather than blocking anyone.
const RATE = { max: 300, window: 10 };
function clientIp(e) {
  const remote = String(e.request.remoteAddr || "").replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
  if (remote === "127.0.0.1" || remote === "::1") {
    const xff = (e.request.header.get("X-Forwarded-For") || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return remote;
}
function overLimit(e) {
  const store = $app.store();
  const key = `rl:${Math.floor(Date.now() / 1000 / RATE.window)}:${clientIp(e)}`;
  if (store.length() >= 50000 && !store.has(key)) return false;
  let n = 0;
  store.setFunc(key, (old) => (n = (old || 0) + 1));
  return n > RATE.max;
}
function clearOldCounts() {
  const store = $app.store(), t = Date.now() / 1000;
  const cur = { rl: Math.floor(t / RATE.window), fail: Math.floor(t / FAILS.window) };
  for (const k of Object.keys(store.getAll())) {
    const m = /^(rl|fail):(\d+):/.exec(k);
    if (m && +m[2] < cur[m[1]]) store.remove(k);
  }
}

module.exports = {
  serve, login, send, nothingHere, page, esc, fmtBytes, cookieValues, passHash, isHttps, clientIp, TYPES, RATE, FAILS, overLimit, clearOldCounts,
};
