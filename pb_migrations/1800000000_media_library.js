/// <reference path="../pb_data/types.d.ts" />
// Media library schema: albums + media (photos, GIFs, videos). Every record belongs to one user
// and is only visible to that user. Applied automatically when PocketBase starts.

const OWNER = "owner = @request.auth.id";
const KEEP_OWNER = "(@request.body.owner:isset = false || @request.body.owner = @request.auth.id)";
const timestamps = [
  { type: "autodate", name: "created", onCreate: true, onUpdate: false },
  { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
];

migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  // Media URLs carry a file token; make it last long enough to watch a long video without it expiring mid-stream.
  users.fileToken.duration = 6 * 60 * 60;
  app.save(users);

  const ownerField = { type: "relation", name: "owner", collectionId: users.id, maxSelect: 1, required: true, cascadeDelete: true };

  const albums = new Collection({
    type: "base",
    name: "albums",
    listRule: OWNER,
    viewRule: OWNER,
    createRule: "@request.auth.id != '' && @request.body.owner = @request.auth.id",
    updateRule: `${OWNER} && ${KEEP_OWNER}`,
    deleteRule: OWNER,
    fields: [
      ownerField,
      { type: "text", name: "name", required: true, max: 120 },
      { type: "text", name: "description", max: 1000 },
      ...timestamps,
    ],
    indexes: ["CREATE INDEX idx_albums_owner ON albums (owner)"],
  });
  app.save(albums);

  const media = new Collection({
    type: "base",
    name: "media",
    listRule: OWNER,
    viewRule: OWNER,
    createRule: "@request.auth.id != '' && @request.body.owner = @request.auth.id",
    updateRule: `${OWNER} && ${KEEP_OWNER}`,
    deleteRule: OWNER,
    fields: [
      ownerField,
      // Up to 5 GB per file. Protected = the URL only works with a signed-in user's file token.
      { type: "file", name: "file", required: true, maxSelect: 1, maxSize: 5 * 1024 * 1024 * 1024, protected: true, thumbs: ["400x400"] },
      // Video poster frame, captured in the browser at upload time.
      { type: "file", name: "poster", maxSelect: 1, maxSize: 10 * 1024 * 1024, protected: true, thumbs: ["400x400"], mimeTypes: ["image/jpeg", "image/png", "image/webp"] },
      { type: "select", name: "kind", required: true, maxSelect: 1, values: ["image", "gif", "video"] },
      { type: "text", name: "title", max: 300 },
      { type: "text", name: "originalName", max: 300 },
      { type: "json", name: "tags", maxSize: 4000 },
      { type: "relation", name: "albums", collectionId: albums.id, maxSelect: 999, cascadeDelete: false },
      { type: "bool", name: "favorite" },
      { type: "number", name: "size", onlyInt: true, min: 0 },
      { type: "number", name: "width", onlyInt: true, min: 0 },
      { type: "number", name: "height", onlyInt: true, min: 0 },
      { type: "number", name: "duration", min: 0 },
      { type: "date", name: "takenAt" },
      ...timestamps,
    ],
    indexes: [
      "CREATE INDEX idx_media_owner_created ON media (owner, created)",
      "CREATE INDEX idx_media_owner_taken ON media (owner, takenAt)",
    ],
  });
  app.save(media);
}, (app) => {
  for (const name of ["media", "albums"]) {
    try { app.delete(app.findCollectionByNameOrId(name)); } catch (_) {}
  }
});
