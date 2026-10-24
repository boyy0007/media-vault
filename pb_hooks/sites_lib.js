/// <reference path="../pb_data/types.d.ts" />
// Helpers for sites.pb.js: where a site's files live on disk and which names/paths are allowed.
// The sites server (pb_sites/pb_hooks/serve_lib.js) reads the same folders; keep SLUG in step with it.

// The ports in mediavault.json (written by Setup.ps1, read by MediaVault.ps1 to start the servers).
function configPort(key, fallback) {
  try {
    const p = JSON.parse(toString($os.readFile($filepath.join(__hooks, "..", "mediavault.json"))).replace(/^﻿/, ""))[key];
    if (Number.isInteger(p) && p > 0 && p < 65536) return p;
  } catch (_) {}
  return fallback;
}
const PORT = configPort("sitesPort", 8092); // the sites server
const VAULT_PORT = configPort("vaultPort", 8091); // Media Vault itself
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RESERVED = ["api", "s"]; // (/s/{token}/ = public share links, pb_sites/pb_hooks/pubshare_lib.js)

const base = () => $filepath.join(__hooks, "..", "pb_sites");
// Live files: pb_sites/www/{slug}/. An upload goes to pb_sites/staging/{site id}/ first and is swapped in when done.
const liveDir = (slug) => $filepath.join(base(), "www", slug);
const stagingDir = (id) => $filepath.join(base(), "staging", id);

function exists(path) {
  try { $os.stat(path); return true; } catch (_) { return false; }
}

function checkSlug(slug, exceptId) {
  if (!SLUG.test(slug)) throw new BadRequestError("Addresses use lowercase letters, numbers and dashes (up to 40), and can't start or end with a dash.");
  if (RESERVED.includes(slug)) throw new BadRequestError("That address is reserved. Pick another.");
  let other = null;
  try { other = $app.findFirstRecordByData("sites", "slug", slug); } catch (_) {}
  if (other && other.id !== exceptId) throw new BadRequestError("Another site already uses that address.");
}

// A file path inside a site ("css/app.css"), or "" if it isn't allowed: no "..", no absolute paths, nothing Windows
// can't store, and no hidden files or folders (.git, .env…) except .well-known. The app skips those before uploading.
const BAD_CHARS = /[\\:*?"<>|\x00-\x1f]/;
const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
function cleanPath(p) {
  p = String(p || "");
  if (!p || p.length > 400 || p.startsWith("/")) return "";
  const parts = p.split("/");
  for (const s of parts) {
    if (!s || s === "." || s === ".." || BAD_CHARS.test(s) || WIN_RESERVED.test(s) || /[. ]$/.test(s)) return "";
    if (s.startsWith(".") && s !== ".well-known") return "";
  }
  return parts.join("/");
}

// Number of files and their total size under a folder.
function tally(dir) {
  let files = 0, bytes = 0;
  for (const d of $os.readDir(dir)) {
    const p = $filepath.join(dir, d.name());
    if (d.isDir()) {
      const t = tally(p);
      files += t.files;
      bytes += t.bytes;
    } else {
      files++;
      bytes += d.info().size();
    }
  }
  return { files, bytes };
}

// Windows can refuse to rename a folder for a moment while the sites server (or OneDrive, or a virus scanner)
// has a file in it open, so try a few times.
function retry(fn) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (err) {
      if (i >= 4) throw err;
      sleep(150 * (i + 1));
    }
  }
}

// Puts a finished upload live, replacing what was there.
function swapIn(staging, live) {
  const old = $filepath.join(base(), "staging", "old-" + $security.randomString(10));
  const had = exists(live);
  if (had) retry(() => $os.rename(live, old));
  try {
    retry(() => $os.rename(staging, live));
  } catch (err) {
    if (had) try { $os.rename(old, live); } catch (_) {}
    throw err;
  }
  if (had) try { $os.removeAll(old); } catch (_) {}
}

