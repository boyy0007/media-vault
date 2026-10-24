/// <reference path="../pb_data/types.d.ts" />
// Sharing. Helpers: share_lib.js. A share is one album or a set of items, and goes to either
//   - a link: anyone with it, at /s/{token} on Media Vault's own address (pb_public/share.html); if `public`, also on
//     the internet through the sites server at https://{pc}.ts.net/s/{token}/ (a copy: publish() in share_lib.js), or
//   - people with an account here (`recipients`): it shows under "Shared with me" in their app (/api/inbox).

// A share must point at the creator's own album, or at a non-empty list of their own items.
onRecordCreateRequest((e) => {
  const { checkAudience } = require(`${__hooks}/share_lib.js`);
  const owner = e.auth ? e.auth.id : "";
  const album = e.record.getString("album");
  const items = e.record.getStringSlice("items");
  if (album) {
    let a = null;
    try { a = $app.findRecordById("albums", album); } catch (_) {}
    if (!a || a.getString("owner") !== owner) throw new BadRequestError("Album not found.");
    e.record.set("items", []);
  } else {
    if (!items.length) throw new BadRequestError("Pick something to share.");
    const recs = $app.findRecordsByIds("media", items);
    if (recs.length !== items.length || recs.some((r) => r.getString("owner") !== owner)) {
      throw new BadRequestError("Some of those items can't be shared.");
    }
  }
  e.record.set("views", 0);
  e.record.set("downloads", 0); // (and picks: counted by the sites server, see gallery_lib.js)
  e.record.set("picks", []);
  e.record.set("password", e.record.getString("password").trim());
  e.record.set("passKey", $security.randomString(40));
  checkAudience(e.record, owner);
  e.next();
}, "shares");

// A new password (or none) locks out everyone who typed the old one. passKey is never taken from the request.
onRecordUpdateRequest((e) => {
  const before = e.record.original();
  e.record.set("gallery", before.getBool("gallery")); // (a gallery stays one, and a share stays a share)
  e.record.set("password", e.record.getString("password").trim());
  e.record.set("passKey", e.record.getString("password") !== before.getString("password") || !before.getString("passKey")
    ? $security.randomString(40) : before.getString("passKey"));
  require(`${__hooks}/share_lib.js`).checkAudience(e.record, e.record.getString("owner"));
  // (Without anyone it would turn into a link that nobody asked for.)
  if (before.getStringSlice("recipients").length && !e.record.getStringSlice("recipients").length) {
    throw new BadRequestError("Pick at least one person, or delete the share.");
  }
  e.next();
}, "shares");

// Public links follow their share: published when made or changed, taken down when deleted.
onRecordAfterCreateSuccess((e) => {
  try { require(`${__hooks}/share_lib.js`).syncPublic(e.record); } catch (err) { console.log("couldn't publish share", e.record.id, err); }
  e.next();
}, "shares");
onRecordAfterUpdateSuccess((e) => {
  try { require(`${__hooks}/share_lib.js`).syncPublic(e.record); } catch (err) { console.log("couldn't publish share", e.record.id, err); }
  e.next();
}, "shares");
onRecordAfterDeleteSuccess((e) => {
  try { require(`${__hooks}/share_lib.js`).unpublish(e.record.getString("token")); } catch (err) { console.log("couldn't unpublish share", e.record.id, err); }
  e.next();
}, "shares");

// ...and their items: one moved to Trash, into or out of an album, or replaced, changes the public copy.
onRecordAfterUpdateSuccess((e) => {
  const r = e.record, old = r.original();
  if (["trashedAt", "albums", "file", "poster", "title", "originalName"].every((f) => JSON.stringify(r.get(f)) === JSON.stringify(old.get(f)))) return e.next();
  const albums = [...new Set([...r.getStringSlice("albums"), ...old.getStringSlice("albums")])];
  try { require(`${__hooks}/share_lib.js`).republishFor(r, albums); } catch (err) { console.log("couldn't update public links for", r.id, err); }
  e.next();
}, "media");
onRecordAfterDeleteSuccess((e) => {
  try { require(`${__hooks}/share_lib.js`).republishFor(e.record, e.record.getStringSlice("albums")); } catch (err) { console.log("couldn't update public links for", e.record.id, err); }
  e.next();
}, "media");

