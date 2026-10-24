/// <reference path="../../pb_data/types.d.ts" />
// Public share links on the sites server (the only part of Media Vault that's on the internet):
// https://{pc}.ts.net/s/{token}/. The main app publishes each one to pb_sites/shares/{token}/ - share.json + f/{files},
// hard links of the originals (publish() in pb_hooks/share_lib.js; keep share.json's format in step) - and takes it
// down when it expires or is turned off. The page is Media Vault's own share page (pb_public/share.html, share.js,
// app.css), which notices it's under /s/{token}/ and asks here instead of /api/share/.
//   /s/{token}/                  the page               /s/{token}/api               what it shows
//   /s/{token}/{share.js|…}      its script, css, icon  /s/{token}/api/file/{id}     a file (?thumb=1, ?poster=1, ?download=1)
//   POST /s/{token}/api/unlock   { password } → the cookie mvp-{token} for /s/{token}/ (password-protected links)
// Client galleries (share.json has gallery) also have
//   /s/{token}/api/file/{id}?web=1   the web-size copy       GET /s/{token}/api/picks?client=   that client's hearts
//   POST /s/{token}/api/pick      { client, name, item, on }
// and the opens, downloads and hearts are counted in this server's own database (gallery_stats / gallery_picks), which
// Media Vault collects with POST /api/mv/activity (activity(), below; pb_hooks/gallery_lib.js sync()). That's the only
// thing this server writes.

const L = () => require(`${__hooks}/serve_lib.js`);
const PASS_DAYS = 30;
const now = () => Math.floor(Date.now() / 1000);
const dir = (token) => $filepath.join(__hooks, "..", "shares", token);
const PAGE = { "": "share.html", "share.js": "share.js", "zip.js": "zip.js", "app.css": "app.css", "icon.svg": "icon.svg" };
const pagesDir = () => $filepath.join(__hooks, "..", "..", "pb_public");

// The published link, or null: not there, taken down, or past its expiry (public links always have one).
function manifest(token) {
  try {
    const m = JSON.parse(toString($os.readFile($filepath.join(dir(token), "share.json"))));
    const exp = Date.parse(String(m.expires || "").replace(" ", "T"));
    return exp > Date.now() ? m : null;
  } catch (_) {
    return null;
  }
}

const passSig = (m, token, exp) => $security.hs256(`pshare|${token}|${exp}`, m.key);
function unlocked(e, token, m) {
  if (!m.pass) return true;
  if (!m.key) return false;
  return L().cookieValues(e, `mvp-${token}`).some((v) => {
    const [exp, sig] = v.split(".");
    return !!sig && +exp > now() && $security.equal(sig, passSig(m, token, exp));
  });
}

const gone = (e) => e.json(404, { message: "This link doesn't exist, has expired, or was turned off by its owner." });