// Each published site is also copied to Media Vault's projects/ folder, so every site is in one place to keep, back up
// or edit (the live files stay in pb_sites/www/). The copy is marked with .mediavault-site.json and only ever replaced
// when it's that site's copy - found by the mark, so it can be renamed or moved within projects/. A folder of the same
// name that isn't one (e.g. a project added from there, with its backend) is left alone and the copy goes next to it.
// Changes made in the copy don't go live; uploading again replaces it.
const projectsDir = () => $filepath.join(__hooks, "..", "projects");
const COPY_MARK = ".mediavault-site.json";
function copyMark(dir) {
  try { return JSON.parse(toString($os.readFile($filepath.join(dir, COPY_MARK)))); } catch (_) { return null; }
}
function findCopy(siteId) {
  if (!exists(projectsDir())) return "";
  for (const d of $os.readDir(projectsDir())) {
    if (!d.isDir() || d.name().startsWith(".")) continue;
    const p = $filepath.join(projectsDir(), d.name());
    const m = copyMark(p);
    if (m && m.site === siteId) return p;
  }
  return "";
}
// Real copies, so editing one never changes the live site; files over 300 MB are hard links (same drive) instead of
// being read into memory.
function copyTree(src, dst) {
  $os.mkdirAll(dst, 0o755);
  for (const d of $os.readDir(src)) {
    const s = $filepath.join(src, d.name()), t = $filepath.join(dst, d.name());
    if (d.isDir()) copyTree(s, t);
    else if (d.info().size() <= 300 * 1024 * 1024) $os.writeFile(t, $os.readFile(s), 0o644);
    else {
      const top = $filepath.join(__hooks, "..");
      const root = $os.openRoot(top);
      try { root.link($filepath.rel(top, s), $filepath.rel(top, t)); } finally { root.close(); }
    }
  }
}
// Returns the copy's folder (relative to Media Vault's folder, e.g. "projects/cubeword"), or "" if there was no room.
function copyToProjects(site) {
  const slug = site.getString("slug");
  const live = liveDir(slug);
  if (!exists(live)) return "";
  let dest = findCopy(site.id);
  if (!dest) {
    const names = [slug, slug + "-site"];
    for (let n = 2; n <= 9; n++) names.push(`${slug}-site-${n}`);
    dest = names.map((n) => $filepath.join(projectsDir(), n)).find((p) => !exists(p)) || "";
    if (!dest) return "";
  }
  $os.mkdirAll(projectsDir(), 0o755);
  const tmp = $filepath.join(projectsDir(), ".mv-copy-" + $security.randomString(8));
  try {
    copyTree(live, tmp);
    $os.writeFile($filepath.join(tmp, COPY_MARK), JSON.stringify({
      site: site.id, name: site.getString("name"), slug, published: new Date().toISOString(),
      note: "A copy of the site as published in Media Vault. Changes here don't go live - upload or add it again to publish. Publishing again replaces this folder.",
    }, null, 2), 0o644);
    if (exists(dest)) {
      const old = $filepath.join(projectsDir(), ".mv-old-" + $security.randomString(8));
      retry(() => $os.rename(dest, old));
      try { retry(() => $os.rename(tmp, dest)); } catch (err) { try { $os.rename(old, dest); } catch (_) {} throw err; }
      try { $os.removeAll(old); } catch (_) {}
    } else retry(() => $os.rename(tmp, dest));
  } catch (err) {
    try { $os.removeAll(tmp); } catch (_) {}
    throw err;
  }
  return "projects/" + $filepath.base(dest);
}

function requireSite(e) {
  require(`${__hooks}/library_lib.js`).requireOwner(e);
  let site = null;
  try { site = $app.findRecordById("sites", e.request.pathValue("id")); } catch (_) {}
  if (!site || site.getString("owner") !== e.auth.id) throw new NotFoundError("Site not found.");
  return site;
}

