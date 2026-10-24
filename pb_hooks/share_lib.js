/// <reference path="../pb_data/types.d.ts" />
// Helpers for share links, loaded with require() from share.pb.js (hook handlers run in isolated
// scopes, so shared code has to live in a module).

const MAX_ITEMS = 5000;

const TOKEN = /^[a-zA-Z0-9]{24}$/;
const MAX_PUBLIC_DAYS = 30;
const MAX_GALLERY_DAYS = 90; // client galleries (shares.gallery) may stay open longer
const isPeople = (share) => share.getStringSlice("recipients").length > 0;
function expired(share) {
  const exp = share.getDateTime("expires");
  return !exp.isZero() && exp.before(new DateTime());
}

// The link share for a token, or null if it doesn't exist or has expired. Shares with people have no link.
function findShare(token) {
  if (!TOKEN.test(token || "")) return null;
  let s;
  try { s = $app.findFirstRecordByData("shares", "token", token); } catch (_) { return null; }
  return expired(s) || isPeople(s) ? null : s;
}

// A share with people that uid is one of, or null.
function findInboxShare(id, uid) {
  let s;
  try { s = $app.findRecordById("shares", id); } catch (_) { return null; }
  return !expired(s) && s.getStringSlice("recipients").includes(uid) ? s : null;
}

// Who a new or changed share is for. Recipients: other people with an account (none = a link). A share with people
// has no password and isn't public; a public link needs an expiry at most MAX_PUBLIC_DAYS away and a public address.
function checkAudience(rec, owner) {
  const ids = [...new Set(rec.getStringSlice("recipients"))].filter((id) => id && id !== owner);
  if (ids.length && $app.findRecordsByIds("users", ids).length !== ids.length) {
    throw new BadRequestError("Someone on that list doesn't have an account here any more.");
  }
  rec.set("recipients", ids);
  rec.set("seenBy", rec.getStringSlice("seenBy").filter((id) => ids.includes(id)));
  // A client gallery is always a public link: no people, on the internet.
  if (rec.getBool("gallery")) {
    if (ids.length) throw new BadRequestError("A client gallery is a link - it can't be shared with people here.");
    rec.set("public", true);
  }
  if (ids.length) {
    rec.set("public", false);
    rec.set("password", "");
  }
  if (rec.getBool("public")) {
    // Only the owner, and people the owner allows (users.allowPublic), put things on the internet.
    let mayPublic = require(`${__hooks}/library_lib.js`).isOwner(owner);
    if (!mayPublic) try { mayPublic = $app.findRecordById("users", owner).getBool("allowPublic"); } catch (_) {}
    if (!mayPublic) throw new ForbiddenError("Public links need the owner's permission. Ask them to turn on public links for you (People).");
    const exp = rec.getDateTime("expires"), days = rec.getBool("gallery") ? MAX_GALLERY_DAYS : MAX_PUBLIC_DAYS;
    if (exp.isZero() || exp.after(new DateTime().addDate(0, 0, days + 1))) {
      throw new BadRequestError(rec.getBool("gallery") ? `A gallery needs an end date, at most ${days} days away.` : `Public links need an expiry date, at most ${days} days away.`);
    }
    if ($app.settings().s3.enabled) throw new BadRequestError("Public links need the files stored on this PC (not on S3).");
    const https = require(`${__hooks}/sites_lib.js`).httpsInfo();
    if (!https || !https.public) {
      throw new BadRequestError("Public links and galleries go out through the sites' address, which isn't public. Turn it on in the Media Vault window: Settings > Hosted sites > Public (Funnel).");
    }
  }
}

// Galleries offer every JPEG/PNG photo at web size too (fits in 2048 x 2048): quicker to look through on a phone and
// small enough to post; the original stays one tap away. Made with PocketBase's own thumbnails.
const WEB_SIZE = "2048x2048f";
const hasWeb = (r) => r.getString("kind") === "image" && /\.(jpe?g|png)$/i.test(r.getString("file"));
const webKey = (r) => `${r.baseFilesPath()}/thumbs_${r.getString("file")}/${WEB_SIZE}_${r.getString("file")}`;

