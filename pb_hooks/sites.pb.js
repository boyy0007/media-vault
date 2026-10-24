/// <reference path="../pb_data/types.d.ts" />
// Hosted sites (owner only): static HTML projects. This app writes the files to pb_sites/www/{slug}/; the separate
// sites server on port 8092 (pb_sites/pb_hooks/, started by start.bat) serves them, so a hosted page is on another
// origin and can't read the Media Vault login. Helpers: sites_lib.js. App side: "Sites" in pb_public/app.js.
//
// Uploading replaces the whole site: POST /deploy (empties the staging folder), POST /deploy/files (batches of
// files with their paths), POST /deploy/finish (swaps the staging folder in, and copies it to projects/ -
// copyToProjects() in sites_lib.js).

// Each site has stats: { all, week, today } × { views, plays, downloads } from the sites server, or null when it
// isn't answering.
routerAdd("GET", "/api/sites", (e) => {
  const L = require(`${__hooks}/sites_lib.js`);
  require(`${__hooks}/library_lib.js`).requireOwner(e);
  const sites = $app.findRecordsByFilter("sites", "owner = {:uid}", "name", 500, 0, { uid: e.auth.id });
  const act = L.siteActivity();
  const none = { views: 0, plays: 0, downloads: 0 };
  return e.json(200, {
    port: L.PORT, https: L.httpsInfo(),
    sites: sites.map((r) => Object.assign(L.siteJson(r), {
      stats: act ? (act.stats || {})[r.id] || { all: none, week: none, today: none } : null,
    })),
  });
}, $apis.requireAuth("users"));

// Body: { name, slug }.
routerAdd("POST", "/api/sites", (e) => {
  const L = require(`${__hooks}/sites_lib.js`);
  require(`${__hooks}/library_lib.js`).requireOwner(e);
  const body = e.requestInfo().body;
  const name = String(body["name"] || "").trim().slice(0, 100);
  const slug = String(body["slug"] || "").trim().toLowerCase();
  if (!name) throw new BadRequestError("Give the site a name.");
  L.checkSlug(slug, "");
  const site = new Record($app.findCollectionByNameOrId("sites"));
  site.set("owner", e.auth.id);
  site.set("name", name);
  site.set("slug", slug);
  site.set("files", 0);
  site.set("bytes", 0);
  site.set("access", "public");
  site.set("accessKey", $security.randomString(40));
  $os.mkdirAll(L.liveDir(slug), 0o755);
  $app.save(site);
  return e.json(200, L.siteJson(site));
}, $apis.requireAuth("users"));

// Body: { name } and/or { slug } and/or { access, password }. A new slug moves the files, so the old link stops
// working. Changing access or the password signs out everyone who got in before (new accessKey).
routerAdd("PATCH", "/api/sites/{id}", (e) => {
  const L = require(`${__hooks}/sites_lib.js`);
  const site = L.requireSite(e);
  const body = e.requestInfo().body;
  if (body["name"] !== undefined) {
    const name = String(body["name"] || "").trim().slice(0, 100);
    if (!name) throw new BadRequestError("Give the site a name.");
    site.set("name", name);
  }
  if (body["access"] !== undefined || body["password"] !== undefined) {
    const access = body["access"] !== undefined ? String(body["access"]) : L.accessOf(site);
    if (!L.ACCESS.includes(access)) throw new BadRequestError("Unknown access setting.");
    const password = body["password"] !== undefined ? String(body["password"] || "") : site.getString("password");
    if (password.length > 100) throw new BadRequestError("The password can be up to 100 characters.");
    if (access === "password" && !password) throw new BadRequestError("Choose a password.");
    if (access !== L.accessOf(site) || password !== site.getString("password") || !site.getString("accessKey")) {
      site.set("accessKey", $security.randomString(40));
    }
    site.set("access", access);
    site.set("password", password);
  }
  const from = site.getString("slug");
  const to = body["slug"] !== undefined ? String(body["slug"] || "").trim().toLowerCase() : from;
  if (to !== from) {
    L.checkSlug(to, site.id);
    if (L.exists(L.liveDir(to))) throw new BadRequestError("A folder with that address is still on disk. Pick another.");
    if (L.exists(L.liveDir(from))) $os.rename(L.liveDir(from), L.liveDir(to));
    else $os.mkdirAll(L.liveDir(to), 0o755);
    site.set("slug", to);
  }
  try {
    $app.save(site);
  } catch (err) {
    if (to !== from) try { $os.rename(L.liveDir(to), L.liveDir(from)); } catch (_) {}
    throw err;
  }
  return e.json(200, L.siteJson(site));
}, $apis.requireAuth("users"));