// ---------- who may open a site (sites.access, see pb_migrations/1800000012_site_access.js) ----------
// The sites server has its own empty database, so it reads pb_sites/access.json (outside www/, never served):
// { slug: { mode, key, salt, hash } }. Rewritten from the sites collection whenever a site changes and at start-up.
// A site missing from it is treated as private. The ticket/hash formats are checked in pb_sites/pb_hooks/serve_lib.js;
// keep them in step.
const ACCESS = ["public", "password", "private"];
const accessOf = (r) => (ACCESS.includes(r.getString("access")) ? r.getString("access") : "public");
const accessFile = () => $filepath.join(base(), "access.json");

function passHash(password, salt) {
  let h = salt;
  for (let i = 0; i < 5000; i++) h = $security.hs256(h + password, salt);
  return h;
}

// Each entry also has the site's id (its activity is counted by id, so renaming keeps it), its keys
// ([{ id, hash: sha256 of the token, max, exp }], see site_keys), keyDl (sites.keyDownloads) and page: what the store
// page shows (null when it's off; pageInfo() below).
function writeAccess() {
  const out = {}, keys = {};
  let all = [];
  try { all = $app.findAllRecords("site_keys"); } catch (_) {} // (the first start after an update runs this before the migration)
  for (const k of all) {
    const exp = Date.parse(k.getString("expires").replace(" ", "T"));
    (keys[k.getString("site")] || (keys[k.getString("site")] = [])).push({
      id: k.id, hash: $security.sha256(k.getString("token")), max: k.getInt("maxUses"), exp: exp > 0 ? Math.floor(exp / 1000) : 0,
    });
  }
  for (const r of $app.findAllRecords("sites")) {
    const mode = accessOf(r), entry = { mode, id: r.id, key: r.getString("accessKey") };
    if (mode !== "public" && !entry.key) continue; // not saved through /api/sites yet: left out, so private
    if (mode === "password") {
      entry.salt = $security.randomString(16);
      entry.hash = passHash(r.getString("password"), entry.salt);
    }
    entry.keys = keys[r.id] || [];
    entry.keyDl = r.getBool("keyDownloads");
    entry.page = pageInfo(r);
    out[r.getString("slug")] = entry;
  }
  const tmp = accessFile() + ".tmp";
  $os.writeFile(tmp, JSON.stringify(out), 0o600);
  retry(() => $os.rename(tmp, accessFile()));
}

// A one-off way in for the owner, valid for 10 minutes: the app opens /{slug}/?__mv={ticket} and the sites server
// swaps it for a cookie.
function ownerTicket(r) {
  const exp = Math.floor(Date.now() / 1000) + 600;
  return `${exp}.${$security.hs256(`enter|${r.getString("slug")}|${exp}`, r.getString("accessKey"))}`;
}

function siteJson(r) {
  return {
    id: r.id,
    name: r.getString("name"),
    slug: r.getString("slug"),
    access: accessOf(r),
    password: r.getString("password"),
    files: r.getInt("files"),
    bytes: r.getInt("bytes"),
    deployedAt: r.getString("deployedAt"),
    created: r.getString("created"),
    page: r.getBool("page"),
    tagline: r.getString("tagline"),
    about: r.getString("about"),
    cover: r.getString("cover"),
    shots: r.getStringSlice("shots"),
    downloads: downloadsOf(r),
    keyDownloads: r.getBool("keyDownloads"),
  };
}

