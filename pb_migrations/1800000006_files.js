/// <reference path="../pb_data/types.d.ts" />
// Regular files (PDFs, documents, zips, audio…) alongside photos and videos.
//
// media.kind         gains "file": stored and listed like any item, shown with an icon instead of a thumbnail.
// users.allowFiles   the owner turns this on per person (People screen → /api/library/people); users can't set
//                    it themselves. The owner can always store files. Checked on upload in pb_hooks/library.pb.js.
//                    Locked-folder items are encrypted, so there it's only enforced by the app (see kindOf()).
// invites.allowFiles what a new account gets.
// media.kind can no longer be changed after upload (so a file can't be relabelled as a photo).

const add = (rule, extra) => {
  const r = String(rule ?? "").trim();
  return r ? `${r} && ${extra}` : extra;
};
const strip = (rule, extra) => String(rule ?? "").replace(` && ${extra}`, "").replace(extra, "");
const NO_SELF = "@request.body.allowFiles:isset = false";
const KIND_FIXED = "@request.body.kind:isset = false";

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.add(new BoolField({ name: "allowFiles" }));
  if (users.createRule !== null) users.createRule = add(users.createRule, NO_SELF);
  if (users.updateRule !== null) users.updateRule = add(users.updateRule, NO_SELF);
  app.save(users);

  const invites = app.findCollectionByNameOrId("invites");
  invites.fields.add(new BoolField({ name: "allowFiles" }));
  app.save(invites);

  const media = app.findCollectionByNameOrId("media");
  const kind = media.fields.getByName("kind");
  kind.values = ["image", "gif", "video", "file"];
  media.updateRule = add(media.updateRule, KIND_FIXED);
  app.save(media);
}, (app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.removeByName("allowFiles");
  if (users.createRule !== null) users.createRule = strip(users.createRule, NO_SELF);
  if (users.updateRule !== null) users.updateRule = strip(users.updateRule, NO_SELF);
  app.save(users);

  const invites = app.findCollectionByNameOrId("invites");
  invites.fields.removeByName("allowFiles");
  app.save(invites);

  const media = app.findCollectionByNameOrId("media");
  media.fields.getByName("kind").values = ["image", "gif", "video"];
  media.updateRule = strip(media.updateRule, KIND_FIXED);
  app.save(media);
});