routerAdd("DELETE", "/api/sites/{id}", (e) => {
  const site = require(`${__hooks}/sites_lib.js`).requireSite(e);
  $app.delete(site); // files: see onRecordAfterDeleteSuccess below
  return e.noContent(204);
}, $apis.requireAuth("users"));

// The owner's way into a password-protected or private site: open /{slug}/?__mv={ticket} (see sites_lib.js).
routerAdd("POST", "/api/sites/{id}/enter", (e) => {
  const L = require(`${__hooks}/sites_lib.js`);
  const site = L.requireSite(e);
  if (!site.getString("accessKey")) {
    site.set("accessKey", $security.randomString(40));
    $app.save(site);
  }
  return e.json(200, { ticket: L.ownerTicket(site) });
}, $apis.requireAuth("users"));

// However a site goes (here, or with its owner's account), its files go with it.
onRecordAfterDeleteSuccess((e) => {
  const L = require(`${__hooks}/sites_lib.js`);
  for (const dir of [L.liveDir(e.record.getString("slug")), L.stagingDir(e.record.id), $filepath.join(L.pagesRoot(), e.record.id)]) {
    try { $os.removeAll(dir); } catch (err) { console.log("couldn't remove site folder", dir, err); }
  }
  try { L.writeAccess(); } catch (err) { console.log("couldn't write pb_sites/access.json", err); }
  e.next();
}, "sites");

// The sites server learns who may open what (and what a store page shows) from pb_sites/access.json, and gets a page's
// pictures and downloads in pb_sites/pages/: brought up to date on every change and at start-up.
onRecordAfterCreateSuccess((e) => {
  try { require(`${__hooks}/sites_lib.js`).writeAccess(); } catch (err) { console.log("couldn't write pb_sites/access.json", err); }
  e.next();
}, "sites");
onRecordAfterUpdateSuccess((e) => {
  const L = require(`${__hooks}/sites_lib.js`);
  try { L.publishPage(e.record); } catch (err) { console.log("couldn't publish the page of", e.record.getString("slug"), err); }
  try { L.writeAccess(); } catch (err) { console.log("couldn't write pb_sites/access.json", err); }
  e.next();
}, "sites");
// (A deleted site's keys go with it; the site's own delete hook rewrites the file.)
onRecordAfterCreateSuccess((e) => {
  try { require(`${__hooks}/sites_lib.js`).writeAccess(); } catch (err) { console.log("couldn't write pb_sites/access.json", err); }
  e.next();
}, "site_keys");
onRecordAfterDeleteSuccess((e) => {
  try { require(`${__hooks}/sites_lib.js`).writeAccess(); } catch (err) { console.log("couldn't write pb_sites/access.json", err); }
  e.next();
}, "site_keys");
onBootstrap((e) => {
  e.next();
  const L = require(`${__hooks}/sites_lib.js`);
  try { L.reconcilePages(); } catch (err) { console.log("couldn't publish the site pages", err); }
  try { L.writeAccess(); } catch (err) { console.log("couldn't write pb_sites/access.json", err); }
});

