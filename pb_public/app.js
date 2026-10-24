import PocketBase from "./pocketbase.es.mjs";
import * as V from "./vault.js";
import { sha256 } from "./vendor/noble.js";
import { panoView, panoPoster, detectPano } from "./pano.js";
import { mediaInfo, rangeReader } from "./mediainfo.js";
import { qrSvg, qrPng } from "./qr.js";

const pb = new PocketBase(location.origin);
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const PAGE = 60;
const UPLOAD_CONCURRENCY = 2;

const S = {
  view: "library",      // library | favorites | albums | album | locked | trash | map | day | sites | inbox
  inbox: [],            // shared with me: /api/inbox (refreshInbox())
  day: "",              // YYYY-MM-DD for the "day" view (On this day)
  storage: null,        // { used, quota } from the summary
  allowFiles: false,    // may upload regular files (PDFs, documents…), not just photos/videos; from the summary
  allowPublic: false,   // may make public (internet) share links: the owner, or with the owner's permission; from the summary
  isOwner: false,       // from the summary; only the owner hosts sites
  albumId: "",
  kind: "all",
  q: "",
  sort: "-takenAt",     // set from P.sort at startup; date taken (falls back to upload date) by default
  items: [],
  page: 0,
  totalPages: 1,
  total: 0,
  loading: false,
  gen: 0,               // bumps on every list reset so stale responses are dropped
  curGrid: null,
  lastMonth: null,
  selecting: false,
  selected: new Set(),
  albums: [],
  folders: [],          // regular folders: hold files and group albums
  folderId: "",         // open folder (view "folder")
  kinds: [],
  token: "",
  tokenAt: 0,
  vi: -1,               // viewer index into items
  infoOpen: false,
  dirty: false,         // list needs a reload once the viewer closes
  vault: undefined,     // this user's vault row; undefined = not fetched yet, null = no locked folder set up
  vaultAll: null,       // decrypted locked-folder items (only while unlocked)
  vfolders: null,       // decrypted locked-folder folders (only while unlocked)
  vfolder: "",          // open folder inside the locked folder ("" = top level)
};

