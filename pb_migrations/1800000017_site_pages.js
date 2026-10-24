/// <reference path="../pb_data/types.d.ts" />
// Store pages and keys for hosted sites (like an itch.io game page and its download keys).
//
// sites.page           show a page before the site: cover, title, tagline, about, screenshots, downloads, Play
// sites.tagline/about  its text (plain text; the page escapes it and turns blank lines into paragraphs)
// sites.cover/shots    its pictures - not protected, so the app's page editor can show thumbnails
// sites.downloads      files to download from the page (a game build, an APK…) - protected, only the sites server
//                      hands them out; dlNames = { stored name: the name it was uploaded as }, what people download it as
// sites.keyDownloads   the downloads need a key (below), even on a public site
// The sites server can't read this database or pb_data: pb_hooks/sites_lib.js publishPage() hard-links the files into
// pb_sites/pages/{site id}/ and writeAccess() copies the text into pb_sites/access.json.
//
// site_keys: personal links (…/{slug}/?key={token}) that let one person in - into a password-protected or private
// site, and to the downloads. maxUses = how many browsers can redeem it (0 = no limit), expires = optional. Deleting
// one shuts its holders out. The sites server counts redemptions in its own database
// (pb_sites/pb_migrations/1800000002_site_activity.js). No API rules: everything goes through /api/sites/{id}/keys.

const IMAGES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];

migrate((app) => {
  const sites = app.findCollectionByNameOrId("sites");
  sites.fields.add(new BoolField({ name: "page" }));
  sites.fields.add(new TextField({ name: "tagline", max: 140 }));
  sites.fields.add(new TextField({ name: "about", max: 5000 }));
  sites.fields.add(new FileField({ name: "cover", maxSelect: 1, maxSize: 20 * 1024 * 1024, mimeTypes: IMAGES, thumbs: ["480x270"] }));
  sites.fields.add(new FileField({ name: "shots", maxSelect: 8, maxSize: 20 * 1024 * 1024, mimeTypes: IMAGES, thumbs: ["480x270"] }));
  sites.fields.add(new FileField({ name: "downloads", maxSelect: 10, maxSize: 4 * 1024 * 1024 * 1024, protected: true }));
  sites.fields.add(new JSONField({ name: "dlNames", maxSize: 20000 }));
  sites.fields.add(new BoolField({ name: "keyDownloads" }));
  app.save(sites);

  app.save(new Collection({
    type: "base",
    name: "site_keys",
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { type: "relation", name: "site", collectionId: sites.id, maxSelect: 1, required: true, cascadeDelete: true },
      { type: "text", name: "label", max: 80 },
      { type: "text", name: "token", required: true, min: 24, max: 24 },
      { type: "number", name: "maxUses", min: 0, onlyInt: true },
      { type: "date", name: "expires" },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_site_keys_token ON site_keys (token)",
      "CREATE INDEX idx_site_keys_site ON site_keys (site)",
    ],
  }));
}, (app) => {
  try { app.delete(app.findCollectionByNameOrId("site_keys")); } catch (_) {}
  const sites = app.findCollectionByNameOrId("sites");
  for (const n of ["page", "tagline", "about", "cover", "shots", "downloads", "dlNames", "keyDownloads"]) sites.fields.removeByName(n);
  app.save(sites);
});