// ---------- store page (like an itch.io game page) ----------
// Multipart (or JSON): page, tagline, about, keyDownloads ("true"/"false" in a form), remove (JSON list of file names
// to take off) + files: cover (replaces the old one), shots and downloads (added to what's there).
routerAdd("POST", "/api/sites/{id}/page", (e) => {
  const L = require(`${__hooks}/sites_lib.js`);
  const site = L.requireSite(e);
  const body = e.requestInfo().body;
  const yes = (v) => v === true || v === "true" || v === "1" || v === "on";
  if (body["page"] !== undefined) site.set("page", yes(body["page"]));
  if (body["keyDownloads"] !== undefined) site.set("keyDownloads", yes(body["keyDownloads"]));
  if (body["tagline"] !== undefined) site.set("tagline", String(body["tagline"] || "").trim().slice(0, 140));
  if (body["about"] !== undefined) site.set("about", String(body["about"] || "").trim().slice(0, 5000));
  let remove = body["remove"] || [];
  if (typeof remove === "string") try { remove = JSON.parse(remove); } catch (_) { remove = []; }
  if (Array.isArray(remove) && remove.length) {
    const gone = new Set(remove.map(String));
    if (gone.has(site.getString("cover"))) site.set("cover", "");
    for (const f of ["shots", "downloads"]) {
      const names = site.getStringSlice(f).filter((n) => gone.has(n));
      if (names.length) site.set(f + "-", names);
    }
  }
  const uploaded = (key) => { try { return e.findUploadedFiles(key) || []; } catch (_) { return []; } };
  const cover = uploaded("cover"), shots = uploaded("shots"), downloads = uploaded("downloads");
  if (site.getStringSlice("shots").length + shots.length > 8) throw new BadRequestError("A page can have up to 8 screenshots.");
  if (site.getStringSlice("downloads").length + downloads.length > 10) throw new BadRequestError("A page can have up to 10 downloads.");
  if (cover.length) site.set("cover", cover[0]);
  if (shots.length) site.set("shots+", shots);
  if (downloads.length) site.set("downloads+", downloads);
  // The names the downloads were uploaded as (what people get them as), for the files that are still there.
  // (Files still being uploaded aren't in getStringSlice() yet.)
  const names = L.dlNames(site), keep = {};
  for (const f of site.getStringSlice("downloads")) if (names[f]) keep[f] = names[f];
  for (const f of downloads) if (f.originalName) keep[f.name] = String(f.originalName).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 200);
  site.set("dlNames", keep);
  $app.save(site);
  return e.json(200, L.siteJson(site));
}, $apis.requireAuth("users"), $apis.bodyLimit(5 * 1024 * 1024 * 1024));

// ---------- keys: personal links that let one person in (site_keys) ----------
routerAdd("GET", "/api/sites/{id}/keys", (e) => {
  const L = require(`${__hooks}/sites_lib.js`);
  const site = L.requireSite(e);
  const act = L.siteActivity();
  const keys = $app.findRecordsByFilter("site_keys", "site = {:s}", "-created", 500, 0, { s: site.id });
  return e.json(200, { counted: !!act, keys: keys.map((k) => L.keyJson(k, act ? (act.keys || {})[k.id] : 0)) });
}, $apis.requireAuth("users"));

// Body: { label, maxUses (0 = no limit), days (0 = never expires) }.
routerAdd("POST", "/api/sites/{id}/keys", (e) => {
  const L = require(`${__hooks}/sites_lib.js`);
  const site = L.requireSite(e);
  const body = e.requestInfo().body;
  const maxUses = Math.floor(+body["maxUses"] || 0), days = Math.floor(+body["days"] || 0);
  if (maxUses < 0 || maxUses > 100000 || days < 0 || days > 3650) throw new BadRequestError("Check the uses and the expiry.");
  if ($app.countRecords("site_keys", $dbx.hashExp({ site: site.id })) >= 500) throw new BadRequestError("A site can have up to 500 keys. Delete some first.");
  const k = new Record($app.findCollectionByNameOrId("site_keys"));
  k.set("site", site.id);
  k.set("label", String(body["label"] || "").trim().slice(0, 80));
  k.set("token", $security.randomString(24));
  k.set("maxUses", maxUses);
  if (days) k.set("expires", new DateTime().addDate(0, 0, days));
  $app.save(k);
  return e.json(200, L.keyJson(k, 0));
}, $apis.requireAuth("users"));

