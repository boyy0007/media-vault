/// <reference path="../pb_data/types.d.ts" />
// Numbers for the desktop status window (MediaVault.ps1, opened by start.bat). Not for the app or browsers: it
// needs the secret in pb_data/.status-token (written by the window, never served) as the X-Status-Token header
// (requireStatusToken() in library_lib.js).
routerAdd("GET", "/api/status", (e) => {
  require(`${__hooks}/library_lib.js`).requireStatusToken(e);

  const one = (sql, shape, params) => {
    const m = new DynamicModel(shape);
    $app.db().newQuery(sql).bind(params || {}).one(m);
    return m;
  };
  const count = (sql, params) => one(sql, { n: 0 }, params).n;

  const kinds = arrayOf(new DynamicModel({ kind: "", count: 0, bytes: 0 }));
  $app.db()
    .newQuery("SELECT kind, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM media WHERE COALESCE(trashedAt, '') = '' GROUP BY kind")
    .all(kinds);
  const trash = one("SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM media WHERE COALESCE(trashedAt, '') != ''", { count: 0, bytes: 0 });
  const locked = one("SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM vault_items", { count: 0, bytes: 0 });
  const last = one("SELECT COALESCE(MAX(created), '') AS at FROM media", { at: "" });
  // (.all: a fresh install has no users yet, and .one() would throw on no rows)
  const owners = arrayOf(new DynamicModel({ name: "", email: "" }));
  $app.db().newQuery("SELECT COALESCE(name, '') AS name, email FROM users ORDER BY created LIMIT 1").all(owners);
  const owner = owners[0] || { name: "", email: "" };
  const now = new Date().toISOString().replace("T", " ");

  return e.json(200, {
    users: count("SELECT COUNT(*) AS n FROM users"),
    owner: owner.email ? (owner.name || owner.email) : "",
    kinds: kinds.map((k) => ({ kind: k.kind, count: k.count, bytes: k.bytes })),
    favorites: count("SELECT COUNT(*) AS n FROM media WHERE favorite = TRUE AND COALESCE(trashedAt, '') = ''"),
    trash: { count: trash.count, bytes: trash.bytes },
    albums: count("SELECT COUNT(*) AS n FROM albums"),
    folders: count("SELECT COUNT(*) AS n FROM folders"),
    shares: count("SELECT COUNT(*) AS n FROM shares WHERE COALESCE(expires, '') = '' OR expires > {:now}", { now }),
    invites: count("SELECT COUNT(*) AS n FROM invites"),
    locked: { users: count("SELECT COUNT(*) AS n FROM vault"), count: locked.count, bytes: locked.bytes },
    sites: count("SELECT COUNT(*) AS n FROM sites"),
    lastUpload: last.at,
  });
});
