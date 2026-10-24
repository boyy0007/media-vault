/// <reference path="../pb_data/types.d.ts" />
// Who may open a hosted site (like itch.io's visibility setting). sites.access:
//   "" / "public"  anyone who can reach the sites server (the whole internet when Funnel is on)
//   "password"     visitors type sites.password once (kept here so the owner can see and share it)
//   "private"      only the owner, who gets in by opening the site from Media Vault
// sites.accessKey signs the sites server's pass cookies; a new one is made whenever access or the password changes,
// which signs everyone out. The sites server can't read this database: pb_hooks/sites_lib.js writeAccess() copies
// what it needs (mode, key, password hash) to pb_sites/access.json.

migrate((app) => {
  const sites = app.findCollectionByNameOrId("sites");
  sites.fields.add(new SelectField({ name: "access", maxSelect: 1, values: ["public", "password", "private"] }));
  sites.fields.add(new TextField({ name: "password", max: 100 }));
  sites.fields.add(new TextField({ name: "accessKey", max: 100, hidden: true }));
  app.save(sites);
}, (app) => {
  const sites = app.findCollectionByNameOrId("sites");
  for (const n of ["access", "password", "accessKey"]) sites.fields.removeByName(n);
  app.save(sites);
});
