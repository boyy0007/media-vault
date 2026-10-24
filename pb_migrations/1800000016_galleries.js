/// <reference path="../pb_data/types.d.ts" />
// Client galleries (the Galleries page; photographers sending a shoot to a client). A gallery is a public link share
// (shares.public) with a few more things, so it goes out through the sites server like any public link and needs no
// Tailscale on the client's side:
//
// shares.gallery     true = a client gallery: listed on the Galleries page, shown with the gallery look (cover, studio,
//                    message, favorites, web-size downloads) and open for up to 90 days (MAX_GALLERY_DAYS in
//                    pb_hooks/share_lib.js) instead of a public link's 30.
// shares.cover       the media record shown big at the top ("" = the first photo).
// shares.message     a short welcome note for the client.
// shares.allowPicks  clients may heart photos; their picks come back as shares.picks.
// shares.downloads   files downloaded from it, and shares.views (already there) how often it was opened - counted by the
//                    sites server and copied here by the galleries sync (pb_hooks/gallery_lib.js).
// shares.picks       what clients hearted: [{ client, name, items: [media ids], at }] - from the same sync.
// users.studio       the studio name shown on every gallery of this person (falls back to their name).
//
// downloads and picks are only ever set by the server, so they're refused in requests like views already is.

const add = (rule, extra) => {
  const r = String(rule ?? "").trim();
  return r ? `${r} && ${extra}` : extra;
};
const strip = (rule, extra) => String(rule ?? "").split(` && ${extra}`).join("").split(extra).join("");
const SERVER_ONLY = "@request.body.downloads:isset = false && @request.body.picks:isset = false";

migrate((app) => {
  const shares = app.findCollectionByNameOrId("shares");
  shares.fields.add(new BoolField({ name: "gallery" }));
  shares.fields.add(new TextField({ name: "cover", max: 15 }));
  shares.fields.add(new TextField({ name: "message", max: 2000 }));
  shares.fields.add(new BoolField({ name: "allowPicks" }));
  shares.fields.add(new NumberField({ name: "downloads", min: 0, onlyInt: true }));
  shares.fields.add(new JSONField({ name: "picks", maxSize: 2000000 }));
  shares.createRule = add(shares.createRule, SERVER_ONLY);
  shares.updateRule = add(shares.updateRule, SERVER_ONLY);
  app.save(shares);

  const users = app.findCollectionByNameOrId("users");
  users.fields.add(new TextField({ name: "studio", max: 100 }));
  app.save(users);
}, (app) => {
  const shares = app.findCollectionByNameOrId("shares");
  for (const n of ["gallery", "cover", "message", "allowPicks", "downloads", "picks"]) shares.fields.removeByName(n);
  shares.createRule = strip(shares.createRule, SERVER_ONLY);
  shares.updateRule = strip(shares.updateRule, SERVER_ONLY);
  app.save(shares);
  const users = app.findCollectionByNameOrId("users");
  users.fields.removeByName("studio");
  app.save(users);
});
