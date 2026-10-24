/// <reference path="../pb_data/types.d.ts" />
// Storage limits, photo locations and smart albums.
//
// users.quota       bytes this person may store (0 = no limit). Set by the owner (People screen) or from the
//                   invite code they signed up with; users can't change their own. Enforced on upload in
//                   pb_hooks/library.pb.js, which also overwrites media.size / vault_items.bytes with the
//                   real uploaded size, so usage can't be under-reported.
// invites.quota     the quota a new account gets.
// vault_items.bytes ciphertext size (the server already sees it; nothing about the content).
// media.lat/lng     GPS position from EXIF (0/0 = none). geoDone = the file has been checked for one, so
//                   older items are scanned once when the map is first opened.
// albums.rules      set = smart album: items are matched by these rules instead of being added by hand.
//                   Format: see smartFilter() in pb_public/app.js (and the server copy in share_lib.js).

// Rules come through as string pointers; String() reads them ("" = public, which still gets the extra check).
const add = (rule, extra) => {
  const r = String(rule ?? "").trim();
  return r ? `${r} && ${extra}` : extra;
};

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.add(new NumberField({ name: "quota", min: 0, onlyInt: true }));
  if (users.createRule !== null) users.createRule = add(users.createRule, "@request.body.quota:isset = false");
  if (users.updateRule !== null) users.updateRule = add(users.updateRule, "@request.body.quota:isset = false");
  app.save(users);

  const invites = app.findCollectionByNameOrId("invites");
  invites.fields.add(new NumberField({ name: "quota", min: 0, onlyInt: true }));
  app.save(invites);

  const items = app.findCollectionByNameOrId("vault_items");
  items.fields.add(new NumberField({ name: "bytes", min: 0, onlyInt: true }));
  items.updateRule = add(items.updateRule, "@request.body.bytes:isset = false");
  app.save(items);

  const media = app.findCollectionByNameOrId("media");
  media.fields.add(new NumberField({ name: "lat", min: -90, max: 90 }));
  media.fields.add(new NumberField({ name: "lng", min: -180, max: 180 }));
  media.fields.add(new BoolField({ name: "geoDone" }));
  media.updateRule = add(media.updateRule, "@request.body.size:isset = false");
  media.addIndex("idx_media_owner_lat", false, "owner, lat", "");
  app.save(media);

  const albums = app.findCollectionByNameOrId("albums");
  albums.fields.add(new JSONField({ name: "rules", maxSize: 4000 }));
  app.save(albums);

  // Sizes of locked items stored before this migration.
  const fsys = app.newFilesystem();
  try {
    for (const r of app.findAllRecords("vault_items")) {
      let bytes = 0;
      for (const f of ["file", "thumb"]) {
        const name = r.getString(f);
        if (!name) continue;
        try { bytes += fsys.attributes(r.baseFilesPath() + "/" + name).size; } catch (_) {}
      }
      r.set("bytes", bytes);
      app.unsafeWithoutHooks().save(r);
    }
  } finally {
    fsys.close();
  }
}, (app) => {
  const strip = (rule, extra) => String(rule ?? "").replace(` && ${extra}`, "").replace(extra, "");
  const users = app.findCollectionByNameOrId("users");
  users.fields.removeByName("quota");
  if (users.createRule !== null) users.createRule = strip(users.createRule, "@request.body.quota:isset = false");
  if (users.updateRule !== null) users.updateRule = strip(users.updateRule, "@request.body.quota:isset = false");
  app.save(users);
  const invites = app.findCollectionByNameOrId("invites");
  invites.fields.removeByName("quota");
  app.save(invites);
  const items = app.findCollectionByNameOrId("vault_items");
  items.fields.removeByName("bytes");
  items.updateRule = strip(items.updateRule, "@request.body.bytes:isset = false");
  app.save(items);
  const media = app.findCollectionByNameOrId("media");
  media.removeIndex("idx_media_owner_lat");
  for (const f of ["lat", "lng", "geoDone"]) media.fields.removeByName(f);
  media.updateRule = strip(media.updateRule, "@request.body.size:isset = false");
  app.save(media);
  const albums = app.findCollectionByNameOrId("albums");
  albums.fields.removeByName("rules");
  app.save(albums);
});