// ---------- helpers ----------
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pbDate = s => (s ? new Date(String(s).replace(" ", "T")) : null);
// An icon from the sprite in index.html.
const ic = (name, cls = "") => `<svg class="i${cls ? " " + cls : ""}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const nf = new Intl.NumberFormat();

// ---------- appearance prefs ----------
// Saved in localStorage (applied before first paint by the script in index.html's <head>) and on the
// account (users.prefs), so they follow you to other devices. CSS reads them as data-* on <html>.
const PREF_DEFAULTS = { theme: "dark", accent: "violet", grid: "square", size: 3, spacing: "normal", months: true, sidebar: "full", sort: "-takenAt", sites: "cards" };
const PREF_VALUES = {
  sort: ["-takenAt", "takenAt", "-created", "title", "-size"], // the #sort options
  theme: ["system", "dark", "midnight", "slate", "ocean", "forest", "plum", "mocha", "dusk", "ember", "arctic",
    "light", "paper", "mist", "blush", "sage", "lilac", "sky"],
  accent: ["violet", "blue", "cyan", "teal", "green", "amber", "orange", "rose", "pink", "graphite"],
  grid: ["square", "justified", "captions", "list"], spacing: ["tight", "normal", "roomy"], sidebar: ["full", "compact"],
  sites: ["cards", "list"], // the Sites page
};
function cleanPrefs(p) {
  const out = { ...PREF_DEFAULTS };
  if (!p || typeof p !== "object") return out;
  for (const [k, vals] of Object.entries(PREF_VALUES)) if (vals.includes(p[k])) out[k] = p[k];
  if ([1, 2, 3, 4, 5].includes(+p.size)) out.size = +p.size;
  if (typeof p.months === "boolean") out.months = p.months;
  return out;
}
let P = (() => { try { return cleanPrefs(JSON.parse(localStorage.getItem("mv-prefs") || "{}")); } catch { return cleanPrefs(null); } })();
const sysLight = matchMedia("(prefers-color-scheme: light)");
function applyPrefs() {
  const d = document.documentElement;
  d.dataset.theme = P.theme === "system" ? (sysLight.matches ? "light" : "dark") : P.theme;
  for (const k of ["accent", "grid", "size", "spacing", "sidebar", "sites"]) d.dataset[k] = P[k];
  const bg = getComputedStyle(d).getPropertyValue("--bg").trim();
  if (bg) document.querySelector('meta[name="theme-color"]').content = bg;
  document.getElementById("sideToggle").title = P.sidebar === "compact" ? "Full sidebar" : "Compact sidebar";
}
// A change that redraws the whole page (theme, accent, layout) cross-fades where the browser can (View Transitions;
// the Android WebView too), and just happens where it can't or when reduced motion is asked for.
const lessMotion = matchMedia("(prefers-reduced-motion: reduce)");
function smoothly(fn) {
  if (!document.startViewTransition || lessMotion.matches || document.hidden) return fn();
  document.startViewTransition(fn);
}
sysLight.addEventListener("change", () => P.theme === "system" && smoothly(applyPrefs));
let prefsTimer;
function setPrefs(patch) {
  const before = P;
  P = cleanPrefs({ ...P, ...patch });
  // (Not for the size slider: it changes on every step of a drag.)
  if (["theme", "accent", "grid", "spacing", "sidebar", "sites"].some(k => before[k] !== P[k])) smoothly(applyPrefs);
  else applyPrefs();
  try { localStorage.setItem("mv-prefs", JSON.stringify(P)); } catch {}
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(savePrefs, 800);
  if (before.months !== P.months && ![...PAGE_VIEWS, "locked"].includes(S.view)) resetList();
  if (before.grid !== P.grid || before.size !== P.size || before.spacing !== P.spacing) setTimeout(() => { if (!$("#rail").hidden) railKnob(); }, 50);
}
async function savePrefs() {
  const u = pb.authStore.record;
  if (!u) return;
  try {
    const rec = await pb.collection("users").update(u.id, { prefs: P }, { requestKey: null });
    pb.authStore.save(pb.authStore.token, rec);
  } catch {}
}
// Prefs saved on the account win over this device's copy (they may have been changed elsewhere).
function adoptAccountPrefs(u) {
  if (!u?.prefs || typeof u.prefs !== "object" || Array.isArray(u.prefs)) return;
  P = cleanPrefs(u.prefs);
  try { localStorage.setItem("mv-prefs", JSON.stringify(P)); } catch {}
  applyPrefs();
}
function fmtBytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
}
function fmtDur(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s).padStart(2, "0")}`;
}
const fmtDate = d => (d ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");
function errText(e) {
  const d = e?.response?.data || e?.data?.data;
  const field = d && Object.values(d)[0]?.message;
  return field || e?.response?.message || e?.message || "Something went wrong";
}
let toastTimer;
// action: { label, run } adds a button (e.g. Undo) to the toast.
function toast(msg, ms = 3000, action = null) {
  const t = $("#toast");
  t.textContent = msg;
  if (action) {
    const b = document.createElement("button");
    b.className = "toast-act";
    b.textContent = action.label;
    b.onclick = () => { t.hidden = true; action.run(); };
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// Thumbnails fade in once they've arrived (app.css: img.in). load/error don't bubble, so this listens on the way down.
for (const t of ["load", "error"]) document.addEventListener(t, e => { if (e.target.tagName === "IMG") e.target.classList.add("in"); }, true);

// File URLs are protected; they need a short-lived file token.
async function ensureToken() {
  if (!S.token || Date.now() - S.tokenAt > 60 * 60 * 1000) {
    S.token = await pb.files.getToken({ requestKey: null });
    S.tokenAt = Date.now();
  }
}
const fileUrl = (r, name, params = {}) => pb.files.getURL(r, name, { token: S.token, ...params });
function thumbUrl(r) {
  if (r.kind === "file") return "";
  const name = r.poster || (r.kind === "video" ? "" : r.file); // photos have a poster when raw 360 (a stitched view)
  return name ? fileUrl(r, name, { thumb: "400x400" }) : "";
}

// ---------- modal ----------
let modalDone = null;
let modalSticky = false; // true = backdrop / Esc / Back don't close it (work in progress, recovery key screen)
let modalHideTimer = 0;
// Open = showing and not on its way out (it fades for a moment after closeModal()).
const modalOpen = () => !$("#modal").hidden && !$("#modal").classList.contains("closing");
function openModal(html, wide = false) {
  modalSticky = false;
  clearTimeout(modalHideTimer); // (a dialog opened straight after another one closed replaces it)
  $("#modal").classList.remove("closing");
  $("#modalCard").innerHTML = html;
  $("#modalCard").classList.toggle("wide", wide);
  $("#modal").hidden = false;
  return $("#modalCard");
}
function closeModal(value = null) {
  const m = $("#modal");
  if (lessMotion.matches || m.hidden) {
    m.hidden = true;
    $("#modalCard").innerHTML = "";
  } else {
    m.classList.add("closing");
    clearTimeout(modalHideTimer);
    modalHideTimer = setTimeout(() => { m.hidden = true; m.classList.remove("closing"); $("#modalCard").innerHTML = ""; }, 170);
  }
  modalSticky = false;
  const done = modalDone;
  modalDone = null;
  done?.(value);
}
$("#modal").addEventListener("mousedown", e => { if (e.target.id === "modal" && !modalSticky) closeModal(null); });

function ask(title, value = "", okText = "Save") {
  return new Promise(res => {
    modalDone = res;
    const card = openModal(`<h3>${esc(title)}</h3>
      <form class="grid-gap"><input name="v" value="${esc(value)}" maxlength="120" required autofocus>
      <div class="modal-actions" style="margin-top:14px"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">${esc(okText)}</button></div></form>`);
    const input = $("input", card);
    input.focus();
    input.select();
    $("[data-x]", card).onclick = () => closeModal(null);
    $("form", card).onsubmit = e => { e.preventDefault(); closeModal(input.value.trim() || null); };
  });
}
function confirmBox(title, text, okText = "Delete") {
  return new Promise(res => {
    modalDone = res;
    const card = openModal(`<h3>${esc(title)}</h3><p>${esc(text)}</p>
      <div class="modal-actions"><button class="btn" data-x>Cancel</button><button class="btn primary" data-ok style="background:var(--danger);border-color:var(--danger)">${esc(okText)}</button></div>`);
    $("[data-x]", card).onclick = () => closeModal(false);
    $("[data-ok]", card).onclick = () => closeModal(true);
    $("[data-ok]", card).focus();
  });
}
function pickAlbum(title) {
  return new Promise(res => {
    modalDone = res;
    const card = openModal(`<h3>${esc(title)}</h3>
      <div class="pick-list">${S.albums.filter(a => !a.rules).map(a => `<button data-id="${a.id}">${ic("images")}<span class="nm">${esc(a.name)}</span><span class="muted">${nf.format(a.count)}</span></button>`).join("")}
      <button data-new class="new">${ic("plus")}<span class="nm">New album…</span></button></div>
      <div class="modal-actions"><button class="btn" data-x>Cancel</button></div>`);
    $("[data-x]", card).onclick = () => closeModal(null);
    $$("[data-id]", card).forEach(b => (b.onclick = () => closeModal(b.dataset.id)));
    $("[data-new]", card).onclick = async () => {
      modalDone = null;
      closeModal();
      const a = await createAlbum();
      res(a ? a.id : null);
    };
  });
}

// ---------- auth ----------
// authMode: "owner" (first run), "signin", or "invite" (sign up with an invite code).
let authMode = "signin";
async function showAuth() {
  $("#app").hidden = true;
  $("#auth").hidden = false;
  let needsOwner = false;
  try { needsOwner = (await pb.send("/api/library/setup", { requestKey: null })).needsOwner; } catch {}
  setAuthMode(needsOwner ? "owner" : "signin");
}
function setAuthMode(mode) {
  authMode = mode;
  const signup = mode !== "signin";
  $("#nameRow").hidden = $("#confirmRow").hidden = !signup;
  $("#inviteRow").hidden = mode !== "invite";
  $("#authForm [name=invite]").required = mode === "invite";
  $("#authToggle").hidden = mode === "owner";
  $("#authToggle").textContent = mode === "invite" ? "Already have an account? Sign in" : "Have an invite code? Create an account";
  $("#authHint").textContent = {
    owner: "Welcome! Create the owner account for your library.",
    signin: "Sign in to your library",
    invite: "Create your account with the invite code you were given.",
  }[mode];
  $("#authSubmit").textContent = signup ? "Create account" : "Sign in";
  $("#authForm [name=password]").autocomplete = signup ? "new-password" : "current-password";
  $("#authError").hidden = true;
  $("#authForm [name=email]").focus();
}
$("#authToggle").onclick = () => setAuthMode(authMode === "invite" ? "signin" : "invite");
$("#authForm").addEventListener("submit", async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const err = $("#authError");
  err.hidden = true;
  const btn = $("#authSubmit");
  btn.disabled = true;
  try {
    if (authMode !== "signin") {
      if (f.get("password") !== f.get("confirm")) throw new Error("Passwords don't match");
      await pb.collection("users").create({
        name: f.get("name"), email: f.get("email"), password: f.get("password"), passwordConfirm: f.get("confirm"),
        ...(authMode === "invite" && { invite: f.get("invite").trim() }),
      });
    }
    await pb.collection("users").authWithPassword(f.get("email"), f.get("password"));
    startApp();
  } catch (ex) {
    err.textContent = ex.status === 400 && authMode === "signin" ? "Wrong email or password" : errText(ex);
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});
$("#logoutBtn").onclick = async () => {
  if (uploadsBusy() && !(await confirmBox("Uploads in progress", "Signing out will stop them.", "Sign out"))) return;
  pb.authStore.clear();
  location.hash = "";
  location.reload();
};

async function startApp() {
  $("#auth").hidden = true;
  $("#app").hidden = false;
  const u = pb.authStore.record;
  $("#whoami").textContent = u.name || u.email;
  $("#avatar").textContent = (u.name || u.email || "?").trim().charAt(0).toUpperCase();
  adoptAccountPrefs(u);
  S.sort = P.sort;
  $("#sort").value = S.sort;
  await loadSummary();
  applyRoute();
}

// ---------- summary (sidebar) ----------
async function loadSummary() {
  try {
    const res = await pb.send("/api/library/summary", { requestKey: "summary" });
    S.folders = res.folders || [];
    S.albums = (res.albums || []).map(a => ({ ...a, rules: parseRules(a.rules) }));
    S.kinds = res.kinds || [];
    S.storage = res.storage || null;
    S.isOwner = !!res.isOwner;
    $("#invitesBtn").hidden = $("#sitesNav").hidden = !res.isOwner;
    S.allowFiles = !!res.allowFiles;
    S.allowPublic = !!res.allowPublic;
    $("#galleriesNav").hidden = !canGallery();
    $("#trashCount").textContent = res.trash?.count ? nf.format(res.trash.count) : "";
    renderSidebar();
    applyFileAccess();
    refreshInbox();
    if (S.view === "albums" || S.view === "folder") renderAlbumGrid();
    updateTitle();
    smartCounts();
  } catch (e) {
    if (!e.isAbort) console.warn(e);
  }
}
// Smart albums: the server doesn't evaluate rules for the summary, so count + cover come from a query each.
async function smartCounts() {
  const smart = S.albums.filter(a => a.rules);
  if (!smart.length) return;
  await Promise.all(smart.map(async a => {
    try {
      const { filter, params } = smartFilter(a.rules);
      const res = await pb.collection("media").getList(1, 1, {
        filter: pb.filter("trashedAt = ''" + (filter ? ` && ${filter}` : ""), params),
        sort: "-takenAt", fields: "id,kind,file,poster", requestKey: null,
      });
      const c = res.items[0];
      a.count = res.totalItems;
      a.cover = c ? `${c.id}|${c.kind}|${c.file}|${c.poster || ""}` : "";
    } catch {}
  }));
  renderSidebar();
  if (S.view === "albums" || S.view === "folder") renderAlbumGrid();
}

// ---------- smart albums ----------
// rules: { kinds: ["image","video","gif"] (empty = all), favorite, tags: [] (any of), from/to: "YYYY-MM-DD",
// text, located }. Keep smartFilter in sync with the server copy in pb_hooks/share_lib.js.
function parseRules(raw) {
  if (!raw) return null;
  try { const r = typeof raw === "string" ? JSON.parse(raw) : raw; return r && typeof r === "object" && !Array.isArray(r) ? r : null; } catch { return null; }
}
function smartFilter(rules) {
  const parts = [], params = {};
  const kinds = (rules.kinds || []).filter(k => ["image", "video", "gif"].includes(k));
  if (kinds.length && kinds.length < 3) parts.push("(" + kinds.map((k, i) => { params["k" + i] = k; return `kind = {:k${i}}`; }).join(" || ") + ")");
  if (rules.favorite) parts.push("favorite = true");
  const tags = (rules.tags || []).map(t => String(t).trim()).filter(Boolean).slice(0, 20);
  if (tags.length) parts.push("(" + tags.map((t, i) => { params["t" + i] = JSON.stringify(t); return `tags ~ {:t${i}}`; }).join(" || ") + ")");
  if (/^\d{4}-\d\d-\d\d$/.test(rules.from || "")) { params.from = rules.from + " 00:00:00.000Z"; parts.push("takenAt >= {:from}"); }
  if (/^\d{4}-\d\d-\d\d$/.test(rules.to || "")) { params.to = rules.to + " 23:59:59.999Z"; parts.push("takenAt <= {:to}"); }
  if (rules.text) { params.sq = String(rules.text).slice(0, 100); parts.push("(title ~ {:sq} || originalName ~ {:sq})"); }
  if (rules.located) parts.push("lat != 0");
  return { filter: parts.join(" && "), params };
}
function describeRules(r) {
  const bits = [];
  const kinds = r.kinds?.length && r.kinds.length < 3 ? r.kinds.map(k => ({ image: "photos", video: "videos", gif: "GIFs" }[k])).join(" & ") : "everything";
  bits.push(r.favorite ? `favorite ${kinds}` : kinds);
  if (r.tags?.length) bits.push(`tagged ${r.tags.join(" or ")}`);
  if (r.from && r.to) bits.push(`from ${r.from} to ${r.to}`); else if (r.from) bits.push(`since ${r.from}`); else if (r.to) bits.push(`until ${r.to}`);
  if (r.text) bits.push(`named “${r.text}”`);
  if (r.located) bits.push("with a location");
  return bits.join(", ");
}
function readRules(f) {
  const kinds = $$("[name=k]:checked", f).map(x => x.value);
  return {
    kinds: kinds.length === 3 ? [] : kinds,
    favorite: f.favorite.checked,
    tags: f.tags.value.split(",").map(t => t.trim()).filter(Boolean),
    from: f.from.value, to: f.to.value,
    text: f.text.value.trim(),
    located: f.located.checked,
  };
}
async function smartAlbumForm(album = null) {
  const r = album?.rules || {};
  const kinds = r.kinds?.length ? r.kinds : ["image", "video", "gif"];
  const chk = k => (kinds.includes(k) ? "checked" : "");
  let countTimer;
  const saved = formModal(`<h3>${album ? "Edit smart album" : "New smart album"}</h3>
    <p>Photos and videos that match these rules appear automatically, including ones you upload later.</p>
    <label class="field">Name<input name="name" required maxlength="120" value="${esc(album?.name || "")}" placeholder="e.g. Beach days"></label>
    <div class="field">Include<div class="seg-checks">
      <label><input type="checkbox" name="k" value="image" ${chk("image")}><span>Photos</span></label>
      <label><input type="checkbox" name="k" value="video" ${chk("video")}><span>Videos</span></label>
      <label><input type="checkbox" name="k" value="gif" ${chk("gif")}><span>GIFs</span></label></div></div>
    <label class="field">Tagged with any of<input name="tags" value="${esc((r.tags || []).join(", "))}" placeholder="beach, holiday"></label>
    <div class="two"><label class="field">Taken from<input type="date" name="from" value="${esc(r.from || "")}"></label>
      <label class="field">Until<input type="date" name="to" value="${esc(r.to || "")}"></label></div>
    <label class="field">Name contains<input name="text" value="${esc(r.text || "")}" maxlength="100"></label>
    <label class="ack"><input type="checkbox" name="favorite" ${r.favorite ? "checked" : ""}> Favorites only</label>
    <label class="ack"><input type="checkbox" name="located" ${r.located ? "checked" : ""}> Only items with a location</label>
    <p class="match" data-match>Counting…</p>`,
  album ? "Save" : "Create", async f => {
    const rules = readRules(f);
    if (!$$("[name=k]:checked", f).length) throw new Error("Pick at least one type");
    const data = { name: f.name.value.trim(), rules };
    return album ? pb.collection("albums").update(album.id, data, { requestKey: null })
      : pb.collection("albums").create({ ...data, owner: pb.authStore.record.id, folder: openFolder() }, { requestKey: null });
  });
  // live "Matches N items" while editing
  const f = $("#modalCard form");
  const count = async () => {
    const out = $("[data-match]", f);
    if (!out) return;
    try {
      const { filter, params } = smartFilter(readRules(f));
      const res = await pb.collection("media").getList(1, 1, { filter: pb.filter("trashedAt = ''" + (filter ? ` && ${filter}` : ""), params), fields: "id", requestKey: "smartcount" });
      out.innerHTML = `${ic("sparkles")}Matches <strong>${nf.format(res.totalItems)}</strong> item${res.totalItems === 1 ? "" : "s"} right now`;
    } catch (e) { if (!e.isAbort) out.textContent = ""; }
  };
  f.addEventListener("input", () => { clearTimeout(countTimer); countTimer = setTimeout(count, 300); });
  f.addEventListener("change", () => { clearTimeout(countTimer); countTimer = setTimeout(count, 100); });
  count();
  const a = await saved;
  if (!a) return null;
  await loadSummary();
  toast(album ? "Smart album updated" : `Smart album “${a.name}” created`);
  return a;
}
// "+" in the sidebar / "New" on the albums page: an album, a smart album, or a folder.
// Inside a folder, new albums are filed in it (and there's no "Folder" choice — folders don't nest).
function newAlbumChooser() {
  return new Promise(res => {
    modalDone = res;
    const card = openModal(`<h3>Create new</h3>
      <div class="choice">
        <button data-kind="plain">${ic("folder-plus")}<span><strong>Album</strong><small>Pick the photos and videos yourself.</small></span></button>
        <button data-kind="smart">${ic("sparkles")}<span><strong>Smart album</strong><small>Fills itself from rules: tags, dates, favorites, type, location.</small></span></button>
        ${openFolder() ? "" : `<button data-kind="folder">${ic("folder")}<span><strong>Folder</strong><small>Keep files in it, and organise albums into it.</small></span></button>`}
      </div>
      <div class="modal-actions"><button class="btn" data-x>Cancel</button></div>`);
    $("[data-x]", card).onclick = () => closeModal(null);
    $$("[data-kind]", card).forEach(b => (b.onclick = async () => {
      modalDone = null;
      closeModal();
      if (b.dataset.kind === "folder") {
        const f = await createFolder();
        if (f) go(`#folder/${f.id}`);
        return res(null);
      }
      res(b.dataset.kind === "smart" ? await smartAlbumForm() : await createAlbum());
    }));
  });
}
const openFolder = () => (S.view === "folder" ? S.folderId : "");
async function createFolder() {
  const name = await ask("New folder", "", "Create");
  if (!name) return null;
  try {
    const f = await pb.collection("folders").create({ name, owner: pb.authStore.record.id }, { requestKey: null });
    await loadSummary();
    toast(`Folder “${name}” created`);
    return f;
  } catch (e) { toast(errText(e)); return null; }
}
// Pick a folder: its id, "" for "no folder" (when allowNone), or null if cancelled.
function pickFolder(title, { allowNone = false, except = "" } = {}) {
  return new Promise(res => {
    modalDone = res;
    const card = openModal(`<h3>${esc(title)}</h3>
      <div class="pick-list">
        ${allowNone ? `<button data-id="">${ic("images")}<span class="nm">No folder</span></button>` : ""}
        ${S.folders.filter(f => f.id !== except).map(f => `<button data-id="${f.id}">${ic("folder")}<span class="nm">${esc(f.name)}</span></button>`).join("")}
        <button data-new class="new">${ic("plus")}<span class="nm">New folder…</span></button></div>
      <div class="modal-actions"><button class="btn" data-x>Cancel</button></div>`);
    $("[data-x]", card).onclick = () => closeModal(null);
    $$("[data-id]", card).forEach(b => (b.onclick = () => closeModal(b.dataset.id)));
    $("[data-new]", card).onclick = async () => {
      modalDone = null;
      closeModal();
      const f = await createFolder();
      res(f ? f.id : null);
    };
  });
}
const loadSummarySoon = debounce(loadSummary, 600);

// Albums whose folder still exists are filed under it; the rest are at the top level.
const filedIn = a => (a.folder && S.folders.some(f => f.id === a.folder) ? a.folder : "");
function renderSidebar() {
  const album = (a, sub) => `<button data-album="${a.id}" class="${sub ? "sub " : ""}${S.view === "album" && S.albumId === a.id ? "active" : ""}">
        ${ic(a.rules ? "sparkles" : "images")}<span class="nm">${esc(a.name)}</span><span class="n">${nf.format(a.count)}</span></button>`;
  $("#albumList").innerHTML = S.albums.length || S.folders.length
    ? S.folders.map(f => `<button data-folder="${f.id}" class="${S.view === "folder" && S.folderId === f.id ? "active" : ""}">
        ${ic("folder")}<span class="nm">${esc(f.name)}</span><span class="n">${f.count ? nf.format(f.count) : ""}</span></button>`
        + S.albums.filter(a => filedIn(a) === f.id).map(a => album(a, true)).join("")).join("")
      + S.albums.filter(a => !filedIn(a)).map(a => album(a, false)).join("")
    : `<p class="muted" style="padding:4px 10px;margin:0;font-size:12px">No albums yet</p>`;
  const by = Object.fromEntries(S.kinds.map(k => [k.kind, k]));
  const bytes = S.kinds.reduce((s, k) => s + k.bytes, 0);
  const c = k => nf.format(by[k]?.count || 0);
  const seg = k => (bytes ? `<i class="k-${k}" style="width:${((by[k]?.bytes || 0) / bytes) * 100}%"></i>` : "");
  const legend = `<div class="st-legend"><span><i class="k-image"></i>${c("image")} photos</span><span><i class="k-video"></i>${c("video")} videos</span><span><i class="k-gif"></i>${c("gif")} GIFs</span>${by.file?.count ? `<span><i class="k-file"></i>${c("file")} files</span>` : ""}</div>`;
  const st = S.storage;
  if (st?.quota) {
    const pct = Math.min(100, (st.used / st.quota) * 100);
    $("#stats").innerHTML = `<div class="st-top"><strong>${fmtBytes(st.used)}</strong><span>of ${fmtBytes(st.quota)}</span></div>
      <div class="st-bar${pct > 90 ? " full" : ""}"><i class="st-fill" style="width:${pct}%"></i></div>
      ${legend}
      ${pct > 90 ? `<p class="st-warn">${pct >= 100 ? "Storage full" : "Almost full"}: delete something or ask the owner for more space.</p>` : ""}`;
    return;
  }
  $("#stats").innerHTML = `<div class="st-top"><strong>${fmtBytes(bytes)}</strong><span>used</span></div>
    <div class="st-bar">${seg("image")}${seg("video")}${seg("gif")}${seg("file")}</div>
    ${legend}`;
}
// Regular files: the picker, the drop hint and the "Files" filter follow whether this account may store them.
function applyFileAccess() {
  const has = S.kinds.some(k => k.kind === "file" && k.count);
  if (S.allowFiles) $("#fileInput").removeAttribute("accept");
  else $("#fileInput").accept = "image/*,video/*,.gif,.mkv,.avi,.mov,.heic,.insp,.insv,.lrv";
  $('.chip[data-kind="file"]').hidden = !S.allowFiles && !has && S.kind !== "file";
  $("#dropText").textContent = S.allowFiles ? "Drop photos, videos and files to upload" : "Drop photos, videos and GIFs to upload";
}
$("#albumList").addEventListener("click", e => {
  const b = e.target.closest("[data-album]");
  if (b) go(`#album/${b.dataset.album}`);
  const f = e.target.closest("[data-folder]");
  if (f) go(`#folder/${f.dataset.folder}`);
});

async function createAlbum() {
  const name = await ask("New album", "", "Create");
  if (!name) return null;
  try {
    const a = await pb.collection("albums").create({ name, owner: pb.authStore.record.id, folder: openFolder() });
    await loadSummary();
    toast(`Album “${name}” created`);
    return a;
  } catch (e) {
    toast(errText(e));
    return null;
  }
}
$("#newAlbumBtn").onclick = async () => {
  const a = await newAlbumChooser();
  if (a) go(`#album/${a.id}`);
};

// ---------- invites (owner only) ----------
function copyText(text) {
  // navigator.clipboard needs https; fall back to execCommand on the plain-http LAN address.
  if (navigator.clipboard && isSecureContext) return navigator.clipboard.writeText(text).then(() => toast("Copied"), () => toast(text, 6000));
  const t = document.createElement("textarea");
  t.value = text;
  document.body.append(t);
  t.select();
  try { toast(document.execCommand("copy") ? "Copied" : text, 6000); } catch { toast(text, 6000); }
  t.remove();
}
const GB = 1024 ** 3;
const QUOTAS = [0, 1 * GB, 5 * GB, 10 * GB, 25 * GB, 50 * GB, 100 * GB, 250 * GB, 500 * GB, 1024 * GB];
const quotaLabel = q => (q ? fmtBytes(q) : "No limit");
const quotaOptions = cur => [...new Set([...QUOTAS, cur || 0])].sort((a, b) => a - b)
  .map(q => `<option value="${q}" ${q === (cur || 0) ? "selected" : ""}>${quotaLabel(q)}</option>`).join("");
function inviteRow(r) {
  const exp = pbDate(r.expires);
  const expired = exp && exp < new Date();
  const usedUp = r.maxUses > 0 && r.uses >= r.maxUses;
  const meta = [
    r.note,
    r.maxUses > 0 ? `${r.uses}/${r.maxUses} used` : `${r.uses} used`,
    r.quota ? `${fmtBytes(r.quota)} limit` : "",
    r.allowFiles ? "files allowed" : "",
    expired ? "expired" : exp ? `expires ${exp.toLocaleDateString()}` : "",
    usedUp ? "used up" : "",
  ].filter(Boolean).join(" · ");
  return `<div class="inv${expired || usedUp ? " dead" : ""}">
    <div class="inv-main"><span class="inv-code">${esc(r.code)}</span><span class="inv-meta">${esc(meta)}</span></div>
    <button class="icon-btn sm" data-copy="${esc(r.code)}" title="Copy">${ic("copy")}</button>
    <button class="icon-btn sm danger" data-del="${esc(r.id)}" title="Delete">${ic("trash")}</button></div>`;
}
function personRow(p) {
  const pct = p.quota ? Math.min(100, (p.used / p.quota) * 100) : 0;
  return `<div class="person" data-id="${esc(p.id)}">
    <span class="avatar">${esc((p.name || p.email || "?").trim().charAt(0).toUpperCase())}</span>
    <div class="person-main">
      <span class="person-name">${esc(p.name || p.email)}${p.owner ? `<span class="tag-owner">Owner</span>` : ""}</span>
      <span class="inv-meta">${esc(p.name ? p.email : "")}${p.name ? " · " : ""}${nf.format(p.items)} item${p.items === 1 ? "" : "s"}</span>
      <div class="usage"><div class="st-bar${pct > 90 ? " full" : ""}">${p.quota ? `<i class="st-fill" style="width:${pct}%"></i>` : ""}</div>
        <span>${fmtBytes(p.used)}${p.quota ? ` of ${fmtBytes(p.quota)}` : " used"}</span></div>
    </div>
    ${p.owner ? "" : `<div class="person-ctl">
      <label class="select quota" title="Storage limit">${ic("sliders")}<select data-quota>${quotaOptions(p.quota)}</select></label>
      <label class="switch files" title="Can store regular files (PDFs, documents…), in the library and the locked folder">Files<input type="checkbox" data-files ${p.allowFiles ? "checked" : ""}></label>
      <label class="switch files" title="Can make public links that open on the internet (temporary, through the sites' address)">Public links<input type="checkbox" data-public ${p.allowPublic ? "checked" : ""}></label>
    </div>`}
  </div>`;
}
async function openInvites() {
  $("#app").classList.remove("nav-open");
  const card = openModal(`<h3>People</h3>
    <p>Everyone here has their own private library. Set how much each person can store (uploads stop at the limit), whether they can store regular files like PDFs and documents, and whether they can make public links that open on the internet.</p>
    <div class="people-list"><p class="muted">Loading…</p></div>
    <div class="files-all" hidden><span>Files for everyone else</span><button type="button" class="btn sm" data-all="1">Turn on</button><button type="button" class="btn sm" data-all="0">Turn off</button></div>
    <h4 class="sub">Invite someone</h4>
    <p>Share a code. They tap “Have an invite code? Create an account” on the sign-in screen.</p>
    <div class="inv-list"><p class="muted">Loading…</p></div>
    <form class="inv-new">
      <input name="note" placeholder="Who is it for? (optional)" maxlength="200">
      <label>Uses<select name="maxUses"><option value="1">1 person</option><option value="5">5 people</option><option value="0">Unlimited</option></select></label>
      <label>Expires<select name="days"><option value="7">In 7 days</option><option value="30">In 30 days</option><option value="0">Never</option></select></label>
      <label class="full">Storage limit for the new account<select name="quota">${quotaOptions(10 * GB)}</select></label>
      <label class="ack full"><input type="checkbox" name="allowFiles"> Can store regular files too (PDFs, documents…)</label>
      <button class="btn primary" style="grid-column:1/-1">${ic("plus")}New invite code</button>
    </form>
    <div class="modal-actions"><button type="button" class="btn" data-x>Close</button></div>`, true);
  const list = $(".inv-list", card), people = $(".people-list", card);
  let rows = [], folks = [];
  const render = () => (list.innerHTML = rows.length ? rows.map(inviteRow).join("") : `<p class="muted">No invite codes yet.</p>`);
  const allBox = $(".files-all", card);
  const renderPeople = () => {
    people.innerHTML = folks.map(personRow).join("");
    allBox.hidden = !folks.some(p => !p.owner);
  };
  const setFiles = async (id, on) => {
    const res = await pb.send(`/api/library/people/${id}`, { method: "POST", body: { allowFiles: on }, requestKey: null });
    folks = folks.map(p => (p.id === id ? { ...p, allowFiles: res.allowFiles } : p));
  };
  $("[data-x]", card).onclick = () => closeModal(null);
  allBox.onclick = async e => {
    const b = e.target.closest("[data-all]");
    if (!b) return;
    const on = b.dataset.all === "1";
    try {
      for (const p of folks.filter(x => !x.owner && x.allowFiles !== on)) await setFiles(p.id, on);
      toast(on ? "Everyone can store files" : "Files turned off for everyone else");
    } catch (ex) { toast(errText(ex)); }
    renderPeople();
  };
  people.onchange = async e => {
    const pub = e.target.closest("[data-public]");
    if (pub) {
      const p = folks.find(x => x.id === pub.closest(".person").dataset.id);
      try {
        const res = await pb.send(`/api/library/people/${p.id}`, { method: "POST", body: { allowPublic: pub.checked }, requestKey: null });
        folks = folks.map(x => (x.id === p.id ? { ...x, allowPublic: res.allowPublic } : x));
        toast(`${p.name || p.email}: public links ${res.allowPublic ? "on" : "off - their public links are off the internet now"}`);
      } catch (ex) { toast(errText(ex)); }
      renderPeople();
      return;
    }
    const chk = e.target.closest("[data-files]");
    if (chk) {
      const p = folks.find(x => x.id === chk.closest(".person").dataset.id);
      try {
        await setFiles(p.id, chk.checked);
        toast(`${p.name || p.email}: files ${chk.checked ? "on" : "off"}`);
      } catch (ex) { toast(errText(ex)); }
      renderPeople();
      return;
    }
    const sel = e.target.closest("[data-quota]");
    if (!sel) return;
    const id = sel.closest(".person").dataset.id;
    try {
      const res = await pb.send(`/api/library/people/${id}`, { method: "POST", body: { quota: +sel.value }, requestKey: null });
      folks = folks.map(p => (p.id === id ? { ...p, quota: res.quota } : p));
      renderPeople();
      toast(`Storage limit: ${quotaLabel(res.quota)}`);
    } catch (ex) { toast(errText(ex)); }
  };
  list.onclick = async e => {
    const c = e.target.closest("[data-copy]");
    if (c) return copyText(c.dataset.copy);
    const d = e.target.closest("[data-del]");
    if (!d) return;
    try {
      await pb.send(`/api/library/invites/${d.dataset.del}`, { method: "DELETE", requestKey: null });
      rows = rows.filter(r => r.id !== d.dataset.del);
      render();
    } catch (ex) { toast(errText(ex)); }
  };
  const f = $("form", card);
  f.onsubmit = async e => {
    e.preventDefault();
    const btn = $("button", f);
    btn.disabled = true;
    try {
      const r = await pb.send("/api/library/invites", {
        method: "POST", requestKey: null,
        body: { note: f.note.value.trim(), maxUses: +f.maxUses.value, days: +f.days.value, quota: +f.quota.value, allowFiles: f.allowFiles.checked },
      });
      rows = [r, ...rows];
      render();
      f.note.value = "";
      copyText(r.code);
    } catch (ex) { toast(errText(ex)); }
    btn.disabled = false;
  };
  try {
    [rows, folks] = await Promise.all([
      pb.send("/api/library/invites", { requestKey: null }),
      pb.send("/api/library/people", { requestKey: null }),
    ]);
    render();
    renderPeople();
  } catch (e) { list.innerHTML = people.innerHTML = `<p class="error">${esc(errText(e))}</p>`; }
}
$("#invitesBtn").onclick = openInvites;

// ---------- routing ----------
// Pages without a photo grid of their own.
const PAGE_VIEWS = ["albums", "map", "sites", "inbox", "galleries"];
function go(hash) {
  if (location.hash === hash || (!location.hash && hash === "#library")) applyRoute(hash);
  else location.hash = hash;
}
window.addEventListener("hashchange", () => applyRoute());

let lastRoute = null;
function applyRoute(hash = location.hash) {
  const [v, id] = hash.replace(/^#/, "").split("/");
  const prev = S.view;
  if (lastRoute !== null && lastRoute !== hash) {
    scrollTo(0, 0); // a different page starts at the top...
    const app = $("#app"); // ...and its content eases in (app.css: .view-enter)
    app.classList.remove("view-enter");
    void app.offsetWidth;
    app.classList.add("view-enter");
  }
  lastRoute = hash;
  closeSiteFrame();
  S.view = ["favorites", "albums", "album", "folder", "locked", "trash", "map", "day", "sites", "inbox", "galleries"].includes(v) ? v : "library";
  S.day = S.view === "day" && /^\d{4}-\d\d-\d\d$/.test(id || "") ? id : "";
  if (S.view === "day" && !S.day) S.view = "library";
  if (prev === "locked" && S.view !== "locked") lockVault(); // leaving the locked folder locks it
  if (prev !== S.view && S.selecting) setSelecting(false);
  S.albumId = S.view === "album" ? id || "" : "";
  if (S.view === "album" && !S.albumId) S.view = "albums";
  S.folderId = S.view === "folder" ? id || "" : "";
  if (S.view === "folder" && !S.folderId) S.view = "albums";
  S.vfolder = S.view === "locked" ? id || "" : "";

  $$(".nav [data-nav]").forEach(b => b.classList.toggle("active", b.dataset.nav === S.view || (["album", "folder"].includes(S.view) && b.dataset.nav === "albums")));
  $$("#albumList [data-album]").forEach(b => b.classList.toggle("active", S.view === "album" && b.dataset.album === S.albumId));
  $$("#albumList [data-folder]").forEach(b => b.classList.toggle("active", S.view === "folder" && b.dataset.folder === S.folderId));
  $("#app").classList.remove("nav-open");

  const albumsPage = S.view === "albums", mapPage = S.view === "map", sitesPage = S.view === "sites", inboxPage = S.view === "inbox", galleriesPage = S.view === "galleries";
  const noGrid = PAGE_VIEWS.includes(S.view);
  const smart = S.view === "album" && !!S.albums.find(a => a.id === S.albumId)?.rules;
  $("#grid").hidden = noGrid;
  $("#sentinel").hidden = noGrid;
  $("#filters").hidden = noGrid;
  $("#albumGrid").hidden = !albumsPage && S.view !== "folder";
  $("#albumGrid").classList.toggle("in-folder", S.view === "folder");
  $("#mapView").hidden = !mapPage;
  $("#sitesView").hidden = !sitesPage;
  $("#inboxView").hidden = !inboxPage;
  $("#galleriesView").hidden = !galleriesPage;
  $("#albumActions").hidden = S.view !== "album";
  $("#folderActions").hidden = S.view !== "folder";
  $("#editRulesBtn").hidden = !smart;
  $('[data-bulk="unalbum"]').hidden = !(S.view === "album" && !smart) && S.view !== "folder";
  const locked = S.view === "locked", trash = S.view === "trash";
  for (const k of ["fav", "album", "lock", "share", "folder"]) $(`[data-bulk="${k}"]`).hidden = locked || trash;
  $('[data-bulk="gallery"]').hidden = locked || trash || !canGallery();
  $("#galleryAlbumBtn").hidden = !canGallery();
  $('[data-bulk="unlock"]').hidden = $('[data-bulk="move"]').hidden = !locked;
  $('[data-bulk="album"] span').textContent = S.view === "library" ? "Move to album" : "Add to album";
  $('[data-bulk="restore"]').hidden = !trash;
  $('[data-bulk="delete"] span').textContent = trash ? "Delete forever" : "Delete";
  $("#trashActions").hidden = !trash;
  $("#trashNote").hidden = !trash;
  $("#sortWrap").hidden = trash;
  updateVaultUi();
  updateTitle();

  hideRail();
  if (noGrid) {
    S.gen++;
    setSelecting(false);
    $("#empty").hidden = true;
    if (albumsPage) renderAlbumGrid(); else if (mapPage) openMap(); else if (inboxPage) openInbox(); else if (galleriesPage) openGalleries(); else openSites();
  } else {
    if (S.view === "folder") renderAlbumGrid();
    resetList();
  }
  renderMemories();
}
$$(".nav [data-nav]").forEach(b => (b.onclick = () => go(`#${b.dataset.nav}`)));

function updateTitle() {
  let t = { library: "Library", favorites: "Favorites", albums: "Albums", locked: "Locked folder", trash: "Trash", map: "Map", sites: "Sites", inbox: "Shared with me", galleries: "Galleries" }[S.view];
  if (S.view === "album") t = S.albums.find(a => a.id === S.albumId)?.name || "Album";
  if (S.view === "folder") t = S.folders.find(f => f.id === S.folderId)?.name || "Folder";
  if (S.view === "locked" && S.vfolder) t = S.vfolders?.find(f => f.id === S.vfolder)?.name || t;
  if (S.view === "day") t = dayDate(S.day).toLocaleDateString(undefined, { dateStyle: "long" });
  $("#viewTitle").textContent = t;
  document.title = `${t} · Media Vault`;
  updateCount();
}
function updateCount() {
  $("#viewCount").textContent = S.view === "locked" && !V.isUnlocked() ? ""
    : S.view === "map" ? (M.located ? `${nf.format(M.located)} place${M.located === 1 ? "" : "s"}` : "")
    : S.view === "sites" ? (W.sites.length ? `${W.sites.length} site${W.sites.length === 1 ? "" : "s"}` : "")
    : S.view === "inbox" ? (S.inbox.length ? `${nf.format(S.inbox.length)} shared` : "")
    : S.view === "galleries" ? (GL.list.length ? `${nf.format(GL.list.length)} galler${GL.list.length === 1 ? "y" : "ies"}` : "")
    : S.view === "albums"
    ? `${S.albums.length} album${S.albums.length === 1 ? "" : "s"}`
    : S.page ? `${nf.format(S.total)} item${S.total === 1 ? "" : "s"}` : "";
}

// ---------- albums page ----------
async function renderAlbumGrid() {
  await ensureToken().catch(() => {});
  const cover = a => {
    if (!a.cover) return ic("images");
    const [id, kind, file, poster] = a.cover.split("|");
    const name = poster || (kind === "video" ? "" : file);
    if (!name) return ic("play");
    return `${ic("images")}<img loading="lazy" alt="" src="${fileUrl({ id, collectionName: "media" }, name, { thumb: "400x400" })}" onerror="this.remove()">`;
  };
  // Albums page: folders, then albums not in a folder. A folder's page: just its albums.
  const here = openFolder();
  const plural = (n, w) => `${nf.format(n)} ${w}${n === 1 ? "" : "s"}`;
  const folders = here ? [] : S.folders.map(f => {
    const n = S.albums.filter(a => filedIn(a) === f.id).length;
    return `<button class="album-card folder-card" data-folder="${f.id}">
      <div class="cover">${ic("folder")}</div>
      <div class="nm">${esc(f.name)}</div>
      <div class="n">${[n ? plural(n, "album") : "", f.count ? plural(f.count, "item") : ""].filter(Boolean).join(" · ") || "Empty"}</div>
    </button>`;
  });
  $("#albumGrid").innerHTML = folders.join("") + S.albums.filter(a => filedIn(a) === here).map(a => `
    <button class="album-card" data-album="${a.id}">
      <div class="cover">${cover(a)}${a.rules ? `<span class="smart-tag">${ic("sparkles")}Smart</span>` : ""}</div>
      <div class="nm">${esc(a.name)}</div>
      <div class="n">${plural(a.count, "item")}</div>
    </button>`).join("") + `
    <button class="album-card new" data-new><div class="cover">${ic("plus")}</div><div class="nm">${here ? "New album here" : "New"}</div><div class="n">${here ? "Filed in this folder" : "Album, smart album or folder"}</div></button>`;
  updateCount();
}
$("#albumGrid").addEventListener("click", async e => {
  const card = e.target.closest(".album-card");
  if (!card) return;
  if (card.dataset.new !== undefined) {
    const a = await newAlbumChooser();
    if (a) go(`#album/${a.id}`);
  } else if (card.dataset.folder) go(`#folder/${card.dataset.folder}`);
  else go(`#album/${card.dataset.album}`);
});

$("#albumFolderBtn").onclick = async () => {
  const a = S.albums.find(x => x.id === S.albumId);
  if (!a) return;
  const fid = await pickFolder(`Put “${a.name}” in a folder`, { allowNone: !!filedIn(a), except: filedIn(a) });
  if (fid === null) return;
  try {
    await pb.collection("albums").update(a.id, { folder: fid }, { requestKey: null });
    await loadSummary();
    toast(fid ? `Moved to “${S.folders.find(f => f.id === fid)?.name || "folder"}”` : "Taken out of its folder");
  } catch (e) { toast(errText(e)); }
};
$("#folderRenameBtn").onclick = async () => {
  const f = S.folders.find(x => x.id === S.folderId);
  const name = await ask("Rename folder", f?.name || "");
  if (!name) return;
  try {
    await pb.collection("folders").update(S.folderId, { name }, { requestKey: null });
    await loadSummary();
  } catch (e) { toast(errText(e)); }
};
$("#folderDeleteBtn").onclick = async () => {
  const f = S.folders.find(x => x.id === S.folderId);
  if (!(await confirmBox(`Delete folder “${f?.name || "folder"}”?`, "The folder is removed. Albums in it go back to Albums, and files in it go back to your library."))) return;
  try {
    await pb.collection("folders").delete(S.folderId, { requestKey: null });
    await loadSummary();
    go("#albums");
  } catch (e) { toast(errText(e)); }
};

$("#editRulesBtn").onclick = async () => {
  const a = S.albums.find(x => x.id === S.albumId);
  if (a && (await smartAlbumForm(a))) applyRoute();
};
$("#renameAlbumBtn").onclick = async () => {
  const a = S.albums.find(x => x.id === S.albumId);
  const name = await ask("Rename album", a?.name || "");
  if (!name) return;
  try {
    await pb.collection("albums").update(S.albumId, { name });
    await loadSummary();
  } catch (e) { toast(errText(e)); }
};
$("#deleteAlbumBtn").onclick = async () => {
  const a = S.albums.find(x => x.id === S.albumId);
  if (!(await confirmBox(`Delete “${a?.name || "album"}”?`, "The album is removed. Photos and videos in it go back to your library."))) return;
  try {
    await pb.collection("albums").delete(S.albumId);
    await loadSummary();
    go("#albums");
  } catch (e) { toast(errText(e)); }
};

// ---------- list / grid ----------
function buildFilter() {
  const parts = [];
  const params = {};
  if (S.kind !== "all") { parts.push("kind = {:kind}"); params.kind = S.kind; }
  parts.push(S.view === "trash" ? "trashedAt != ''" : "trashedAt = ''");
  if (S.view === "favorites") parts.push("favorite = true");
  // Items in an album or a folder live only there; a search still looks everywhere.
  if (S.view === "library" && !S.q) parts.push("albums:length = 0 && folder = ''");
  if (S.view === "folder") { parts.push("folder = {:folder}"); params.folder = S.folderId; }
  if (S.view === "album") {
    const rules = S.albums.find(a => a.id === S.albumId)?.rules;
    if (rules) {
      const sf = smartFilter(rules);
      if (sf.filter) parts.push(sf.filter);
      Object.assign(params, sf.params);
    } else { parts.push("albums ~ {:album}"); params.album = S.albumId; }
  }
  if (S.view === "day") {
    const d = dayDate(S.day);
    params.d0 = pbTime(d);
    params.d1 = pbTime(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));
    parts.push("takenAt >= {:d0} && takenAt < {:d1}");
  }
  if (S.q) { parts.push("(title ~ {:q} || originalName ~ {:q} || tags ~ {:q})"); params.q = S.q; }
  return pb.filter(parts.join(" && "), params);
}
// "YYYY-MM-DD" → local midnight; Date → PocketBase's stored datetime format (for comparisons in filters).
const dayDate = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const pbTime = d => d.toISOString().replace("T", " ");
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function sortExpr() {
  if (S.view === "trash") return "-trashedAt";
  return { "-created": "-created", "-takenAt": "-takenAt,-created", takenAt: "takenAt,created", title: "title,created", "-size": "-size,-created" }[S.sort];
}
const dateSorted = () => S.view !== "trash" && (S.sort.includes("created") || S.sort.includes("takenAt"));
const groupedByDate = () => dateSorted() && P.months;
function monthOf(r) {
  const d = pbDate(S.sort.includes("takenAt") ? r.takenAt || r.created : r.created);
  return d ? d.toLocaleString(undefined, { month: "long", year: "numeric" }) : "";
}

function resetList() {
  if (S.view === "map") { S.gen++; return openMap(); }
  S.gen++;
  hideRail();
  S.items = [];
  S.page = 0;
  S.totalPages = 1;
  S.total = 0;
  S.loading = false;
  S.curGrid = null;
  S.lastMonth = null;
  S.dirty = false;
  $("#grid").innerHTML = "";
  $("#empty").hidden = true;
  S.selected.clear();
  updateSelBar();
  updateCount();
  loadMore();
}

async function loadMore() {
  if (PAGE_VIEWS.includes(S.view) || S.loading || S.page >= S.totalPages) return;
  if (S.view === "locked") return loadVault();
  S.loading = true;
  const gen = S.gen;
  try {
    await ensureToken();
    const res = await pb.collection("media").getList(S.page + 1, PAGE, { filter: buildFilter(), sort: sortExpr(), requestKey: null });
    if (gen !== S.gen) return;
    addPage(res);
    if (res.page === 1) buildTimeline(gen);
  } catch (e) {
    if (gen === S.gen) toast(errText(e));
    return;
  } finally {
    if (gen === S.gen) S.loading = false;
  }
  if (gen === S.gen && $("#sentinel").getBoundingClientRect().top < innerHeight + 800) loadMore();
}
new IntersectionObserver(entries => entries[0].isIntersecting && loadMore(), { rootMargin: "800px" }).observe($("#sentinel"));
function addPage(res) {
  S.page = res.page;
  S.totalPages = res.totalPages;
  S.total = res.totalItems;
  S.items.push(...res.items);
  appendTiles(res.items);
  updateCount();
  updateEmpty();
}
// Loads every page up to `target` (several at a time), for jumping far down the timeline.
async function loadPagesUpTo(target) {
  const gen = S.gen;
  while (S.loading) await new Promise(r => setTimeout(r, 50));
  if (gen !== S.gen || S.page >= Math.min(target, S.totalPages)) return;
  S.loading = true;
  try {
    await ensureToken();
    const pages = [];
    for (let p = S.page + 1; p <= Math.min(target, S.totalPages); p++) pages.push(p);
    const got = new Map();
    let next = pages[0];
    await pool(pages, 6, async p => {
      got.set(p, await pb.collection("media").getList(p, PAGE, { filter: buildFilter(), sort: sortExpr(), requestKey: null }));
      while (got.has(next) && gen === S.gen) { addPage(got.get(next)); got.delete(next); next++; } // keep page order
    });
  } catch (e) {
    if (gen === S.gen) toast(errText(e));
  } finally {
    if (gen === S.gen) S.loading = false;
  }
}

// ---------- timeline rail (jump to a month) ----------
const T = { buckets: [], total: 0, gen: -1 };
const railViews = ["library", "favorites", "album", "folder"];
function hideRail() { $("#rail").hidden = true; T.buckets = []; }
async function buildTimeline(gen) {
  if (!railViews.includes(S.view) || !dateSorted() || S.totalPages < 2) return;
  try {
    const field = S.sort.includes("takenAt") ? "takenAt,created" : "created";
    const all = await pb.collection("media").getFullList({ filter: buildFilter(), sort: sortExpr(), fields: field, batch: 1000, requestKey: null });
    if (gen !== S.gen) return;
    const buckets = [];
    all.forEach((r, i) => {
      const d = pbDate(S.sort.includes("takenAt") ? r.takenAt || r.created : r.created);
      const key = d ? `${d.getFullYear()}-${d.getMonth()}` : "?";
      const last = buckets[buckets.length - 1];
      if (last?.key === key) last.count++;
      else buckets.push({ key, index: i, count: 1, year: d?.getFullYear(), label: d ? d.toLocaleString(undefined, { month: "long", year: "numeric" }) : "No date" });
    });
    Object.assign(T, { buckets, total: all.length, gen });
    if (buckets.length >= 2) renderRail();
  } catch {}
}
function renderRail() {
  const rail = $("#rail");
  rail.hidden = false;
  const h = $(".rail-track", rail).clientHeight || 400;
  let lastY = -99, lastYear = null;
  $(".rail-track", rail).innerHTML = T.buckets.map(b => {
    const y = (b.index / T.total) * 100;
    let html = `<i class="rail-dot" style="top:${y}%"></i>`;
    if (b.year !== lastYear && (y / 100) * h - lastY > 18) {
      html += `<span class="rail-year" style="top:${y}%">${b.year ?? ""}</span>`;
      lastY = (y / 100) * h;
    }
    lastYear = b.year;
    return html;
  }).join("");
  railKnob();
}
const railBucketAt = clientY => {
  const r = $(".rail-track").getBoundingClientRect();
  const at = Math.min(0.9999, Math.max(0, (clientY - r.top) / r.height)) * T.total;
  let b = T.buckets[0];
  for (const x of T.buckets) { if (x.index <= at) b = x; else break; }
  return b;
};
function railTip(clientY, b) {
  const tip = $(".rail-tip");
  if (!b) { tip.hidden = true; return; }
  const r = $("#rail").getBoundingClientRect();
  tip.textContent = b.label;
  tip.style.top = `${clientY - r.top}px`;
  tip.hidden = false;
}
function railKnob() {
  if ($("#rail").hidden || !T.total) return;
  const top = $(".topbar").getBoundingClientRect().bottom + 60;
  const tile = $$(".tile").find(t => t.getBoundingClientRect().bottom > top);
  const i = tile ? S.items.findIndex(x => x.id === tile.dataset.id) : 0;
  $(".rail-knob").style.top = `${(Math.max(0, i) / T.total) * 100}%`;
}
async function jumpTo(b) {
  if (!b) return;
  if (b.index >= S.items.length) {
    toast(`Loading ${b.label}…`, 30000);
    await loadPagesUpTo(Math.ceil((b.index + 1) / PAGE));
    $("#toast").hidden = true;
  }
  const r = S.items[b.index];
  const tile = r && $(`.tile[data-id="${r.id}"]`);
  if (!tile) return;
  const head = tile.parentElement.previousElementSibling?.classList.contains("month") && tile === tile.parentElement.firstElementChild ? tile.parentElement.previousElementSibling : tile;
  scrollTo({ top: head.getBoundingClientRect().top + scrollY - $(".topbar").offsetHeight - 8, behavior: "instant" });
}
{
  const rail = $("#rail");
  let dragging = false;
  rail.addEventListener("pointerdown", e => { dragging = true; rail.setPointerCapture(e.pointerId); rail.classList.add("active"); railTip(e.clientY, railBucketAt(e.clientY)); });
  rail.addEventListener("pointermove", e => { if (dragging || e.pointerType === "mouse") railTip(e.clientY, railBucketAt(e.clientY)); });
  rail.addEventListener("pointerup", e => { if (!dragging) return; dragging = false; rail.classList.remove("active"); railTip(0, null); jumpTo(railBucketAt(e.clientY)); });
  rail.addEventListener("pointercancel", () => { dragging = false; rail.classList.remove("active"); railTip(0, null); });
  rail.addEventListener("pointerleave", () => { if (!dragging) railTip(0, null); });
  let ticking = false;
  addEventListener("scroll", () => { if (!ticking) { ticking = true; setTimeout(() => { ticking = false; railKnob(); }, 80); } }, { passive: true });
  addEventListener("resize", debounce(() => { if (!$("#rail").hidden) renderRail(); }, 200));
}

// ---------- On this day ----------
const MEM = { key: "", groups: [] };
async function renderMemories() {
  const box = $("#memories");
  const show = S.view === "library" && !S.q && S.kind === "all";
  if (!show) { box.hidden = true; return; }
  const now = new Date();
  const key = ymd(now);
  if (MEM.key !== key) {
    MEM.key = key;
    MEM.groups = [];
    try {
      const md = key.slice(5);
      const items = await pb.send(`/api/library/memories?md=${md}&year=${now.getFullYear()}&tz=${-now.getTimezoneOffset()}`, { requestKey: null });
      const byYear = new Map();
      for (const r of items) {
        const y = pbDate(r.takenAt).getFullYear();
        if (!byYear.has(y)) byYear.set(y, []);
        byYear.get(y).push(r);
      }
      MEM.groups = [...byYear].sort((a, b) => b[0] - a[0]).map(([year, list]) => ({ year, list }));
    } catch { MEM.key = ""; }
  }
  if (!MEM.groups.length || S.view !== "library" || S.q || S.kind !== "all") { box.hidden = true; return; }
  await ensureToken().catch(() => {});
  box.innerHTML = `<h3 class="mem-title">${ic("sparkles")}On this day</h3><div class="mem-row">${MEM.groups.map(g => {
    const ago = now.getFullYear() - g.year;
    const cover = g.list.find(r => thumbUrl(r)) || g.list[0];
    const d = new Date(g.year, now.getMonth(), now.getDate());
    return `<a class="mem-card" href="#day/${ymd(d)}">
      ${thumbUrl(cover) ? `<img loading="lazy" alt="" src="${thumbUrl(cover)}">` : ""}
      <span class="mem-label"><strong>${ago} year${ago === 1 ? "" : "s"} ago</strong><small>${nf.format(g.list.length)} item${g.list.length === 1 ? "" : "s"} · ${g.year}</small></span></a>`;
  }).join("")}</div>`;
  box.hidden = false;
}

const tileDay = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
function tileHtml(r) {
  const thumb = r.vault ? vthumbs.get(r.id) || "" : thumbUrl(r);
  const icon = ic(r.kind === "video" ? "play" : r.kind === "file" ? "file" : "image");
  const p360 = r.pano ? "360° · " : "";
  const badge = r.kind === "video" ? `<span class="badge">${ic("play")}${p360}${fmtDur(r.duration)}</span>` : r.kind === "gif" ? `<span class="badge">GIF</span>` : r.pano ? `<span class="badge">360°</span>` : "";
  const ar = r.width && r.height ? Math.min(3, Math.max(0.4, r.width / r.height)).toFixed(3) : 1;
  // Name / date / size: only shown by the "With names" and "List" layouts (data-grid="captions" | "list" in app.css).
  const when = r.takenAt || r.created, about = [when ? tileDay.format(pbDate(when)) : "", r.size ? fmtBytes(r.size) : ""].filter(Boolean).join(" · ");
  return `<div class="tile${S.selected.has(r.id) ? " sel" : ""}" data-id="${r.id}" title="${esc(r.title || r.originalName)}" style="--ar:${ar}">
    ${thumb ? `<img loading="lazy" alt="" src="${thumb}" onerror="this.hidden=true;this.nextElementSibling.hidden=false">` : r.vault ? `<img alt="" hidden>` : ""}
    <div class="ph" ${thumb ? "hidden" : ""}>${icon}<small>${esc((r.originalName || "").split(".").pop().toUpperCase())}</small>${r.kind === "file" ? `<span class="ph-name">${esc(r.title || r.originalName)}</span>` : ""}</div>
    <span class="tile-info"><span class="ti-name">${esc(r.title || r.originalName || "")}</span><span class="ti-about">${esc(about)}</span></span>
    ${badge}${r.favorite && !r.trashedAt ? `<span class="heart">${ic("heart-fill")}</span>` : ""}
    ${r.trashedAt ? `<span class="days">${trashDaysLeft(r)}d left</span>` : ""}
    <span class="check" data-check>${ic("check")}</span>
  </div>`;
}
const TRASH_DAYS = 30; // keep in sync with the purge cron in pb_hooks/library.pb.js
const trashDaysLeft = r => Math.max(0, Math.ceil(TRASH_DAYS - (Date.now() - pbDate(r.trashedAt)) / 864e5));
function appendTiles(items) {
  const wrap = $("#grid");
  for (const r of items) {
    if (groupedByDate()) {
      const m = monthOf(r);
      if (m !== S.lastMonth) {
        S.lastMonth = m;
        wrap.insertAdjacentHTML("beforeend", `<h3 class="month">${esc(m)}</h3>`);
        S.curGrid = null;
      }
    }
    if (!S.curGrid) {
      S.curGrid = document.createElement("div");
      S.curGrid.className = "grid";
      wrap.append(S.curGrid);
    }
    S.curGrid.insertAdjacentHTML("beforeend", tileHtml(r));
    if (r.vault && r.thumb && !vthumbs.has(r.id)) thumbObserver.observe(S.curGrid.lastElementChild);
  }
}
function refreshTile(r) {
  const t = $(`.tile[data-id="${r.id}"]`);
  if (t) t.outerHTML = tileHtml(r);
}
function removeTile(id) {
  const t = $(`.tile[data-id="${id}"]`);
  if (!t) return;
  const g = t.parentElement;
  t.remove();
  if (!g.children.length) {
    if (g.previousElementSibling?.classList.contains("month")) g.previousElementSibling.remove();
    if (S.curGrid === g) { S.curGrid = null; S.lastMonth = null; }
    g.remove();
  }
}
function dropItem(id) {
  if (S.vaultAll) S.vaultAll = S.vaultAll.filter(x => x.id !== id);
  if (vthumbs.has(id)) { URL.revokeObjectURL(vthumbs.get(id)); vthumbs.delete(id); }
  const i = S.items.findIndex(x => x.id === id);
  if (i >= 0) S.items.splice(i, 1);
  S.selected.delete(id);
  S.total = Math.max(0, S.total - 1);
  removeTile(id);
}

function updateEmpty() {
  const empty = $("#empty");
  if (S.items.length) { empty.hidden = true; return; }
  let html;
  if (S.view === "locked") html = S.q || S.kind !== "all"
    ? `<div class="big">${ic("search")}</div><h3>Nothing matches</h3><p>Try a different search or filter.</p>`
    : S.vfolder ? `<div class="big">${ic("folder")}</div><h3>This folder is empty</h3><p>Tap <strong>Upload</strong> while it's open, or select items in your Locked folder and choose “Move”.</p>`
    : S.vfolders?.length ? `<p>Everything else is in the folders above.</p>`
    : `<div class="big">${ic("lock")}</div><h3>Your locked folder is empty</h3><p>Tap <strong>Upload</strong> here, or select items in your Library and choose “Move to Locked folder”. Everything is encrypted on this device first.</p>`;
  else if (S.q || S.kind !== "all") html = `<div class="big">${ic("search")}</div><h3>Nothing matches</h3><p>Try a different search or filter.</p>`;
  else if (S.view === "trash") html = `<div class="big">${ic("trash")}</div><h3>Trash is empty</h3><p>Deleted items stay here for ${TRASH_DAYS} days, so you can restore them if you change your mind.</p>`;
  else if (S.view === "favorites") html = `<div class="big">${ic("heart")}</div><h3>No favorites yet</h3><p>Open anything and tap the heart to add it here.</p>`;
  else if (S.view === "folder") html = S.albums.some(a => filedIn(a) === S.folderId) ? "" : `<div class="big">${ic("folder")}</div><h3>This folder is empty</h3><p>Upload while this folder is open, select items elsewhere and choose “Move to folder”, or file an album here with its <strong>Folder</strong> button.</p>`;
  else if (S.view === "album") html = `<div class="big">${ic("images")}</div><h3>This album is empty</h3><p>Upload while this album is open, or select items in your Library and choose “Add to album”.</p>`;
  else if (S.view === "library" && (S.albums.some(a => !a.rules && a.count) || S.folders.some(f => f.count))) html = `<div class="big">${ic("images")}</div><h3>Everything is in albums and folders</h3><p>Things you put in an album or folder only show there. New uploads land here.</p>
    <button class="btn" onclick="location.hash='#albums'">${ic("images")}Open albums</button>`;
  else html = `<div class="big">${ic("cloud-up")}</div><h3>Your library is empty</h3><p>Drag photos, videos and GIFs anywhere on this page, or click <strong>Upload</strong>.</p>
    <button class="btn primary" onclick="document.getElementById('uploadBtn').click()">${ic("upload")}Upload</button>`;
  empty.innerHTML = html;
  empty.hidden = !html;
}

// filters
$$(".chip[data-kind]").forEach(c => (c.onclick = () => {
  S.kind = c.dataset.kind;
  $$(".chip[data-kind]").forEach(x => x.classList.toggle("active", x === c));
  resetList();
  renderMemories();
}));
S.sort = P.sort;
$("#sort").value = S.sort;
$("#sort").onchange = e => { S.sort = e.target.value; setPrefs({ sort: S.sort }); resetList(); };
$("#search").addEventListener("input", debounce(e => {
  S.q = e.target.value.trim();
  if (PAGE_VIEWS.includes(S.view)) go("#library");
  else { resetList(); renderMemories(); }
}, 300));

// grid interaction
// Touch: press and hold a tile to start selecting (like a phone gallery).
let holdTimer = null, holdStart = null, heldTile = false;
$("#grid").addEventListener("pointerdown", e => {
  const t = e.target.closest(".tile");
  if (!t || e.pointerType === "mouse") return;
  heldTile = false;
  holdStart = { x: e.clientX, y: e.clientY };
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => {
    heldTile = true;
    if (!S.selecting) setSelecting(true);
    if (!S.selected.has(t.dataset.id)) toggleSelect(t.dataset.id);
    navigator.vibrate?.(15);
  }, 450);
});
$("#grid").addEventListener("pointermove", e => {
  if (holdStart && Math.hypot(e.clientX - holdStart.x, e.clientY - holdStart.y) > 10) clearTimeout(holdTimer);
});
["pointerup", "pointercancel"].forEach(ev => $("#grid").addEventListener(ev, () => { clearTimeout(holdTimer); holdStart = null; }));
$("#grid").addEventListener("contextmenu", e => { if (e.target.closest(".tile")) e.preventDefault(); });

$("#grid").addEventListener("click", e => {
  const t = e.target.closest(".tile");
  if (!t) return;
  if (heldTile) { heldTile = false; return; } // the long press already selected it
  const id = t.dataset.id;
  if (S.selecting || e.target.closest("[data-check]") || e.ctrlKey || e.metaKey || e.shiftKey) {
    if (!S.selecting) setSelecting(true);
    toggleSelect(id, e.shiftKey);
  } else {
    openViewer(S.items.findIndex(x => x.id === id));
  }
});
// GIFs animate on hover (the grid shows a still thumbnail to save bandwidth).
$("#grid").addEventListener("mouseover", e => {
  const t = e.target.closest(".tile");
  if (!t || t.dataset.anim) return;
  const r = S.items.find(x => x.id === t.dataset.id);
  const img = $("img", t);
  if (r?.kind !== "gif" || r.vault || !img) return;
  t.dataset.anim = img.src;
  img.src = fileUrl(r, r.file);
  t.addEventListener("mouseleave", () => { img.src = t.dataset.anim; delete t.dataset.anim; }, { once: true });
});

// ---------- selection ----------
let lastSelected = null;
function setSelecting(on) {
  S.selecting = on;
  if (!on) {
    S.selected.clear();
    $$(".tile.sel").forEach(t => t.classList.remove("sel"));
  }
  $("#grid").classList.toggle("selecting", on);
  $("#selectBtn").textContent = on ? "Cancel" : "Select";
  updateSelBar();
}
function toggleSelect(id, range) {
  if (range && lastSelected) {
    const a = S.items.findIndex(x => x.id === lastSelected), b = S.items.findIndex(x => x.id === id);
    if (a >= 0 && b >= 0) {
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) S.selected.add(S.items[i].id);
      $$(".tile").forEach(t => t.classList.toggle("sel", S.selected.has(t.dataset.id)));
      lastSelected = id;
      return updateSelBar();
    }
  }
  S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id);
  $(`.tile[data-id="${id}"]`)?.classList.toggle("sel", S.selected.has(id));
  lastSelected = id;
  updateSelBar();
}
function updateSelBar() {
  $("#selBar").hidden = !S.selecting;
  $("#selCount").textContent = `${S.selected.size} selected`;
  $$("#selBar [data-bulk]").forEach(b => {
    if (!["all", "cancel"].includes(b.dataset.bulk)) b.disabled = !S.selected.size;
  });
}
$("#selectBtn").onclick = () => setSelecting(!S.selecting);