// Expired links go, smart albums and thumbnails catch up, and nothing is left behind in pb_sites/shares.
cronAdd("publicShares", "*/5 * * * *", () => {
  require(`${__hooks}/share_lib.js`).reconcilePublic();
});
onBootstrap((e) => {
  e.next();
  try { require(`${__hooks}/share_lib.js`).reconcilePublic(); } catch (err) { console.log("couldn't check public links", err); }
});

// ---------- links ----------
routerAdd("GET", "/s/{token}", (e) => {
  return e.redirect(302, "/share.html?t=" + encodeURIComponent(e.request.pathValue("token")));
});

// What the share page shows. Only display fields; never the owner's email or other records.
routerAdd("GET", "/api/share/{token}", (e) => {
  const { findShare, sharePayload, unlocked } = require(`${__hooks}/share_lib.js`);
  const share = findShare(e.request.pathValue("token"));
  if (!share) throw new NotFoundError("This link doesn't exist or has expired.");
  e.response.header().set("Cache-Control", "no-store");
  // Password-protected and not typed yet: nothing about the share, not even its title.
  if (!unlocked(e, share)) return e.json(401, { locked: true, message: "This link needs a password." });
  const out = sharePayload(share);
  share.set("views", share.getInt("views") + 1);
  try { $app.unsafeWithoutHooks().save(share); } catch (_) {}
  return e.json(200, out);
});

// Body: { password }. The right one sets the cookie that unlocks the share's data and files (share_lib.js).
// At most 10 wrong tries a minute per visitor (so one stranger can't lock out the people it was sent to) and 300 per
// link from everyone together, each one slowed down.
routerAdd("POST", "/api/share/{token}/unlock", (e) => {
  const { findShare, setUnlocked } = require(`${__hooks}/share_lib.js`);
  const share = findShare(e.request.pathValue("token"));
  if (!share) throw new NotFoundError("This link doesn't exist or has expired.");
  const want = share.getString("password");
  if (!want) return e.json(200, { ok: true });
  const store = $app.store(), win = Math.floor(Date.now() / 60000);
  const sk = `sharefail:${win}:${share.id}`, vk = `${sk}:${require(`${__hooks}/library_lib.js`).clientIp(e)}`;
  if ((store.get(vk) || 0) >= 10 || (store.get(sk) || 0) >= 300) throw new TooManyRequestsError("Too many wrong tries. Wait a minute and try again.");
  const got = String(e.requestInfo().body["password"] || "").trim();
  if (got && $security.equal(got, want)) {
    if (!share.getString("passKey")) {
      share.set("passKey", $security.randomString(40));
      $app.unsafeWithoutHooks().save(share);
    }
    setUnlocked(e, share);
    return e.json(200, { ok: true });
  }
  if (store.length() < 50000 || store.has(vk)) store.setFunc(vk, (old) => (old || 0) + 1);
  store.setFunc(sk, (old) => (old || 0) + 1);
  sleep(700);
  throw new BadRequestError("That password isn't right.");
});
// Wrong-try counts of minutes gone by.
cronAdd("shareFails", "* * * * *", () => {
  const store = $app.store(), win = Math.floor(Date.now() / 60000);
  for (const k of Object.keys(store.getAll())) {
    const m = /^sharefail:(\d+):/.exec(k);
    if (m && +m[1] < win) store.remove(k);
  }
});

// One shared file (?thumb=1, ?poster=1, ?download=1: serveMedia() in share_lib.js).
routerAdd("GET", "/api/share/{token}/file/{id}", (e) => {
  const { findShare, canSee, unlocked, serveMedia } = require(`${__hooks}/share_lib.js`);
  const share = findShare(e.request.pathValue("token"));
  if (!share || !unlocked(e, share)) throw new NotFoundError("This link doesn't exist or has expired.");
  let r = null;
  try { r = $app.findRecordById("media", e.request.pathValue("id")); } catch (_) {}
  if (!r || !canSee(share, r)) throw new NotFoundError("Not found.");
  serveMedia(e, share, r);
});

