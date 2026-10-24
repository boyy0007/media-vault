/// <reference path="../../pb_data/types.d.ts" />
// What clients do in a public gallery, kept in the sites server's own database (it can't reach Media Vault's): the
// main app collects it with the galleries sync (pb_hooks/gallery_lib.js → /api/mv/activity in pubshare_lib.js) and
// copies it into shares.views / downloads / picks. No API rules: nothing is reachable through PocketBase's own API
// (which serve.pb.js blocks anyway); only the routes in pubshare_lib.js read and write these.
//
// gallery_stats  one row per link: how often it was opened and how many files were downloaded.
// gallery_picks  one row per photo a client hearted: the link, the client (a random id their browser keeps, with the
//                name they typed), and the photo.

migrate((app) => {
  app.save(new Collection({
    type: "base",
    name: "gallery_stats",
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { type: "text", name: "token", required: true, min: 24, max: 24 },
      { type: "number", name: "views", min: 0, onlyInt: true },
      { type: "number", name: "downloads", min: 0, onlyInt: true },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_gallery_stats_token ON gallery_stats (token)"],
  }));
  app.save(new Collection({
    type: "base",
    name: "gallery_picks",
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { type: "text", name: "token", required: true, min: 24, max: 24 },
      { type: "text", name: "client", required: true, min: 16, max: 16 },
      { type: "text", name: "name", max: 60 },
      { type: "text", name: "item", required: true, min: 15, max: 15 },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_gallery_picks_one ON gallery_picks (token, client, item)",
      "CREATE INDEX idx_gallery_picks_token ON gallery_picks (token)",
    ],
  }));
}, (app) => {
  for (const n of ["gallery_picks", "gallery_stats"]) try { app.delete(app.findCollectionByNameOrId(n)); } catch (_) {}
});