$("#selBar").addEventListener("click", async e => {
  const action = e.target.closest("[data-bulk]")?.dataset.bulk;
  if (!action) return;
  const ids = [...S.selected];
  const items = ids.map(id => S.items.find(x => x.id === id)).filter(Boolean);
  const col = pb.collection(S.view === "locked" ? "vault_items" : "media");
  let failed = 0;
  const each = async (fn, label) => {
    let n = 0;
    await pool(items, 4, async r => {
      try { await fn(r); } catch { failed++; }
      toast(`${label} ${++n} / ${items.length}…`, 60000);
    });
    toast(failed ? `${failed} item(s) failed` : `${label} ${items.length} item(s) — done`);
  };

  if (action === "cancel") return setSelecting(false);
  if (action === "all") {
    S.items.forEach(r => S.selected.add(r.id));
    $$(".tile").forEach(t => t.classList.add("sel"));
    return updateSelBar();
  }
  if (action === "fav") {
    const val = !items.every(r => r.favorite);
    await each(async r => { Object.assign(r, await col.update(r.id, { favorite: val }, { requestKey: null })); refreshTile(r); }, val ? "Favorited" : "Unfavorited");
  }
  if (action === "album") {
    const aid = await pickAlbum(`${S.view === "library" ? "Move" : "Add"} ${items.length} item(s) to album`);
    if (!aid) return;
    const leaves = S.view === "library" && !S.q; // album items aren't shown in the library
    await each(async r => { Object.assign(r, await col.update(r.id, { "albums+": aid }, { requestKey: null })); if (leaves) dropItem(r.id); }, leaves ? "Moved" : "Added");
    if (leaves) { setSelecting(false); updateEmpty(); }
    loadSummary();
  }
  if (action === "unalbum") {
    const patch = S.view === "folder" ? { folder: "" } : { "albums-": S.albumId };
    await each(async r => { await col.update(r.id, patch, { requestKey: null }); dropItem(r.id); }, "Removed");
    loadSummary();
    updateEmpty();
  }
  if (action === "folder") {
    const fid = await pickFolder(`Move ${items.length} item(s) to folder`, { except: openFolder() });
    if (fid === null) return;
    const leaves = (S.view === "library" && !S.q) || S.view === "folder";
    await each(async r => { Object.assign(r, await col.update(r.id, { folder: fid }, { requestKey: null })); if (leaves) dropItem(r.id); }, "Moved");
    if (leaves) { setSelecting(false); updateEmpty(); }
    loadSummary();
  }
  if (action === "download" && S.view === "locked") {
    await each(async r => saveBlob(await vaultFile(r), r.originalName || r.title || "file"), "Decrypted");
    return;
  }
  if (action === "lock") {
    if (!(await ensureVaultUnlocked())) return;
    if (!(await confirmBox(`Move ${items.length} item(s) to the Locked folder?`,
      "They're encrypted on this device, then removed from your library, albums and search. You'll need your passphrase to see them.", "Move"))) return;
    const keys = new Map(items.map(r => [r.id, V.newFileKey()])); // made now, so an auto-lock mid-way can't stop the move
    await each(async r => { await moveToVault(r, keys.get(r.id)); dropItem(r.id); }, "Moved");
    S.vaultAll = null;
    setSelecting(false);
    loadSummary();
    updateEmpty();
  }
  if (action === "move") {
    const fid = await pickVaultFolder(`Move ${items.length} item(s) to`);
    if (fid === null) return;
    await each(r => setVaultFolder(r, fid), "Moved");
    setSelecting(false);
    resetList();
    return;
  }
  if (action === "unlock") {
    if (!(await confirmBox(`Move ${items.length} item(s) to your library?`, "They'll be decrypted and stored normally again.", "Move"))) return;
    await each(r => moveToLibrary(r), "Decrypted");
    setSelecting(false);
  }
  if (action === "download") {
    await ensureToken();
    toast(`Downloading ${items.length} file(s). If your browser asks, allow multiple downloads.`, 6000);
    for (const r of items) {
      download(r);
      await new Promise(res => setTimeout(res, 600));
    }
    return;
  }
  if (action === "delete") {
    if (S.view === "locked" || S.view === "trash") {
      if (!(await confirmBox(`Delete ${items.length} item(s) forever?`, "They are permanently removed from the server. This can't be undone.", "Delete forever"))) return;
      await each(async r => { await col.delete(r.id, { requestKey: null }); dropItem(r.id); }, "Deleted");
      loadSummary();
      updateEmpty();
    } else {
      await trashItems(items);
      setSelecting(false);
    }
  }
  if (action === "restore") {
    await restoreItems(items);
    setSelecting(false);
  }
  if (action === "gallery") {
    if (await newGallery({ items: items.map(r => r.id) })) setSelecting(false);
    return;
  }
  if (action === "share") {
    if (await createShare({ items: items.map(r => r.id) })) setSelecting(false);
    return;
  }
  updateSelBar();
  updateCount();
});

// ---------- map ----------
const M = { map: null, cluster: null, located: 0, scanning: false };
let leafletLoading = null;
function loadLeaflet() {
  if (window.L?.markerClusterGroup) return Promise.resolve();
  const load = src => new Promise((ok, fail) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => fail(new Error("Couldn't load the map")); document.head.append(s); });
  if (!leafletLoading) {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "vendor/leaflet/leaflet.css";
    document.head.append(css);
    leafletLoading = load("vendor/leaflet/leaflet.js").then(() => load("vendor/leaflet/leaflet.markercluster.js"));
  }
  return leafletLoading;
}
const pinHtml = (r, n = 0) => `<div class="pin${n ? " cluster" : ""}">${thumbUrl(r) ? `<img alt="" src="${thumbUrl(r)}">` : ic(r.kind === "video" ? "play" : "image")}${n ? `<b>${n > 999 ? "999+" : n}</b>` : ""}</div>`;
async function openMap() {
  const gen = S.gen;
  M.located = 0;
  updateCount();
  $("#mapEmpty").hidden = true;
  try {
    await loadLeaflet();
    await ensureToken();
  } catch (e) { mapStatus(errText(e)); return; }
  if (gen !== S.gen) return;
  if (!M.map) {
    M.map = L.map("map", { worldCopyJump: true, zoomControl: false, attributionControl: true }).setView([25, 5], 2);
    L.control.zoom({ position: "bottomright" }).addTo(M.map);
    // OpenStreetMap's standard tiles (free with attribution; darkened in CSS to match the app).
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, className: "osm-tiles", attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(M.map);
    M.cluster = L.markerClusterGroup({
      showCoverageOnHover: false, maxClusterRadius: 56, spiderfyDistanceMultiplier: 1.6,
      iconCreateFunction: c => {
        const kids = c.getAllChildMarkers().map(m => m.options.item);
        const newest = kids.reduce((a, b) => ((b.takenAt || b.created) > (a.takenAt || a.created) ? b : a));
        return L.divIcon({ html: pinHtml(newest, c.getChildCount()), className: "pin-wrap", iconSize: [56, 56], iconAnchor: [28, 28] });
      },
    });
    M.cluster.on("click", e => openViewer(S.items.indexOf(e.layer.options.item)));
    M.map.addLayer(M.cluster);
  }
  setTimeout(() => M.map.invalidateSize(), 0);
  try {
    const items = await pb.collection("media").getFullList({ filter: "trashedAt = '' && (lat != 0 || lng != 0)", sort: "-takenAt", batch: 1000, requestKey: null });
    if (gen !== S.gen) return;
    Object.assign(S, { items, page: 1, totalPages: 1, total: items.length });
    renderMarkers(true);
  } catch (e) { if (gen === S.gen) toast(errText(e)); return; }
  scanLocations(gen);
}
function renderMarkers(fit = false) {
  if (!M.cluster) return;
  M.cluster.clearLayers();
  const ms = S.items.filter(r => r.lat || r.lng).map(markerFor);
  M.cluster.addLayers(ms);
  M.located = ms.length;
  if (fit && ms.length) M.map.fitBounds(L.latLngBounds(ms.map(m => m.getLatLng())), { padding: [60, 60], maxZoom: 13 });
  updateCount();
  $("#mapEmpty").hidden = !!ms.length || M.scanning;
  $("#mapEmpty").innerHTML = `<div class="big">${ic("pin")}</div><h3>No places yet</h3><p>Photos and videos taken with location turned on show up here. The location is read from the file itself (the GPS position the camera saved).</p>`;
}
const markerFor = r => L.marker([r.lat, r.lng], { item: r, icon: L.divIcon({ html: pinHtml(r), className: "pin-wrap", iconSize: [48, 48], iconAnchor: [24, 24] }) });
function mapStatus(text, ms = 0) {
  const el = $("#mapStatus");
  el.innerHTML = text;
  el.hidden = !text;
  if (ms) setTimeout(() => { if (el.innerHTML === text) el.hidden = true; }, ms);
}
// Older photos/videos have never been checked for a location: read just the metadata of each one (range
// requests, see mediainfo.js), once.
async function scanLocations(gen) {
  if (M.scanning) return;
  let todo;
  try {
    todo = await pb.collection("media").getFullList({ filter: "geoDone = false && trashedAt = ''", fields: "id,collectionId,collectionName,file,kind", batch: 1000, requestKey: null });
  } catch { return; }
  if (!todo.length || gen !== S.gen) return;
  M.scanning = true;
  let done = 0, found = 0;
  const show = () => mapStatus(`<span class="spin"></span>Finding photo locations… ${nf.format(done)} / ${nf.format(todo.length)}`);
  show();
  try {
    await pool(todo, 3, async r => {
      if (gen !== S.gen) return;
      let geo = null;
      if (r.kind === "image" || r.kind === "video") {
        const rd = await rangeReader(fileUrl(r, r.file));
        if (!rd) { done++; return; } // couldn't fetch it: try again next time the map opens
        geo = await mediaInfo(rd.size, rd.read);
      }
      const patch = { geoDone: true };
      if (geo?.lat != null) Object.assign(patch, { lat: geo.lat, lng: geo.lng });
      try {
        const rec = await pb.collection("media").update(r.id, patch, { requestKey: null });
        if (patch.lat != null && gen === S.gen) {
          found++;
          S.items.push(rec);
          M.cluster.addLayer(markerFor(rec));
          M.located++;
          updateCount();
          $("#mapEmpty").hidden = true;
        }
      } catch {}
      done++;
      if (gen === S.gen) show();
    });
  } finally {
    M.scanning = false;
  }
  if (gen !== S.gen) return;
  mapStatus(found ? `Found ${nf.format(found)} new place${found === 1 ? "" : "s"}` : "", 4000);
  if (found && M.located === found) renderMarkers(true);
  $("#mapEmpty").hidden = M.located > 0;
}

// ---------- sites (owner only) ----------
// Static HTML projects, served by the sites server (pb_sites/, started by start.bat) on its own port at
// http://<this host>:<port>/<slug>/: another origin, so hosted code can't read this app's login. Uploading replaces
// the whole site: files go up in batches to a staging folder, then /finish swaps it in (the old version stays live
// until then). Server: pb_hooks/sites.pb.js (+ sites_lib.js) and pb_sites/pb_hooks/serve_lib.js.
const SITES_HTTPS_PORT = 443; // `tailscale serve/funnel --https=443 http://127.0.0.1:8092`; this app is on 8443 (see docs/MOVING.md)
const W = { sites: [], port: 8092, https: null, loaded: false, server: null, busy: new Map() }; // busy: site id → { done, total, label }
// With `tailscale serve` set up for the sites, links use its https address (public when Funnel is on, else tailnet
// only), however this app was opened; otherwise this host on the sites server's own port.
const hostPort = (h, p) => +p === 443 ? h : `${h}:${p}`;
const siteHost = () => W.https ? hostPort(W.https.host, W.https.port) : hostPort(location.hostname, W.port);
const siteBase = () => W.https ? `https://${siteHost()}` : `${location.protocol}//${siteHost()}`;
const siteUrl = s => `${siteBase()}/${s.slug}/`;
const slugify = s => String(s || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "");
// Never uploaded (the sites server wouldn't serve them anyway): hidden files and folders (.git, .env…) and junk.
const SITE_SKIP = new Set(["node_modules", "__MACOSX", "Thumbs.db", "desktop.ini"]);
const siteSkip = name => SITE_SKIP.has(name) || (name.startsWith(".") && name !== ".well-known");
const SITE_MAX_FILES = 5000;
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function ago(d) {
  const s = (d - Date.now()) / 1000;
  for (const [u, n] of [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]]) {
    if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), u);
  }
  return "just now";
}

async function openSites() {
  const box = $("#sitesView");
  if (!S.isOwner) {
    box.innerHTML = `<div class="empty"><div class="big">${ic("globe")}</div><h3>Sites are for the owner</h3><p>Only the owner of this Media Vault can host sites.</p></div>`;
    return;
  }
  if (!W.loaded) box.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const res = await pb.send("/api/sites", { requestKey: "sites" });
    // Over https (tailscale serve) the sites server is proxied on SITES_HTTPS_PORT, since its own port is plain http.
    W.port = location.protocol === "https:" ? SITES_HTTPS_PORT : res.port;
    W.https = res.https || null;
    W.sites = res.sites;
    W.loaded = true;
  } catch (e) {
    if (!e.isAbort) box.innerHTML = `<p class="error">${esc(errText(e))}</p>`;
    return;
  }
  if (S.view !== "sites") return;
  renderSites();
  checkSitesServer();
}
async function checkSitesServer() {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 3000);
  let ok = false;
  try { ok = (await fetch(`${siteBase()}/api/health`, { signal: ctl.signal, cache: "no-store" })).ok; } catch {}
  clearTimeout(t);
  W.server = ok;
  renderSitesNote();
}

