/// <reference path="../../pb_data/types.d.ts" />
// What visitors do on the hosted sites, kept in the sites server's own database (it can't reach Media Vault's), and
// collected by Media Vault when its Sites page opens (POST /api/mv/sites in sitepage_lib.js). No API rules: only the
// routes in sitepage_lib.js read and write these.
//
// site_stats     one row per site per day (UTC): store page views, plays (the site's start page loaded) and downloads.
//                A visitor counts once per 30 minutes for each.
// site_key_uses  how many browsers have redeemed each key (pb_migrations/1800000017_site_pages.js site_keys).

migrate((app) => {
  app.save(new Collection({
    type: "base",
    name: "site_stats",
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { type: "text", name: "site", required: true, min: 15, max: 15 },
      { type: "text", name: "day", required: true, min: 10, max: 10 },
      { type: "number", name: "views", min: 0, onlyInt: true },
      { type: "number", name: "plays", min: 0, onlyInt: true },
      { type: "number", name: "downloads", min: 0, onlyInt: true },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_site_stats_day ON site_stats (site, day)"],
  }));
  app.save(new Collection({
    type: "base",
    name: "site_key_uses",
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { type: "text", name: "key", required: true, min: 15, max: 15 },
      { type: "number", name: "uses", min: 0, onlyInt: true },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_site_key_uses_key ON site_key_uses (key)"],
  }));
}, (app) => {
  for (const n of ["site_key_uses", "site_stats"]) try { app.delete(app.findCollectionByNameOrId(n)); } catch (_) {}
});
