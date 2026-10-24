/// <reference path="../pb_data/types.d.ts" />
// Locked folder: end-to-end encrypted items. Everything is encrypted in the browser (pb_public/vault.js)
// before upload, so the server only ever stores ciphertext — files, thumbnails and metadata alike.
//
// vault       one row per user: the random master key, wrapped (encrypted) twice — once with a key
//             derived from the user's passphrase (scrypt), once with the one-time recovery key.
// vault_items the encrypted files. `key` is the item's own file key wrapped with the master key;
//             `meta` is the encrypted name/kind/date/dimensions JSON. Nothing readable is stored.

const OWNER = "owner = @request.auth.id";
const KEEP_OWNER = "(@request.body.owner:isset = false || @request.body.owner = @request.auth.id)";
const timestamps = [
  { type: "autodate", name: "created", onCreate: true, onUpdate: false },
  { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
];

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  const ownerField = { type: "relation", name: "owner", collectionId: users.id, maxSelect: 1, required: true, cascadeDelete: true };

  const vault = new Collection({
    type: "base",
    name: "vault",
    listRule: OWNER,
    viewRule: OWNER,
    createRule: "@request.auth.id != '' && @request.body.owner = @request.auth.id",
    updateRule: `${OWNER} && ${KEEP_OWNER}`,
    deleteRule: null, // losing this row makes every locked item unreadable; superusers only
    fields: [
      ownerField,
      { type: "json", name: "kdf", required: true, maxSize: 500 },
      { type: "text", name: "wrapped", required: true, max: 500 },
      { type: "text", name: "recovery", required: true, max: 500 },
      ...timestamps,
    ],
    indexes: ["CREATE UNIQUE INDEX idx_vault_owner ON vault (owner)"],
  });
  app.save(vault);

  const items = new Collection({
    type: "base",
    name: "vault_items",
    listRule: OWNER,
    viewRule: OWNER,
    createRule: "@request.auth.id != '' && @request.body.owner = @request.auth.id",
    updateRule: `${OWNER} && ${KEEP_OWNER}`,
    deleteRule: OWNER,
    fields: [
      ownerField,
      { type: "file", name: "file", required: true, maxSelect: 1, maxSize: 5 * 1024 * 1024 * 1024, protected: true },
      { type: "file", name: "thumb", maxSelect: 1, maxSize: 5 * 1024 * 1024, protected: true },
      { type: "text", name: "key", required: true, max: 500 },
      { type: "text", name: "meta", required: true, max: 20000 },
      ...timestamps,
    ],
    indexes: ["CREATE INDEX idx_vault_items_owner ON vault_items (owner, created)"],
  });
  app.save(items);
}, (app) => {
  for (const name of ["vault_items", "vault"]) {
    try { app.delete(app.findCollectionByNameOrId(name)); } catch (_) {}
  }
});