// Where links open. tailnet: Media Vault's https address over Tailscale ("" if not set up) - links are only offered
// there, never on the unencrypted home Wi-Fi address; public: the sites' https address when Funnel makes it public.
routerAdd("GET", "/api/library/share-bases", (e) => {
  const L = require(`${__hooks}/sites_lib.js`);
  const https = L.httpsInfo();
  e.response.header().set("Cache-Control", "no-store");
  return e.json(200, { tailnet: L.vaultHttps(), public: https && https.public ? `https://${https.host}` : "" });
}, $apis.requireAuth("users"));

// ---------- sharing with people who have an account here ----------
// Everyone else with an account, to pick from. Names (or emails, for accounts without one) only.
routerAdd("GET", "/api/library/contacts", (e) => {
  const out = $app.findRecordsByFilter("users", "id != {:me}", "name,email", 1000, 0, { me: e.auth.id })
    .map((u) => ({ id: u.id, name: u.getString("name") || u.getString("email") }));
  return e.json(200, out);
}, $apis.requireAuth("users"));

// What's been shared with me, newest first: [{ id, title, by, count, cover, created, expires, allowDownload, seen }].
routerAdd("GET", "/api/inbox", (e) => {
  const { sharePayload, expired } = require(`${__hooks}/share_lib.js`);
  const me = e.auth.id;
  const out = [];
  for (const s of $app.findRecordsByFilter("shares", "recipients ~ {:me}", "-created", 500, 0, { me })) {
    if (expired(s)) continue;
    const p = sharePayload(s);
    const cover = p.items.find((it) => it.kind !== "file" && (it.kind !== "video" || it.poster));
    out.push({
      id: s.id, title: p.title, by: p.by, count: p.items.length, cover: cover ? cover.id : "", created: s.getString("created"),
      expires: p.expires, allowDownload: p.allowDownload, seen: s.getStringSlice("seenBy").includes(me),
    });
  }
  e.response.header().set("Cache-Control", "no-store");
  return e.json(200, out);
}, $apis.requireAuth("users"));

// One share with me: what /api/share/{token} returns. Opening it takes it off the "new" count.
routerAdd("GET", "/api/inbox/{id}", (e) => {
  const { findInboxShare, sharePayload } = require(`${__hooks}/share_lib.js`);
  const share = findInboxShare(e.request.pathValue("id"), e.auth.id);
  if (!share) throw new NotFoundError("This isn't shared with you any more.");
  const out = sharePayload(share);
  const seen = share.getStringSlice("seenBy");
  if (!seen.includes(e.auth.id)) {
    share.set("seenBy", [...seen, e.auth.id]);
    try { $app.unsafeWithoutHooks().save(share); } catch (_) {}
  }
  e.response.header().set("Cache-Control", "no-store");
  return e.json(200, out);
}, $apis.requireAuth("users"));

// One file of a share with me. Images and videos can't send headers, so ?token= (a file token, as for the
// library's own files) works too.
routerAdd("GET", "/api/inbox/{id}/file/{mid}", (e) => {
  const { findInboxShare, canSee, serveMedia } = require(`${__hooks}/share_lib.js`);
  let me = e.auth ? e.auth.id : "";
  if (!me) {
    try { me = $app.findAuthRecordByToken(e.request.url.query().get("token"), "file").id; } catch (_) {}
  }
  const share = me ? findInboxShare(e.request.pathValue("id"), me) : null;
  if (!share) throw new NotFoundError("Not found.");
  let r = null;
  try { r = $app.findRecordById("media", e.request.pathValue("mid")); } catch (_) {}
  if (!r || !canSee(share, r)) throw new NotFoundError("Not found.");
  serveMedia(e, share, r);
});

// "Remove from my list": I'm no longer one of its recipients (the owner's share stays for the others).
routerAdd("DELETE", "/api/inbox/{id}", (e) => {
  const { findInboxShare } = require(`${__hooks}/share_lib.js`);
  const share = findInboxShare(e.request.pathValue("id"), e.auth.id);
  if (!share) return e.noContent(204);
  share.set("recipients", share.getStringSlice("recipients").filter((id) => id !== e.auth.id));
  share.set("seenBy", share.getStringSlice("seenBy").filter((id) => id !== e.auth.id));
  // Left with nobody, it would turn into a plain link; it's of no use to anyone, so it goes.
  if (!share.getStringSlice("recipients").length) $app.delete(share);
  else $app.unsafeWithoutHooks().save(share);
  return e.noContent(204);
}, $apis.requireAuth("users"));
