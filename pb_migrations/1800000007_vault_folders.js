/// <reference path="../pb_data/types.d.ts" />
// Folders inside the locked folder. Encrypted like everything else there (pb_public/vault.js):
//
// vault_folders  `key` is the folder's own key wrapped with the master key; `meta` is the encrypted
//                { name } JSON. Which folder an item is in lives inside the item's encrypted meta
//                (vault_items.meta → folder), so the server can't see the grouping either.
//                Deleting a folder leaves its items pointing at a missing id; the app shows those
//                in the top level of the locked folder again.

const OWNER = "owner = @request.auth.id";
const KEEP_OWNER = "(@request.body.owner:isset = false || @request.body.owner = @request.auth.id)";

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  const folders = new Collection({
    type: "base",
    name: "vault_folders",
    listRule: OWNER,
    viewRule: OWNER,
    createRule: "@request.auth.id != '' && @request.body.owner = @request.auth.id",
    updateRule: `${OWNER} && ${KEEP_OWNER}`,
    deleteRule: OWNER,
    fields: [
      { type: "relation", name: "owner", collectionId: users.id, maxSelect: 1, required: true, cascadeDelete: true },
      { type: "text", name: "key", required: true, max: 500 },
      { type: "text", name: "meta", required: true, max: 2000 },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
    ],
    indexes: ["CREATE INDEX idx_vault_folders_owner ON vault_folders (owner)"],
  });
  app.save(folders);
}, (app) => {
  try { app.delete(app.findCollectionByNameOrId("vault_folders")); } catch (_) {}
});