function renderSites() {
  $("#sitesView").innerHTML = `<div id="sitesNote"></div>
    <div class="site-list">${W.sites.map(siteCard).join("")}
      <button class="site-card new" data-new><span class="site-ico">${ic("plus")}</span><span class="site-main"><span class="site-name">New site</span><span class="site-meta">Or drop a project folder or .zip anywhere here</span></span></button>
    </div>`;
  renderSitesNote();
  updateCount();
}
function renderSitesNote() {
  const n = $("#sitesNote");
  if (!n) return;
  const who = (!W.https ? ""
    : W.https.public ? ` <strong>Funnel is on:</strong> anyone with the link can open a public site, no Tailscale needed.`
    : ` <strong>Tailnet only:</strong> only your devices signed in to Tailscale can open these links.`)
    + ` Use <strong>Access</strong> on a site to put a password on it or keep it to yourself.`;
  n.innerHTML = W.server === false
    ? `<p class="note warn">${ic("alert")}<span>The sites server isn't answering at ${esc(siteHost())}, so links won't open. Start Media Vault with <strong>start.bat</strong> (it starts both servers), and run <strong>allow-firewall.bat</strong> once so phones can reach it.${W.https ? " On this device, Tailscale also needs to be on." : ""}</span></p>`
    : `<p class="note">${ic("info")}<span>Publish a folder or .zip with an <strong>index.html</strong>. Each site gets its own address, served separately so its code can't reach your library. Uploading again replaces the whole site.${who}${W.https ? " Funnel is changed in the Media Vault window on the PC (Settings)." : ""}</span></p>`;
}
// Who may open a site (s.access): "public", "password" or "private" (only the owner). Checked by the sites server.
function accessBadge(s) {
  if (s.access === "password") return `<span class="site-access pw">Password</span>`;
  if (s.access === "private") return `<span class="site-access">Only me</span>`;
  if (!W.https) return "";
  return W.https.public ? `<span class="site-access public">Public</span>` : `<span class="site-access">Tailnet only</span>`;
}
// The owner opens a password-protected or private site with a one-off ticket, which the sites server swaps for a
// cookie (pb_hooks/sites.pb.js /enter, pb_sites/pb_hooks/serve_lib.js gate()).
async function enterUrl(s) {
  if (s.access !== "password" && s.access !== "private") return siteUrl(s);
  const { ticket } = await pb.send(`/api/sites/${s.id}/enter`, { method: "POST", requestKey: null });
  return `${siteUrl(s)}?__mv=${encodeURIComponent(ticket)}`;
}
// A real tab for a site that needs the ticket: opened straight away (popup blockers), pointed at the site once it's here.
function openSiteTab(s) {
  const w = window.open("", "_blank");
  if (!w) return;
  w.opener = null;
  enterUrl(s).then(u => { w.location.href = u; }, ex => { w.close(); toast(errText(ex)); });
}
function siteCard(s) {
  const p = W.busy.get(s.id), url = esc(siteUrl(s));
  const meta = s.files
    ? `${nf.format(s.files)} file${s.files === 1 ? "" : "s"} · ${fmtBytes(s.bytes)} · updated ${ago(pbDate(s.deployedAt))}`
    : "Nothing uploaded yet";
  const off = p ? "disabled" : "";
  return `<article class="site-card" data-id="${esc(s.id)}">
    <div class="site-head">
      <span class="site-ico">${ic("globe")}</span>
      <div class="site-main">
        <span class="site-name">${esc(s.name)} ${accessBadge(s)}</span>
        <a class="site-url" href="${url}" target="_blank" rel="noopener" data-open>${esc(`${siteHost()}/${s.slug}/`)}</a>
      </div>
      ${s.files && !p ? `<a class="btn sm primary" href="${url}" target="_blank" rel="noopener" data-open>${ic("play")}Open</a>` : ""}
    </div>
    ${p ? `<div class="site-prog"><div class="st-bar"><i class="st-fill" style="width:${(p.done / p.total) * 100}%"></i></div><span>${esc(p.label)}</span></div>`
      : `<div class="site-meta">${esc(meta)}${s.page ? ` · <span class="site-pg">${ic("image")}Store page</span>` : ""}</div>`}
    ${s.stats ? `<button class="site-stats" data-act="stats" title="Visits">${ic("eye")}${esc(statsLine(s))}</button>` : ""}
    <div class="site-actions">${[["folder", "upload", "Upload folder"], ["zip", "zip", "Upload .zip"], ["copy", "copy", "Copy link"],
      ["qr", "qr", "QR code"], ["access", "lock", "Access"], ["page", "image", "Page"], ["keys", "key", "Keys"], ["edit", "pencil", "Rename"],
      ["delete", "trash", "Delete"]].map(([act, icon, label]) =>
      // (the title is for the list layout, which shows only the icons)
      `<button class="btn ghost sm${act === "delete" ? " danger" : ""}" data-act="${act}" title="${label}" ${["folder", "zip", "edit", "delete"].includes(act) ? off : ""}>${ic(icon)}${label}</button>`).join("")}
    </div>
  </article>`;
}
function refreshSiteCard(id) {
  const el = $(`#sitesView [data-id="${id}"]`), s = W.sites.find(x => x.id === id);
  if (el && s) el.outerHTML = siteCard(s);
}
// A site as the server sent it back after a change, keeping the visit counts (only /api/sites has them).
function putSite(res) {
  W.sites = W.sites.map(x => (x.id === res.id ? { ...res, stats: res.stats ?? x.stats ?? null } : x));
  return W.sites.find(x => x.id === res.id);
}
const countOf = (n, word) => `${nf.format(n)} ${word}${n === 1 ? "" : "s"}`;
// "12 views · 30 plays · 4 downloads" (all time): views only with a store page, downloads only when it has some.
function statsLine(s) {
  const t = s.stats.all;
  const parts = [];
  if (s.page || t.views) parts.push(countOf(t.views, "view"));
  parts.push(countOf(t.plays, "play"));
  if (s.downloads?.length || t.downloads) parts.push(countOf(t.downloads, "download"));
  return t.views || t.plays || t.downloads ? parts.join(" · ") : "No visits yet";
}
const sortSites = () => W.sites.sort((a, b) => a.name.localeCompare(b.name));

$("#sitesView").addEventListener("click", e => {
  if (e.target.closest("[data-new]")) return newSite();
  // A plain click opens the site inside the app; Ctrl/⌘/Shift-click still opens a real tab.
  const link = e.target.closest("a[data-open]");
  if (link) {
    const s = W.sites.find(x => x.id === link.closest("[data-id]").dataset.id);
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      if (s.access === "password" || s.access === "private") { e.preventDefault(); openSiteTab(s); }
      return;
    }
    e.preventDefault();
    return openSiteFrame(s);
  }
  const b = e.target.closest("[data-act]");
  const s = b && W.sites.find(x => x.id === b.closest("[data-id]").dataset.id);
  if (!s) return;
  const act = b.dataset.act;
  if (act === "copy") copyText(siteUrl(s));
  else if (act === "qr") siteQr(s);
  else if (act === "access") siteAccess(s);
  else if (act === "page") sitePage(s);
  else if (act === "keys") siteKeys(s);
  else if (act === "stats") siteStats(s);
  else if (act === "folder" || act === "zip") pickSiteFiles(act, src => publishSite(s, src));
  else if (act === "edit") editSite(s);
  else if (act === "delete") deleteSite(s);
});
$("#sitesView").addEventListener("dragover", e => {
  const card = e.target.closest(".site-card[data-id]");
  $$(".site-card.drop-on").forEach(c => c !== card && c.classList.remove("drop-on"));
  card?.classList.add("drop-on");
});

// Name + address. The address follows the name until it's edited by hand.
function siteForm(site, name = "") {
  const done = formModal(`<h3>${site ? "Rename site" : "New site"}</h3>
    <label class="field">Name<input name="name" value="${esc(site ? site.name : name)}" maxlength="100" required placeholder="My project"></label>
    <label class="field">Address<span class="slug-row"><span>${esc(siteHost())}/</span><input name="slug" value="${esc(site ? site.slug : slugify(name))}" maxlength="40" required autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="my-project"><span>/</span></span></label>
    ${site ? `<p>Changing the address breaks the old link.</p>` : ""}`,
    site ? "Save" : "Create",
    f => {
      const body = { name: f.name.value.trim(), slug: slugify(f.slug.value) };
      return site
        ? pb.send(`/api/sites/${site.id}`, { method: "PATCH", body, requestKey: null })
        : pb.send("/api/sites", { method: "POST", body, requestKey: null });
    });
  const f = $("#modalCard form");
  let auto = !site;
  f.slug.addEventListener("input", () => (auto = false));
  f.name.addEventListener("input", () => { if (auto) f.slug.value = slugify(f.name.value); });
  return done;
}
// src (optional): { name, entries } from a drop; the new site is published from it straight away.
async function newSite(src = null) {
  const s = await siteForm(null, src?.name || "");
  if (!s) return;
  W.sites.push(s);
  sortSites();
  renderSites();
  if (src) publishSite(s, src);
}
async function editSite(s) {
  const res = await siteForm(s);
  if (!res) return;
  putSite(res);
  sortSites();
  renderSites();
}
// The QR code window (qr.js): a link to show on a screen, or save and share as a picture - for posters, chats, a
// phone's camera. { title, url, what: what it opens ("the site"), about: HTML on who can open it, name, file,
// onDone }. Sites > QR code and Shared links use it.
function showQr({ title, url, what, about = "", name, file, onDone = null }) {
  // On the PC itself (localhost) a link only works on that PC.
  const local = /^(localhost|127\.|\[::1\])/.test(new URL(url).hostname);
  const caption = `${name} · ${url}`;
  const card = openModal(`<h3>QR code · ${esc(title)}</h3>
    ${local ? `<p class="note warn">${ic("alert")}<span>This is the PC's own address, so a phone can't open it. Open Media Vault from its home Wi-Fi or Tailscale address (the Media Vault window shows them) - or give the sites an https address in its Settings - and the code uses that instead.</span></p>` : ""}
    <div class="qr-box">${qrSvg(url, `QR code for ${name}`)}</div>
    <p class="qr-url">${esc(url)}</p>
    <p>Point a phone's camera at it to open ${what}. ${about}</p>
    <div class="modal-actions">
      ${navigator.share ? `<button class="btn" data-send>${ic("share")}Share…</button>` : ""}
      <button class="btn" data-save>${ic("download")}Save picture</button>
      <button class="btn" data-copy>${ic("copy")}Copy link</button>
      <button class="btn primary" data-x>Done</button>
    </div>`);
  $("[data-x]", card).onclick = () => { closeModal(null); onDone?.(); };
  $("[data-copy]", card).onclick = () => copyText(url);
  $("[data-save]", card).onclick = async () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await qrPng(url, { caption }));
    a.download = file;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };
  const send = $("[data-send]", card);
  // The picture where the browser can share files (phones), otherwise just the link.
  if (send) send.onclick = async () => {
    const pic = new File([await qrPng(url, { caption })], file, { type: "image/png" });
    const data = navigator.canShare?.({ files: [pic] }) ? { files: [pic], title: name, text: url } : { title: name, url };
    navigator.share(data).catch(() => {});
  };
}
// A site's link as a QR code. It's the plain link: a password site still asks for its password, and an "only me"
// one doesn't let anyone else in.
function siteQr(s) {
  const reach = !W.https ? "It works on the same network as this PC (the home Wi-Fi), or over Tailscale."
    : W.https.public ? "Anyone can open it - no Tailscale needed."
    : "Only devices signed in to your Tailscale can open it.";
  const who = s.access === "private" ? " The site is set to <strong>Only me</strong>, so anyone else who scans it is turned away - change that under <strong>Access</strong> to share it."
    : s.access === "password" ? ` Visitors type the site's password after scanning${s.password ? `: <strong>${esc(s.password)}</strong>` : ""}.`
    : "";
  showQr({ title: s.name, url: siteUrl(s), what: "the site", about: reach + who, name: s.name, file: `${s.slug}-qr.png` });
}// Public / password / only me, like itch.io's visibility setting. The password is shown so it can be shared.
async function siteAccess(s) {
  const opt = (v, label) => `<label><input type="radio" name="access" value="${v}" ${s.access === v ? "checked" : ""}><span>${label}</span></label>`;
  const help = {
    public: W.https?.public ? "Anyone with the link can open it."
      : W.https ? "Anyone signed in to your Tailscale with the link can open it (turn on Funnel in the Media Vault window to make it public)."
      : "Anyone who can reach this server and has the link can open it.",
    password: "Visitors type the password once; their device remembers it for 30 days. Changing the password, or the setting, signs everyone out.",
    private: "Only you: open it from here and Media Vault lets you in. Anyone else sees “This site is private”.",
  };
  const done = formModal(`<h3>Who can open “${esc(s.name)}”?</h3>
    <div class="seg-checks">${opt("public", "Public")}${opt("password", "Password")}${opt("private", "Only me")}</div>
    <p data-help></p>
    <label class="field" data-pw>Password<input name="password" value="${esc(s.password || "")}" maxlength="100" autocomplete="off" autocapitalize="off" spellcheck="false"></label>`,
    "Save",
    f => {
      if (f.access.value === "password" && !f.password.value) throw new Error("Choose a password");
      return pb.send(`/api/sites/${s.id}`, { method: "PATCH", body: { access: f.access.value, password: f.password.value }, requestKey: null });
    });
  const f = $("#modalCard form");
  const show = () => {
    $("[data-help]", f).textContent = help[f.access.value];
    $("[data-pw]", f).style.display = f.access.value === "password" ? "" : "none";
  };
  f.addEventListener("change", show);
  show();
  const res = await done;
  if (!res) return;
  putSite(res);
  refreshSiteCard(res.id);
  toast(res.access === "password" ? "Password set" : res.access === "private" ? "Only you can open it now" : "Site is public");
}
// The store page (like an itch.io game page): shown to people who open the link, before the site. Pictures and
// downloads are uploaded with the rest when saving (POST /api/sites/{id}/page; sitepage_lib.js on the sites server
// shows it). Cover and screenshots aren't protected files, so their thumbnails load straight from /api/files.
function sitePage(s) {
  const MAX_SHOTS = 8, MAX_DL = 10;
  const st = { cover: null, dropCover: false, shots: [], downloads: [], remove: new Set(), urls: [] };
  const thumb = n => `/api/files/sites/${s.id}/${encodeURIComponent(n)}?thumb=480x270`;
  const local = f => { const u = URL.createObjectURL(f); st.urls.push(u); return u; };
  const shotsNow = () => s.shots.filter(n => !st.remove.has(n)).length + st.shots.length;
  const dlNow = () => s.downloads.filter(d => !st.remove.has(d.file)).length + st.downloads.length;
  const x = `<button type="button" class="sp-x" title="Remove" aria-label="Remove">${ic("x")}</button>`;
  return new Promise(res => {
    modalDone = v => { st.urls.forEach(u => URL.revokeObjectURL(u)); res(v); };
    const card = openModal(`<h3>Store page · ${esc(s.name)}</h3>
      <form class="vform sp-form">
        <label class="switch"><span>Show a page before the site</span><input type="checkbox" name="page" ${s.page ? "checked" : ""}></label>
        <p class="muted sp-note">People who open the link see this page first - cover, description, screenshots and downloads - and press <strong>Play</strong> to open the site full screen. Opening it here in Media Vault still goes straight to the site.</p>
        <label class="field">Tagline<input name="tagline" maxlength="140" value="${esc(s.tagline || "")}" placeholder="One line about it"></label>
        <label class="field">About<textarea name="about" rows="5" maxlength="5000" placeholder="What it is, how to play, the controls… Leave a blank line between paragraphs.">${esc(s.about || "")}</textarea></label>
        <div class="sp-sec"><div class="sp-head"><span>Cover</span><button type="button" class="btn ghost sm" data-pick="cover">${ic("image")}Choose…</button></div>
          <div class="sp-cover" data-cover></div></div>
        <div class="sp-sec"><div class="sp-head"><span>Screenshots <small data-n="shots"></small></span><button type="button" class="btn ghost sm" data-pick="shots">${ic("plus")}Add…</button></div>
          <div class="sp-shots" data-shots></div></div>
        <div class="sp-sec"><div class="sp-head"><span>Downloads <small data-n="dl"></small></span><button type="button" class="btn ghost sm" data-pick="downloads">${ic("plus")}Add files…</button></div>
          <ul class="sp-dl" data-dl></ul>
          <label class="switch"><span>Downloads need a key <small class="muted">(see Keys)</small></span><input type="checkbox" name="keyDownloads" ${s.keyDownloads ? "checked" : ""}></label></div>
        <p class="error" hidden></p>
        <div class="modal-actions"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save</button></div>
      </form>`, true);
    const f = $("form", card), btn = $(".btn.primary", f), err = $(".error", f);
    const draw = () => {
      const cover = st.cover ? local(st.cover) : s.cover && !st.dropCover ? thumb(s.cover) : "";
      $("[data-cover]", f).innerHTML = cover
        ? `<div class="sp-pic wide" data-rm-cover><img alt="" src="${cover}">${x}</div>`
        : `<p class="muted">No cover - the page has a plain banner. A wide picture (16:9) looks best.</p>`;
      $("[data-shots]", f).innerHTML = [
        ...s.shots.filter(n => !st.remove.has(n)).map(n => `<div class="sp-pic" data-rm="${esc(n)}"><img alt="" src="${thumb(n)}">${x}</div>`),
        ...st.shots.map((file, i) => `<div class="sp-pic" data-rm-new="shots:${i}"><img alt="" src="${local(file)}">${x}</div>`),
      ].join("") || `<p class="muted">None yet.</p>`;
      $("[data-dl]", f).innerHTML = [
        ...s.downloads.filter(d => !st.remove.has(d.file)).map(d => `<li data-rm="${esc(d.file)}"><span>${esc(d.name)}</span><small>${fmtBytes(d.size)}</small>${x}</li>`),
        ...st.downloads.map((file, i) => `<li data-rm-new="downloads:${i}"><span>${esc(file.name)}</span><small>${fmtBytes(file.size)} · new</small>${x}</li>`),
      ].join("") || `<li class="muted">None yet - add a build, an APK or a .zip people can download.</li>`;
      $('[data-n="shots"]', f).textContent = `${shotsNow()} / ${MAX_SHOTS}`;
      $('[data-n="dl"]', f).textContent = `${dlNow()} / ${MAX_DL}`;
    };
    f.addEventListener("click", e => {
      const pick = e.target.closest("[data-pick]");
      if (pick) {
        const kind = pick.dataset.pick, input = document.createElement("input");
        input.type = "file";
        input.multiple = kind !== "cover";
        if (kind !== "downloads") input.accept = "image/jpeg,image/png,image/webp,image/gif,image/avif";
        input.onchange = () => {
          const files = [...input.files];
          if (kind === "cover") { st.cover = files[0] || st.cover; st.dropCover = false; }
          else {
            const room = Math.max(0, kind === "shots" ? MAX_SHOTS - shotsNow() : MAX_DL - dlNow());
            (kind === "shots" ? st.shots : st.downloads).push(...files.slice(0, room));
            if (files.length > room) toast(`A page can have up to ${kind === "shots" ? `${MAX_SHOTS} screenshots` : `${MAX_DL} downloads`}`);
          }
          draw();
        };
        input.click();
        return;
      }
      const rm = e.target.closest(".sp-x") && e.target.closest("[data-rm], [data-rm-new], [data-rm-cover]");
      if (!rm) return;
      if (rm.dataset.rm) st.remove.add(rm.dataset.rm);
      else if (rm.dataset.rmNew) { const [k, i] = rm.dataset.rmNew.split(":"); st[k].splice(+i, 1); }
      else if (st.cover) st.cover = null;
      else st.dropCover = true;
      draw();
    });
    $("[data-x]", f).onclick = () => !modalSticky && closeModal(null);
    f.onsubmit = async e => {
      e.preventDefault();
      const form = new FormData();
      form.append("page", f.page.checked);
      form.append("keyDownloads", f.keyDownloads.checked);
      form.append("tagline", f.tagline.value);
      form.append("about", f.about.value);
      const remove = [...st.remove];
      if (st.dropCover && s.cover) remove.push(s.cover);
      form.append("remove", JSON.stringify(remove));
      if (st.cover) form.append("cover", st.cover);
      st.shots.forEach(file => form.append("shots", file));
      st.downloads.forEach(file => form.append("downloads", file));
      btn.disabled = true;
      err.hidden = true;
      modalSticky = true;
      const big = st.cover || st.shots.length || st.downloads.length;
      btn.textContent = big ? "Uploading…" : "Saving…";
      try {
        const saved = putSite(await postForm(`/api/sites/${s.id}/page`, form, p => { if (big) btn.textContent = `Uploading ${Math.round(p * 100)}%`; }));
        modalSticky = false;
        closeModal(saved);
        refreshSiteCard(saved.id);
        toast(saved.page ? "Store page saved" : "Saved - the page is off, so the link opens the site", 5000,
          saved.page ? { label: "View", run: () => openSiteTab(saved) } : null);
      } catch (ex) {
        modalSticky = false;
        err.textContent = errText(ex);
        err.hidden = false;
        btn.disabled = false;
        btn.textContent = "Save";
      }
    };
    draw();
  });
}

// Keys: personal links (…/{slug}/?key=…) that let one person in - past the password or "Only me" - and to downloads
// that need a key. Uses = how many devices can open it; deleting one shuts it off (site_keys, sitepage_lib.js).
async function siteKeys(s) {
  const intro = s.access === "private" ? "This site is set to <strong>Only me</strong>. A key lets one person in anyway: make one and send them its link."
    : s.access === "password" ? "A key lets someone in without typing the password: make one and send them its link."
    : s.keyDownloads ? "The site is public; its downloads need a key. Make one per person and send them its link."
    : "This site is public, so anyone with its link gets in already. Keys matter when it has a password or is set to <strong>Only me</strong> (Access), or when its downloads need one (Page).";
  const keyUrl = k => `${siteUrl(s)}?key=${k.token}`;
  const card = openModal(`<h3>Keys · ${esc(s.name)}</h3>
    <p class="muted">${intro}</p>
    <p class="muted">Anyone who gets hold of a key's link can use it, so a key works on just 1 device unless you choose more.</p>
    <form class="key-new">
      <input name="label" maxlength="80" placeholder="Who it's for (only you see this)" aria-label="Who it's for">
      <select name="uses" aria-label="How many devices"><option value="1" selected>1 device</option><option value="3">3 devices</option><option value="0">Any number of devices</option></select>
      <select name="days" aria-label="Expires"><option value="0">Never expires</option><option value="7">Expires in 7 days</option><option value="30">Expires in 30 days</option></select>
      <button class="btn primary">${ic("plus")}Make key</button>
    </form>
    <ul class="key-list" data-list><li class="muted">Loading…</li></ul>
    <div class="modal-actions"><button class="btn primary" data-x>Done</button></div>`, true);
  let keys = [], counted = true;
  const list = $("[data-list]", card);
  const draw = () => {
    if (!keys.length) { list.innerHTML = `<li class="muted">No keys yet.</li>`; return; }
    list.innerHTML = keys.map(k => {
      const exp = k.expires ? pbDate(k.expires) : null, over = exp && exp < Date.now();
      const used = !counted ? "" : k.maxUses ? `Opened on ${nf.format(k.uses)} of ${countOf(k.maxUses, "device")}` : `Opened on ${countOf(k.uses, "device")}`;
      const when = over ? "Expired" : exp ? `expires ${exp.toLocaleDateString()}` : "never expires";
      return `<li data-k="${esc(k.id)}" class="${over || (k.maxUses && k.uses >= k.maxUses) ? "spent" : ""}">
        <span class="key-main"><strong>${esc(k.label || "Key")}</strong><small>${[used, when].filter(Boolean).join(" · ")}</small></span>
        <button class="icon-btn sm" data-copy title="Copy link">${ic("copy")}</button>
        <button class="icon-btn sm" data-qr title="QR code">${ic("qr")}</button>
        <button class="icon-btn sm danger" data-del title="Delete - shuts it off">${ic("trash")}</button></li>`;
    }).join("");
  };
  $("[data-x]", card).onclick = () => closeModal(null);
  try {
    const r = await pb.send(`/api/sites/${s.id}/keys`, { requestKey: null });
    keys = r.keys; counted = r.counted;
    draw();
  } catch (ex) { list.innerHTML = `<li class="error">${esc(errText(ex))}</li>`; }
  $(".key-new", card).onsubmit = async e => {
    e.preventDefault();
    const f = e.target, b = $("button", f);
    b.disabled = true;
    try {
      const k = await pb.send(`/api/sites/${s.id}/keys`, { method: "POST", body: { label: f.label.value, maxUses: +f.uses.value, days: +f.days.value }, requestKey: null });
      keys.unshift(k);
      f.label.value = "";
      draw();
      copyText(keyUrl(k));
    } catch (ex) { toast(errText(ex)); }
    b.disabled = false;
  };
  list.addEventListener("click", async e => {
    const li = e.target.closest("[data-k]"), k = li && keys.find(x => x.id === li.dataset.k);
    if (!k) return;
    if (e.target.closest("[data-copy]")) copyText(keyUrl(k));
    else if (e.target.closest("[data-qr]")) {
      showQr({ title: k.label || "Key", url: keyUrl(k), what: `“${esc(s.name)}”`, about: "It's a personal key: whoever scans it gets in.", name: `${s.name} - ${k.label || "key"}`,
        file: `${s.slug}-key-qr.png`, onDone: () => siteKeys(s) });
    } else if (e.target.closest("[data-del]")) {
      // Two taps: the first asks (a confirm window would replace this one).
      const b = e.target.closest("[data-del]");
      if (!b.classList.contains("sure")) { b.classList.add("sure"); b.title = "Tap again to delete"; setTimeout(() => b.classList.remove("sure"), 4000); return; }
      try {
        await pb.send(`/api/sites/${s.id}/keys/${k.id}`, { method: "DELETE", requestKey: null });
        keys = keys.filter(x => x !== k);
        draw();
        toast("Key deleted - it no longer works");
      } catch (ex) { toast(errText(ex)); }
    }
  });
}

// Visits: today / last 7 days / all time, as the sites server counted them (sitepage_lib.js).
function siteStats(s) {
  const t = s.stats, cols = [["today", "Today"], ["week", "Last 7 days"], ["all", "All time"]];
  const row = (k, label) => `<tr><th>${label}</th>${cols.map(([c]) => `<td>${nf.format(t[c][k])}</td>`).join("")}</tr>`;
  const card = openModal(`<h3>Visits · ${esc(s.name)}</h3>
    <table class="st-table"><thead><tr><th></th>${cols.map(([, l]) => `<th>${l}</th>`).join("")}</tr></thead>
      <tbody>${s.page || t.all.views ? row("views", "Page views") : ""}${row("plays", "Plays")}${s.downloads?.length || t.all.downloads ? row("downloads", "Downloads") : ""}</tbody></table>
    <p class="muted">A visitor counts once every 30 minutes. ${s.page ? "Page views are visits to the store page; plays are times the site itself was opened." : "Plays are times the site was opened."} Opening it here in Media Vault isn't counted.</p>
    <div class="modal-actions"><button class="btn primary" data-x>Done</button></div>`);
  $("[data-x]", card).onclick = () => closeModal(null);
}

async function deleteSite(s) {
  if (!(await confirmBox(`Delete “${s.name}”?`, "Its files are deleted from the sites server and the link stops working."))) return;
  try {
    await pb.send(`/api/sites/${s.id}`, { method: "DELETE", requestKey: null });
    W.sites = W.sites.filter(x => x.id !== s.id);
    renderSites();
    toast("Site deleted");
  } catch (ex) { toast(errText(ex)); }
}

// Files to publish are { path, size, blob() } so folders, drops and zips (unpacked on demand) look the same.
const fileEntry = (f, path) => ({ path, size: f.size, blob: async () => f });
function pickSiteFiles(kind, then) {
  const input = document.createElement("input");
  input.type = "file";
  if (kind === "zip") input.accept = ".zip,application/zip,application/x-zip-compressed";
  else { input.webkitdirectory = true; input.multiple = true; }
  input.onchange = async () => {
    const files = [...input.files];
    if (!files.length) return;
    try {
      if (kind === "zip") then({ name: files[0].name.replace(/\.zip$/i, ""), entries: await readZip(files[0]) });
      else then({ name: "", entries: files.map(f => fileEntry(f, f.webkitRelativePath || f.name)) });
    } catch (ex) { toast(errText(ex), 5000); }
  };
  input.click();
}
// Dropped on the Sites page: onto a site's card → replaces that site; anywhere else → a new site.
// The drop's entries have to be taken synchronously, before anything is awaited.
function siteDrop(e) {
  if (!S.isOwner) return;
  const card = e.target.closest?.(".site-card[data-id]");
  const site = card && W.sites.find(s => s.id === card.dataset.id);
  const roots = [...(e.dataTransfer.items || [])].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  const files = [...e.dataTransfer.files];
  (async () => {
    try {
      const src = await droppedSite(roots, files);
      if (site) publishSite(site, src); else newSite(src);
    } catch (ex) { toast(errText(ex), 5000); }
  })();
}
async function droppedSite(roots, files) {
  if (files.length === 1 && /\.zip$/i.test(files[0].name) && (!roots.length || roots[0].isFile)) {
    return { name: files[0].name.replace(/\.zip$/i, ""), entries: await readZip(files[0]) };
  }
  if (!roots.length) return { name: "", entries: files.map(f => fileEntry(f, f.name)) };
  const entries = [];
  const walk = async (entry, prefix) => {
    if (siteSkip(entry.name)) return;
    if (entry.isFile) {
      entries.push(fileEntry(await new Promise((res, rej) => entry.file(res, rej)), prefix + entry.name));
      return;
    }
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const c of batch) await walk(c, prefix + entry.name + "/");
    }
  };
  for (const r of roots) await walk(r, "");
  return { name: roots.length === 1 && roots[0].isDirectory ? roots[0].name : "", entries };
}