// ---------- store pages (pb_migrations/1800000017_site_pages.js) ----------
// The sites server can't read pb_data, so a site with its page on gets pb_sites/pages/{site id}/: hard links of the
// cover (+ w_{cover}, a 1600-wide copy), the screenshots (+ t_{shot}, 640 wide) and the downloads (dl_{file}), made by
// publishPage() whenever the site is saved and at start-up. pb_sites/pb_hooks/sitepage_lib.js serves them.
const pagesRoot = () => $filepath.join(base(), "pages");
const storagePath = (r, name) => $filepath.join($app.dataDir(), "storage", ...r.baseFilesPath().split("/"), name);
// PocketBase stores "My Game.zip" as "my_game_abc123defg.zip"; people download it under the name it was uploaded as
// (sites.dlNames - a JSON field comes to hooks as raw bytes), or without the suffix.
function dlNames(r) {
  try { const v = JSON.parse(toString(r.get("dlNames")) || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch (_) { return {}; }
}
function downloadsOf(r) {
  const names = dlNames(r);
  return r.getStringSlice("downloads").map((f) => {
    let size = 0;
    try { size = $os.stat(storagePath(r, f)).size(); } catch (_) {}
    return { file: f, name: String(names[f] || f.replace(/_[a-z0-9]{10}(\.[^.]*)?$/i, "$1")), size };
  });
}

function publishPage(r) {
  const dir = $filepath.join(pagesRoot(), r.id);
  if (!r.getBool("page")) {
    if (exists(dir)) retry(() => $os.removeAll(dir));
    return;
  }
  const { linkOrCopy } = require(`${__hooks}/share_lib.js`);
  $os.mkdirAll(dir, 0o755);
  const want = new Set(), b = r.baseFilesPath();
  const put = (src, as) => {
    want.add(as);
    const dst = $filepath.join(dir, as);
    if (!exists(dst)) linkOrCopy(src, dst);
  };
  const fsys = $app.newFilesystem();
  try {
    // A smaller copy for the page (GIFs stay as they are, so they keep moving).
    const smaller = (name, size, prefix) => {
      if (!/\.(jpe?g|png|webp)$/i.test(name)) return;
      const key = `${b}/thumbs_${name}/${size}_${name}`;
      let ok = fsys.exists(key);
      if (!ok) try { fsys.createThumb(`${b}/${name}`, key, size); ok = true; } catch (_) {}
      if (ok) put($filepath.join($app.dataDir(), "storage", ...key.split("/")), prefix + name);
    };
    const cover = r.getString("cover");
    if (cover) { put(storagePath(r, cover), cover); smaller(cover, "1600x0", "w_"); }
    for (const s of r.getStringSlice("shots")) { put(storagePath(r, s), s); smaller(s, "640x0", "t_"); }
    for (const d of r.getStringSlice("downloads")) {
      try { put(storagePath(r, d), "dl_" + d); } catch (err) { console.log("site page", r.getString("slug"), "couldn't publish", d, err); }
    }
  } finally {
    fsys.close();
  }
  for (const d of $os.readDir(dir)) {
    if (!want.has(d.name())) try { $os.remove($filepath.join(dir, d.name())); } catch (_) {}
  }
}

// Every site's page brought up to date; folders of sites that are gone are removed.
function reconcilePages() {
  const ids = new Set();
  for (const r of $app.findAllRecords("sites")) {
    ids.add(r.id);
    try { publishPage(r); } catch (err) { console.log("site page", r.getString("slug"), "couldn't publish", err); }
  }
  if (!exists(pagesRoot())) return;
  for (const d of $os.readDir(pagesRoot())) {
    if (!ids.has(d.name())) try { $os.removeAll($filepath.join(pagesRoot(), d.name())); } catch (_) {}
  }
}

// What the store page shows, for access.json (null = no page). Picture names are the files publishPage() made.
function pageInfo(r) {
  if (!r.getBool("page")) return null;
  const dir = $filepath.join(pagesRoot(), r.id);
  const pick = (small, name) => (exists($filepath.join(dir, small)) ? small : name);
  const cover = r.getString("cover");
  return {
    title: r.getString("name"),
    tagline: r.getString("tagline"),
    about: r.getString("about"),
    updated: r.getString("deployedAt"),
    play: exists($filepath.join(liveDir(r.getString("slug")), "index.html")),
    cover: cover ? { full: cover, wide: pick("w_" + cover, cover) } : null,
    shots: r.getStringSlice("shots").map((s) => ({ full: s, thumb: pick("t_" + s, s) })),
    downloads: downloadsOf(r).map((d) => ({ file: "dl_" + d.file, name: d.name, size: d.size })),
  };
}

// ---------- activity: views, plays, downloads, key uses ----------
// Counted by the sites server in its own database (pb_sites/pb_migrations/1800000002_site_activity.js) and asked for
// here over 127.0.0.1 with the key in pb_sites/.sync-key (gallery_lib.js syncKey()), when the Sites page or a site's
// keys open. It's also told which sites and keys still exist, so the rest is dropped there.
// Returns { stats: { siteId: { all, week, today } }, keys: { keyId: uses } }, or null when it isn't running.
function siteActivity() {
  const { syncKey } = require(`${__hooks}/gallery_lib.js`);
  try {
    const res = $http.send({
      url: `http://127.0.0.1:${PORT}/api/mv/sites`,
      method: "POST",
      body: JSON.stringify({
        sites: $app.findAllRecords("sites").map((r) => r.id),
        keys: (() => { try { return $app.findAllRecords("site_keys").map((k) => k.id); } catch (_) { return []; } })(),
      }),
      headers: { "Content-Type": "application/json", "X-MV-Key": syncKey() },
      timeout: 3,
    });
    return res.statusCode === 200 && res.json ? res.json : null;
  } catch (_) {
    return null;
  }
}

function keyJson(k, uses) {
  return {
    id: k.id, label: k.getString("label"), token: k.getString("token"), maxUses: k.getInt("maxUses"),
    expires: k.getString("expires"), created: k.getString("created"), uses: uses || 0,
  };
}

// The sites' https address from `tailscale serve` (port 443 → PORT; Media Vault itself is on 8443), and whether
// Funnel makes it public: { host, port, public } or null when it isn't set up. Changed from the status window's
// Settings tab (MediaVault.ps1). Asked again at most every 15 seconds (kept as JSON in the app store, which every
// hook VM shares).
const HTTPS_PORT = 443;
const VAULT_HTTPS_PORT = 8443;
// What `tailscale serve` publishes for this machine's current name: [{ host, port, target (local port), public }].
// Only that name: after a rename in Tailscale the old name's entries stay in the serve config but no longer answer
// (MediaVault.ps1's Settings tab offers to clear them).
function serveEntries() {
  const store = $app.store();
  try {
    const c = JSON.parse(store.get("ts.serve") || "null");
    if (c && Date.now() - c.at < 15000) return c.v;
  } catch (_) {}
  const v = [];
  try {
    const win = "C:\\Program Files\\Tailscale\\tailscale.exe";
    const exe = exists(win) ? win : "tailscale";
    const self = String((JSON.parse(toString($os.cmd(exe, "status", "--json").output()) || "{}").Self || {}).DNSName || "").replace(/\.$/, "");
    const st = JSON.parse(toString($os.cmd(exe, "serve", "status", "--json").output()) || "{}");
    for (const [key, web] of Object.entries(st.Web || {})) {
      const m = /^(.+):(\d+)$/.exec(key);
      const proxy = /:(\d+)\/?$/.exec(String((((web || {}).Handlers || {})["/"] || {}).Proxy || ""));
      if (!m || !proxy || (self && m[1] !== self)) continue;
      v.push({ host: m[1], port: +m[2], target: +proxy[1], public: !!(st.AllowFunnel || {})[key] });
    }
  } catch (err) {
    console.log("couldn't read tailscale serve status", err);
  }
  store.set("ts.serve", JSON.stringify({ at: Date.now(), v }));
  return v;
}
function httpsInfo() {
  const e = serveEntries().find((x) => x.port === HTTPS_PORT && x.target === PORT);
  return e ? { host: e.host, port: e.port, public: e.public } : null;
}
// Media Vault's own address on the tailnet (8443 → VAULT_PORT), or "".
function vaultHttps() {
  const e = serveEntries().find((x) => x.port === VAULT_HTTPS_PORT && x.target === VAULT_PORT);
  return e ? `https://${e.host}:${VAULT_HTTPS_PORT}` : "";
}

module.exports = {
  PORT, VAULT_PORT, base, liveDir, stagingDir, exists, checkSlug, cleanPath, tally, swapIn, retry, requireSite, siteJson, httpsInfo,
  vaultHttps, passHash,
  ACCESS, accessOf, writeAccess, ownerTicket, copyToProjects,
  pagesRoot, publishPage, reconcilePages, siteActivity, keyJson, dlNames,
};