routerAdd("DELETE", "/api/sites/{id}/keys/{key}", (e) => {
  const site = require(`${__hooks}/sites_lib.js`).requireSite(e);
  let k = null;
  try { k = $app.findRecordById("site_keys", e.request.pathValue("key")); } catch (_) {}
  if (!k || k.getString("site") !== site.id) throw new NotFoundError("Key not found.");
  $app.delete(k);
  return e.noContent(204);
}, $apis.requireAuth("users"));

// ---------- uploading ----------

routerAdd("POST", "/api/sites/{id}/deploy", (e) => {
  const L = require(`${__hooks}/sites_lib.js`);
  const site = L.requireSite(e);
  const dir = L.stagingDir(site.id);
  $os.removeAll(dir);
  $os.mkdirAll(dir, 0o755);
  return e.json(200, { ok: true });
}, $apis.requireAuth("users"));

// Multipart: `files` (one or more) + `paths` (JSON array, the path of each file in the same order).
routerAdd("POST", "/api/sites/{id}/deploy/files", (e) => {
  const L = require(`${__hooks}/sites_lib.js`);
  const site = L.requireSite(e);
  const dir = L.stagingDir(site.id);
  if (!L.exists(dir)) throw new BadRequestError("This upload was interrupted. Start it again.");

  const files = e.findUploadedFiles("files");
  let paths = [];
  try { paths = JSON.parse(e.request.formValue("paths") || "[]"); } catch (_) {}
  if (!Array.isArray(paths) || paths.length !== files.length) throw new BadRequestError("Each file needs its path.");

  // os.Root keeps every write inside the staging folder, whatever the path says.
  const root = $os.openRoot(dir);
  let written = 0;
  try {
    files.forEach((f, i) => {
      const path = L.cleanPath(paths[i]);
      if (!path) return;
      const parent = $filepath.dir(path);
      if (parent !== ".") root.mkdirAll($filepath.fromSlash(parent), 0o755);
      const rs = f.reader.open();
      try {
        root.writeFile($filepath.fromSlash(path), toBytes(rs, Math.max(1, f.size)), 0o644);
      } finally {
        rs.close();
      }
      written++;
    });
  } finally {
    root.close();
  }
  return e.json(200, { written, skipped: files.length - written });
}, $apis.requireAuth("users"), $apis.bodyLimit(2 * 1024 * 1024 * 1024));

routerAdd("POST", "/api/sites/{id}/deploy/finish", (e) => {
  const L = require(`${__hooks}/sites_lib.js`);
  const site = L.requireSite(e);
  const dir = L.stagingDir(site.id);
  if (!L.exists(dir)) throw new BadRequestError("This upload was interrupted. Start it again.");
  const t = L.tally(dir);
  if (!t.files) throw new BadRequestError("Nothing was uploaded.");
  L.swapIn(dir, L.liveDir(site.getString("slug")));
  site.set("files", t.files);
  site.set("bytes", t.bytes);
  site.set("deployedAt", new DateTime());
  $app.save(site);
  let copy = "";
  try { copy = L.copyToProjects(site); } catch (err) { console.log("couldn't copy the site to projects/", site.getString("slug"), err); }
  return e.json(200, Object.assign(L.siteJson(site), { copy }));
}, $apis.requireAuth("users"));

