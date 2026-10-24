/// <reference path="../pb_data/types.d.ts" />
// Media library server hooks. Shared helpers (owner check, storage usage, quota) are in library_lib.js.

// Sign-up is open only until the first (owner) account exists. After that it needs an invite code
// from the `invites` collection (managed by the owner in the app, or a superuser at /_/), sent as `invite`.
// The new account gets the invite's storage limit.
onRecordCreateRequest((e) => {
  let invite = null;
  if (!e.hasSuperuserAuth() && $app.countRecords("users") > 0) {
    const code = String(e.requestInfo().body["invite"] || "").trim();
    try { invite = code ? $app.findFirstRecordByData("invites", "code", code) : null; } catch (_) {}
    const maxUses = invite ? invite.getInt("maxUses") : 0;
    const expires = invite ? invite.getDateTime("expires") : null;
    if (!invite
      || (maxUses > 0 && invite.getInt("uses") >= maxUses)
      || (expires && !expires.isZero() && expires.before(new DateTime()))) {
      throw new ForbiddenError("That invite code isn't valid. Ask the owner for a new one.");
    }
    // Taken before the account is made, in one step, so two sign-ups at once can't both get the last use.
    const took = $app.db().newQuery("UPDATE invites SET uses = uses + 1 WHERE id = {:id} AND (maxUses = 0 OR uses < maxUses)")
      .bind({ id: invite.id }).execute().rowsAffected();
    if (!took) throw new ForbiddenError("That invite code isn't valid. Ask the owner for a new one.");
    e.record.set("quota", invite.getInt("quota"));
    e.record.set("allowFiles", invite.getBool("allowFiles"));
  }
  try {
    e.next();
  } catch (err) {
    // (The account wasn't made - e.g. that email is taken - so the use goes back.)
    if (invite) $app.db().newQuery("UPDATE invites SET uses = MAX(uses - 1, 0) WHERE id = {:id}").bind({ id: invite.id }).execute();
    throw err;
  }
}, "users");

// Uploads: record the real file size (the client's number isn't trusted) and enforce the storage limit.
// Regular files need the owner's permission (users.allowFiles).
onRecordCreateRequest((e) => {
  const { uploadSize, checkQuota, canStoreFiles, isMediaName } = require(`${__hooks}/library_lib.js`);
  if (!e.hasSuperuserAuth() && !canStoreFiles(e.record.getString("owner"))) {
    const f = e.record.get("file");
    const name = f && typeof f === "object" ? f.originalName : "";
    if (e.record.getString("kind") === "file" || !isMediaName(name)) {
      throw new ForbiddenError("Only photos, videos and GIFs can be uploaded. Ask the owner to turn on files for your account.");
    }
  }
  const size = uploadSize(e.record, ["file"]);
  if (size) e.record.set("size", size);
  if (!e.hasSuperuserAuth()) checkQuota(e.record.getString("owner"), uploadSize(e.record, ["file", "poster"]) || e.request.contentLength);
  e.next();
}, "media");
onRecordCreateRequest((e) => {
  const { uploadSize, checkQuota } = require(`${__hooks}/library_lib.js`);
  const bytes = uploadSize(e.record, ["file", "thumb"]) || e.request.contentLength;
  e.record.set("bytes", bytes);
  if (!e.hasSuperuserAuth()) checkQuota(e.record.getString("owner"), bytes);
  e.next();
}, "vault_items");

// An item's files can't be swapped afterwards: the size, storage limit and file-type checks above only run on upload
// (the app never replaces a file - it uploads a new item).
onRecordUpdateRequest((e) => {
  if (!e.hasSuperuserAuth()) require(`${__hooks}/library_lib.js`).keepFiles(e, ["file", "poster"]);
  e.next();
}, "media");
onRecordUpdateRequest((e) => {
  if (!e.hasSuperuserAuth()) require(`${__hooks}/library_lib.js`).keepFiles(e, ["file", "thumb"]);
  e.next();
}, "vault_items");

// Tells the login screen whether to show "create owner account" instead of "sign in".
routerAdd("GET", "/api/library/setup", (e) => {
  return e.json(200, { needsOwner: $app.countRecords("users") === 0 });
});