// Reads a .zip's file list in the browser; entries are unpacked one by one as they're uploaded.
// Handles stored and deflated entries (what every zip tool writes), not zip64 (over 4 GB) or encryption.
async function readZip(file) {
  if (typeof DecompressionStream === "undefined") throw new Error("This browser can't unpack zips. Upload the folder instead.");
  const tailLen = Math.min(file.size, 65557);
  const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("That doesn't look like a .zip file.");
  const count = tail.getUint16(eocd + 10, true), cdSize = tail.getUint32(eocd + 12, true), cdOff = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOff === 0xffffffff) throw new Error("That zip is too big to unpack here. Upload the folder instead.");
  const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const out = [];
  for (let p = 0, n = 0; n < count; n++) {
    if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== 0x02014b50) throw new Error("That zip file is damaged.");
    const flags = cd.getUint16(p + 8, true), method = cd.getUint16(p + 10, true);
    const csize = cd.getUint32(p + 20, true), size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), commentLen = cd.getUint16(p + 32, true);
    const local = cd.getUint32(p + 42, true);
    const path = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (path.endsWith("/")) continue; // a folder
    if (flags & 1) throw new Error("Password-protected zips can't be unpacked here.");
    if (method !== 0 && method !== 8) throw new Error(`“${path}” is compressed in a way this can't unpack. Upload the folder instead.`);
    if (csize === 0xffffffff || size === 0xffffffff) throw new Error("That zip is too big to unpack here. Upload the folder instead.");
    out.push({
      path, size,
      blob: async () => {
        const h = new DataView(await file.slice(local, local + 30).arrayBuffer());
        const start = local + 30 + h.getUint16(26, true) + h.getUint16(28, true);
        const raw = file.slice(start, start + csize);
        return method === 0 ? raw : new Response(raw.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
      },
    });
  }
  return out;
}

function choose(title, text, options) {
  return new Promise(res => {
    modalDone = res;
    const card = openModal(`<h3>${esc(title)}</h3><p>${esc(text)}</p>
      <div class="modal-actions"><button class="btn" data-x>Cancel</button>${options.map(([v, label], i) =>
        `<button class="btn${i === 0 ? " primary" : ""}" data-v="${esc(v)}">${esc(label)}</button>`).join("")}</div>`);
    $("[data-x]", card).onclick = () => closeModal(null);
    $$("[data-v]", card).forEach(b => (b.onclick = () => closeModal(b.dataset.v)));
  });
}
// Clean up what was picked: skip hidden/junk files, drop the folder everything is wrapped in (my-project/index.html),
// and offer the built site (dist/…) when there's no index.html at the top. null = cancelled.
async function prepareSite(entries) {
  let files = entries.map(f => ({ ...f, path: f.path.replace(/\\/g, "/").replace(/^(\.?\/)+/, "") }))
    .filter(f => f.path && !f.path.endsWith("/") && !f.path.split("/").some(siteSkip));
  while (files.length && files.every(f => f.path.includes("/")) && new Set(files.map(f => f.path.split("/")[0])).size === 1) {
    files = files.map(f => ({ ...f, path: f.path.slice(f.path.indexOf("/") + 1) }));
  }
  if (!files.length) throw new Error("There are no files to publish in that.");
  const has = p => files.some(f => f.path === p);
  if (!has("index.html")) {
    const built = ["dist", "build", "out", "_site", "public", "www"].find(d => has(`${d}/index.html`));
    if (built) {
      const pick = await choose(`Publish the “${built}” folder?`, `There's no index.html at the top, but there is one in ${built}/, which is usually the built site.`,
        [[built, `Publish ${built}/`], ["all", "Publish everything"]]);
      if (!pick) return null;
      if (pick !== "all") files = files.filter(f => f.path.startsWith(built + "/")).map(f => ({ ...f, path: f.path.slice(built.length + 1) }));
    }
  }
  if (files.length > SITE_MAX_FILES) {
    throw new Error(`That's ${nf.format(files.length)} files; a site can have up to ${nf.format(SITE_MAX_FILES)}. Upload just the built site (its dist folder, for example).`);
  }
  return files;
}

async function publishSite(s, src) {
  if (W.busy.has(s.id)) return toast("That site is still uploading");
  let files;
  try { files = await prepareSite(src.entries); } catch (ex) { return toast(errText(ex), 5000); }
  if (!files) return;
  const total = files.reduce((n, f) => n + f.size, 0) || 1;
  let sent = 0, count = 0, failed = null;
  const prog = label => { W.busy.set(s.id, { done: sent, total, label }); refreshSiteCard(s.id); };
  prog(`Uploading ${nf.format(files.length)} file${files.length === 1 ? "" : "s"}…`);
  try {
    await pb.send(`/api/sites/${s.id}/deploy`, { method: "POST", requestKey: null });
    // Small files go up together (a request each would be slow on a big project), big ones on their own.
    const batches = [];
    let cur = [], curBytes = 0;
    for (const f of files) {
      if (cur.length && (cur.length >= 40 || curBytes + f.size > 8 * 1024 * 1024)) { batches.push(cur); cur = []; curBytes = 0; }
      cur.push(f);
      curBytes += f.size;
    }
    batches.push(cur);
    await pool(batches, 3, async b => {
      if (failed) return;
      try {
        const form = new FormData();
        for (const f of b) form.append("files", await f.blob(), f.path.split("/").pop());
        form.append("paths", JSON.stringify(b.map(f => f.path)));
        await pb.send(`/api/sites/${s.id}/deploy/files`, { method: "POST", body: form, requestKey: null });
        sent += b.reduce((n, f) => n + f.size, 0);
        count += b.length;
        prog(`Uploaded ${nf.format(count)} of ${nf.format(files.length)} files`);
      } catch (ex) { failed = ex; }
    });
    if (failed) throw failed;
    prog("Publishing…");
    const res = await pb.send(`/api/sites/${s.id}/deploy/finish`, { method: "POST", requestKey: null });
    putSite(res);
    // (res.copy: where the server put a copy on the PC, e.g. "projects/cubeword" - copyToProjects() in sites_lib.js)
    const copied = res.copy ? ` - a copy is in ${res.copy.replace(/\//g, "\\")} on the PC` : "";
    toast(`“${res.name}” is live${copied}`, 6000, { label: "Open", run: () => openSiteFrame(res) });
  } catch (ex) {
    toast(`Upload failed: ${errText(ex)} The site wasn't changed.`, 7000);
  } finally {
    W.busy.delete(s.id);
    if (S.view === "sites") renderSites();
  }
}

// A site opened inside the app, full screen with only a back button over it (in the Android app a link to the site
// would otherwise replace the whole app). It gets its own history entry, so the browser's Back closes it too.
function openSiteFrame(s) {
  if (!s) return;
  W.frameSite = s;
  $("#siteFrame").hidden = false;
  document.body.classList.add("frame-open");
  // Real fullscreen where the browser allows it (needs the click that opened it); otherwise it just fills the window.
  $("#siteFrame").requestFullscreen?.().catch(() => {});
  W.frameToken = Date.now();
  history.pushState({ siteFrame: W.frameToken }, "");
  $("#sfLoadName").textContent = s.name;
  $("#sfLoadMsg").textContent = "Opening…";
  $("#sfLoad").classList.remove("done", "failed");
  sfShow(3000);
  reloadSiteFrame();
}
// A fresh iframe each time (changing src would add browser-history entries); an empty one stops the site's scripts and sounds.
// Each full page load inside it lifts the loading cover and shows the back button for a moment.
function loadSiteFrame(url) {
  const old = $("#sfFrame"), f = old.cloneNode(false);
  f.removeAttribute("src");
  if (url) {
    f.addEventListener("load", () => { $("#sfLoad").classList.add("done"); sfShow(); });
    f.src = url;
  }
  old.replaceWith(f);
}
// The back button fades out after a while. Moves inside the site never reach this page (another origin), so it comes
// back when the pointer reaches the corner, when the site loads a page, or on a first tap where it sits (touch).
let sfHideTimer;
function sfShow(ms = 2500) {
  const b = $("#sfBack");
  b.classList.remove("idle");
  clearTimeout(sfHideTimer);
  if (ms) sfHideTimer = setTimeout(() => b.classList.add("idle"), ms);
}
function closeSiteFrame() {
  if ($("#siteFrame").hidden) return;
  clearTimeout(sfHideTimer);
  $("#siteFrame").hidden = true;
  document.body.classList.remove("frame-open");
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  loadSiteFrame(""); // the removed frame's own history entries go with it
  if (history.state?.siteFrame === W.frameToken) history.back(); // and so does the one added when it opened
  W.frameToken = 0;
}
// From the start page, with a fresh ticket if the site needs one. (__mvo=1: the sites server doesn't count the owner's
// own opens as plays - sitepage_lib.js countPlay().)
async function reloadSiteFrame() {
  const s = W.frameSite, token = W.frameToken;
  loadSiteFrame(s.access === "password" || s.access === "private" ? "" : `${siteUrl(s)}?__mvo=1`);
  if (s.access !== "password" && s.access !== "private") return;
  try {
    const url = `${await enterUrl(s)}&__mvo=1`;
    if (W.frameSite === s && W.frameToken === token && !$("#siteFrame").hidden) loadSiteFrame(url);
  } catch (ex) {
    if (W.frameToken !== token) return;
    $("#sfLoad").classList.add("failed");
    $("#sfLoadMsg").textContent = `Couldn't open it: ${errText(ex)}`;
  }
}
{
  const b = $("#sfBack");
  let wasIdle = false;
  b.addEventListener("pointerenter", e => { if (e.pointerType !== "touch") sfShow(0); });
  b.addEventListener("pointerleave", e => { if (e.pointerType !== "touch") sfShow(1500); });
  b.addEventListener("pointerdown", () => { wasIdle = b.classList.contains("idle"); });
  // A tap on the hidden button only brings it back; the next one goes back.
  b.onclick = () => { if (wasIdle) { wasIdle = false; return sfShow(); } closeSiteFrame(); };
}
// Back past the entry added on open (Back inside the site first steps back through its own pages).
window.addEventListener("popstate", e => { if (W.frameToken && e.state?.siteFrame !== W.frameToken) closeSiteFrame(); });

// ---------- trash ----------
async function trashItems(items) {
  const at = new Date().toISOString(), moved = [];
  await pool(items, 4, async r => {
    try {
      await pb.collection("media").update(r.id, { trashedAt: at }, { requestKey: null });
      moved.push(r);
      dropItem(r.id);
    } catch {}
  });
  updateCount();
  updateEmpty();
  loadSummary();
  const failed = items.length - moved.length;
  toast(failed ? `${failed} item(s) couldn't be moved to Trash` : `Moved ${moved.length} item${moved.length === 1 ? "" : "s"} to Trash`,
    8000, moved.length ? { label: "Undo", run: () => restoreItems(moved, true) } : null);
}
// undo = called from the toast after a delete, so the items belong back in the current list.
async function restoreItems(items, undo = false) {
  let ok = 0;
  await pool(items, 4, async r => {
    try {
      Object.assign(r, await pb.collection("media").update(r.id, { trashedAt: "" }, { requestKey: null }));
      if (S.view === "trash") dropItem(r.id);
      ok++;
    } catch {}
  });
  loadSummary();
  if (S.view === "trash") { updateCount(); updateEmpty(); }
  else if (undo) $("#viewer").hidden ? resetList() : (S.dirty = true);
  toast(ok < items.length ? `${items.length - ok} item(s) couldn't be restored` : `Restored ${ok} item${ok === 1 ? "" : "s"}`);
}
$("#emptyTrashBtn").onclick = async () => {
  const ids = (await pb.collection("media").getFullList({ filter: "trashedAt != ''", fields: "id", requestKey: null })).map(r => r.id);
  if (!ids.length) return toast("Trash is already empty");
  if (!(await confirmBox(`Empty trash?`, `${ids.length} item(s) will be permanently removed from the server. This can't be undone.`, "Empty trash"))) return;
  let n = 0;
  await pool(ids, 4, async id => {
    try { await pb.collection("media").delete(id, { requestKey: null }); } catch {}
    toast(`Deleting ${++n} / ${ids.length}…`, 60000);
  });
  toast("Trash emptied");
  loadSummary();
  resetList();
};

// ---------- sharing ----------
// A share goes to people with an account here (recipients: "Shared with me" in their app), or is a link: on Media
// Vault's own addresses (home Wi-Fi + Tailscale), or public on the internet for a while through the sites' address
// (pb_hooks/share.pb.js).
const shareUrl = s => `${location.origin}/s/${s.token}`; // for opening it from here
const PUBLIC_DAYS = 30; // MAX_PUBLIC_DAYS in pb_hooks/share_lib.js
// Where links open (/api/library/share-bases): B.tailnet = Media Vault over Tailscale, B.public = the sites' address
// on the internet. Links are never offered on the plain-http home Wi-Fi address (unencrypted), nor on the address the
// app happens to be open on (often localhost).
const NO_BASES = { tailnet: "", public: "" };
const tailBase = B => B.tailnet || (location.protocol === "https:" && /\.ts\.net$/i.test(location.hostname) ? location.origin : "");
// The address to send for a link share, or "" when it has none (no Tailscale address, or a public link while the
// sites aren't public).
const linkOf = (s, B) => (s.public ? (B.public ? `${B.public}/s/${s.token}/` : "") : tailBase(B) ? `${tailBase(B)}/s/${s.token}` : "");
const NO_LINK_WHY = () => S.isOwner
  ? "Links open over Tailscale. Turn on Media Vault's HTTPS address in the Media Vault window: Settings > Media Vault HTTPS address."
  : "Links open over Tailscale, and Media Vault's Tailscale address isn't set up. Ask the owner to turn it on.";
// The people one can share with, and where links open.
const shareSetup = () => Promise.all([
  pb.send("/api/library/contacts", { requestKey: null }).catch(() => []),
  pb.send("/api/library/share-bases", { requestKey: null }).then(r => ({ ...NO_BASES, ...r })).catch(() => NO_BASES),
]);
const personChecks = (people, on = []) => `<div class="seg-checks people-checks">${people.map(p =>
  `<label><input type="checkbox" name="to" value="${esc(p.id)}" ${on.includes(p.id) ? "checked" : ""}><span>${esc(p.name)}</span></label>`).join("")}</div>`;
const checkedPeople = f => [...f.querySelectorAll('[name="to"]:checked')].map(i => i.value);

async function createShare({ album = "", items = [], title = "" }) {
  const what = album ? "album" : `${items.length} item${items.length === 1 ? "" : "s"}`;
  const [people, B] = await shareSetup();
  const base = S.allowPublic ? B.public : "", tail = tailBase(B);
  const first = people.length ? "people" : tail ? "link" : base ? "public" : "";
  const aud = (v, on, icon, label) => `<label><input type="radio" name="aud" value="${v}" ${on ? (first === v ? "checked" : "") : "disabled"}><span>${ic(icon)}${label}</span></label>`;
  const done = formModal(`<h3>Share ${esc(what)}</h3>
    <div class="seg-checks share-aud">${aud("people", people.length, "users", "People here")}${aud("link", tail, "link", "Tailscale link")}${aud("public", base, "globe", "Public link")}</div>
    <div data-for="people">
      <p>They'll find it under <strong>Shared with me</strong> in their Media Vault${album ? ", including anything you add to the album later" : ""}.</p>
      ${personChecks(people)}
    </div>
    <p data-for="link">Anyone with the link who's on your Tailscale can view ${album ? "this album, including anything you add to it later" : "these items"}, without an account. It's encrypted all the way and doesn't open on the internet.</p>
    <p data-for="public">Anyone on the internet with the link can view ${album ? "this album" : "these items"} until the link expires, without an account or Tailscale. Use a password for anything private.</p>
    ${people.length ? "" : `<p class="muted share-why">${ic("users")}<span>Nobody else has an account here yet, so there's no one to share with in the app.</span></p>`}
    ${tail ? "" : `<p class="muted share-why">${ic("link")}<span>${esc(NO_LINK_WHY())}</span></p>`}
    ${base ? "" : `<p class="muted share-why">${ic("globe")}<span>${!S.allowPublic ? "Public links need the owner's permission - ask them to turn it on for you under People."
      : `Public links go out through the sites' address, which isn't public. ${S.isOwner ? "Turn it on in the Media Vault window: Settings > Hosted sites > Public." : "Ask the owner to make it public."}`}</span></p>`}
    <label class="field" data-for="link public">Title<input name="title" value="${esc(title)}" maxlength="200" placeholder="Shared photos"></label>
    <label class="field"><span data-for="people">Stop sharing</span><span data-for="link public">Link expires</span><select name="hours">
      <option value="1">In 1 hour</option><option value="24">In 1 day</option><option value="168" selected>In 7 days</option>
      <option value="720">In 30 days</option><option value="0">Never</option></select></label>
    <div data-for="link public">${SHARE_PW_FIELD("")}</div>
    <label class="ack"><input type="checkbox" name="dl" checked> Let them download the originals</label>`,
  "Share", f => {
    const aud = f.aud.value, to = checkedPeople(f), hours = +f.hours.value;
    if (!aud) throw new Error("There's no way to share yet - see the notes above.");
    if (aud === "people" && !to.length) throw new Error("Pick at least one person.");
    return pb.collection("shares").create({
      owner: pb.authStore.record.id, title: aud === "people" ? title : f.title.value.trim(), album, items: album ? [] : items,
      recipients: aud === "people" ? to : [], public: aud === "public", password: aud === "people" ? "" : f.password.value.trim(),
      allowDownload: f.dl.checked, expires: hours ? new Date(Date.now() + hours * 36e5).toISOString() : "",
    }, { requestKey: null });
  });
  // Only what fits the chosen audience shows; public links can't be "never".
  const f = $("#modalCard form");
  const update = () => {
    const aud = f.aud.value;
    $$("[data-for]", f).forEach(el => (el.hidden = !el.dataset.for.split(" ").includes(aud)));
    const never = $('option[value="0"]', f);
    never.disabled = never.hidden = aud === "public";
    if (aud === "public" && f.hours.value === "0") f.hours.value = "168";
    $(".btn.primary", f).textContent = aud === "people" ? "Share" : "Create link";
  };
  f.addEventListener("change", e => e.target.name === "aud" && update());
  update();
  const share = await done;
  if (share) showShareLink(share, B);
  return share;
}
// Optional; shown in plain text so it can be read out or sent. Checked by pb_hooks/share.pb.js (/unlock) and, for
// public links, by the sites server.
const SHARE_PW_FIELD = v => `<label class="field">Password (optional)<input name="password" value="${esc(v)}" maxlength="100" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="No password - anyone with the link"></label>`;
function showShareLink(share, B, ready = true) {
  const n = (share.recipients || []).length;
  if (n) return toast(`Shared with ${n} ${n === 1 ? "person" : "people"}`);
  const url = linkOf(share, B);
  const exp = pbDate(share.expires);
  const title = ready ? (share.gallery ? "Gallery ready" : share.public ? "Public link ready" : "Link ready") : esc(share.title || "Share link");
  if (!url) {
    const why = share.public ? "The sites' address isn't public at the moment, so this link doesn't open. Make it public again in the Media Vault window: Settings > Hosted sites." : NO_LINK_WHY();
    const card = openModal(`<h3>${title}</h3><p>${esc(why)}</p><div class="modal-actions"><button class="btn" data-x>Done</button></div>`);
    $("[data-x]", card).onclick = () => closeModal(null);
    return;
  }
  const card = openModal(`<h3>${title}</h3>
    <p>${share.public ? `Anyone with this link can open it on the internet${exp ? ` until ${esc(exp.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }))}` : ""}.`
      : "Send this link to people on your Tailscale. It doesn't open on the internet or for anyone else."} You can turn it off any time under <strong>Shared links</strong>.</p>
    <div class="link-box"><input readonly value="${esc(url)}"><button class="btn primary" data-copy>${ic("copy")}Copy</button></div>
    ${share.password ? `<p>They'll need the password <strong>${esc(share.password)}</strong> too. Send it separately for the best protection.</p>` : ""}
    <div class="modal-actions">${navigator.share ? `<button class="btn" data-send>${ic("share")}Send…</button>` : ""}<button class="btn" data-qr>${ic("qr")}QR code</button><button class="btn" data-x>Done</button></div>`);
  $("[data-copy]", card).onclick = () => copyText(url);
  $("[data-x]", card).onclick = () => closeModal(null);
  // (The QR window replaces this one; Done there comes back here.)
  $("[data-qr]", card).onclick = () => shareQr(share, B, () => showShareLink(share, B, ready));
  const send = $("[data-send]", card);
  if (send) send.onclick = () => navigator.share({ title: share.title || "Shared photos", url }).catch(() => {});
  $("input", card).onfocus = e => e.target.select();
}
// A link share as a QR code (showQr): the same link the link window gives out, with who can open it.
function shareQr(share, B, onDone = null) {
  const url = linkOf(share, B);
  if (!url) return showShareLink(share, B, false); // (says why there's no link right now)
  const exp = pbDate(share.expires), name = share.title || share.expand?.album?.name || "Shared photos";
  const about = (exp && exp < new Date() ? "<strong>This link has expired</strong> - give it a new end date (the pencil in Shared links) to use it again. "
      : share.public ? `Anyone can open it on the internet${exp ? ` until ${esc(exp.toLocaleDateString())}` : ""}. `
      : "Only devices signed in to your Tailscale can open it. ")
    + (share.password ? `They'll need the password <strong>${esc(share.password)}</strong> too.` : "");
  showQr({ title: name, url, what: "the photos", about, name, file: `${slugify(name) || "shared-photos"}-qr.png`, onDone });
}
// Change a share afterwards: who it's with, or a link's password; and when it ends. A new password locks out
// everyone who used the old one.
async function editShare(s, people) {
  const exp = pbDate(s.expires);
  const withPeople = (s.recipients || []).length > 0;
  const max = s.public ? ymd(new Date(Date.now() + PUBLIC_DAYS * 864e5)) : "";
  return formModal(`<h3>${withPeople ? "Edit share" : "Edit link"}</h3>
    ${withPeople ? `<p>Shared with:</p>${personChecks(people, s.recipients)}` : ""}
    <label class="field">${withPeople ? "Stop sharing on" : "Expires on"}<input type="date" name="exp" value="${exp ? ymd(exp) : ""}" min="${ymd(new Date())}" ${max ? `max="${max}" required` : ""}></label>
    <p class="muted">${s.public ? `Public links last at most ${PUBLIC_DAYS} days.` : "Leave the date empty to keep sharing until you turn it off."} It stops at the end of that day.</p>
    ${withPeople ? "" : `${SHARE_PW_FIELD(s.password || "")}<p class="muted">Changing or removing the password asks everyone for the new one.</p>`}`,
  "Save", f => {
    const d = f.exp.value ? new Date(`${f.exp.value}T23:59:59`) : null;
    const body = { expires: d ? d.toISOString() : "" };
    if (withPeople) {
      body.recipients = checkedPeople(f);
      if (!body.recipients.length) throw new Error("Pick at least one person, or delete the share.");
    } else body.password = f.password.value.trim();
    return pb.collection("shares").update(s.id, body, { expand: "album", requestKey: null });
  });
}
function shareRow(s, names, B) {
  const exp = pbDate(s.expires);
  const expired = exp && exp < new Date();
  const to = (s.recipients || []).map(id => names[id] || "someone");
  const what = s.album ? `Album · ${s.expand?.album?.name || ""}` : `${(s.items || []).length} item${(s.items || []).length === 1 ? "" : "s"}`;
  const meta = [
    what,
    to.length ? `with ${to.join(", ")}` : s.public ? "public" : "",
    to.length ? "" : `${s.views || 0} view${s.views === 1 ? "" : "s"}`,
    expired ? "expired" : exp ? `until ${exp.toLocaleDateString()}` : to.length ? "" : "never expires",
    s.password ? `password: ${s.password}` : "",
    s.allowDownload ? "" : "no downloads",
  ].filter(Boolean).join(" · ");
  // Open: from here (this device can reach the address the app is on). The links to send: in the link dialog.
  const open = to.length ? "" : s.public ? linkOf(s, B) : shareUrl(s);
  const icon = to.length ? ic("users") : s.public ? ic("globe") : s.password ? ic("lock") : "";
  return `<div class="inv${expired ? " dead" : ""}">
    <div class="inv-main"><span class="inv-title">${icon}${esc(s.title || s.expand?.album?.name || (to.length ? "Shared with people" : "Shared photos"))}</span><span class="inv-meta">${esc(meta)}</span></div>
    ${open ? `<a class="icon-btn sm" href="${esc(open)}" target="_blank" rel="noopener" title="Open">${ic("external")}</a>
    <button class="icon-btn sm" data-links="${esc(s.id)}" title="Links to send">${ic("copy")}</button>
    <button class="icon-btn sm" data-qr="${esc(s.id)}" title="QR code">${ic("qr")}</button>` : ""}
    <button class="icon-btn sm" data-edit="${esc(s.id)}" title="${to.length ? "People and end date" : "Password and expiry"}">${ic("pencil")}</button>
    <button class="icon-btn sm danger" data-del="${esc(s.id)}" title="${to.length ? "Stop sharing" : "Turn off link"}">${ic("trash")}</button></div>`;
}
async function openShares() {
  $("#app").classList.remove("nav-open");
  const card = openModal(`<h3>Shared links</h3>
    <p>What you've shared: links, and albums and photos shared with people here. Deleting one stops it right away; the photos stay in your library.</p>
    <div class="inv-list"><p class="muted">Loading…</p></div>
    <div class="modal-actions"><button type="button" class="btn" data-x>Close</button></div>`);
  const list = $(".inv-list", card);
  let rows = [], people = [], B = NO_BASES, names = {};
  const render = () => (list.innerHTML = rows.length ? rows.map(s => shareRow(s, names, B)).join("")
    : `<p class="muted">Nothing shared yet. Select photos and tap <strong>Share</strong>, or open an album and tap <strong>Share</strong>.</p>`);
  $("[data-x]", card).onclick = () => closeModal(null);
  list.onclick = async e => {
    const l = e.target.closest("[data-links]");
    if (l) return showShareLink(rows.find(r => r.id === l.dataset.links), B, false);
    // (Replaces this list; Done in the QR window opens it again.)
    const q = e.target.closest("[data-qr]");
    if (q) return shareQr(rows.find(r => r.id === q.dataset.qr), B, openShares);
    // Only one dialog at a time: the editor replaces this list, which opens again afterwards.
    const ed = e.target.closest("[data-edit]");
    if (ed) {
      const res = await editShare(rows.find(r => r.id === ed.dataset.edit), people);
      if (res) toast("Share updated");
      return openShares();
    }
    const d = e.target.closest("[data-del]");
    if (!d) return;
    try {
      await pb.collection("shares").delete(d.dataset.del, { requestKey: null });
      rows = rows.filter(r => r.id !== d.dataset.del);
      render();
      toast("Stopped sharing");
    } catch (ex) { toast(errText(ex)); }
  };
  try {
    [rows, [people, B]] = await Promise.all([
      pb.collection("shares").getFullList({ sort: "-created", expand: "album", requestKey: null }),
      shareSetup(),
    ]);
    names = Object.fromEntries(people.map(p => [p.id, p.name]));
    render();
  } catch (e) { list.innerHTML = `<p class="error">${esc(errText(e))}</p>`; }
}
$("#sharesBtn").onclick = openShares;
$("#shareAlbumBtn").onclick = () => {
  const a = S.albums.find(x => x.id === S.albumId);
  createShare({ album: S.albumId, title: a?.name || "" });
};

// ---------- client galleries ----------
// The Galleries page, for photographers: a public link with a gallery look - cover, studio name, welcome message -
// where a client views, hearts their favorites and downloads (web size or full resolution, one photo or all as a
// .zip) with no account or Tailscale. A gallery is a share with shares.gallery set (pb_migrations/
// 1800000016_galleries.js); /api/galleries (pb_hooks/gallery.pb.js) lists them with the opens, downloads and picks
// the sites server collected. It goes out through the sites' public address (Tailscale Funnel) like any public link.
const GL = { list: [], B: NO_BASES, loaded: false };
const canGallery = () => S.isOwner || S.allowPublic;
const GALLERY_DAYS = [7, 30, 60, 90]; // (MAX_GALLERY_DAYS in pb_hooks/share_lib.js)
const galleryName = g => g.title || g.albumName || "Gallery";
const galleryLink = g => linkOf({ public: true, token: g.token }, GL.B);

async function openGalleries() {
  const box = $("#galleriesView");
  if (!GL.loaded) box.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const [list, [, B]] = await Promise.all([pb.send("/api/galleries", { requestKey: "galleries" }), shareSetup()]);
    GL.list = list;
    GL.B = B;
    GL.loaded = true;
  } catch (e) {
    if (!e.isAbort) box.innerHTML = `<p class="error">${esc(errText(e))}</p>`;
    return;
  }
  if (S.view !== "galleries") return;
  await ensureToken().catch(() => {});
  renderGalleries();
}

