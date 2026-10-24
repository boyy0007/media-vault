/// <reference path="../pb_data/types.d.ts" />
// Hosted sites (owner only): static HTML projects, served by the second PocketBase on port 8092 (pb_sites/,
// started by start.bat) at http://<host>:8092/{slug}/. A site's files live on disk in pb_sites/www/{slug}/,
// written by pb_hooks/sites.pb.js; this collection only describes them. Every write goes through /api/sites,
// so there are no API rules (superusers only).

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  const sites = new Collection({
    type: "base",
    name: "sites",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: "relation", name: "owner", collectionId: users.id, maxSelect: 1, required: true, cascadeDelete: true },
      { type: "text", name: "name", required: true, max: 100 },
      { type: "text", name: "slug", required: true, min: 1, max: 40, pattern: "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$" },
      { type: "number", name: "files", min: 0, onlyInt: true },
      { type: "number", name: "bytes", min: 0, onlyInt: true },
      { type: "date", name: "deployedAt" },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_sites_slug ON sites (slug)",
      "CREATE INDEX idx_sites_owner ON sites (owner)",
    ],
  });
  app.save(sites);
}, (app) => {
  try { app.delete(app.findCollectionByNameOrId("sites")); } catch (_) {}
});