// ---------- adding a site from the status window ----------
// Settings > "Add a site or backend..." in MediaVault.ps1 copies a project's site files to pb_sites/staging/import-{x}/
// itself (it runs on this PC), then this puts them live as one of the owner's sites, like /deploy/finish does.
// Body: { staging, name, slug, access, password, replace, mirror }. A slug that's taken answers 409 { exists: name } unless
// replace is true; replacing keeps the site's access setting unless one is sent. Needs the status window's secret.
routerAdd("POST", "/api/status/sites/import", (e) => {
  const lib = require(`${__hooks}/library_lib.js`);
  lib.requireStatusToken(e);
  const L = require(`${__hooks}/sites_lib.js`);
  const body = e.requestInfo().body;
  const staging = String(body["staging"] || "");
  if (!/^import-[a-z0-9]{12}$/.test(staging)) throw new BadRequestError("Unknown upload folder.");
  const dir = $filepath.join(L.base(), "staging", staging);
  if (!L.exists(dir)) throw new BadRequestError("The copied files weren't found.");
  const owner = $app.findRecordsByFilter("users", "id != ''", "created", 1, 0)[0];
  if (!owner) throw new BadRequestError("Create your Media Vault account first (open Media Vault in the browser) - the first account owns the sites.");
  const name = String(body["name"] || "").trim().slice(0, 100);
  const slug = String(body["slug"] || "").trim().toLowerCase();
  if (!name) throw new BadRequestError("Give the site a name.");
  let site = null;
  try { site = $app.findFirstRecordByData("sites", "slug", slug); } catch (_) {}
  if (site && !body["replace"]) return e.json(409, { exists: site.getString("name") });
  if (!site) {
    L.checkSlug(slug, "");
    site = new Record($app.findCollectionByNameOrId("sites"));
    site.set("owner", owner.id);
    site.set("slug", slug);
    site.set("access", "public");
  }
  site.set("name", name);
  if (body["access"] !== undefined) {
    const access = String(body["access"]);
    const password = String(body["password"] || "");
    if (!L.ACCESS.includes(access)) throw new BadRequestError("Unknown access setting.");
    if (access === "password" && !password) throw new BadRequestError("Choose a password.");
    if (password.length > 100) throw new BadRequestError("The password can be up to 100 characters.");
    if (access !== L.accessOf(site) || password !== site.getString("password")) site.set("accessKey", "");
    site.set("access", access);
    site.set("password", access === "password" ? password : "");
  }
  if (!site.getString("accessKey")) site.set("accessKey", $security.randomString(40));
  const t = L.tally(dir);
  if (!t.files) throw new BadRequestError("There were no files to publish.");
  $os.mkdirAll($filepath.join(L.base(), "www"), 0o755);
  L.swapIn(dir, L.liveDir(slug));
  site.set("files", t.files);
  site.set("bytes", t.bytes);
  site.set("deployedAt", new DateTime());
  $app.save(site);
  // (mirror: false when the project is in projects/ already - no second copy next to it.)
  let copy = "";
  if (body["mirror"] !== false) {
    try { copy = L.copyToProjects(site); } catch (err) { console.log("couldn't copy the site to projects/", slug, err); }
  }
  return e.json(200, Object.assign(L.siteJson(site), { https: L.httpsInfo(), port: L.PORT, copy }));
});

// Settings > "Remove a site or backend..." in MediaVault.ps1: the owner's sites, and removing one (its files go with
// it, see onRecordAfterDeleteSuccess above). Need the status window's secret.
routerAdd("GET", "/api/status/sites", (e) => {
  require(`${__hooks}/library_lib.js`).requireStatusToken(e);
  const L = require(`${__hooks}/sites_lib.js`);
  return e.json(200, { sites: $app.findAllRecords("sites").map(L.siteJson) });
});
routerAdd("DELETE", "/api/status/sites/{slug}", (e) => {
  require(`${__hooks}/library_lib.js`).requireStatusToken(e);
  let site = null;
  try { site = $app.findFirstRecordByData("sites", "slug", e.request.pathValue("slug")); } catch (_) {}
  if (!site) throw new NotFoundError("Site not found.");
  $app.delete(site);
  return e.noContent(204);
});
