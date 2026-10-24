/// <reference path="../pb_data/types.d.ts" />
// Regular (not locked) folders: a place for files, and a way to group albums.
//
// folders       owner + name, one level (folders don't nest).
// albums.folder the folder an album is filed under ("" = top level of Albums).
// media.folder  the folder an item lives in. Like album items, these don't show in the Library.
// Deleting a folder clears both relations, so its albums and items go back to the top level / Library.
// The rules only let you point at your own folder.

const OWNER = "owner = @request.auth.id";
const KEEP_OWNER = "(@request.body.owner:isset = false || @request.body.owner = @request.auth.id)";
const OWN_FOLDER = "(@request.body.folder:isset = false || @request.body.folder = '' || @request.body.folder.owner = @request.auth.id)";
const add = (rule, extra) => {
  const r = String(rule ?? "").trim();
  return r ? `${r} && ${extra}` : extra;
};
const strip = (rule, extra) => String(rule ?? "").replace(` && ${extra}`, "").replace(extra, "");

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  const folders = new Collection({
    type: "base",
    name: "folders",
    listRule: OWNER,
    viewRule: OWNER,
    createRule: "@request.auth.id != '' && @request.body.owner = @request.auth.id",
    updateRule: `${OWNER} && ${KEEP_OWNER}`,
    deleteRule: OWNER,
    fields: [
      { type: "relation", name: "owner", collectionId: users.id, maxSelect: 1, required: true, cascadeDelete: true },
      { type: "text", name: "name", required: true, max: 120 },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
    ],
    indexes: ["CREATE INDEX idx_folders_owner ON folders (owner)"],
  });
  app.save(folders);

  for (const name of ["albums", "media"]) {
    const c = app.findCollectionByNameOrId(name);
    c.fields.add(new RelationField({ name: "folder", collectionId: folders.id, maxSelect: 1, cascadeDelete: false }));
    c.createRule = add(c.createRule, OWN_FOLDER);
    c.updateRule = add(c.updateRule, OWN_FOLDER);
    app.save(c);
  }
}, (app) => {
  for (const name of ["albums", "media"]) {
    const c = app.findCollectionByNameOrId(name);
    c.fields.removeByName("folder");
    c.createRule = strip(c.createRule, OWN_FOLDER);
    c.updateRule = strip(c.updateRule, OWN_FOLDER);
    app.save(c);
  }
  try { app.delete(app.findCollectionByNameOrId("folders")); } catch (_) {}
});
