/// <reference path="../pb_data/types.d.ts" />
// Invite codes: once the owner account exists, sign-up needs a valid code (checked in pb_hooks/library.pb.js).
// The owner manages codes in the app via /api/library/invites (pb_hooks/library.pb.js); superusers can also
// use the dashboard. No API rules, so nobody else can list or read them.
//
// maxUses  0 = unlimited; `uses` is bumped by the hook after each successful sign-up.
// expires  optional; empty = never.

migrate((app) => {
  const invites = new Collection({
    type: "base",
    name: "invites",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: "text", name: "code", required: true, min: 6, max: 100 },
      { type: "text", name: "note", max: 200 },
      { type: "number", name: "maxUses", min: 0, onlyInt: true },
      { type: "number", name: "uses", min: 0, onlyInt: true },
      { type: "date", name: "expires" },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_invites_code ON invites (code)"],
  });
  app.save(invites);
}, (app) => {
  app.delete(app.findCollectionByNameOrId("invites"));
});
