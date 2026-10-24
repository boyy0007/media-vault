/// <reference path="../pb_data/types.d.ts" />
// Optional password on share links. shares.password: "" = none; kept readable so the owner can see and send it
// (only the owner can list their shares, and the public /api/share endpoints never return it). shares.passKey signs
// the cookie a visitor gets after typing the password; pb_hooks/share.pb.js makes a new one whenever the password
// changes, which locks out everyone who got in before.

migrate((app) => {
  const shares = app.findCollectionByNameOrId("shares");
  shares.fields.add(new TextField({ name: "password", max: 100 }));
  shares.fields.add(new TextField({ name: "passKey", max: 100, hidden: true }));
  app.save(shares);
}, (app) => {
  const shares = app.findCollectionByNameOrId("shares");
  for (const n of ["password", "passKey"]) shares.fields.removeByName(n);
  app.save(shares);
});
