/// <reference path="../pb_data/types.d.ts" />
// users.prefs: appearance settings (theme, accent, grid layout, size, spacing, month headers, sidebar), saved
// by the app so they follow the account across devices. Format: PREF_DEFAULTS in pb_public/app.js.

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.add(new JSONField({ name: "prefs", maxSize: 2000 }));
  app.save(users);
}, (app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.removeByName("prefs");
  app.save(users);
});