function renderGalleries() {
  const me = pb.authStore.record || {};
  $("#galleriesView").innerHTML = `
    ${GL.B.public ? "" : `<p class="note warn">${ic("alert")}<span>Galleries go on the internet through the sites' public address, which isn't on. ${S.isOwner
      ? "Turn it on in the Media Vault window on the PC: <strong>Settings &gt; Hosted sites &gt; Public</strong> (Tailscale Funnel)."
      : "Ask the owner of this Media Vault to turn it on."} Your clients then need nothing but the link.</span></p>`}
    <p class="note">${ic("info")}<span>A gallery is a private page on the internet for a client: your photos under your studio name, with a cover and a message. They look through them, heart their favorites and download - web size or full resolution, one photo or all as a .zip - without an account or an app. Make one from an album (<strong>Client gallery</strong> at the top of it) or from photos you've selected (<strong>Gallery</strong>).</span></p>
    <form class="g-studio-row" id="studioForm">
      <label>Studio name<input name="studio" maxlength="100" value="${esc(me.studio || "")}" placeholder="${esc(me.name || "Your studio")}"></label>
      <button class="btn sm">Save</button><span class="muted">Shown at the top of every gallery.</span>
    </form>
    <div class="g-list">
      <button class="g-card new" data-gnew>${ic("plus")}<span><strong>New gallery</strong><small>From one of your albums</small></span></button>
      ${GL.list.map(galleryCard).join("")}
    </div>`;
  updateCount();
}

function galleryCard(g) {
  const exp = pbDate(g.expires), now = new Date();
  const closed = exp && exp < now, days = exp ? Math.max(1, Math.ceil((exp - now) / 864e5)) : 0;
  const [state, cls] = !g.public ? ["Off", "off"] : closed ? ["Closed", "off"] : !GL.B.public ? ["Not online", "warn"] : !g.live ? ["Getting ready", "warn"] : ["Open", "on"];
  const when = !g.public ? "Public links were turned off for you - ask the owner (People)."
    : closed ? `Closed on ${exp.toLocaleDateString(undefined, { dateStyle: "medium" })} - Edit to open it again.`
    : `${days === 1 ? "Closes tomorrow" : `Open for ${days} more days`} (until ${exp.toLocaleDateString(undefined, { dateStyle: "medium" })})`;
  const picks = g.picks || [], picked = new Set(picks.flatMap(p => p.items || [])).size;
  const link = !closed && g.public ? galleryLink(g) : "";
  const cover = g.cover ? thumbUrl({ ...g.cover, collectionName: "media" }) : "";
  const n = (k, w) => `${nf.format(k)} ${w}${k === 1 ? "" : "s"}`;
  return `<article class="g-card" data-gid="${esc(g.id)}">
    <div class="g-thumb">${cover ? `<img loading="lazy" alt="" src="${cover}">` : ic("camera")}<span class="g-state ${cls}">${state}</span></div>
    <div class="g-body">
      <h3>${esc(galleryName(g))}</h3>
      <p class="muted">${n(g.count, "photo")} · ${g.albumName ? `album ${esc(g.albumName)}` : "selected photos"}${g.password ? " · password" : ""}</p>
      <p class="g-when">${esc(when)}</p>
      <div class="g-stats">
        <span title="Times it was opened">${ic("eye")}${n(g.views, "view")}</span>
        <span title="Files downloaded">${ic("download")}${n(g.downloads, "download")}</span>
        ${g.allowPicks ? `<span title="Photos hearted by clients">${ic("heart")}${picked ? `${n(picked, "favorite")} from ${n(picks.length, "person")}`.replace("persons", "people") : "No favorites yet"}</span>` : ""}
      </div>
      ${g.pending ? `<p class="muted g-pending">Making web-size copies: ${nf.format(g.pending)} to go (clients see the originals meanwhile).</p>` : ""}
      <div class="g-acts">
        ${link ? `<a class="btn sm primary" href="${esc(link)}" target="_blank" rel="noopener">${ic("external")}Open</a>
          <button class="btn ghost sm" data-ga="copy">${ic("copy")}Copy link</button>
          <button class="btn ghost sm" data-ga="qr">${ic("qr")}QR code</button>` : ""}
        ${g.allowPicks ? `<button class="btn ghost sm" data-ga="picks">${ic("heart")}Favorites</button>` : ""}
        <button class="btn ghost sm" data-ga="edit">${ic("pencil")}Edit</button>
        <button class="btn ghost sm danger" data-ga="delete">${ic("trash")}Delete</button>
      </div>
    </div>
  </article>`;
}

$("#galleriesView").addEventListener("submit", async e => {
  if (e.target.id !== "studioForm") return;
  e.preventDefault();
  try {
    await pb.collection("users").update(pb.authStore.record.id, { studio: e.target.studio.value.trim() }, { requestKey: null });
    toast("Studio name saved - galleries show it within a minute");
  } catch (ex) { toast(errText(ex)); }
});
$("#galleriesView").addEventListener("click", async e => {
  if (e.target.closest("[data-gnew]")) return newGallery();
  const b = e.target.closest("[data-ga]");
  const g = b && GL.list.find(x => x.id === b.closest("[data-gid]").dataset.gid);
  if (!g) return;
  const act = b.dataset.ga;
  if (act === "copy") copyText(galleryLink(g));
  else if (act === "qr") shareQr({ token: g.token, public: true, expires: g.expires, password: g.password, title: galleryName(g) }, GL.B);
  else if (act === "picks") galleryPicks(g);
  else if (act === "edit") { if (await galleryForm(g)) { toast("Gallery updated"); openGalleries(); } }
  else if (act === "delete") {
    if (!(await confirmBox("Delete this gallery?", `The link stops working right away and the client's favorites are dropped. Your photos stay in your library.`))) return;
    try {
      await pb.collection("shares").delete(g.id, { requestKey: null });
      GL.list = GL.list.filter(x => x.id !== g.id);
      renderGalleries();
      toast("Gallery deleted");
    } catch (ex) { toast(errText(ex)); }
  }
});
$("#galleryAlbumBtn").onclick = () => newGallery({ album: S.albumId });

// A new gallery from an album (picked here if none) or from selected photos. Resolves to the share, or null.
async function newGallery({ album = "", items = [] } = {}) {
  const [, B] = await shareSetup();
  GL.B = B;
  if (!B.public) {
    const card = openModal(`<h3>Galleries aren't online yet</h3>
      <p>A gallery goes on the internet through the sites' public address, which isn't on. ${S.isOwner
        ? "Turn it on in the Media Vault window on the PC: <strong>Settings &gt; Hosted sites &gt; Public</strong> (Tailscale Funnel), then try again."
        : "Ask the owner of this Media Vault to turn it on."}</p>
      <div class="modal-actions"><button class="btn primary" data-x>OK</button></div>`);
    $("[data-x]", card).onclick = () => closeModal(null);
    return null;
  }
  if (!album && !items.length) album = await pickGalleryAlbum();
  if (!album && !items.length) return null;
  const a = album ? S.albums.find(x => x.id === album) : null;
  const res = await galleryForm(null, { album, items, title: a?.name || "" });
  if (!res) return null;
  if (S.view === "galleries") openGalleries();
  showShareLink(res, B);
  return res;
}
function pickGalleryAlbum() {
  return new Promise(res => {
    modalDone = res;
    const card = openModal(`<h3>New gallery from…</h3>
      <div class="pick-list">${S.albums.map(a => `<button data-id="${a.id}">${ic(a.rules ? "sparkles" : "images")}<span class="nm">${esc(a.name)}</span><span class="muted">${nf.format(a.count || 0)}</span></button>`).join("")
        || `<p class="muted">You don't have albums yet.</p>`}</div>
      <p class="muted">Or select photos in your library and press <strong>Gallery</strong>.</p>
      <div class="modal-actions"><button class="btn" data-x>Cancel</button></div>`);
    $("[data-x]", card).onclick = () => closeModal(null);
    $(".pick-list", card).onclick = e => { const b = e.target.closest("[data-id]"); if (b) closeModal(b.dataset.id); };
  });
}

// Make (g = null) or change a gallery. Editing also picks the cover from its photos.
function galleryForm(g, src = {}) {
  const exp = g ? pbDate(g.expires) : null, today = ymd(new Date());
  const max = ymd(new Date(Date.now() + GALLERY_DAYS[GALLERY_DAYS.length - 1] * 864e5));
  const done = formModal(`<h3>${g ? "Edit gallery" : "New client gallery"}</h3>
    <label class="field">Title<input name="title" value="${esc(g ? g.title || g.albumName : src.title || "")}" maxlength="200" required placeholder="Anna &amp; Ben's wedding"></label>
    <label class="field">Welcome message (optional)<textarea name="message" maxlength="2000" rows="3" placeholder="Hi Anna and Ben! Here are your photos. Heart your favorites and I'll start on the album.">${esc(g?.message || "")}</textarea></label>
    ${g ? `<label class="field">Open until<input type="date" name="exp" value="${exp ? ymd(exp) : ""}" min="${today}" max="${max}" required></label>`
      : `<label class="field">Open for<select name="days">${GALLERY_DAYS.map(d => `<option value="${d}" ${d === 30 ? "selected" : ""}>${d} days</option>`).join("")}</select></label>`}
    <p class="muted">Galleries stay open at most ${GALLERY_DAYS[GALLERY_DAYS.length - 1]} days; extend it here any time.</p>
    ${SHARE_PW_FIELD(g?.password || "")}
    <label class="ack"><input type="checkbox" name="dl" ${!g || g.allowDownload ? "checked" : ""}> Clients can download (web size and full resolution, or all as a .zip)</label>
    <label class="ack"><input type="checkbox" name="picks" ${!g || g.allowPicks ? "checked" : ""}> Clients can heart their favorites - you see them here</label>
    ${g ? `<div class="field"><span>Cover photo</span><input type="hidden" name="cover" value="${esc(g.cover?.id || "")}"><div class="g-covers"><p class="muted">Loading…</p></div></div>` : ""}`,
  g ? "Save" : "Create gallery", f => {
    const body = {
      title: f.title.value.trim(), message: f.message.value.trim(), password: f.password.value.trim(),
      allowDownload: f.dl.checked, allowPicks: f.picks.checked,
      expires: g ? new Date(`${f.exp.value}T23:59:59`).toISOString() : new Date(Date.now() + +f.days.value * 864e5).toISOString(),
    };
    if (g) return pb.collection("shares").update(g.id, { ...body, cover: f.cover.value }, { requestKey: null });
    return pb.collection("shares").create({
      ...body, owner: pb.authStore.record.id, album: src.album || "", items: src.album ? [] : src.items || [],
      public: true, gallery: true, recipients: [],
    }, { requestKey: null });
  });
  if (g) loadCovers(g, $("#modalCard form"));
  return done;
}
async function loadCovers(g, f) {
  const box = $(".g-covers", f);
  try {
    const [photos] = await Promise.all([pb.send(`/api/galleries/${g.id}/photos`, { requestKey: null }), ensureToken()]);
    if (!f.isConnected) return;
    box.innerHTML = photos.map(p => `<button type="button" data-cover="${p.id}" class="${p.id === f.cover.value ? "on" : ""}" title="Use as the cover"><img loading="lazy" alt="" src="${thumbUrl({ ...p, collectionName: "media" })}"></button>`).join("")
      || `<p class="muted">No photos in it yet.</p>`;
    box.onclick = e => {
      const b = e.target.closest("[data-cover]");
      if (!b) return;
      f.cover.value = b.dataset.cover;
      $$("[data-cover]", box).forEach(x => x.classList.toggle("on", x === b));
    };
  } catch (e) { box.innerHTML = `<p class="error">${esc(errText(e))}</p>`; }
}

// What clients hearted, person by person: their file names (to find the originals, e.g. in Lightroom) or an album.
async function galleryPicks(g) {
  const card = openModal(`<h3>Favorites · ${esc(galleryName(g))}</h3><div class="g-picks"><p class="muted">Loading…</p></div>
    <div class="modal-actions"><button class="btn" data-x>Close</button></div>`, true);
  $("[data-x]", card).onclick = () => closeModal(null);
  const box = $(".g-picks", card);
  let list;
  try { [list] = await Promise.all([pb.send(`/api/galleries/${g.id}/picks`, { requestKey: null }), ensureToken()]); }
  catch (e) { box.innerHTML = `<p class="error">${esc(errText(e))}</p>`; return; }
  box.innerHTML = list.length ? list.map((p, i) => `<section class="g-pick">
      <div class="g-pick-head"><strong>${esc(p.name || "Someone")}</strong>
        <span class="muted">${nf.format(p.items.length)} photo${p.items.length === 1 ? "" : "s"}${p.at ? ` · ${esc(ago(pbDate(p.at)))}` : ""}</span>
        <span class="g-pick-acts"><button class="btn ghost sm" data-pk="names" data-i="${i}">${ic("copy")}Copy file names</button>
        <button class="btn ghost sm" data-pk="album" data-i="${i}">${ic("folder-plus")}Make an album</button></span></div>
      <div class="g-pick-grid">${p.items.slice(0, 60).map(it => `<img loading="lazy" alt="" title="${esc(it.name)}" src="${thumbUrl({ ...it, collectionName: "media" })}">`).join("")}
        ${p.items.length > 60 ? `<span class="muted">+${nf.format(p.items.length - 60)} more</span>` : ""}</div>
    </section>`).join("")
    : `<p class="muted">No favorites yet. When a client hearts photos in the gallery, they show up here within a minute.</p>`;
  box.onclick = async e => {
    const b = e.target.closest("[data-pk]");
    if (!b) return;
    const p = list[+b.dataset.i];
    if (b.dataset.pk === "names") return copyText(p.items.map(it => it.name).join("\n"));
    b.disabled = true;
    try {
      const a = await pb.collection("albums").create({ name: `${p.name || "Client"}'s favorites · ${galleryName(g)}`.slice(0, 200), owner: pb.authStore.record.id }, { requestKey: null });
      for (const it of p.items) await pb.collection("media").update(it.id, { "albums+": a.id }, { requestKey: null });
      toast(`Album "${a.name}" made with ${nf.format(p.items.length)} photo${p.items.length === 1 ? "" : "s"}`);
      loadSummary();
    } catch (ex) { toast(errText(ex)); }
    b.disabled = false;
  };
}

// ---------- shared with me ----------
// What people with an account here have shared with me (/api/inbox). Each one opens in the share page
// (share.html?inbox={id}); the badge counts the ones not opened yet.
async function refreshInbox() {
  try { S.inbox = await pb.send("/api/inbox", { requestKey: "inbox" }); } catch { return; }
  const n = S.inbox.filter(s => !s.seen).length;
  $("#inboxCount").textContent = n ? nf.format(n) : "";
  if (S.view === "inbox") renderInbox();
}
async function openInbox() {
  renderInbox();
  await refreshInbox();
}
async function renderInbox() {
  await ensureToken().catch(() => {});
  const cover = s => s.cover
    ? `${ic("users")}<img loading="lazy" alt="" src="/api/inbox/${esc(s.id)}/file/${esc(s.cover)}?thumb=1&token=${encodeURIComponent(S.token)}" onerror="this.remove()">`
    : ic("users");
  $("#inboxView").innerHTML = S.inbox.length ? `<div class="album-grid">${S.inbox.map(s => {
    const exp = pbDate(s.expires);
    const meta = [s.by && `From ${s.by}`, `${nf.format(s.count)} item${s.count === 1 ? "" : "s"}`, exp && `until ${exp.toLocaleDateString()}`].filter(Boolean).join(" · ");
    return `<div class="inbox-item">
      <a class="album-card" href="share.html?inbox=${encodeURIComponent(s.id)}">
        <div class="cover">${cover(s)}${s.seen ? "" : `<span class="smart-tag new-tag">New</span>`}</div>
        <div class="nm">${esc(s.title)}</div>
        <div class="n">${esc(meta)}</div>
      </a>
      <button class="icon-btn sm inbox-x" data-remove="${esc(s.id)}" title="Remove from my list">${ic("x")}</button>
    </div>`;
  }).join("")}</div>` : `<div class="empty"><div class="big">${ic("users")}</div><h3>Nothing shared with you yet</h3>
    <p>When someone with an account here shares an album or photos with you, they show up here.</p></div>`;
  updateCount();
}
$("#inboxView").addEventListener("click", async e => {
  const b = e.target.closest("[data-remove]");
  if (!b) return;
  const s = S.inbox.find(x => x.id === b.dataset.remove);
  if (!(await confirmBox("Remove from your list?", `“${s?.title || "This"}” won't be shared with you any more. Only the person who shared it can share it again.`, "Remove"))) return;
  try {
    await pb.send(`/api/inbox/${encodeURIComponent(b.dataset.remove)}`, { method: "DELETE", requestKey: null });
    S.inbox = S.inbox.filter(x => x.id !== b.dataset.remove);
    renderInbox();
    refreshInbox();
  } catch (ex) { toast(errText(ex)); }
});

function download(r) {
  const a = document.createElement("a");
  a.href = fileUrl(r, r.file, { download: 1 });
  a.download = r.originalName || r.file;
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------- viewer ----------
async function openViewer(i) {
  if (i < 0) return;
  await ensureToken();
  S.vi = i;
  $("#viewer").classList.remove("bare", "closing");
  $("#viewer").hidden = false;
  document.body.style.overflow = "hidden";
  renderViewer();
}
function closeViewer() {
  clearTimeout(tapTimer);
  $("#viewer").hidden = true;
  $("#viewer").classList.remove("closing");
  $("#viewer").style.removeProperty("--v-bg");
  stageMove(0, 0, 1, false);
  $("#vAmbient").classList.remove("on");
  stopPano();
  $("#vStage").innerHTML = "";
  if (vView) { URL.revokeObjectURL(vView); vView = null; }
  document.body.style.overflow = "";
  S.vi = -1;
  if (S.view === "map") { S.dirty = false; renderMarkers(); }
  else if (S.dirty) resetList();
}
function step(d) {
  const n = S.vi + d;
  if (n < 0) return;
  if (n >= S.items.length) {
    if (S.page < S.totalPages) loadMore().then(() => n < S.items.length && (S.vi = n, renderViewer()));
    return;
  }
  S.vi = n;
  renderViewer();
}
function renderViewer() {
  const r = S.items[S.vi];
  if (!r) return closeViewer();
  const stage = $("#vStage");
  if (vView) { URL.revokeObjectURL(vView); vView = null; }
  stopPano();
  if (r.vault) showVaultItem(r, stage);
  else showMedia(r, fileUrl(r, r.file), r.poster ? fileUrl(r, r.poster) : "", stage);
  $("#vZoomCtl").hidden = r.kind === "video" || r.kind === "file" || as360(r);
  const pb360 = $("#vPano");
  pb360.hidden = !r.pano;
  pb360.textContent = as360(r) ? "Flat" : "360°";
  $("#vName").textContent = r.title || r.originalName;
  const when = pbDate(r.takenAt || r.created), total = Math.max(S.total || 0, S.items.length);
  $("#vMeta").textContent = [
    when && !isNaN(when) ? when.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "",
    total > 1 ? `${nf.format(S.vi + 1)} of ${nf.format(total)}` : "",
  ].filter(Boolean).join("  ·  ");
  const amb = $("#vAmbient"), tu = r.vault ? vthumbs.get(r.id) || "" : r.pano ? "" : thumbUrl(r);
  amb.classList.toggle("on", !!tu);
  if (tu) amb.style.backgroundImage = `url("${tu}")`;
  const fav = $('[data-v="fav"]');
  fav.innerHTML = ic(r.favorite ? "heart-fill" : "heart");
  fav.classList.toggle("on", !!r.favorite);
  // Locked items have no favorites/tags/albums (that would mean storing them unencrypted).
  fav.hidden = $('[data-v="info"]').hidden = !!r.vault;
  if (r.trashedAt) fav.hidden = true;
  $('[data-v="restore"]').hidden = !r.trashedAt;
  $('[data-v="unlock"]').hidden = !r.vault;
  $('[data-v="prev"]').hidden = S.vi === 0;
  $('[data-v="next"]').hidden = S.vi >= S.items.length - 1 && S.page >= S.totalPages;
  if (S.infoOpen && !r.vault) renderInfo(r);
  else if (r.vault) $("#vInfo").hidden = true;
  // Preload the photos either side so swiping through is instant.
  for (const nx of [S.items[S.vi + 1], S.items[S.vi - 1]])
    if (nx && (nx.kind === "image" || nx.kind === "gif") && !nx.vault && !nx.pano) new Image().src = fileUrl(nx, nx.file);
  if (S.vi >= S.items.length - 5) loadMore();
}
// Regular files: PDFs/text open in a frame, audio gets a player, anything else a card with Download.
// (The Android WebView can't show PDFs inline, so there it's always the card.)
const DOC_EXT = /\.(pdf|txt|md|csv|json|log)$/i, AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;
function showFile(r, src, stage) {
  const name = r.originalName || r.title || "";
  if (DOC_EXT.test(name) && !window.MediaVaultNative) {
    stage.innerHTML = `<iframe class="v-doc" title="${esc(name)}" src="${src}"></iframe>`;
    return;
  }
  stage.innerHTML = `<div class="nopreview v-file"><div class="big">${ic("file")}</div><p class="v-file-name">${esc(name)}</p>
    <p>${esc(name.includes(".") ? name.split(".").pop().toUpperCase() + " · " : "")}${fmtBytes(r.size || 0)}</p>
    ${AUDIO_EXT.test(name) ? `<audio src="${src}" controls autoplay></audio>` : ""}
    <button class="btn primary" data-v="download">${ic("download")}Download</button></div>`;
}
// ---------- 360° (see pano.js) ----------
let pano360 = null;    // the live 360 view in the viewer
let flat360 = false;   // the "Flat" button: show 360 items as their plain image/video instead (this session)
const as360 = r => !!r?.pano && !flat360 && (r.kind === "image" || r.kind === "video");
function stopPano() {
  pano360?.destroy();
  pano360 = null;
}
function showPano(r, src, poster, stage) {
  const fail = e => noPreview(stage, errText(e) || "This 360° item can't be shown here.");
  const wrap = document.createElement("div");
  wrap.className = "pano";
  stage.replaceChildren(wrap);
  const start = el => {
    if (S.items[S.vi] !== r || $("#viewer").hidden || !wrap.isConnected) return;
    try { pano360 = panoView(wrap, el, r.pano); } catch (e) { fail(e); }
  };
  if (r.kind === "image") {
    wrap.innerHTML = `<div class="nopreview"><p>Loading 360° photo…</p></div>`;
    const img = new Image();
    img.onload = () => { wrap.innerHTML = ""; start(img); };
    img.onerror = () => fail(new Error("This image format can't be shown in the browser."));
    img.src = src;
    return;
  }
  // Video: the picture is drawn on the canvas, so the controls are our own.
  wrap.innerHTML = `<video class="pano-src" src="${src}" playsinline autoplay ${poster ? `poster="${poster}"` : ""}></video>
    <div class="pano-bar"><button class="icon-btn" data-pp title="Play / pause">${ic("play")}</button>
    <input type="range" min="0" max="1000" value="0" data-seek aria-label="Seek"><span data-t>0:00</span></div>`;
  const v = $("video", wrap), seek = $("[data-seek]", wrap), t = $("[data-t]", wrap);
  v.onerror = () => fail(new Error("This video format can't be played in the browser."));
  v.addEventListener("loadeddata", () => start(v), { once: true });
  $("[data-pp]", wrap).onclick = () => (v.paused ? v.play() : v.pause());
  seek.oninput = () => { if (v.duration) v.currentTime = (seek.value / 1000) * v.duration; };
  v.ontimeupdate = () => {
    if (v.duration) seek.value = Math.round((v.currentTime / v.duration) * 1000);
    t.textContent = `${fmtDur(v.currentTime)} / ${fmtDur(v.duration)}`;
  };
  v.onplay = v.onpause = () => ($("[data-pp]", wrap).innerHTML = ic(v.paused ? "play" : "pause"));
}

function showMedia(r, src, poster, stage) {
  if (r.kind === "file") return showFile(r, src, stage);
  if (as360(r)) return showPano(r, src, poster, stage);
  if (r.kind === "video") {
    stage.innerHTML = `<video src="${src}" controls autoplay playsinline ${poster ? `poster="${poster}"` : ""}></video>`;
    $("video", stage).onerror = () => noPreview(stage, "This video format can't be played in the browser.");
  } else {
    stage.innerHTML = `<img alt="" draggable="false" src="${src}">`;
    const img = $("img", stage);
    img.onload = () => { zReset(); img.classList.add("shown"); };
    img.onerror = () => { $("#vZoomCtl").hidden = true; noPreview(stage, "This image format can't be shown in the browser."); };
    zReset();
  }
}
// Locked items: download the ciphertext, decrypt it here, show it from memory (never written to disk).
async function showVaultItem(r, stage) {
  stage.innerHTML = `<div class="nopreview"><div class="big">${ic("lock")}</div><p>Decrypting… <span data-pct>0%</span></p></div>`;
  try {
    const blob = await vaultFile(r, p => { const el = $("[data-pct]", stage); if (el) el.textContent = `${Math.round(p * 100)}%`; });
    if (S.items[S.vi] !== r || $("#viewer").hidden) return; // moved on meanwhile
    vView = URL.createObjectURL(blob);
    showMedia(r, vView, vthumbs.get(r.id) || "", stage);
  } catch (e) {
    if (S.items[S.vi] === r) noPreview(stage, e.message);
  }
}
function noPreview(stage, msg) {
  stage.innerHTML = `<div class="nopreview"><div class="big">${ic("alert")}</div><p>${esc(msg)}</p><button class="btn primary" data-v="download">${ic("download")}Download to open it</button></div>`;
}

function renderInfo(r) {
  const box = $("#vInfo");
  box.hidden = false;
  const tags = Array.isArray(r.tags) ? r.tags : [];
  const taken = pbDate(r.takenAt), added = pbDate(r.created);
  box.innerHTML = `
    <div><h4>Name</h4><input id="iTitle" value="${esc(r.title)}" maxlength="300"></div>
    <div><h4>Tags</h4>
      <div class="tag-list">${tags.map(t => `<span class="tag">${esc(t)}<button data-untag="${esc(t)}" title="Remove">×</button></span>`).join("") || `<span class="muted">No tags</span>`}</div>
      <input id="iTag" placeholder="Add a tag and press Enter" maxlength="40"></div>
    <div><h4>Albums</h4>
      <div class="check-list">${S.albums.filter(a => !a.rules).map(a => `<label><input type="checkbox" data-alb="${a.id}" ${(r.albums || []).includes(a.id) ? "checked" : ""}> ${esc(a.name)}</label>`).join("") || `<span class="muted">No albums yet</span>`}</div></div>
    <div><h4>Details</h4><dl>
      <dt>File</dt><dd>${esc(r.originalName)}</dd>
      <dt>Type</dt><dd>${{ image: "Photo", gif: "GIF", video: "Video", file: "File" }[r.kind]}</dd>
      ${r.kind === "image" || r.kind === "video" ? `<dt>360°</dt><dd><select id="iPano" aria-label="360° view">
        ${[["", "Off (flat)"], ["equirect", "360° panorama"], ["fisheye", "Insta360 raw (dual fisheye)"]].map(([v, l]) => `<option value="${v}" ${(r.pano || "") === v ? "selected" : ""}>${l}</option>`).join("")}
      </select></dd>` : ""}
      <dt>Size</dt><dd>${fmtBytes(r.size)}</dd>
      ${r.width ? `<dt>Dimensions</dt><dd>${r.width} × ${r.height}</dd>` : ""}
      ${r.kind === "video" && r.duration ? `<dt>Length</dt><dd>${fmtDur(r.duration)}</dd>` : ""}
      <dt>Taken</dt><dd>${fmtDate(taken)}</dd>
      <dt>Added</dt><dd>${fmtDate(added)}</dd>
      ${r.lat || r.lng ? `<dt>Place</dt><dd><a href="https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lng}#map=15/${r.lat}/${r.lng}" target="_blank" rel="noopener">${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}</a></dd>` : ""}
    </dl></div>`;
}
async function saveItem(r, patch) {
  try {
    Object.assign(r, await pb.collection("media").update(r.id, patch, { requestKey: null }));
    refreshTile(r);
    if (S.items[S.vi] === r) {
      $("#vName").textContent = r.title || r.originalName;
      if (S.infoOpen) renderInfo(r);
    }
  } catch (e) { toast(errText(e)); }
}
$("#vInfo").addEventListener("change", e => {
  const r = S.items[S.vi];
  if (e.target.id === "iTitle") saveItem(r, { title: e.target.value.trim() });
  if (e.target.id === "iPano") saveItem(r, { pano: e.target.value }).then(renderViewer);
  if (e.target.dataset.alb) {
    saveItem(r, { [e.target.checked ? "albums+" : "albums-"]: e.target.dataset.alb }).then(() => {
      if (S.view === "album" || S.view === "library") S.dirty = true;
      loadSummarySoon();
    });
  }
});
$("#vInfo").addEventListener("keydown", e => {
  if (e.target.id !== "iTag" || e.key !== "Enter") return;
  const r = S.items[S.vi];
  const t = e.target.value.trim().toLowerCase();
  const tags = Array.isArray(r.tags) ? r.tags : [];
  if (t && !tags.includes(t)) saveItem(r, { tags: [...tags, t] }).then(() => $("#iTag")?.focus());
  e.target.value = "";
});
$("#vInfo").addEventListener("click", e => {
  const t = e.target.closest("[data-untag]")?.dataset.untag;
  if (t == null) return;
  const r = S.items[S.vi];
  saveItem(r, { tags: (r.tags || []).filter(x => x !== t) });
});

async function viewerAction(a) {
  const r = S.items[S.vi];
  if (!r) return;
  if (r.vault && (a === "fav" || a === "info")) return;
  if (a === "close") closeViewer();
  if (a === "pano" && r.pano) { flat360 = !flat360; renderViewer(); }
  if (a === "prev") slide(-1);
  if (a === "next") slide(1);
  if (a === "fav") {
    await saveItem(r, { favorite: !r.favorite });
    renderViewer();
    loadSummarySoon();
  }
  if (a === "download") {
    if (r.vault) {
      toast("Decrypting…", 60000);
      try { await saveBlob(await vaultFile(r), r.originalName || r.title || "file"); } catch (e) { toast(errText(e)); }
    } else { await ensureToken(); download(r); }
  }
  if (a === "unlock") {
    if (!(await confirmBox("Move to library?", `“${r.title || r.originalName}” will be decrypted and stored normally again.`, "Move"))) return;
    try { await moveToLibrary(r); closeViewer(); } catch (e) { toast(errText(e)); }
  }
  if (a === "info") {
    S.infoOpen = !S.infoOpen;
    if (S.infoOpen) renderInfo(r);
    else $("#vInfo").hidden = true;
    zApply();
  }
  if (a === "zoomin" || a === "zoomout") {
    const st = $("#vStage");
    zoomAt(st.clientWidth / 2, st.clientHeight / 2, Z.s * (a === "zoomin" ? 1.6 : 1 / 1.6), true);
  }
  if (a === "zoomfit") zToggle($("#vStage").clientWidth / 2, $("#vStage").clientHeight / 2);
  if (a === "restore") {
    await restoreItems([r]);
    afterViewerRemove();
  }
  if (a === "delete") {
    if (!r.vault && !r.trashedAt) {
      await trashItems([r]);
      return afterViewerRemove();
    }
    if (!(await confirmBox("Delete forever?", `“${r.title || r.originalName}” will be permanently removed from the server.`, "Delete forever"))) return;
    try {
      await pb.collection(r.vault ? "vault_items" : "media").delete(r.id);
      dropItem(r.id);
      updateCount();
      updateEmpty();
      loadSummarySoon();
      afterViewerRemove();
    } catch (e) { toast(errText(e)); }
  }
}
// The current item left the list (deleted, trashed, restored): show the next one, or close.
function afterViewerRemove() {
  if (S.vi >= S.items.length) S.vi = S.items.length - 1;
  S.items.length ? renderViewer() : closeViewer();
}
$("#viewer").addEventListener("click", e => {
  const a = e.target.closest("[data-v]")?.dataset.v;
  if (a) viewerAction(a);
});
// ---------- zoom & pan (photos and GIFs) ----------
// Z.s is the zoom relative to "fit to screen"; Z.x/Z.y translate the fitted image (stage pixels).
const Z = { s: 1, x: 0, y: 0 };
const zImg = () => $("#vStage img");
function zGeom() {
  const st = $("#vStage"), img = zImg();
  const W = st.clientWidth, H = st.clientHeight;
  const nw = img?.naturalWidth || W, nh = img?.naturalHeight || H;
  const fit = Math.min(1, W / nw, H / nh); // never blow small images up past 100%
  const iw = nw * fit, ih = nh * fit;
  return { W, H, fit, iw, ih, ox: (W - iw) / 2, oy: (H - ih) / 2, max: Math.max(4, 3 / fit) };
}
function zApply(animate = false) {
  const img = zImg();
  if (!img) return;
  const g = zGeom();
  Z.s = Math.min(g.max, Math.max(1, Z.s));
  // Smaller than the screen on an axis → centre it; bigger → don't let an edge pull inside the screen.
  const clamp = (v, box, len, off) => {
    const sl = Z.s * len;
    return sl <= box ? (box - sl) / 2 - off : Math.min(-off, Math.max(box - off - sl, v));
  };
  Z.x = clamp(Z.x, g.W, g.iw, g.ox);
  Z.y = clamp(Z.y, g.H, g.ih, g.oy);
  Object.assign(img.style, {
    left: `${g.ox}px`, top: `${g.oy}px`, width: `${g.iw}px`, height: `${g.ih}px`,
    transition: animate ? "transform .2s ease, opacity .2s ease" : "opacity .2s ease",
    transform: `translate(${Z.x}px, ${Z.y}px) scale(${Z.s})`,
  });
  img.classList.toggle("zoomed", Z.s > 1.01);
  $("#vZoom").textContent = `${Math.round(Z.s * g.fit * 100)}%`;
}
function zReset() {
  Z.s = 1; Z.x = 0; Z.y = 0;
  zApply();
}
// Zoom to scale s while keeping the image point under (cx, cy) — stage coordinates — in place.
function zoomAt(cx, cy, s, animate = false) {
  const { ox, oy, max } = zGeom();
  s = Math.min(max, Math.max(1, s));
  const qx = (cx - ox - Z.x) / Z.s, qy = (cy - oy - Z.y) / Z.s;
  Z.x = cx - ox - s * qx;
  Z.y = cy - oy - s * qy;
  Z.s = s;
  zApply(animate);
}
// Double-click / double-tap / the % button: fit ↔ 100% (or 2.5× for photos already close to screen size).
function zToggle(cx, cy) {
  if (Z.s > 1.01) { Z.s = 1; Z.x = Z.y = 0; zApply(true); return; }
  const fit = zGeom().fit;
  zoomAt(cx, cy, 1 / fit > 1.5 ? 1 / fit : 2.5, true);
}
const stagePt = (e, st = $("#vStage").getBoundingClientRect()) => ({ x: e.clientX - st.left, y: e.clientY - st.top });

$("#vStage").addEventListener("wheel", e => {
  if (!zImg()) return;
  e.preventDefault();
  const p = stagePt(e);
  // ctrlKey = trackpad pinch on most browsers; it sends small deltas.
  zoomAt(p.x, p.y, Z.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)));
}, { passive: false });

