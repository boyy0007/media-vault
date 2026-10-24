/// <reference path="../pb_data/types.d.ts" />
// Client galleries (the Galleries page): public link shares with shares.gallery set - see
// pb_migrations/1800000016_galleries.js. Publishing is share_lib.js's (publish() adds the web-size copies); this is the
// rest: what clients did, and catching up on web-size copies.
//
// The sites server is the part on the internet, so clients' hearts, page opens and downloads land in its own database
// (pb_sites/pb_migrations/1800000001_gallery_activity.js). sync() collects them over 127.0.0.1 with the secret in
// pb_sites/.sync-key (made here, read there: pubshare_lib.js activity()) and copies them into the shares records -
// straight into the table, so the copy doesn't set off the publish hooks. It also tells the sites server which links
// still exist, so a deleted gallery's activity is dropped there too.

const ROOT = () => $filepath.join(__hooks, "..");
const keyFile = () => $filepath.join(ROOT(), "pb_sites", ".sync-key");

function syncKey() {
  try {
    const k = toString($os.readFile(keyFile())).trim();
    if (k.length >= 32) return k;
  } catch (_) {}
  const k = $security.randomString(48);
  $os.writeFile(keyFile(), k, 0o600);
  return k;
}

// shares.picks as a list. (A JSON field comes to hooks as raw bytes, not as the value.)
function picksOf(s) {
  try { const v = JSON.parse(toString(s.get("picks")) || "[]"); return Array.isArray(v) ? v : []; } catch (_) { return []; }
}

// The picks as the app shows them: one entry per client, newest first.
function groupPicks(rows) {
  const by = {};
  for (const p of rows) {
    const c = by[p.client] || (by[p.client] = { client: p.client, name: p.name || "", items: [], at: "" });
    if (p.name) c.name = p.name;
    c.items.push(p.item);
    if (String(p.created) > c.at) c.at = String(p.created);
  }
  return Object.values(by).sort((a, b) => b.at.localeCompare(a.at));
}

// Returns false if the sites server didn't answer (it may be stopped); the counts then stay as they were.
function sync() {
  const { PORT } = require(`${__hooks}/sites_lib.js`);
  const shares = $app.findRecordsByFilter("shares", "public = true", "", 2000, 0);
  let res;
  try {
    res = $http.send({
      url: `http://127.0.0.1:${PORT}/api/mv/activity`,
      method: "POST",
      body: JSON.stringify({ live: shares.map((s) => s.getString("token")) }),
      headers: { "Content-Type": "application/json", "X-MV-Key": syncKey() },
      timeout: 5,
    });
  } catch (_) { return false; }
  if (res.statusCode !== 200 || !res.json) return false;
  const stats = {}, picks = {};
  for (const s of res.json.stats || []) stats[s.token] = s;
  for (const p of res.json.picks || []) (picks[p.token] || (picks[p.token] = [])).push(p);
  for (const s of shares) {
    const t = s.getString("token"), st = stats[t];
    // (A Tailscale-only link counts its own views in share.pb.js; only public ones are counted on the sites server.)
    const views = st ? st.views : s.getInt("views"), downloads = st ? st.downloads : s.getInt("downloads");
    const pk = s.getBool("gallery") ? JSON.stringify(groupPicks(picks[t] || [])) : "[]";
    if (views === s.getInt("views") && downloads === s.getInt("downloads") && pk === JSON.stringify(picksOf(s))) continue;
    $app.db().newQuery("UPDATE shares SET views = {:v}, downloads = {:d}, picks = {:p} WHERE id = {:id}")
      .bind({ v: views, d: downloads, p: pk, id: s.id }).execute();
  }
  return true;
}

// A published gallery's share.json, or null.
function manifest(token) {
  try {
    return JSON.parse(toString($os.readFile($filepath.join(require(`${__hooks}/share_lib.js`).pubRoot(), token, "share.json"))));
  } catch (_) { return null; }
}
// Photos whose thumbnail or web-size copy isn't made yet (the page shows the original meanwhile).
const pendingOf = (m) => (m ? (m.items || []).filter((it) => it.kind === "image" && (!it.thumb || (/\.(jpe?g|png)$/i.test(it.file || "") && !it.web))).length : 0);

// Spends up to budgetMs making the missing ones, gallery by gallery.
function prepare(budgetMs) {
  const L = require(`${__hooks}/share_lib.js`);
  const until = Date.now() + budgetMs;
  for (const s of $app.findRecordsByFilter("shares", "gallery = true && public = true", "-created", 500, 0)) {
    if (Date.now() >= until) return;
    if (L.expired(s) || !pendingOf(manifest(s.getString("token")))) continue;
    try { L.publish(s, until - Date.now()); } catch (err) { console.log("gallery", s.getString("token"), "couldn't publish", err); }
  }
}

module.exports = { sync, prepare, manifest, pendingOf, syncKey, picksOf };