// What a share page shows (/api/share/{token}, /api/inbox/{id}): display fields only, never the owner's email.
// A gallery adds its look: the studio, the welcome message, the cover photo and whether clients can heart photos.
function sharePayload(share) {
  let by = "", studio = "";
  try {
    const u = $app.findRecordById("users", share.getString("owner"));
    by = u.getString("name");
    studio = u.getString("studio");
  } catch (_) {}
  let title = share.getString("title");
  if (!title && share.getString("album")) {
    try { title = $app.findRecordById("albums", share.getString("album")).getString("name"); } catch (_) {}
  }
  const gallery = share.getBool("gallery");
  const recs = shareItems(share);
  const out = {
    title: title || (gallery ? "Your gallery" : "Shared photos"),
    by: gallery ? studio || by : by,
    expires: share.getString("expires"),
    allowDownload: share.getBool("allowDownload"),
    items: recs.map((r) => ({
      id: r.id,
      kind: r.getString("kind"),
      title: r.getString("title") || r.getString("originalName"),
      name: r.getString("originalName"),
      width: r.getInt("width"),
      height: r.getInt("height"),
      duration: r.getFloat("duration"),
      size: r.getInt("size"),
      takenAt: r.getString("takenAt"),
      poster: !!r.getString("poster"),
      web: gallery && hasWeb(r),
    })),
  };
  if (gallery) {
    const cover = share.getString("cover");
    out.gallery = {
      message: share.getString("message"),
      cover: recs.some((r) => r.id === cover) ? cover : (recs.find((r) => r.getString("kind") === "image") || recs[0] || { id: "" }).id,
      picks: share.getBool("allowPicks"),
    };
  }
  return out;
}

// Sends one shared item. ?thumb=1 → 400x400 thumbnail (videos: of the poster), ?poster=1 → video poster,
// ?download=1 → as an attachment (only if the share allows downloads).
function serveMedia(e, share, r) {
  const q = e.request.url.query();
  const thumb = q.get("thumb") === "1";
  if (q.get("download") && !share.getBool("allowDownload")) throw new ForbiddenError("Downloads are turned off for this link.");

  // Raw 360° photos have a poster too (a stitched view), which makes a better thumbnail than two fisheye circles.
  const field = q.get("poster") === "1" || (thumb && (r.getString("kind") === "video" || r.getString("poster"))) ? "poster" : "file";
  const name = r.getString(field);
  if (!name) throw new NotFoundError("Not found.");

  const base = r.baseFilesPath();
  let key = base + "/" + name;
  const fsys = $app.newFilesystem();
  try {
    // ?web=1: a gallery's web-size copy (made the first time it's asked for).
    if (q.get("web") === "1" && field === "file" && share.getBool("gallery") && hasWeb(r)) {
      try {
        if (!fsys.exists(webKey(r))) fsys.createThumb(key, webKey(r), WEB_SIZE);
        key = webKey(r);
      } catch (_) {}
    } else if (thumb && /\.(jpe?g|png|gif|webp)$/i.test(name)) {
      const thumbKey = base + "/thumbs_" + name + "/400x400_" + name;
      try {
        if (!fsys.exists(thumbKey)) fsys.createThumb(key, thumbKey, "400x400");
        key = thumbKey;
      } catch (_) {} // unsupported format etc.: fall back to the original
    }
    e.response.header().set("Cache-Control", "private, max-age=86400");
    fsys.serve(e.response, e.request, key, field === "file" ? r.getString("originalName") || name : name);
  } finally {
    fsys.close();
  }
}