// One pointer: drag to pan when zoomed. When not, the item follows the finger — sideways to go to the
// next/previous one, down to close. Tap once to hide/show the controls, tap twice to zoom.
// Two pointers: pinch to zoom (and move both fingers to pan).
const ptrs = new Map();
let drag = null, pinch = null, lastTap = { t: 0, x: 0, y: 0 }, tapTimer = 0, sliding = false;
const SWIPE_EASE = "cubic-bezier(.2,.8,.2,1)";
// Move the whole stage (the swipe); ms = 0 follows the finger with no animation.
function stageMove(x, y, scale = 1, ms = 0, fade = 1) {
  const st = $("#vStage");
  st.style.transition = ms ? `transform ${ms}ms ${SWIPE_EASE}, opacity ${ms}ms ease` : "none";
  st.style.transform = x || y || scale !== 1 ? `translate3d(${x}px, ${y}px, 0) scale(${scale})` : "";
  st.style.opacity = fade < 1 ? fade : "";
}
const hasItem = d => (d > 0 ? S.vi + 1 < S.items.length || S.page < S.totalPages : S.vi > 0);
// Snap back to where it was (a swipe that didn't go far enough).
function settle() {
  stageMove(0, 0, 1, 300);
  $("#viewer").style.removeProperty("--v-bg");
}
// Go to the next (1) / previous (-1) item: the current one slides out, the new one slides in after it.
function slide(d) {
  if (sliding) return;
  if (!hasItem(d)) return settle();
  if (S.vi + d >= S.items.length) { settle(); step(d); return; } // next page still loading; step() shows it when it's in
  sliding = true;
  const W = $("#vStage").clientWidth;
  stageMove(-d * W, 0, 1, 190, 0.2);
  setTimeout(() => {
    step(d);
    stageMove(d * W * 0.3, 0, 1, 0, 0);
    $("#vStage").offsetWidth; // apply that start position before animating from it
    stageMove(0, 0, 1, 300);
    sliding = false;
  }, 190);
}
// Swiped down far enough: the item drops away with the backdrop, then the viewer closes.
function swipeClose() {
  const v = $("#viewer"), H = $("#vStage").clientHeight;
  sliding = true;
  v.style.setProperty("--v-bg", 0);
  stageMove(0, H * 0.45, 0.8, 220, 0);
  setTimeout(() => { sliding = false; closeViewer(); }, 220);
}

$("#vStage").addEventListener("pointerdown", e => {
  if (sliding || e.target.closest("button, input, audio, iframe, .pano-bar") || (e.pointerType === "mouse" && e.button !== 0)) return;
  // The video's own control bar (seek, volume) needs its sideways drags.
  const isVideo = e.target.tagName === "VIDEO";
  if (isVideo && e.clientY > e.target.getBoundingClientRect().bottom - 80) return;
  // Videos get the pointer only once it's clearly a swipe, so a tap still reaches their controls.
  if (!isVideo) try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  ptrs.set(e.pointerId, stagePt(e));
  if (ptrs.size === 2 && zImg()) {
    const [a, b] = [...ptrs.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: Z.s, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    if (drag?.axis) { $("#viewer").classList.remove("dragging"); settle(); }
    drag = null;
  } else if (ptrs.size === 1) {
    drag = { cx: e.clientX, cy: e.clientY, zx: Z.x, zy: Z.y, moved: false, axis: "", t: e.timeStamp, lx: e.clientX, ly: e.clientY, vx: 0, vy: 0 };
  }
});
$("#vStage").addEventListener("pointermove", e => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, stagePt(e));
  if (pinch && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    Z.x += mid.x - pinch.mid.x;
    Z.y += mid.y - pinch.mid.y;
    pinch.mid = mid;
    zoomAt(mid.x, mid.y, pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d);
    return;
  }
  if (!drag) return;
  const dx = e.clientX - drag.cx, dy = e.clientY - drag.cy;
  // Finger speed (px/ms), smoothed, so a quick flick counts even when it's short.
  const dt = Math.max(1, e.timeStamp - drag.t);
  drag.vx = 0.6 * ((e.clientX - drag.lx) / dt) + 0.4 * drag.vx;
  drag.vy = 0.6 * ((e.clientY - drag.ly) / dt) + 0.4 * drag.vy;
  Object.assign(drag, { t: e.timeStamp, lx: e.clientX, ly: e.clientY });
  if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 8) drag.moved = true;
  if (Z.s > 1.01 && zImg()) {
    Z.x = drag.zx + dx;
    Z.y = drag.zy + dy;
    zApply();
    return;
  }
  if (!drag.moved || sliding) return;
  if (!drag.axis) {
    drag.axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
    try { $("#vStage").setPointerCapture(e.pointerId); } catch {}
    $("#viewer").classList.add("dragging");
  }
  if (drag.axis === "x") {
    // Nothing that way: it gives a little, like a rubber band.
    stageMove(hasItem(dx < 0 ? 1 : -1) ? dx : dx / 4, 0);
  } else {
    const k = Math.min(1, Math.max(0, dy) / $("#vStage").clientHeight);
    stageMove(dx * 0.4, dy > 0 ? dy : dy / 5, 1 - k * 0.25);
    $("#viewer").style.setProperty("--v-bg", Math.max(0, 1 - k * 1.8));
  }
});
function pointerEnd(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if (pinch) {
    if (ptrs.size < 2) pinch = null;
    // Keep panning smoothly with the finger that's still down.
    if (ptrs.size === 1) { const p = [...ptrs.values()][0], st = $("#vStage").getBoundingClientRect(); drag = { cx: p.x + st.left, cy: p.y + st.top, zx: Z.x, zy: Z.y, moved: true, axis: "", t: e.timeStamp, lx: 0, ly: 0, vx: 0, vy: 0 }; }
    return;
  }
  const d = drag;
  drag = null;
  $("#viewer").classList.remove("dragging");
  if (!d) return;
  if (e.type === "pointercancel") { if (d.axis) settle(); return; }
  const dx = e.clientX - d.cx, dy = e.clientY - d.cy;
  if (d.axis === "x") {
    const W = $("#vStage").clientWidth;
    // Far enough (and not flicked back), or a quick flick that way.
    const far = Math.abs(dx) > W * 0.2 && d.vx * dx > -0.05, flick = Math.abs(d.vx) > 0.35 && d.vx * dx > 0 && Math.abs(dx) > 24;
    return far || flick ? slide(dx < 0 ? 1 : -1) : settle();
  }
  if (d.axis === "y") {
    const H = $("#vStage").clientHeight;
    return dy > H * 0.16 || (d.vy > 0.5 && dy > 40) ? swipeClose() : settle();
  }
  if (d.moved) return;
  const img = zImg();
  if (!img && $("video, iframe, .pano", $("#vStage"))) return; // their own taps
  const p = stagePt(e), now = Date.now();
  if (img && now - lastTap.t < 300 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
    clearTimeout(tapTimer);
    lastTap.t = 0;
    zToggle(p.x, p.y);
  } else {
    lastTap = { t: now, x: p.x, y: p.y };
    clearTimeout(tapTimer);
    if (e.pointerType !== "mouse") tapTimer = setTimeout(() => $("#viewer").classList.toggle("bare"), img ? 280 : 0);
  }
}
$("#vStage").addEventListener("pointerup", pointerEnd);
$("#vStage").addEventListener("pointercancel", pointerEnd);
window.addEventListener("resize", () => { if (!$("#viewer").hidden) zApply(); });

document.addEventListener("keydown", e => {
  if (modalOpen()) { if (e.key === "Escape" && !modalSticky) closeModal(null); return; }
  if (!$("#siteFrame").hidden) { if (e.key === "Escape") closeSiteFrame(); return; } // keys inside the site stay there
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (!$("#viewer").hidden) {
    const map = { Escape: "close", ArrowLeft: "prev", ArrowRight: "next", f: "fav", i: "info", v: "pano", Delete: "delete" };
    if (zImg()) Object.assign(map, { "+": "zoomin", "=": "zoomin", "-": "zoomout", 0: "zoomfit" });
    // Esc while zoomed goes back to "fit" first, then closes on the next press.
    if (e.key === "Escape" && Z.s > 1.01 && zImg()) map.Escape = "zoomfit";
    if (map[e.key]) { e.preventDefault(); viewerAction(map[e.key]); }
  } else if (e.key === "Escape" && S.selecting) {
    setSelecting(false);
  }
});

// ---------- uploads ----------
// .insp / .insv / .lrv: Insta360 raw 360° photo (a JPEG) / video / low-res video (MP4s).
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|3gp|mpe?g|ts|mts|insv|lrv)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|heic|heif|avif|tiff?|insp)$/i;
function kindOf(f) {
  if (f.type === "image/gif" || /\.gif$/i.test(f.name)) return "gif";
  if (/\.insp$/i.test(f.name)) return "image";
  if (f.type.startsWith("video/") || VIDEO_EXT.test(f.name)) return "video";
  if ((f.type.startsWith("image/") && f.type !== "image/svg+xml") || IMAGE_EXT.test(f.name)) return "image";
  return S.allowFiles ? "file" : null; // the server checks this too for library uploads (locked items are opaque to it)
}