function serveShare(e, token, rest) {
  const h = e.response.header();
  h.set("X-Robots-Tag", "noindex, nofollow");
  h.set("Referrer-Policy", "no-referrer");
  if (rest === "") return e.redirect(302, `/s/${token}/${e.request.url.rawQuery ? "?" + e.request.url.rawQuery : ""}`);
  const p = rest.slice(1);
  if (Object.prototype.hasOwnProperty.call(PAGE, p)) return L().send(e, pagesDir(), [PAGE[p]]);

  const m = manifest(token);
  if (p === "api") {
    h.set("Cache-Control", "no-store");
    if (!m) return gone(e);
    if (!unlocked(e, token, m)) return e.json(401, { locked: true, message: "This link needs a password." });
    bump(token, "views");
    return e.json(200, {
      title: m.title, by: m.by, expires: m.expires, allowDownload: !!m.allowDownload, gallery: m.gallery || null,
      items: (m.items || []).map((it) => ({
        id: it.id, kind: it.kind, title: it.title, name: it.name, width: it.width, height: it.height,
        duration: it.duration, size: it.size, takenAt: it.takenAt, poster: !!it.poster, web: !!it.web, webSize: it.webSize || 0,
      })),
    });
  }
  if (p === "api/picks") {
    h.set("Cache-Control", "no-store");
    if (!m || !m.gallery || !m.gallery.picks || !unlocked(e, token, m)) return gone(e);
    const client = String(e.request.url.query().get("client") || "");
    if (!CLIENT.test(client)) return e.json(200, { items: [] });
    const rows = $app.findRecordsByFilter("gallery_picks", "token = {:t} && client = {:c}", "created", 10000, 0, { t: token, c: client });
    return e.json(200, { items: rows.map((r) => r.getString("item")), name: rows.length ? rows[0].getString("name") : "" });
  }
  const f = /^api\/file\/([a-z0-9]{15})$/.exec(p);
  if (f) {
    if (!m || !unlocked(e, token, m)) return gone(e);
    const it = (m.items || []).find((x) => x.id === f[1]);
    if (!it) return gone(e);
    const q = e.request.url.query();
    const download = !!q.get("download");
    if (download && !m.allowDownload) return e.json(403, { message: "Downloads are turned off for this link." });
    const name = q.get("web") === "1" && it.web ? it.web
      : q.get("poster") === "1" ? it.poster
      : q.get("thumb") === "1" ? it.thumb || (it.kind === "video" || it.poster ? it.poster : it.file)
      : it.file;
    if (!name) return gone(e);
    // Photos and videos show in the page; anything else (and every download) is an attachment, and nothing a
    // file contains can run here (an uploaded .html or .svg would otherwise be a page on the sites' address).
    const type = L().TYPES[$filepath.ext(name).toLowerCase()] || "";
    const media = it.kind !== "file" && /^(image|video|audio)\//.test(type) && type !== "image/svg+xml";
    h.set("Content-Type", media ? type : "application/octet-stream");
    if (download || !media) h.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(it.name || name)}`);
    h.set("Content-Security-Policy", "sandbox; default-src 'none'");
    h.set("X-Content-Type-Options", "nosniff");
    h.set("Cache-Control", "private, max-age=3600");
    if (download) bump(token, "downloads");
    return e.fileFS($os.dirFS($filepath.join(dir(token), "f")), name);
  }
  return L().nothingHere(e);
}

// POST /s/{token}/api/unlock. Wrong tries limited like a site's password page (FAILS in serve_lib.js: per visitor and
// per link; the "fail:" keys are cleared with the flood counters - slug "s" is reserved, so they can't mix with a site's).
function unlock(e, token) {
  const m = manifest(token);
  if (!m) return gone(e);
  if (!m.pass) return e.json(200, { ok: true });
  const F = L().FAILS, store = $app.store(), win = Math.floor(Date.now() / 1000 / F.window);
  const sk = `fail:${win}:s:${token}`, vk = `${sk}:${L().clientIp(e)}`;
  if ((store.get(vk) || 0) >= F.visitor || (store.get(sk) || 0) >= F.site) {
    return e.json(429, { message: "Too many wrong tries. Wait a minute and try again." });
  }
  let got = "";
  try { got = String(e.requestInfo().body["password"] || "").trim(); } catch (_) {}
  if (got && m.key && $security.equal(L().passHash(got, m.pass.salt), m.pass.hash)) {
    const exp = now() + PASS_DAYS * 86400;
    e.response.header().add("Set-Cookie", `mvp-${token}=${exp}.${passSig(m, token, exp)}; Path=/s/${token}/; Max-Age=${PASS_DAYS * 86400}; HttpOnly; SameSite=Lax`
      + (L().isHttps(e) ? "; Secure" : ""));
    return e.json(200, { ok: true });
  }
  if (store.length() < 50000 || store.has(vk)) store.setFunc(vk, (old) => (old || 0) + 1);
  store.setFunc(sk, (old) => (old || 0) + 1);
  sleep(700);
  return e.json(400, { message: "That password isn't right." });
}

// ---------- client galleries: what clients do ----------
const CLIENT = /^[a-z0-9]{16}$/;
const MAX_CLIENTS = 100; // people picking in one gallery

// One more open or download of a link (gallery_stats).
function bump(token, field) {
  for (let i = 0; i < 2; i++) {
    try {
      let r = null;
      try { r = $app.findFirstRecordByData("gallery_stats", "token", token); } catch (_) {}
      if (!r) { r = new Record($app.findCollectionByNameOrId("gallery_stats")); r.set("token", token); }
      r.set(field, r.getInt(field) + 1);
      $app.save(r);
      return;
    } catch (_) {} // (two firsts at once: the unique index refuses one, which tries again)
  }
}

// POST /s/{token}/api/pick { client, name, item, on }: a client hearts a photo (on) or takes it back.
function pick(e, token) {
  const m = manifest(token);
  if (!m || !m.gallery || !m.gallery.picks || !unlocked(e, token, m)) return gone(e);
  let b = {};
  try { b = e.requestInfo().body || {}; } catch (_) {}
  const client = String(b.client || ""), item = String(b.item || ""), name = String(b.name || "").trim().slice(0, 60);
  if (!CLIENT.test(client) || !(m.items || []).some((it) => it.id === item)) return e.json(400, { message: "That photo isn't in this gallery." });
  let row = null;
  try { row = $app.findFirstRecordByFilter("gallery_picks", "token = {:t} && client = {:c} && item = {:i}", { t: token, c: client, i: item }); } catch (_) {}
  if (b.on) {
    if (!row) {
      const known = $app.findRecordsByFilter("gallery_picks", "token = {:t} && client = {:c}", "", 1, 0, { t: token, c: client }).length > 0;
      if (!known) {
        const n = new DynamicModel({ n: 0 });
        $app.db().newQuery("SELECT COUNT(DISTINCT client) AS n FROM gallery_picks WHERE token = {:t}").bind({ t: token }).one(n);
        if (n.n >= MAX_CLIENTS) return e.json(429, { message: "This gallery has as many people picking as it can take. Ask the photographer." });
      }
      row = new Record($app.findCollectionByNameOrId("gallery_picks"));
      row.set("token", token); row.set("client", client); row.set("item", item); row.set("name", name);
      try { $app.save(row); } catch (_) {} // (a double tap: it's there already)
    }
    // The name they typed most recently goes on all their picks.
    if (name) $app.db().newQuery("UPDATE gallery_picks SET name = {:n} WHERE token = {:t} AND client = {:c}").bind({ n: name, t: token, c: client }).execute();
  } else if (row) {
    $app.delete(row);
  }
  return e.json(200, { ok: true });
}

// POST /api/mv/activity { live: [tokens] } - Media Vault itself, every minute (pb_hooks/gallery_lib.js sync()): all
// the counts and picks, after dropping those of links that don't exist any more. Only straight from this PC (not
// through tailscale serve, which adds X-Forwarded-For) and with the key in pb_sites/.sync-key, which only Media Vault
// writes.
function activity(e) {
  let key = "";
  try { key = toString($os.readFile($filepath.join(__hooks, "..", ".sync-key"))).trim(); } catch (_) {}
  const sent = e.request.header.get("X-MV-Key") || "";
  const local = /^(127\.0\.0\.1|::1)$/.test(e.remoteIP()) && !e.request.header.get("X-Forwarded-For");
  if (!local || key.length < 32 || !$security.equal(sent, key)) return e.json(404, { message: "Not found" });
  let live = null;
  try { live = e.requestInfo().body.live; } catch (_) {}
  if (Array.isArray(live) && live.every((t) => /^[a-zA-Z0-9]{24}$/.test(String(t)))) {
    const keep = JSON.stringify(live.map(String));
    for (const tbl of ["gallery_stats", "gallery_picks"]) {
      $app.db().newQuery(`DELETE FROM ${tbl} WHERE token NOT IN (SELECT value FROM json_each({:keep}))`).bind({ keep }).execute();
    }
  }
  return e.json(200, {
    stats: $app.findRecordsByFilter("gallery_stats", "id != ''", "", 100000, 0).map((r) => ({ token: r.getString("token"), views: r.getInt("views"), downloads: r.getInt("downloads") })),
    picks: $app.findRecordsByFilter("gallery_picks", "id != ''", "created", 1000000, 0).map((r) => ({ token: r.getString("token"), client: r.getString("client"), name: r.getString("name"), item: r.getString("item"), created: r.getString("created") })),
  });
}

module.exports = { serveShare, unlock, pick, activity };
