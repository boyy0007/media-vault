/// <reference path="../pb_data/types.d.ts" />
// Client galleries: the Galleries page's data, and the minute-by-minute catch-up. Helpers: gallery_lib.js. Making,
// changing and deleting a gallery go through the shares collection like any share (share.pb.js); the gallery fields
// are in pb_migrations/1800000016_galleries.js.

// Every minute: what clients did (hearts, opens, downloads) comes over from the sites server, and web-size copies that
// weren't ready get made (up to 40 seconds of work, so the next run doesn't start before this one ends).
cronAdd("galleries", "* * * * *", () => {
  const G = require(`${__hooks}/gallery_lib.js`);
  try { G.sync(); } catch (err) { console.log("couldn't sync gallery activity", err); }
  try { G.prepare(40000); } catch (err) { console.log("couldn't prepare galleries", err); }
});
onBootstrap((e) => {
  e.next();
  try { require(`${__hooks}/gallery_lib.js`).syncKey(); } catch (err) { console.log("couldn't make the gallery sync key", err); }
});

// The signed-in person's galleries, newest first, with what the cards need: the cover photo's file, how many photos,
// the counts and picks (fresh from the sites server first), and how many web-size copies are still being made.
routerAdd("GET", "/api/galleries", (e) => {
  const G = require(`${__hooks}/gallery_lib.js`), L = require(`${__hooks}/share_lib.js`);
  try { G.sync(); } catch (_) {}
  const out = [];
  for (const s of $app.findRecordsByFilter("shares", "owner = {:o} && gallery = true", "-created", 500, 0, { o: e.auth.id })) {
    const items = L.shareItems(s);
    const coverId = s.getString("cover");
    const c = items.find((r) => r.id === coverId) || items.find((r) => r.getString("kind") === "image") || items[0];
    let albumName = "";
    if (s.getString("album")) try { albumName = $app.findRecordById("albums", s.getString("album")).getString("name"); } catch (_) {}
    const m = s.getBool("public") && !L.expired(s) ? G.manifest(s.getString("token")) : null;
    out.push({
      id: s.id, token: s.getString("token"), title: s.getString("title"), message: s.getString("message"),
      album: s.getString("album"), albumName, count: items.length, public: s.getBool("public"),
      password: s.getString("password"), expires: s.getString("expires"), created: s.getString("created"),
      allowDownload: s.getBool("allowDownload"), allowPicks: s.getBool("allowPicks"),
      views: s.getInt("views"), downloads: s.getInt("downloads"), picks: G.picksOf(s),
      cover: c ? { id: c.id, kind: c.getString("kind"), file: c.getString("file"), poster: c.getString("poster") } : null,
      live: !!m, pending: G.pendingOf(m),
    });
  }
  return e.json(200, out);
}, $apis.requireAuth("users"));

// One gallery's photos (first 300), for choosing the cover in the app: [{ id, kind, file, poster }].
routerAdd("GET", "/api/galleries/{id}/photos", (e) => {
  let s;
  try { s = $app.findRecordById("shares", e.request.pathValue("id")); } catch (_) {}
  if (!s || s.getString("owner") !== e.auth.id || !s.getBool("gallery")) throw new NotFoundError("Gallery not found.");
  return e.json(200, require(`${__hooks}/share_lib.js`).shareItems(s).filter((r) => r.getString("kind") !== "file").slice(0, 300)
    .map((r) => ({ id: r.id, kind: r.getString("kind"), file: r.getString("file"), poster: r.getString("poster") })));
}, $apis.requireAuth("users"));

// One gallery's picks with the photos' details, for the Favorites window: [{ client, name, at, items: [...] }].
routerAdd("GET", "/api/galleries/{id}/picks", (e) => {
  let s;
  try { s = $app.findRecordById("shares", e.request.pathValue("id")); } catch (_) {}
  if (!s || s.getString("owner") !== e.auth.id || !s.getBool("gallery")) throw new NotFoundError("Gallery not found.");
  const G = require(`${__hooks}/gallery_lib.js`);
  try { G.sync(); s = $app.findRecordById("shares", s.id); } catch (_) {}
  const picks = G.picksOf(s);
  const ids = [...new Set(picks.flatMap((p) => p.items || []))];
  const recs = Object.fromEntries((ids.length ? $app.findRecordsByIds("media", ids) : []).filter((r) => r.getString("owner") === e.auth.id).map((r) => [r.id, r]));
  return e.json(200, picks.map((p) => ({
    client: p.client, name: p.name, at: p.at,
    items: (p.items || []).filter((id) => recs[id]).map((id) => {
      const r = recs[id];
      return { id, kind: r.getString("kind"), file: r.getString("file"), poster: r.getString("poster"), name: r.getString("originalName") || r.getString("title") };
    }),
  })));
}, $apis.requireAuth("users"));