// Sidebar numbers: counts and bytes per kind, plus every album with its item count and cover (Trash excluded),
// the Trash totals, and storage used vs. the user's limit. Smart albums (rules set) get their count and
// cover from the app, which knows how to turn rules into a filter.
routerAdd("GET", "/api/library/summary", (e) => {
  const { isOwner, usage } = require(`${__hooks}/library_lib.js`);
  const uid = e.auth.id;

  const kinds = arrayOf(new DynamicModel({ kind: "", count: 0, bytes: 0, favorites: 0 }));
  $app.db()
    .newQuery("SELECT kind, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes, SUM(favorite) AS favorites FROM media WHERE owner = {:uid} AND COALESCE(trashedAt, '') = '' GROUP BY kind")
    .bind({ uid })
    .all(kinds);

  // Multi-relation values are stored as a JSON array of ids.
  const inAlbum = "FROM media m, json_each(CASE WHEN json_valid(m.albums) THEN m.albums ELSE '[]' END) j WHERE m.owner = {:uid} AND COALESCE(m.trashedAt, '') = '' AND j.value = a.id";
  const albums = arrayOf(new DynamicModel({ id: "", name: "", description: "", rules: "", folder: "", count: 0, cover: "" }));
  $app.db()
    .newQuery(
      "SELECT a.id, a.name, a.description, COALESCE(a.rules, '') AS rules, COALESCE(a.folder, '') AS folder, " +
      `(SELECT COUNT(*) ${inAlbum}) AS count, ` +
      `COALESCE((SELECT m.id || '|' || m.kind || '|' || m.file || '|' || COALESCE(m.poster, '') ${inAlbum} ORDER BY m.created DESC LIMIT 1), '') AS cover ` +
      "FROM albums a WHERE a.owner = {:uid} ORDER BY a.created DESC"
    )
    .bind({ uid })
    .all(albums);

  // Folders: items filed directly in each (Trash excluded); its albums come from `albums[].folder`.
  const folders = arrayOf(new DynamicModel({ id: "", name: "", count: 0 }));
  $app.db()
    .newQuery(
      "SELECT f.id, f.name, (SELECT COUNT(*) FROM media m WHERE m.owner = {:uid} AND m.folder = f.id AND COALESCE(m.trashedAt, '') = '') AS count " +
      "FROM folders f WHERE f.owner = {:uid} ORDER BY f.created DESC"
    )
    .bind({ uid })
    .all(folders);

  const trash = new DynamicModel({ count: 0, bytes: 0 });
  $app.db()
    .newQuery("SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM media WHERE owner = {:uid} AND COALESCE(trashedAt, '') != ''")
    .bind({ uid })
    .one(trash);

  const storage = { used: usage(uid).bytes, quota: e.auth.getInt("quota") };
  const owner = isOwner(uid);
  return e.json(200, { kinds, albums, folders, trash, storage, isOwner: owner, allowFiles: owner || e.auth.getBool("allowFiles"),
    allowPublic: owner || e.auth.getBool("allowPublic") });
}, $apis.requireAuth("users"));

// "On this day": items taken on today's month-day in earlier years. md = "MM-DD" and tz = the browser's
// UTC offset in minutes, so the day boundaries are the viewer's local ones.
routerAdd("GET", "/api/library/memories", (e) => {
  const q = e.request.url.query();
  const md = /^\d\d-\d\d$/.test(q.get("md")) ? q.get("md") : "";
  const year = /^\d{4}$/.test(q.get("year")) ? q.get("year") : "";
  const tz = Math.max(-840, Math.min(840, parseInt(q.get("tz"), 10) || 0));
  if (!md || !year) throw new BadRequestError("md and year are required.");
  const mod = (tz >= 0 ? "+" : "") + tz + " minutes";
  const rows = arrayOf(new DynamicModel({ id: "" }));
  $app.db()
    .newQuery(
      "SELECT id FROM media WHERE owner = {:uid} AND kind != 'file' AND COALESCE(trashedAt, '') = '' AND COALESCE(takenAt, '') != '' " +
      "AND strftime('%m-%d', takenAt, {:mod}) = {:md} AND strftime('%Y', takenAt, {:mod}) < {:year} ORDER BY takenAt DESC LIMIT 500"
    )
    .bind({ uid: e.auth.id, mod, md, year })
    .all(rows);
  const recs = rows.length ? $app.findRecordsByIds("media", rows.map((r) => r.id)) : [];
  recs.sort((a, b) => b.getString("takenAt").localeCompare(a.getString("takenAt")));
  return e.json(200, recs);
}, $apis.requireAuth("users"));

