/// <reference path="../../pb_data/types.d.ts" />
// The sites server has no admin of its own (its dashboard is blocked in serve.pb.js). Creating a superuser with a
// throwaway password stops PocketBase from opening the "create your first superuser" page on every start.
migrate((app) => {
  const su = new Record(app.findCollectionByNameOrId("_superusers"));
  su.set("email", "sites@mediavault.local");
  su.set("password", $security.randomString(40));
  app.save(su);
});
