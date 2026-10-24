/// <reference path="../pb_data/types.d.ts" />
// Sharing with other people who have an account here, and public (internet) links.
//
// shares.recipients  users this is shared with. Set = a share with people: it shows under "Shared with me" for
//                    them (/api/inbox in pb_hooks/share.pb.js) and its token link doesn't open.
// shares.seenBy      recipients who have opened it (server-managed: for the "new" badge).
// shares.public      also published on the internet through the sites server (https://{pc}.ts.net/s/{token}/),
//                    which only sees a copy: pb_sites/shares/{token}/ (publish() in pb_hooks/share_lib.js).
//                    Needs an expiry date at most 30 days away.

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  const shares = app.findCollectionByNameOrId("shares");
  shares.fields.add(new RelationField({ name: "recipients", collectionId: users.id, maxSelect: 100, cascadeDelete: false }));
  shares.fields.add(new RelationField({ name: "seenBy", collectionId: users.id, maxSelect: 100, cascadeDelete: false }));
  shares.fields.add(new BoolField({ name: "public" }));
  shares.createRule += " && @request.body.seenBy:isset = false";
  shares.updateRule += " && @request.body.seenBy:isset = false";
  app.save(shares);
}, (app) => {
  const shares = app.findCollectionByNameOrId("shares");
  for (const n of ["recipients", "seenBy", "public"]) shares.fields.removeByName(n);
  shares.createRule = shares.createRule.replace(" && @request.body.seenBy:isset = false", "");
  shares.updateRule = shares.updateRule.replace(" && @request.body.seenBy:isset = false", "");
  app.save(shares);
});
