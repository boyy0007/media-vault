/// <reference path="../pb_data/types.d.ts" />
// Shared helpers for library.pb.js (hook handlers run in isolated scopes, so shared code lives in a
// module loaded with require()).

// The owner is the oldest account.
function isOwner(uid) {
  const first = $app.findRecordsByFilter("users", "id != ''", "created", 1, 0)[0];
  return !!first && first.id === uid;
}
function requireOwner(e) {
  if (!e.auth || !isOwner(e.auth.id)) throw new ForbiddenError("Only the owner can do that.");
}
// Routes for the desktop status window (MediaVault.ps1) only: they need the secret in pb_data/.status-token as the
// X-Status-Token header. Requests through `tailscale serve` also arrive from 127.0.0.1, so the address can't be trusted.
function requireStatusToken(e) {
  let token = "";
  try { token = toString($os.readFile($filepath.join($app.dataDir(), ".status-token"))).trim(); } catch (_) {}
  const sent = e.request.header.get("X-Status-Token");
  if (token.length < 32 || !$security.equal(sent, token)) throw new NotFoundError();
}

// Regular files (not photos/videos/GIFs): the owner always may; others when the owner has turned it on.
function canStoreFiles(uid) {
  try {
    return isOwner(uid) || $app.findRecordById("users", uid).getBool("allowFiles");
  } catch (_) {
    return false;
  }
}
// Upload names a person without file access may use: photo/video/GIF extensions, or none (some phone pickers
// hand out names without one). Keep in step with IMAGE_EXT / VIDEO_EXT in pb_public/app.js.
const MEDIA_NAME = /(^[^.]*$)|\.(jpe?g|png|webp|bmp|heic|heif|avif|tiff?|insp|gif|mp4|m4v|mov|webm|mkv|avi|wmv|flv|3gp|mpe?g|ts|mts|insv|lrv)$/i;
function isMediaName(name) {
  return MEDIA_NAME.test(String(name || ""));
}

// Bytes stored by a user: library items (Trash included — the files are still there) + locked items.
function usage(uid) {
  const m = new DynamicModel({ bytes: 0, count: 0 });
  $app.db().newQuery("SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS count FROM media WHERE owner = {:uid}").bind({ uid }).one(m);
  const v = new DynamicModel({ bytes: 0, count: 0 });
  $app.db().newQuery("SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS count FROM vault_items WHERE owner = {:uid}").bind({ uid }).one(v);
  return { bytes: m.bytes + v.bytes, items: m.count + v.count };
}

// Size of the files being uploaded with a record (new uploads are filesystem.File values until saved).
function uploadSize(record, fields) {
  let n = 0;
  for (const f of fields) {
    const v = record.get(f);
    if (v && typeof v === "object" && v.size) n += v.size;
  }
  return n;
}

// Refuses an update that adds, replaces or removes any of these file fields.
function keepFiles(e, fields) {
  const before = e.record.original();
  for (const f of fields) {
    if (JSON.stringify(e.record.get(f)) !== JSON.stringify(before.get(f))) {
      throw new BadRequestError("Files can't be replaced on an existing item. Upload it as a new one.");
    }
  }
}

// Who sent a request: requests through `tailscale serve` all come from 127.0.0.1, so for those it's the address
// Tailscale adds last to X-Forwarded-For (anything the visitor sends comes before it). Same as clientIp() in
// pb_sites/pb_hooks/serve_lib.js.
function clientIp(e) {
  const remote = e.remoteIP();
  if (remote === "127.0.0.1" || remote === "::1") {
    const xff = (e.request.header.get("X-Forwarded-For") || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return remote;
}

function fmtBytes(n) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i > 1 ? n.toFixed(1) : Math.round(n)) + " " + u[i];
}

// Throws if `incoming` more bytes would take the user over their quota.
function checkQuota(uid, incoming) {
  let user;
  try { user = $app.findRecordById("users", uid); } catch (_) { return; }
  const quota = user.getInt("quota");
  if (!quota) return;
  const used = usage(uid).bytes;
  if (used + incoming > quota) {
    throw new BadRequestError(`Storage limit reached: you're using ${fmtBytes(used)} of your ${fmtBytes(quota)}` +
      (incoming ? ` and this file is ${fmtBytes(incoming)}` : "") + ". Delete something (and empty Trash) or ask the owner for more space.");
  }
}

module.exports = { isOwner, requireOwner, requireStatusToken, canStoreFiles, isMediaName, usage, uploadSize, checkQuota, keepFiles, clientIp, fmtBytes };