// ---------- owner: invites and people ----------

routerAdd("GET", "/api/library/invites", (e) => {
  require(`${__hooks}/library_lib.js`).requireOwner(e);
  return e.json(200, $app.findRecordsByFilter("invites", "id != ''", "-created", 200, 0));
}, $apis.requireAuth("users"));

// Body: { note, maxUses (0 = unlimited), days (0 = never expires), quota (bytes, 0 = no limit), allowFiles }.
// The code is generated here.
routerAdd("POST", "/api/library/invites", (e) => {
  require(`${__hooks}/library_lib.js`).requireOwner(e);
  const body = e.requestInfo().body;
  const maxUses = Math.max(0, Math.floor(Number(body["maxUses"]) || 0));
  const days = Math.max(0, Math.floor(Number(body["days"]) || 0));
  const quota = Math.max(0, Math.floor(Number(body["quota"]) || 0));
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  const invite = new Record($app.findCollectionByNameOrId("invites"));
  invite.set("code", $security.randomStringWithAlphabet(4, abc) + "-" + $security.randomStringWithAlphabet(4, abc));
  invite.set("note", String(body["note"] || "").trim().slice(0, 200));
  invite.set("maxUses", maxUses);
  invite.set("uses", 0);
  invite.set("quota", quota);
  invite.set("allowFiles", body["allowFiles"] === true);
  if (days > 0) invite.set("expires", new DateTime().addDate(0, 0, days));
  $app.save(invite);
  return e.json(200, invite);
}, $apis.requireAuth("users"));

routerAdd("DELETE", "/api/library/invites/{id}", (e) => {
  require(`${__hooks}/library_lib.js`).requireOwner(e);
  $app.delete($app.findRecordById("invites", e.request.pathValue("id")));
  return e.noContent(204);
}, $apis.requireAuth("users"));

// Everyone with an account: storage used, their limit, and whether they may store regular files.
routerAdd("GET", "/api/library/people", (e) => {
  const { requireOwner, isOwner, usage } = require(`${__hooks}/library_lib.js`);
  requireOwner(e);
  const out = $app.findRecordsByFilter("users", "id != ''", "created", 1000, 0).map((u) => {
    const use = usage(u.id);
    return {
      id: u.id, name: u.getString("name"), email: u.getString("email"), created: u.getString("created"),
      quota: u.getInt("quota"), used: use.bytes, items: use.items, owner: isOwner(u.id), allowFiles: u.getBool("allowFiles"), allowPublic: u.getBool("allowPublic"),
    };
  });
  return e.json(200, out);
}, $apis.requireAuth("users"));

// Body: { quota } in bytes (0 = no limit), { allowFiles } and/or { allowPublic }; fields left out stay as they are.
// Taking allowPublic away also takes that person's public links off the internet (they stay as tailnet links).
routerAdd("POST", "/api/library/people/{id}", (e) => {
  require(`${__hooks}/library_lib.js`).requireOwner(e);
  const body = e.requestInfo().body;
  const u = $app.findRecordById("users", e.request.pathValue("id"));
  if (body["quota"] !== undefined) u.set("quota", Math.max(0, Math.floor(Number(body["quota"]) || 0)));
  if (body["allowFiles"] !== undefined) u.set("allowFiles", body["allowFiles"] === true);
  if (body["allowPublic"] !== undefined) u.set("allowPublic", body["allowPublic"] === true);
  $app.save(u);
  if (!u.getBool("allowPublic")) {
    for (const s of $app.findRecordsByFilter("shares", "owner = {:o} && public = true", "", 1000, 0, { o: u.id })) {
      s.set("public", false);
      $app.save(s); // (unpublished by share.pb.js's after-update hook)
    }
  }
  return e.json(200, { id: u.id, quota: u.getInt("quota"), allowFiles: u.getBool("allowFiles"), allowPublic: u.getBool("allowPublic") });
}, $apis.requireAuth("users"));

// Trash: items are deleted for good (files included) 30 days after they were moved there.
cronAdd("mediaTrashPurge", "17 * * * *", () => {
  const cutoff = new DateTime().addDate(0, 0, -30).string();
  const old = $app.findRecordsByFilter("media", "trashedAt != '' && trashedAt < {:cutoff}", "trashedAt", 500, 0, { cutoff });
  for (const r of old) {
    try { $app.delete(r); } catch (err) { console.log("trash purge failed for", r.id, err); }
  }
});