// ---------- password-protected links ----------
// After the right password, the visitor gets the HttpOnly cookie mvshare-{token} = "{expiry}.{signature}" for
// /api/share/{token} (the share's data and files), signed with shares.passKey (replaced when the password changes).
const PASS_DAYS = 30;
const cookieName = (share) => "mvshare-" + share.getString("token");
const passSig = (share, exp) => $security.hs256(`share|${share.getString("token")}|${exp}`, share.getString("passKey"));

function unlocked(e, share) {
  if (!share.getString("password")) return true;
  if (!share.getString("passKey")) return false;
  // Any value sent under the name will do: cookies don't keep ports apart, so a page on another port of this host can
  // set one too, and the browser then sends both.
  for (const part of (e.request.header.get("Cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0 || part.slice(0, i).trim() !== cookieName(share)) continue;
    const [exp, sig] = part.slice(i + 1).trim().split(".");
    if (sig && +exp > Date.now() / 1000 && $security.equal(sig, passSig(share, exp))) return true;
  }
  return false;
}

function setUnlocked(e, share) {
  const exp = Math.floor(Date.now() / 1000) + PASS_DAYS * 86400;
  e.response.header().add("Set-Cookie", `${cookieName(share)}=${exp}.${passSig(share, exp)}; `
    + `Path=/api/share/${share.getString("token")}; Max-Age=${PASS_DAYS * 86400}; HttpOnly; SameSite=Lax`);
}

const inTrash = (r) => !r.getDateTime("trashedAt").isZero();

// Smart album rules → PocketBase filter + params. Keep in sync with smartFilter() in pb_public/app.js.
// rules: { kinds: ["image","video","gif"], favorite, tags: [..] (any of), from/to: "YYYY-MM-DD", text, located }
function smartFilter(rules) {
  const parts = [], params = {};
  const kinds = (rules.kinds || []).filter((k) => ["image", "video", "gif"].includes(k));
  if (kinds.length && kinds.length < 3) {
    parts.push("(" + kinds.map((k, i) => { params["k" + i] = k; return `kind = {:k${i}}`; }).join(" || ") + ")");
  }
  if (rules.favorite) parts.push("favorite = true");
  const tags = (rules.tags || []).map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
  if (tags.length) parts.push("(" + tags.map((t, i) => { params["t" + i] = JSON.stringify(t); return `tags ~ {:t${i}}`; }).join(" || ") + ")");
  if (/^\d{4}-\d\d-\d\d$/.test(rules.from || "")) { params.from = rules.from + " 00:00:00.000Z"; parts.push("takenAt >= {:from}"); }
  if (/^\d{4}-\d\d-\d\d$/.test(rules.to || "")) { params.to = rules.to + " 23:59:59.999Z"; parts.push("takenAt <= {:to}"); }
  if (rules.text) { params.sq = String(rules.text).slice(0, 100); parts.push("(title ~ {:sq} || originalName ~ {:sq})"); }
  if (rules.located) parts.push("lat != 0");
  return { filter: parts.join(" && "), params };
}

// The album's rules if it's a smart album, else null.
function albumRules(albumId) {
  try {
    const raw = $app.findRecordById("albums", albumId).getString("rules");
    const r = raw ? JSON.parse(raw) : null;
    return r && typeof r === "object" && !Array.isArray(r) ? r : null;
  } catch (_) { return null; }
}

// Whether a media record is part of the share (same owner, not in Trash, in the album / item list).
function canSee(share, r) {
  if (r.getString("owner") !== share.getString("owner") || inTrash(r)) return false;
  const album = share.getString("album");
  if (!album) return share.getStringSlice("items").includes(r.id);
  const rules = albumRules(album);
  if (!rules) return r.getStringSlice("albums").includes(album);
  const { filter, params } = smartFilter(rules);
  return $app.findRecordsByFilter("media", "id = {:id}" + (filter ? " && " + filter : ""), "", 1, 0, Object.assign({ id: r.id }, params)).length > 0;
}

// The shared media records, oldest first.
function shareItems(share) {
  const owner = share.getString("owner");
  const album = share.getString("album");
  let recs;
  const rules = album ? albumRules(album) : null;
  if (rules) {
    const { filter, params } = smartFilter(rules);
    recs = $app.findRecordsByFilter("media", "owner = {:owner} && trashedAt = ''" + (filter ? " && " + filter : ""), "takenAt,created", MAX_ITEMS, 0, Object.assign({ owner }, params));
  } else if (album) {
    recs = $app.findRecordsByFilter("media", "owner = {:owner} && albums ~ {:album} && trashedAt = ''", "takenAt,created", MAX_ITEMS, 0, { owner, album });
  } else {
    const ids = share.getStringSlice("items");
    recs = ids.length ? $app.findRecordsByIds("media", ids).filter((r) => canSee(share, r)) : [];
    recs.sort((a, b) => (a.getString("takenAt") || a.getString("created")).localeCompare(b.getString("takenAt") || b.getString("created")));
  }
  return recs;
}

// ---------- public links: a copy for the sites server ----------
// The sites server is the only part that's on the internet, and it can't read this database or pb_data, so a public
// link is published to pb_sites/shares/{token}/: share.json (what pb_sites/pb_hooks/pubshare_lib.js needs; keep the
// two in step) and f/ with the files - hard links into pb_data/storage, so no extra disk space. Kept up to date when
// the share or its items change, and every few minutes by a cron in share.pb.js (smart albums, expiry, clean-up).
const ROOT = () => $filepath.join(__hooks, "..");
const pubRoot = () => $filepath.join(ROOT(), "pb_sites", "shares");
const storagePath = (key) => $filepath.join($app.dataDir(), "storage", ...key.split("/"));
function exists(p) {
  try { $os.stat(p); return true; } catch (_) { return false; }
}

// A hard link when pb_data is inside this folder (it is unless moved); otherwise a copy, for files up to 300 MB.
function linkOrCopy(src, dst) {
  const rs = $filepath.rel(ROOT(), src), rd = $filepath.rel(ROOT(), dst);
  if (!rs.startsWith("..")) {
    try {
      const root = $os.openRoot(ROOT());
      try { root.link(rs, rd); return; } finally { root.close(); }
    } catch (_) {}
  }
  if ($os.stat(src).size() > 300 * 1024 * 1024) throw new Error("couldn't link " + src);
  $os.writeFile(dst, $os.readFile(src), 0o644);
}

// budget: milliseconds to spend making thumbnails and (galleries) web-size copies that aren't there yet; what's left is
// made on later passes (the crons in share.pb.js and gallery.pb.js), and the page uses the original meanwhile.
function publish(share, budget = 4000) {
  const token = share.getString("token");
  if (!TOKEN.test(token)) return;
  const { retry, passHash } = require(`${__hooks}/sites_lib.js`);
  const dir = $filepath.join(pubRoot(), token), fdir = $filepath.join(dir, "f");
  $os.mkdirAll(fdir, 0o755);
  const want = new Set(), items = [];
  const put = (key, as) => {
    want.add(as);
    const dst = $filepath.join(fdir, as);
    if (!exists(dst)) linkOrCopy(storagePath(key), dst);
    return as;
  };
  const payload = sharePayload(share);
  const recs = Object.fromEntries(shareItems(share).map((r) => [r.id, r]));
  const until = Date.now() + budget; // thumbnails not made yet: a few seconds' worth now, the rest by the cron
  const fsys = $app.newFilesystem();
  try {
    for (const it of payload.items) {
      const r = recs[it.id], base = r.baseFilesPath(), file = r.getString("file"), poster = r.getString("poster");
      try {
        it.file = put(`${base}/${file}`, `${r.id}_${file}`);
        it.poster = poster ? put(`${base}/${poster}`, `${r.id}_p_${poster}`) : "";
        it.thumb = "";
        const src = it.kind === "video" || poster ? poster : file; // as serveMedia picks it
        if (src && /\.(jpe?g|png|gif|webp)$/i.test(src)) {
          const tkey = `${base}/thumbs_${src}/400x400_${src}`;
          let ok = fsys.exists(tkey);
          if (!ok && Date.now() < until) {
            try { fsys.createThumb(`${base}/${src}`, tkey, "400x400"); ok = true; } catch (_) {}
          }
          if (ok) it.thumb = put(tkey, `${r.id}_t_${src}`);
        }
        // (Galleries) the web-size copy, and its size for the Download all estimate.
        it.web = ""; it.webSize = 0;
        if (payload.gallery && hasWeb(r)) {
          let ok = fsys.exists(webKey(r));
          if (!ok && Date.now() < until) {
            try { fsys.createThumb(`${base}/${file}`, webKey(r), WEB_SIZE); ok = true; } catch (_) {}
          }
          if (ok) {
            it.web = put(webKey(r), `${r.id}_w_${file}`);
            try { it.webSize = $os.stat($filepath.join(fdir, it.web)).size(); } catch (_) {}
          }
        }
        items.push(it);
      } catch (err) {
        console.log("public link", token, "couldn't publish", r.id, err);
      }
    }
  } finally {
    fsys.close();
  }
  for (const d of $os.readDir(fdir)) {
    if (!want.has(d.name())) try { $os.remove($filepath.join(fdir, d.name())); } catch (_) {}
  }
  const pw = share.getString("password"), salt = $security.randomString(16);
  const manifest = Object.assign(payload, {
    items,
    key: share.getString("passKey"),
    pass: pw ? { salt, hash: passHash(pw, salt) } : null,
  });
  const file = $filepath.join(dir, "share.json");
  $os.writeFile(file + ".tmp", JSON.stringify(manifest), 0o600);
  retry(() => $os.rename(file + ".tmp", file));
}

function unpublish(token) {
  if (!TOKEN.test(token || "")) return;
  const dir = $filepath.join(pubRoot(), token);
  if (exists(dir)) require(`${__hooks}/sites_lib.js`).retry(() => $os.removeAll(dir));
}

// Publishes or takes down one share, as it is now.
function syncPublic(share) {
  if (share.getBool("public") && !isPeople(share) && !expired(share)) publish(share);
  else unpublish(share.getString("token"));
}

// Every public link brought up to date; anything in pb_sites/shares that isn't one any more goes.
function reconcilePublic() {
  const live = new Set();
  for (const s of $app.findRecordsByFilter("shares", "public = true", "", 1000, 0)) {
    if (expired(s) || isPeople(s)) continue;
    live.add(s.getString("token"));
    try { publish(s); } catch (err) { console.log("public link", s.getString("token"), "couldn't publish", err); }
  }
  if (!exists(pubRoot())) return;
  for (const d of $os.readDir(pubRoot())) {
    if (!live.has(d.name())) try { unpublish(d.name()); } catch (_) {}
  }
}

// After an item changed or was deleted: the public links it's in (or may now be in) of its owner. Smart albums are
// left to the cron.
function republishFor(r, albums) {
  for (const s of $app.findRecordsByFilter("shares", "owner = {:o} && public = true", "", 200, 0, { o: r.getString("owner") })) {
    const album = s.getString("album");
    if (album ? !albums.includes(album) : !s.getStringSlice("items").includes(r.id)) continue;
    try { syncPublic(s); } catch (err) { console.log("public link", s.getString("token"), "couldn't publish", err); }
  }
}

module.exports = {
  findShare, findInboxShare, checkAudience, sharePayload, serveMedia, canSee, shareItems, smartFilter, unlocked, setUnlocked,
  syncPublic, unpublish, reconcilePublic, republishFor, isPeople, expired, MAX_ITEMS, MAX_PUBLIC_DAYS,
  MAX_GALLERY_DAYS, publish, pubRoot, linkOrCopy,
};