function imageMeta(file) {
  return new Promise(res => {
    const url = URL.createObjectURL(file), img = new Image();
    let finished = false;
    const done = v => { if (finished) return; finished = true; URL.revokeObjectURL(url); res(v); };
    img.onload = () => done({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => done({});
    setTimeout(() => done({}), 15000);
    img.src = url;
  });
}
// Reads dimensions + length and grabs a frame as the poster image.
function videoMeta(file) {
  return new Promise(res => {
    const url = URL.createObjectURL(file), v = document.createElement("video");
    let finished = false, grabbing = false, partial = {};
    const done = val => {
      if (finished) return;
      finished = true;
      v.removeAttribute("src");
      v.load();
      URL.revokeObjectURL(url);
      res(val);
    };
    v.muted = true;
    v.preload = "auto";
    v.playsInline = true;
    v.onloadedmetadata = () => {
      partial = { width: v.videoWidth, height: v.videoHeight, duration: isFinite(v.duration) ? v.duration : 0 };
      v.currentTime = Math.min(1, (partial.duration || 1) / 4);
    };
    // Some files (e.g. browser-recorded WebM) never finish seeking; fall back to the first decoded frame.
    v.onloadeddata = () => setTimeout(() => v.onseeked(), 3000);
    v.onseeked = () => {
      if (finished || grabbing) return;
      grabbing = true;
      if (!v.videoWidth || v.readyState < 2) return done(partial);
      const scale = Math.min(1, 800 / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(v.videoWidth * scale);
      c.height = Math.round(v.videoHeight * scale);
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      c.toBlob(b => done({ ...partial, poster: b }), "image/jpeg", 0.82);
    };
    v.onerror = () => done(partial);
    setTimeout(() => done(partial), 20000);
    v.src = url;
  });
}
// "Date taken" + GPS location from a photo or video File: { date, lat, lng } (any may be missing), or null.
// The parsing lives in mediainfo.js (JPEG/HEIC/PNG/WebP EXIF, MP4/MOV location).
const fileInfo = f => mediaInfo(f.size, async (a, b) => new Uint8Array(await f.slice(a, b).arrayBuffer()));

// Content fingerprint for duplicate detection: SHA-256 of the size plus the whole file, or for files over
// 3 MB a 1 MB sample from the start, middle and end (fast even for huge videos, and only ranges of
// older files need fetching). read(start, end) returns those bytes.
const FP_CHUNK = 1 << 20;
async function fingerprint(size, read) {
  const h = sha256.create();
  h.update(new TextEncoder().encode(`mv1:${size}:`));
  if (size <= 3 * FP_CHUNK) h.update(await read(0, size));
  else for (const at of [0, Math.floor(size / 2 - FP_CHUNK / 2), size - FP_CHUNK]) h.update(await read(at, at + FP_CHUNK));
  return [...h.digest()].map(b => b.toString(16).padStart(2, "0")).join("");
}
const fileFingerprint = f => fingerprint(f.size, async (a, b) => new Uint8Array(await f.slice(a, b).arrayBuffer()));
async function storedFingerprint(r) {
  await ensureToken();
  const url = fileUrl(r, r.file);
  return fingerprint(r.size, async (a, b) => {
    const res = await fetch(url, { headers: { Range: `bytes=${a}-${b - 1}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    return res.status === 206 ? buf : buf.subarray(a, b); // server ignored the range
  });
}
// An existing library item (Trash included) with the same content, or null.
async function findDuplicate(hash, size) {
  const col = pb.collection("media");
  const hit = await col.getList(1, 1, { filter: pb.filter("hash = {:hash}", { hash }), requestKey: null });
  if (hit.items.length) return hit.items[0];
  // Items from before fingerprints existed get one now, but only those with exactly this size could match.
  const older = await col.getFullList({ filter: pb.filter("hash = '' && size = {:size}", { size }), requestKey: null });
  for (const r of older) {
    try {
      const h = await storedFingerprint(r);
      await col.update(r.id, { hash: h }, { requestKey: null });
      if (h === hash) return r;
    } catch {}
  }
  return null;
}

function send(form, onProgress, collection = "media") {
  return postForm(`/api/collections/${collection}/records`, form, onProgress);
}
// A multipart POST with upload progress (fetch can't report it).
function postForm(url, form, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", url);
    x.setRequestHeader("Authorization", pb.authStore.token);
    x.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      let body = {};
      try { body = JSON.parse(x.responseText); } catch {}
      if (x.status < 300) resolve(body);
      else reject(new Error(Object.values(body.data || {})[0]?.message || body.message || `Upload failed (HTTP ${x.status})`));
    };
    x.onerror = () => reject(new Error("Network error"));
    x.send(form);
  });
}

const Q = { jobs: [], active: 0, done: 0, failed: 0, skipped: 0, total: 0, hashes: new Set() };
let upHideTimer = 0;
// The finished uploads panel closes itself: after a few seconds, or longer if something failed or was skipped
// (so there's time to read why / tap "Upload anyway"). Hovering it keeps it open.
function hideUploadsSoon() {
  clearTimeout(upHideTimer);
  upHideTimer = setTimeout(() => {
    if (uploadsBusy()) return;
    if ($("#uploads").matches(":hover")) return hideUploadsSoon();
    $("#uploads").hidden = true;
  }, Q.failed || Q.skipped ? 10000 : 4000);
}
const uploadsBusy = () => Q.active > 0 || Q.jobs.length > 0;
// opts.toLibrary: upload to the normal library even while the locked folder is open (used by "Move to library").
// opts.onDone / opts.tags: run after a successful upload / tags to keep.
// opts.force: upload even if it's a duplicate. opts.albumId: album to add to (default: the open album).
// opts.folder: folder to file it in (default: the open folder).
function enqueue(files, opts = {}) {
  if (!files.length) return;
  const intoVault = S.view === "locked" && !opts.toLibrary;
  if (intoVault && !V.isUnlocked()) { toast("Unlock the locked folder first"); return; }
  if (!uploadsBusy()) { Q.done = Q.failed = Q.skipped = Q.total = 0; Q.hashes.clear(); $("#upList").innerHTML = ""; }
  const albumId = opts.albumId ?? (S.view === "album" && !S.albums.find(a => a.id === S.albumId)?.rules ? S.albumId : "");
  clearTimeout(upHideTimer);
  $("#uploads").hidden = false;
  for (const f of files) {
    Q.total++;
    const row = document.createElement("div");
    row.className = "up-row";
    row.innerHTML = `<div class="nm"><span>${intoVault ? ic("lock") : ""}${esc(f.name)}</span><span class="st">Waiting</span></div><div class="bar"><i></i></div>`;
    $("#upList").append(row);
    const kind = kindOf(f);
    if (!kind) {
      Q.failed++;
      setRow(row, "Not a photo or video (files aren't turned on for your account)", 1, "fail");
      continue;
    }
    // The file key is made now, so the folder auto-locking mid-queue can't stop the upload.
    Q.jobs.push({
      f, kind, row, albumId, key: intoVault ? V.newFileKey() : null, folder: intoVault ? S.vfolder : opts.folder ?? openFolder(), onDone: opts.onDone, tags: opts.tags,
      checkDup: !intoVault && !opts.onDone && !opts.force, // locked items are never compared (that would leak a fingerprint)
    });
  }
  updateUpTitle();
  pump();
}
function pump() {
  while (Q.active < UPLOAD_CONCURRENCY && Q.jobs.length) {
    const job = Q.jobs.shift();
    Q.active++;
    uploadOne(job).finally(() => {
      Q.active--;
      updateUpTitle();
      if (!uploadsBusy()) uploadsFinished();
      else pump();
    });
  }
}
function setRow(row, status, p, cls) {
  $(".st", row).textContent = status;
  $(".bar i", row).style.width = `${Math.round(p * 100)}%`;
  if (cls) row.classList.add(cls);
}
function updateUpTitle() {
  $("#upTitle").textContent = uploadsBusy()
    ? `Uploading ${Q.done + Q.failed + Q.skipped + 1} of ${Q.total}`
    : `${Q.done} uploaded${Q.skipped ? `, ${Q.skipped} already there` : ""}${Q.failed ? `, ${Q.failed} failed` : ""}`;
}
async function uploadOne(job) {
  const { f, kind, row, albumId, key, folder, onDone, tags, checkDup } = job;
  setRow(row, "Preparing…", 0);
  try {
    let hash = "";
    if (!key) {
      setRow(row, "Checking…", 0);
      hash = await fileFingerprint(f);
      // Claim the hash before any await, so an identical file running in parallel sees it.
      const inBatch = Q.hashes.has(hash);
      Q.hashes.add(hash);
      if (checkDup) {
        const twin = inBatch ? "batch" : await findDuplicate(hash, f.size);
        if (twin) return await skipDuplicate(job, twin);
      }
    }
    const meta = kind === "video" ? await videoMeta(f) : kind === "file" ? {} : await imageMeta(f);
    const ex = kind === "image" || kind === "video" ? await fileInfo(f) : null;
    const taken = ex?.date || new Date(f.lastModified || Date.now());
    const pano = await detectPano(f, kind, meta);
    // Raw dual-fisheye: the thumbnail is a stitched straight-ahead view instead of two circles.
    if (pano === "fisheye") {
      const flat = await panoPoster(kind === "video" ? meta.poster : f, pano);
      if (flat) meta.poster = flat;
    }
    if (key) {
      const thumb = kind === "video" || pano === "fisheye" ? meta.poster : kind === "file" ? null : await makeThumb(f);
      await createVaultItem(key, f, thumb, {
        kind, title: f.name.replace(/\.[^.]+$/, ""), originalName: f.name, mime: f.type, size: f.size,
        width: meta.width || 0, height: meta.height || 0, duration: meta.duration || 0, takenAt: taken.toISOString(), tags: tags || [],
        ...(folder && { folder }), ...(pano && { pano }),
      }, (phase, p) => phase === "enc"
        ? setRow(row, `Encrypting ${Math.round(p * 100)}%`, p * 0.3)
        : setRow(row, p < 1 ? `${Math.round(p * 100)}%` : "Saving…", 0.3 + p * 0.7));
      Q.done++;
      setRow(row, "Done", 1, "done");
      return;
    }
    const fd = new FormData();
    fd.append("owner", pb.authStore.record.id);
    fd.append("kind", kind);
    fd.append("title", f.name.replace(/\.[^.]+$/, ""));
    fd.append("originalName", f.name);
    fd.append("size", f.size);
    if (meta.width) { fd.append("width", meta.width); fd.append("height", meta.height); }
    if (meta.duration) fd.append("duration", Math.round(meta.duration * 10) / 10);
    fd.append("takenAt", taken.toISOString());
    if (albumId) fd.append("albums", albumId);
    if (folder) fd.append("folder", folder);
    if (pano) fd.append("pano", pano);
    if (meta.poster) fd.append("poster", meta.poster, "poster.jpg");
    if (tags?.length) fd.append("tags", JSON.stringify(tags));
    if (hash) fd.append("hash", hash);
    // Location from the file's own metadata (EXIF / video location); either way the item counts as checked.
    if (ex?.lat != null) { fd.append("lat", ex.lat); fd.append("lng", ex.lng); }
    fd.append("geoDone", "true");
    fd.append("file", f);
    await send(fd, p => setRow(row, p < 1 ? `${Math.round(p * 100)}%` : "Saving…", p));
    await onDone?.();
    Q.done++;
    setRow(row, "Done", 1, "done");
  } catch (e) {
    Q.failed++;
    setRow(row, e.message, 1, "fail");
  }
}
// twin: the existing record, or "batch" when the same file is earlier in this upload.
async function skipDuplicate(job, twin) {
  Q.skipped++;
  let msg = twin === "batch" ? "Duplicate in this upload" : twin.trashedAt ? "Already in Trash" : "Already in library";
  // Uploading into an album: put the existing copy in it instead.
  if (twin !== "batch" && !twin.trashedAt && job.albumId && !(twin.albums || []).includes(job.albumId)) {
    try {
      await pb.collection("media").update(twin.id, { "albums+": job.albumId }, { requestKey: null });
      msg = "Already in library · added to album";
    } catch {}
  }
  setRow(job.row, msg, 1, "skip");
  const b = document.createElement("button");
  b.className = "link up-again";
  b.textContent = "Upload anyway";
  b.onclick = () => { job.row.remove(); Q.skipped--; Q.total--; enqueue([job.f], { force: true, albumId: job.albumId, folder: job.folder }); };
  job.row.append(b);
}
function uploadsFinished() {
  hideUploadsSoon();
  S.vaultAll = null;
  loadSummary();
  if (S.view !== "albums") {
    if ($("#viewer").hidden) resetList();
    else S.dirty = true;
  }
  toast(`${Q.done} file(s) uploaded${Q.skipped ? `, ${Q.skipped} skipped (already in your library)` : ""}${Q.failed ? `, ${Q.failed} failed` : ""}`);
}
$("#upClose").onclick = () => { clearTimeout(upHideTimer); $("#uploads").hidden = true; };
$("#uploadBtn").onclick = () => $("#fileInput").click();
$("#fileInput").onchange = e => { enqueue([...e.target.files]); e.target.value = ""; };
window.addEventListener("beforeunload", e => { if (uploadsBusy() || W.busy.size) e.preventDefault(); });

// Drag & drop anywhere. On the Sites page a drop publishes a site instead (siteDrop), and there's no overlay, so
// you can drop onto a particular site's card.
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
const dragOver = on => {
  $("#drop").hidden = !on || S.view === "sites";
  $("#sitesView").classList.toggle("dropping", on && S.view === "sites");
  if (!on) $$(".site-card.drop-on").forEach(c => c.classList.remove("drop-on"));
};
window.addEventListener("dragenter", e => {
  if (!hasFiles(e) || $("#app").hidden) return;
  dragDepth++;
  dragOver(true);
});
window.addEventListener("dragleave", e => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; dragOver(false); }
});
window.addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("drop", e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dragOver(false);
  if ($("#app").hidden) return;
  if (S.view === "sites") siteDrop(e);
  else enqueue([...e.dataTransfer.files]);
});

// ---------- locked folder ----------
// End-to-end encrypted: see vault.js. Decrypted thumbnails/files only ever live in memory as blob: URLs.
const vthumbs = new Map(); // item id → blob: URL of its decrypted thumbnail
let vView = null;          // blob: URL of the locked item open in the viewer
// The Android app's bridge. Newer apps (version()) want the key they give this page once it has loaded
// (window.__mvNativeKey, then the "mvnative" event) as the first argument, so hosted sites in its frame can't use it.
const nativeArgs = () => (window.MediaVaultNative?.version ? [window.__mvNativeKey] : []);
const native = (fn, ...a) => {
  const app = window.MediaVaultNative;
  if (!app?.[fn]) return;
  if (app.version && !window.__mvNativeKey) { addEventListener("mvnative", () => native(fn, ...a), { once: true }); return; }
  try { app[fn](...nativeArgs(), ...a); } catch {}
};

async function fetchVault() {
  if (S.vault !== undefined) return S.vault;
  const res = await pb.collection("vault").getList(1, 1, { requestKey: null });
  return (S.vault = res.items[0] || null);
}
async function unlockWith(pass) {
  S.vault = undefined; // always check against the server's current copy (passphrase may have changed elsewhere)
  const v = await fetchVault();
  if (!v) throw new Error("No locked folder is set up yet");
  await V.unlock(v, pass);
  updateVaultUi();
}
function lockVault() {
  const was = V.isUnlocked();
  V.lock();
  S.vaultAll = S.vfolders = null;
  vthumbs.forEach(u => URL.revokeObjectURL(u));
  vthumbs.clear();
  if (was && S.view === "locked") {
    if (!$("#viewer").hidden) closeViewer();
    resetList();
  }
  updateVaultUi();
}
function updateVaultUi() {
  const here = S.view === "locked", open = here && V.isUnlocked();
  $("#vaultActions").hidden = !open;
  $("#vBackBtn").hidden = $("#renameFolderBtn").hidden = $("#deleteFolderBtn").hidden = !S.vfolder;
  renderVaultFolders();
  $("#filters").hidden = PAGE_VIEWS.includes(S.view) || (here && !V.isUnlocked());
  native("secure", here); // Android app: no screenshots / blank preview in the app switcher
}
$("#lockNowBtn").onclick = () => { lockVault(); toast("Locked"); };

// Auto-lock: after a minute in the background, or 5 minutes without touching anything.
let hiddenAt = 0, hideTimer = null, lastActive = Date.now();
document.addEventListener("visibilitychange", () => {
  clearTimeout(hideTimer);
  if (document.hidden) {
    hiddenAt = Date.now();
    if (V.isUnlocked()) hideTimer = setTimeout(lockVault, 60_000);
  } else if (hiddenAt && Date.now() - hiddenAt > 60_000) lockVault();
});
["pointerdown", "keydown", "wheel"].forEach(ev => addEventListener(ev, () => (lastActive = Date.now()), { passive: true, capture: true }));
setInterval(() => {
  const playing = [...document.querySelectorAll("#vStage video")].some(v => !v.paused);
  if (playing) lastActive = Date.now();
  if (V.isUnlocked() && Date.now() - lastActive > 5 * 60_000) lockVault();
}, 15_000);

function getBlob(url, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("GET", url);
    x.responseType = "blob";
    x.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => (x.status < 300 ? resolve(x.response) : reject(new Error(`Download failed (HTTP ${x.status})`)));
    x.onerror = () => reject(new Error("Network error"));
    x.send();
  });
}
async function vaultFile(r, onProgress) {
  if (!r.fk) throw new Error("This item can't be decrypted");
  await ensureToken();
  const ct = await getBlob(fileUrl(r, r.file), p => onProgress?.(p * 0.7));
  return V.decryptBlob(r.fk, ct, r.mime || "", p => onProgress?.(0.7 + p * 0.3));
}

async function loadVaultItems() {
  const recs = await pb.collection("vault_items").getFullList({ sort: "-created", requestKey: null });
  return recs.map(rec => {
    try {
      const fk = V.fileKey(rec);
      const meta = V.openMeta(fk, rec.meta);
      return { ...rec, ...meta, _meta: meta, folder: meta.folder || "", fk, vault: true };
    } catch {
      return { ...rec, fk: null, vault: true, kind: "image", title: "Unreadable item", originalName: "", folder: "" };
    }
  });
}

// ---------- locked folder: folders ----------
// Each folder has its own key (wrapped with the master key) sealing its { name }. An item's folder id is
// in its own sealed meta, so moving an item re-seals that meta. Items whose folder is gone show at the top.
async function loadVaultFolders() {
  const recs = await pb.collection("vault_folders").getFullList({ sort: "-created", requestKey: null });
  const out = [];
  for (const rec of recs) {
    try {
      const fk = V.fileKey(rec);
      out.push({ id: rec.id, fk, name: String(V.openMeta(fk, rec.meta).name || "Folder") });
    } catch {}
  }
  return out; // newest first, like albums and folders
}
const vfolderOf = r => (r.folder && S.vfolders?.some(f => f.id === r.folder) ? r.folder : "");
function renderVaultFolders() {
  const box = $("#vFolders");
  const show = S.view === "locked" && V.isUnlocked() && !S.vfolder && !S.q && !!S.vfolders;
  box.hidden = !show;
  if (!show) return;
  const n = id => S.vaultAll?.filter(r => vfolderOf(r) === id).length || 0;
  box.innerHTML = S.vfolders.map(f => `<button class="vfolder" data-folder="${f.id}">${ic("folder")}<span><strong>${esc(f.name)}</strong><small>${nf.format(n(f.id))} item${n(f.id) === 1 ? "" : "s"}</small></span></button>`).join("")
    + `<button class="vfolder new" data-newfolder>${ic("folder-plus")}<span><strong>New folder</strong></span></button>`;
}
$("#vFolders").addEventListener("click", async e => {
  if (e.target.closest("[data-newfolder]")) {
    const f = await newVaultFolder();
    if (f) go(`#locked/${f.id}`);
    return;
  }
  const b = e.target.closest("[data-folder]");
  if (b) go(`#locked/${b.dataset.folder}`);
});
async function newVaultFolder() {
  if (!(await ensureVaultUnlocked())) return null;
  const name = await ask("New folder", "", "Create");
  if (!name) return null;
  try {
    const { fk, wrapped } = V.newFileKey();
    const rec = await pb.collection("vault_folders").create({ owner: pb.authStore.record.id, key: wrapped, meta: V.sealMeta(fk, { name }) }, { requestKey: null });
    const f = { id: rec.id, fk, name };
    if (S.vfolders) S.vfolders = [f, ...S.vfolders];
    toast(`Folder “${name}” created`);
    return f;
  } catch (e) { toast(errText(e)); return null; }
}
// Pick a destination folder: an id, "" for the top level, or null if cancelled.
function pickVaultFolder(title) {
  return new Promise(res => {
    modalDone = res;
    const here = S.vfolder;
    const card = openModal(`<h3>${esc(title)}</h3>
      <div class="pick-list">
        ${here ? `<button data-id="">${ic("lock")}<span class="nm">Locked folder (top level)</span></button>` : ""}
        ${(S.vfolders || []).filter(f => f.id !== here).map(f => `<button data-id="${f.id}">${ic("folder")}<span class="nm">${esc(f.name)}</span></button>`).join("")}
        <button data-new class="new">${ic("plus")}<span class="nm">New folder…</span></button></div>
      <div class="modal-actions"><button class="btn" data-x>Cancel</button></div>`);
    $("[data-x]", card).onclick = () => closeModal(null);
    $$("[data-id]", card).forEach(b => (b.onclick = () => closeModal(b.dataset.id)));
    $("[data-new]", card).onclick = async () => {
      modalDone = null;
      closeModal();
      const f = await newVaultFolder();
      res(f ? f.id : null);
    };
  });
}
async function setVaultFolder(r, folder) {
  if (!r.fk) throw new Error("This item can't be decrypted");
  const meta = { ...r._meta };
  if (folder) meta.folder = folder; else delete meta.folder;
  const rec = await pb.collection("vault_items").update(r.id, { meta: V.sealMeta(r.fk, meta) }, { requestKey: null });
  Object.assign(r, { meta: rec.meta, updated: rec.updated, _meta: meta, folder: folder || "" });
}
$("#vBackBtn").onclick = () => go("#locked");
$("#renameFolderBtn").onclick = async () => {
  const f = S.vfolders?.find(x => x.id === S.vfolder);
  if (!f) return;
  const name = await ask("Rename folder", f.name);
  if (!name || name === f.name) return;
  try {
    await pb.collection("vault_folders").update(f.id, { meta: V.sealMeta(f.fk, { name }) }, { requestKey: null });
    f.name = name;
    updateTitle();
  } catch (e) { toast(errText(e)); }
};
$("#deleteFolderBtn").onclick = async () => {
  const f = S.vfolders?.find(x => x.id === S.vfolder);
  if (!f) return;
  if (!(await confirmBox(`Delete folder “${f.name}”?`, "The folder is removed. Anything in it moves back to the top of your Locked folder."))) return;
  try {
    await pb.collection("vault_folders").delete(f.id, { requestKey: null });
    S.vfolders = S.vfolders.filter(x => x.id !== f.id);
    go("#locked");
  } catch (e) { toast(errText(e)); }
};
function vaultSorted(all) {
  let xs = all;
  if (S.kind !== "all") xs = xs.filter(r => r.kind === S.kind);
  if (S.q) {
    const q = S.q.toLowerCase();
    xs = xs.filter(r => `${r.title} ${r.originalName} ${(r.tags || []).join(" ")}`.toLowerCase().includes(q));
  }
  const t = v => pbDate(v)?.getTime() || 0;
  const key = {
    "-created": r => t(r.created), "-takenAt": r => t(r.takenAt || r.created), takenAt: r => t(r.takenAt || r.created),
    title: r => (r.title || "").toLowerCase(), "-size": r => r.size || 0,
  }[S.sort];
  const dir = S.sort.startsWith("-") ? -1 : 1;
  return [...xs].sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
}
async function loadVault() {
  S.loading = true;
  const gen = S.gen;
  try {
    const vault = await fetchVault();
    if (gen !== S.gen) return;
    if (!vault || !V.isUnlocked()) return showVaultGate(vault ? "unlock" : "setup");
    await ensureToken();
    [S.vaultAll, S.vfolders] = await Promise.all([S.vaultAll ?? loadVaultItems(), S.vfolders ?? loadVaultFolders()]);
    if (gen !== S.gen) return;
    if (S.vfolder && !S.vfolders.some(f => f.id === S.vfolder)) return go("#locked"); // folder was deleted
    updateTitle();
    // Inside a folder: just its items. Top level: items in no folder, or everything when searching.
    const items = vaultSorted(S.q && !S.vfolder ? S.vaultAll : S.vaultAll.filter(r => vfolderOf(r) === S.vfolder));
    Object.assign(S, { items, page: 1, totalPages: 1, total: items.length });
    appendTiles(items);
    updateCount();
    updateEmpty();
  } catch (e) {
    if (gen === S.gen) toast(errText(e));
  } finally {
    if (gen === S.gen) S.loading = false;
    updateVaultUi();
  }
}

const thumbObserver = new IntersectionObserver(entries => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    thumbObserver.unobserve(en.target);
    loadVaultThumb(en.target.dataset.id);
  }
}, { rootMargin: "600px" });
async function loadVaultThumb(id) {
  const r = S.items.find(x => x.id === id);
  if (!r?.thumb || !r.fk || vthumbs.has(id)) return;
  try {
    await ensureToken();
    const blob = await V.decryptBlob(r.fk, await getBlob(fileUrl(r, r.thumb)), "image/jpeg");
    if (!V.isUnlocked() || vthumbs.has(id)) return;
    const url = URL.createObjectURL(blob);
    vthumbs.set(id, url);
    const tile = $(`.tile[data-id="${id}"]`);
    if (tile) {
      const img = $("img", tile);
      img.src = url;
      img.hidden = false;
      $(".ph", tile).hidden = true;
    }
  } catch {}
}

// The locked-folder page when there's nothing to show yet: set-up, or the unlock form.
function showVaultGate(mode) {
  Object.assign(S, { page: 1, totalPages: 1, total: 0 });
  updateCount();
  const empty = $("#empty");
  empty.hidden = false;
  if (mode === "setup") {
    empty.innerHTML = `<div class="big">${ic("lock")}</div><h3>Locked folder</h3>
      <p class="gate-text">Keep private photos and videos behind a passphrase. They're encrypted on your device before upload,
      so the server, its backups and the admin dashboard only ever hold scrambled data. Locked items never appear in your
      library, search or albums.</p>
      <button class="btn primary" id="vSetup">Set up locked folder</button>`;
    $("#vSetup").onclick = setupVault;
    return;
  }
  empty.innerHTML = `<div class="big">${ic("lock")}</div><h3>Locked folder</h3><p>Enter your passphrase to unlock.</p>
    <form id="vUnlock" class="gate-form">
      <input type="password" name="p" placeholder="Passphrase" autocomplete="off" required>
      <button class="btn primary">Unlock</button>
    </form>
    <p class="error" id="vUnlockErr" hidden></p>
    <button class="link" id="vForgot">Forgot passphrase?</button>`;
  const f = $("#vUnlock"), err = $("#vUnlockErr"), btn = $("button", f);
  if (matchMedia("(pointer: fine)").matches) f.p.focus();
  f.onsubmit = async e => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = "Unlocking…";
    err.hidden = true;
    try {
      await unlockWith(f.p.value);
      resetList();
    } catch (ex) {
      err.textContent = errText(ex);
      err.hidden = false;
      f.p.select();
    } finally {
      btn.disabled = false;
      btn.textContent = "Unlock";
    }
  };
  $("#vForgot").onclick = forgotPassphrase;
}

// A modal holding a form. run(form) does the work: return a value to close with it, throw to show the error.
function formModal(html, okText, run) {
  return new Promise(res => {
    modalDone = res;
    const card = openModal(`<form class="vform">${html}<p class="error" hidden></p>
      <div class="modal-actions"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">${esc(okText)}</button></div></form>`);
    const f = $("form", card), btn = $(".btn.primary", f), err = $(".error", f);
    $("[data-x]", f).onclick = () => !modalSticky && closeModal(null);
    $("input", f)?.focus();
    f.onsubmit = async e => {
      e.preventDefault();
      btn.disabled = true;
      err.hidden = true;
      btn.textContent = "Working…";
      modalSticky = true; // key derivation takes a few seconds on phones; don't let a stray tap abandon it
      try {
        const v = await run(f);
        modalSticky = false;
        if (v !== undefined) return closeModal(v);
      } catch (ex) {
        err.textContent = errText(ex);
        err.hidden = false;
      }
      modalSticky = false;
      btn.disabled = false;
      btn.textContent = okText;
    };
  });
}
const PASS_INPUTS = `
  <input type="password" name="p" placeholder="New passphrase (10+ characters)" autocomplete="off" required>
  <input type="password" name="c" placeholder="Type it again" autocomplete="off" required>`;
function checkNewPass(f) {
  const bad = V.passphraseProblem(f.p.value);
  if (bad) throw new Error(bad);
  if (f.p.value !== f.c.value) throw new Error("The passphrases don't match");
}

async function setupVault() {
  const key = await formModal(`<h3>Set up locked folder</h3>
    <p>Choose a passphrase. It's separate from your account password and never leaves your device.</p>${PASS_INPUTS}`,
  "Create", async f => {
    checkNewPass(f);
    const { record, recoveryKey } = await V.createVault(f.p.value);
    try {
      S.vault = await pb.collection("vault").create({ ...record, owner: pb.authStore.record.id }, { requestKey: null });
    } catch (e) {
      V.lock();
      S.vault = undefined;
      throw e;
    }
    return recoveryKey;
  });
  if (!key) return;
  await showRecoveryKey(key);
  resetList();
}
function showRecoveryKey(key) {
  return new Promise(res => {
    modalDone = res;
    const card = openModal(`<h3>Save your recovery key</h3>
      <p>If you forget your passphrase, this key is the <strong>only</strong> way back in. Nobody can reset it for you,
      not even with full access to the server. Write it down or keep it in a password manager.</p>
      <textarea class="rkey" rows="2" readonly>${esc(key)}</textarea>
      <div><button type="button" class="btn" data-copy>Copy</button></div>
      <label class="ack"><input type="checkbox" data-ack> I've saved my recovery key somewhere safe</label>
      <div class="modal-actions"><button class="btn primary" data-ok disabled>Done</button></div>`);
    modalSticky = true;
    $("[data-copy]", card).onclick = () => {
      const i = $(".rkey", card);
      i.select();
      // navigator.clipboard needs https; execCommand still works on the plain-http LAN address.
      try { document.execCommand("copy") ? toast("Copied") : toast("Select the key and copy it"); } catch { toast("Select the key and copy it"); }
    };
    $("[data-ack]", card).onchange = e => ($("[data-ok]", card).disabled = !e.target.checked);
    $("[data-ok]", card).onclick = () => closeModal(true);
  });
}
async function forgotPassphrase() {
  const ok = await formModal(`<h3>Reset passphrase</h3>
    <p>Enter the recovery key you saved when you set up the locked folder, then choose a new passphrase.</p>
    <input name="k" placeholder="XXXX-XXXX-XXXX-…" autocomplete="off" autocapitalize="characters" spellcheck="false" required>${PASS_INPUTS}`,
  "Reset & unlock", async f => {
    checkNewPass(f);
    S.vault = undefined;
    const v = await fetchVault();
    const patch = await V.recover(v, f.k.value, f.p.value);
    S.vault = await pb.collection("vault").update(v.id, patch, { requestKey: null });
    return true;
  });
  if (!ok) return;
  toast("New passphrase set. Your recovery key still works.");
  resetList();
}
$("#changePassBtn").onclick = async () => {
  const ok = await formModal(`<h3>Change passphrase</h3>
    <input type="password" name="o" placeholder="Current passphrase" autocomplete="off" required>${PASS_INPUTS}`,
  "Change", async f => {
    checkNewPass(f);
    await unlockWith(f.o.value);
    S.vault = await pb.collection("vault").update(S.vault.id, await V.rewrap(f.p.value), { requestKey: null });
    return true;
  });
  if (ok) toast("Passphrase changed. Your recovery key still works.");
};

// Prompt for the passphrase from elsewhere in the app (e.g. "Move to Locked folder" in the library).
async function ensureVaultUnlocked() {
  if (V.isUnlocked()) return true;
  let vault;
  try { vault = await fetchVault(); } catch (e) { toast(errText(e)); return false; }
  if (!vault) {
    toast("Set up the locked folder first");
    go("#locked");
    return false;
  }
  return !!(await formModal(`<h3>Unlock locked folder</h3>
    <input type="password" name="p" placeholder="Passphrase" autocomplete="off" required>`,
  "Unlock", async f => { await unlockWith(f.p.value); return true; }));
}

// Downscaled JPEG for the grid (encrypted like everything else; the server can't make thumbnails of ciphertext).
function makeThumb(blob) {
  return new Promise(res => {
    const url = URL.createObjectURL(blob), img = new Image();
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      const s = Math.min(1, 400 / Math.min(w, h), 1600 / Math.max(w, h));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(w * s));
      c.height = Math.max(1, Math.round(h * s));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(b => res(b), "image/jpeg", 0.8);
    };
    img.onerror = () => { URL.revokeObjectURL(url); res(null); };
    img.src = url;
  });
}
async function createVaultItem({ fk, wrapped }, file, thumb, meta, onProgress) {
  const fd = new FormData();
  fd.append("owner", pb.authStore.record.id);
  fd.append("key", wrapped);
  fd.append("meta", V.sealMeta(fk, meta));
  if (thumb) fd.append("thumb", await V.encryptBlob(fk, thumb), "thumb.bin");
  fd.append("file", await V.encryptBlob(fk, file, p => onProgress?.("enc", p)), "data.bin");
  return send(fd, p => onProgress?.("up", p), "vault_items");
}
async function moveToVault(r, key) {
  await ensureToken();
  const file = await getBlob(fileUrl(r, r.file));
  const thumb = r.poster ? await getBlob(fileUrl(r, r.poster)) : r.kind === "video" || r.kind === "file" ? null : await makeThumb(file);
  await createVaultItem(key, file, thumb, {
    kind: r.kind, title: r.title, originalName: r.originalName, mime: file.type || "", size: r.size || file.size,
    width: r.width || 0, height: r.height || 0, duration: r.duration || 0, ...(r.pano && { pano: r.pano }),
    takenAt: pbDate(r.takenAt)?.toISOString() || pbDate(r.created)?.toISOString() || null, tags: Array.isArray(r.tags) ? r.tags : [],
  });
  await pb.collection("media").delete(r.id, { requestKey: null }); // only once the encrypted copy is safely stored
}
async function moveToLibrary(r) {
  const blob = await vaultFile(r);
  const name = r.originalName || r.title || "file";
  const file = new File([blob], name, { type: r.mime || blob.type, lastModified: pbDate(r.takenAt)?.getTime() || Date.now() });
  enqueue([file], {
    toLibrary: true,
    tags: r.tags,
    onDone: async () => { await pb.collection("vault_items").delete(r.id, { requestKey: null }); dropItem(r.id); },
  });
}

// Save a decrypted file. In the Android app blob: links can't be downloaded, so hand it to the app in pieces.
async function saveBlob(blob, name) {
  const app = window.MediaVaultNative;
  const id = app?.saveBegin?.(...nativeArgs(), name, blob.type || "application/octet-stream");
  if (id) {
    const STEP = 768 * 1024;
    for (let o = 0; o < blob.size; o += STEP) {
      if (!app.saveChunk(id, V.b64(new Uint8Array(await blob.slice(o, o + STEP).arrayBuffer())))) throw new Error("Couldn't save the file");
    }
    if (!app.saveEnd(id)) throw new Error("Couldn't save the file");
    toast(`Saved to Downloads/Media Vault/${name}`);
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------- mobile drawer ----------
$("#menuBtn").onclick = () => $("#app").classList.add("nav-open");
$("#scrim").onclick = () => $("#app").classList.remove("nav-open");

// The Android app's Back button calls this first; true = something was closed, so stay put.
window.vaultBack = () => {
  if (!$("#siteFrame").hidden) { closeSiteFrame(); return true; }
  if (!$("#viewPop").hidden) { closeViewPop(); return true; }
  if (modalOpen()) { if (!modalSticky) closeModal(null); return true; }
  if (!$("#viewer").hidden) { closeViewer(); return true; }
  if ($("#app").classList.contains("nav-open")) { $("#app").classList.remove("nav-open"); return true; }
  if (S.selecting) { setSelecting(false); return true; }
  return false;
};

// ---------- appearance panel / View menu ----------
const THEMES = [["system", "System"], ["dark", "Dark"], ["midnight", "Midnight"], ["slate", "Slate"], ["ocean", "Ocean"], ["forest", "Forest"],
  ["plum", "Plum"], ["mocha", "Mocha"], ["dusk", "Dusk"], ["ember", "Ember"], ["arctic", "Arctic"], ["light", "Light"], ["paper", "Paper"],
  ["mist", "Mist"], ["blush", "Blush"], ["sage", "Sage"], ["lilac", "Lilac"], ["sky", "Sky"]];
const pvMini = t => `<span class="pv" data-theme="${t}"><span class="pv-side"><i></i><i></i><i></i></span><span class="pv-main"><b></b><i></i><i></i><i></i><i></i><i></i><i></i></span></span>`;
const themePreview = id => (id === "system" ? `<span class="pv split">${pvMini("dark")}${pvMini("light")}</span>` : pvMini(id));
function layoutControls() {
  return `<div class="lay">
    <div class="lay-row"><span>Grid</span><div class="seg" data-pref="grid">
      <button data-val="square">${ic("grid")}Square</button><button data-val="justified">${ic("justify")}Original shapes</button>
      <button data-val="captions">${ic("captions")}With names</button><button data-val="list">${ic("list")}List</button></div></div>
    <div class="lay-row"><span>Thumbnail size</span><input type="range" min="1" max="5" step="1" data-pref="size" value="${P.size}" aria-label="Thumbnail size"></div>
    <div class="lay-row"><span>Spacing</span><div class="seg" data-pref="spacing">
      <button data-val="tight">Tight</button><button data-val="normal">Normal</button><button data-val="roomy">Roomy</button></div></div>
    <label class="switch"><span>Group by month</span><input type="checkbox" data-pref="months" ${P.months ? "checked" : ""}></label>
    <div class="lay-row desk"><span>Sidebar</span><div class="seg" data-pref="sidebar">
      <button data-val="full">Full</button><button data-val="compact">Compact</button></div></div>
    <div class="lay-row"><span>Sites page</span><div class="seg" data-pref="sites">
      <button data-val="cards">${ic("layout")}Cards</button><button data-val="list">${ic("list")}List</button></div></div>
  </div>`;
}
function wireLayout(root) {
  const sync = () => {
    $$(".seg[data-pref] button", root).forEach(b => b.classList.toggle("on", String(P[b.parentElement.dataset.pref]) === b.dataset.val));
    const r = $('input[type=range][data-pref]', root); if (r) r.value = P.size;
    const m = $('input[type=checkbox][data-pref]', root); if (m) m.checked = P.months;
  };
  root.addEventListener("click", e => {
    const b = e.target.closest(".seg[data-pref] button");
    if (!b) return;
    setPrefs({ [b.parentElement.dataset.pref]: b.dataset.val });
    sync();
  });
  root.addEventListener("input", e => { if (e.target.matches("input[type=range][data-pref]")) setPrefs({ size: +e.target.value }); });
  root.addEventListener("change", e => { if (e.target.matches("input[type=checkbox][data-pref]")) setPrefs({ months: e.target.checked }); });
  sync();
  return sync;
}
function openAppearance() {
  $("#app").classList.remove("nav-open");
  closeViewPop();
  const card = openModal(`<h3>Appearance</h3>
    <div class="ap-sec"><h4>Theme</h4><div class="themes">${THEMES.map(([id, label]) =>
      `<button class="theme-card" data-theme-pick="${id}">${themePreview(id)}<span>${label}</span></button>`).join("")}</div></div>
    <div class="ap-sec"><h4>Accent colour</h4><div class="accents">${PREF_VALUES.accent.map(a =>
      `<button class="acc" data-accent="${a}" data-accent-pick="${a}" title="${a[0].toUpperCase() + a.slice(1)}">${ic("check")}</button>`).join("")}</div></div>
    <div class="ap-sec"><h4>Layout</h4>${layoutControls()}</div>
    <div class="modal-actions ap-foot"><button class="link" data-reset>Reset to defaults</button><button class="btn primary" data-x>Done</button></div>`, true);
  const sync = () => {
    $$("[data-theme-pick]", card).forEach(b => b.classList.toggle("on", b.dataset.themePick === P.theme));
    $$("[data-accent-pick]", card).forEach(b => b.classList.toggle("on", b.dataset.accentPick === P.accent));
  };
  const syncLayout = wireLayout($(".lay", card));
  card.addEventListener("click", e => {
    const t = e.target.closest("[data-theme-pick]"), a = e.target.closest("[data-accent-pick]");
    if (t) setPrefs({ theme: t.dataset.themePick });
    if (a) setPrefs({ accent: a.dataset.accentPick });
    if (e.target.closest("[data-reset]")) { setPrefs({ ...PREF_DEFAULTS }); syncLayout(); }
    if (e.target.closest("[data-x]")) closeModal(null);
    sync();
  });
  sync();
}
function closeViewPop() { $("#viewPop").hidden = true; }
$("#viewBtn").onclick = e => {
  e.stopPropagation();
  const pop = $("#viewPop");
  if (!pop.hidden) return closeViewPop();
  pop.innerHTML = `<h4>View</h4>${layoutControls()}<button class="link" data-more style="justify-self:start">${ic("palette")} Themes and colours…</button>`;
  wireLayout(pop);
  $("[data-more]", pop).onclick = openAppearance;
  pop.hidden = false;
};
document.addEventListener("click", e => { if (!$("#viewPop").hidden && !e.target.closest(".view-wrap")) closeViewPop(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeViewPop(); });
$("#appearanceBtn").onclick = openAppearance;
$("#sideToggle").onclick = () => setPrefs({ sidebar: P.sidebar === "compact" ? "full" : "compact" });
$$(".nav button").forEach(b => (b.title ||= b.textContent.trim())); // tooltips for the compact sidebar
applyPrefs();

// ---------- boot ----------
(async function boot() {
  if (pb.authStore.isValid) {
    try {
      await pb.collection("users").authRefresh();
      return startApp();
    } catch {
      pb.authStore.clear();
    }
  }
  showAuth();
})();
