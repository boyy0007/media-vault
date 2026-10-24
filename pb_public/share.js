// Share page, in three places (no PocketBase SDK; everything comes from read-only endpoints of the same shape):
//   - a link on Media Vault's own address: /s/{token} → share.html?t={token}, data from /api/share/{token}
//     (pb_hooks/share.pb.js);
//   - a public link on the sites server: /s/{token}/ there, data from /s/{token}/api (pb_sites/pb_hooks/pubshare_lib.js);
//   - something shared with me by someone with an account here: share.html?inbox={id}, data from /api/inbox/{id},
//     signed in with the app's own login (same origin: the PocketBase SDK keeps it in localStorage).
// A client gallery (share.gallery set: the Galleries page) also gets a cover with the studio's name and message,
// web-size viewing and downloads, Download all as one .zip (zip.js), and - on the public link - hearts the
// photographer sees (/s/{token}/api/pick(s)).

import { saveZip } from "./zip.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ic = name => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const nf = new Intl.NumberFormat();
const pbDate = s => (s ? new Date(String(s).replace(" ", "T")) : null);
function fmtDur(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s).padStart(2, "0")}`;
}
function fmtBytes(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.max(1, Math.round(n / 1e6))} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

// Thumbnails fade in once they've arrived (app.css: img.in), as in the app.
for (const t of ["load", "error"]) document.addEventListener(t, e => { if (e.target.tagName === "IMG") e.target.classList.add("in"); }, true);

const params = new URLSearchParams(location.search);
const pub = /^\/s\/([a-zA-Z0-9]{24})\//.exec(location.pathname);
const inbox = pub ? "" : params.get("inbox") || "";
const token = pub ? pub[1] : params.get("t") || "";
const api = pub ? `/s/${token}/api` : inbox ? `/api/inbox/${encodeURIComponent(inbox)}` : `/api/share/${encodeURIComponent(token)}`;
let auth = "", fileToken = "";
if (inbox) try { auth = JSON.parse(localStorage.getItem("pocketbase_auth") || "{}").token || ""; } catch {}
// (Images and videos can't send the login header, so inbox files carry a file token, as the app's own do.)
const fileUrl = (it, q = "") => `${api}/file/${it.id}${q}${inbox ? `${q ? "&" : "?"}token=${encodeURIComponent(fileToken)}` : ""}`;
let share = null, vi = -1;
let G = null; // share.gallery: { message, cover, picks } for a client gallery
const picked = new Set();
let onlyPicks = false;
const shown = () => (onlyPicks ? share.items.filter(it => picked.has(it.id)) : share.items);
// Galleries show photos at web size where there is one (quicker on a phone); the original is one tap away.
const viewUrl = it => fileUrl(it, G && it.web ? "?web=1" : "");

// Back to the app from "Shared with me"; a public link has no app to go back to.
if (inbox) Object.assign($(".brand"), { href: "/#inbox", title: "Back to Media Vault" });
if (pub) $(".brand").removeAttribute("href");

function fail(msg) {
  $("#shareHead").hidden = true;
  const empty = $("#empty");
  empty.innerHTML = `<div class="big">${ic("link")}</div><h3>Link not available</h3><p>${esc(msg)}</p>`;
  empty.hidden = false;
}

// A password-protected link: the right password sets a cookie for this link's data and files (pb_hooks/share.pb.js).
function askPassword() {
  $("#shareHead").hidden = true;
  const empty = $("#empty");
  empty.innerHTML = `<div class="big">${ic("lock")}</div><h3>This link needs a password</h3><p>Ask the person who sent it.</p>
    <form class="share-pw"><input type="password" name="pw" required autocomplete="current-password" aria-label="Password" placeholder="Password">
    <button class="btn primary">Open</button></form><p class="error" hidden></p>`;
  empty.hidden = false;
  const f = $("form", empty), err = $(".error", empty), btn = $("button", f);
  f.pw.focus();
  f.onsubmit = async e => {
    e.preventDefault();
    btn.disabled = true;
    err.hidden = true;
    try {
      const res = await fetch(`${api}/unlock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: f.pw.value }) });
      if (res.ok) { empty.hidden = true; return load(); }
      err.textContent = (await res.json().catch(() => ({}))).message || "That password isn't right.";
    } catch { err.textContent = "Couldn't reach the server. Check your connection and try again."; }
    err.hidden = false;
    btn.disabled = false;
    f.pw.select();
  };
}

async function load() {
  let res;
  const headers = auth ? { Authorization: auth } : {};
  if (inbox && !auth) return fail("Sign in to Media Vault first, then open this again from Shared with me.");
  try {
    if (inbox) fileToken = (await (await fetch("/api/files/token", { method: "POST", headers })).json()).token || "";
    res = await fetch(api, { cache: "no-store", headers });
  } catch { return fail("Couldn't reach the server. Check your connection and try again."); }
  if (res.status === 401 && !inbox) return askPassword();
  if (!res.ok) return fail(inbox ? "This isn't shared with you any more, or it has expired." : "This link doesn't exist, has expired, or was turned off by its owner.");
  share = await res.json();
  G = share.gallery || null;
  // Hearts only on the public link (that's where the photographer collects them).
  if (G && !pub) G.picks = false;
  document.title = G ? `${share.title}${share.by ? ` · ${share.by}` : ""}` : `${share.title} · Media Vault`;
  if (G?.picks) await loadPicks();
  const n = share.items.length;
  const exp = pbDate(share.expires);
  const meta = [
    !G && share.by && `Shared by ${share.by}`,
    `${nf.format(n)} ${G ? "photo" : "item"}${n === 1 ? "" : "s"}`,
    exp && `${G ? "Open until" : "Link expires"} ${exp.toLocaleDateString(undefined, { dateStyle: "medium" })}`,
  ].filter(Boolean).join(" · ");
  if (G) renderHero(meta);
  else {
    $("#title").textContent = share.title;
    $("#meta").textContent = meta;
    $("#dlAll").hidden = !share.allowDownload || !n;
    $("#shareHead").hidden = false;
  }
  $('[data-v="download"]').hidden = !share.allowDownload;
  $('[data-v="heart"]').hidden = !G?.picks;
  if (!n) {
    $("#empty").innerHTML = `<div class="big">${ic("image")}</div><h3>Nothing here yet</h3><p>${G ? "This gallery is empty." : "This shared album is empty."}</p>`;
    $("#empty").hidden = false;
    return;
  }
  renderGrid();
}

function renderGrid() {
  const list = shown();
  $("#grid").innerHTML = list.length ? `<div class="grid">${list.map(it => {
    const i = share.items.indexOf(it);
    const thumb = it.kind === "file" ? "" : it.kind !== "video" || it.poster ? fileUrl(it, "?thumb=1") : "";
    const badge = it.kind === "video" ? `<span class="badge">${ic("play")}${fmtDur(it.duration)}</span>` : it.kind === "gif" ? `<span class="badge">GIF</span>` : "";
    const ar = it.width && it.height ? Math.min(3, Math.max(0.4, it.width / it.height)).toFixed(3) : 1;
    const heart = G?.picks ? `<button class="g-heart${picked.has(it.id) ? " on" : ""}" data-heart="${it.id}" title="${picked.has(it.id) ? "Remove from favorites" : "Add to favorites"}" aria-pressed="${picked.has(it.id)}">${ic(picked.has(it.id) ? "heart-fill" : "heart")}</button>` : "";
    return `<div class="tile" data-i="${i}" title="${esc(it.title)}" style="--ar:${ar}">
      ${thumb ? `<img loading="lazy" alt="" src="${thumb}" onerror="this.hidden=true;this.nextElementSibling.hidden=false">` : ""}
      <div class="ph" ${thumb ? "hidden" : ""}>${ic(it.kind === "video" ? "play" : it.kind === "file" ? "file" : "image")}${it.kind === "file" ? `<span class="ph-name">${esc(it.name || it.title)}</span>` : ""}</div>${badge}${heart}</div>`;
  }).join("")}</div>`
    : `<div class="empty g-none"><div class="big">${ic("heart")}</div><h3>No favorites yet</h3><p>Tap the heart on the photos you like - ${esc(share.by || "the photographer")} sees your picks.</p></div>`;
  updatePickUi();
}

// ---------- client galleries ----------
function renderHero(meta) {
  const cover = share.items.find(it => it.id === G.cover) || share.items[0];
  const img = cover && cover.kind !== "file" && (cover.kind !== "video" || cover.poster)
    ? `<img alt="" src="${cover.kind === "video" ? fileUrl(cover, "?poster=1") : viewUrl(cover)}">` : "";
  const hero = $("#gHero");
  hero.innerHTML = `<div class="g-cover">${img}</div>
    <div class="g-text">
      ${share.by ? `<p class="g-studio">${esc(share.by)}</p>` : ""}
      <h1>${esc(share.title)}</h1>
      ${G.message ? `<p class="g-message">${esc(G.message)}</p>` : ""}
      <p class="g-meta">${esc(meta)}</p>
      <div class="g-actions">
        ${share.allowDownload && share.items.length ? `<button class="btn primary" data-g="all">${ic("download")}Download all</button>` : ""}
        ${G.picks ? `<button class="btn g-favs" data-g="favs" aria-pressed="false">${ic("heart")}<span>Favorites</span> <b class="g-n"></b></button>` : ""}
      </div>
      ${G.picks ? `<p class="g-hint">Tap the heart on the photos you like${share.by ? ` - ${esc(share.by)} sees your picks` : ""}.</p>` : ""}
    </div>`;
  hero.hidden = false;
  document.body.classList.add("is-gallery");
}

// Each browser gets its own id, so a client's picks come back when they open the link again on that device.
function clientId() {
  let id = "";
  try { id = localStorage.getItem("mvg-client") || ""; } catch {}
  if (!/^[a-z0-9]{16}$/.test(id)) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    id = Array.from(b, x => "abcdefghijklmnopqrstuvwxyz0123456789"[x % 36]).join("");
    try { localStorage.setItem("mvg-client", id); } catch {}
  }
  return id;
}
const clientName = () => { try { return localStorage.getItem("mvg-name") || ""; } catch { return ""; } };

async function loadPicks() {
  try {
    const r = await (await fetch(`${api}/picks?client=${clientId()}`, { cache: "no-store" })).json();
    for (const id of r.items || []) picked.add(id);
    if (r.name && !clientName()) try { localStorage.setItem("mvg-name", r.name); } catch {}
  } catch {}
}

// The first heart asks for a name, so the photographer knows whose picks they are.
async function togglePick(id) {
  let name = clientName();
  const on = !picked.has(id);
  if (on && !name) {
    name = await askName();
    if (!name) return;
  }
  on ? picked.add(id) : picked.delete(id);
  refreshHearts(id);
  try {
    const res = await fetch(`${api}/pick`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client: clientId(), name, item: id, on }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Couldn't save that.");
  } catch (e) {
    on ? picked.delete(id) : picked.add(id);
    refreshHearts(id);
    alertBox(e.message || "Couldn't reach the server. Check your connection and try again.");
  }
}
function refreshHearts(id) {
  const on = picked.has(id);
  for (const b of $$(`[data-heart="${id}"]`)) {
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on);
    b.title = on ? "Remove from favorites" : "Add to favorites";
    b.innerHTML = ic(on ? "heart-fill" : "heart");
  }
  if (onlyPicks && !on) renderGrid();
  updatePickUi();
}
function updatePickUi() {
  const n = picked.size, b = $('[data-g="favs"]');
  if (b) {
    $(".g-n", b).textContent = n ? nf.format(n) : "";
    b.classList.toggle("on", onlyPicks);
    b.setAttribute("aria-pressed", onlyPicks);
    $("span", b).textContent = onlyPicks ? "Showing favorites" : "Favorites";
  }
  if (vi >= 0) {
    const hb = $('[data-v="heart"]'), on = picked.has(share.items[vi].id);
    hb.classList.toggle("on", on);
    hb.innerHTML = ic(on ? "heart-fill" : "heart");
    hb.title = on ? "Remove from favorites (F)" : "Add to favorites (F)";
  }
}

// ---------- small dialogs (the page has none of the app's) ----------
function dialog(html) {
  const d = $("#dlg");
  $(".dlg-card", d).innerHTML = html;
  d.hidden = false;
  return $(".dlg-card", d);
}
function closeDialog() { $("#dlg").hidden = true; $("#dlg .dlg-card").innerHTML = ""; }
function alertBox(msg) {
  const c = dialog(`<p>${esc(msg)}</p><div class="dlg-actions"><button class="btn primary" data-ok>OK</button></div>`);
  $("[data-ok]", c).onclick = closeDialog;
}
function askName() {
  return new Promise(resolve => {
    const c = dialog(`<h3>Your name</h3><p>So ${esc(share.by || "the photographer")} knows these favorites are yours.</p>
      <form><input name="n" maxlength="60" required autocomplete="name" placeholder="Your name">
      <div class="dlg-actions"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save</button></div></form>`);
    const f = $("form", c);
    f.n.focus();
    $("[data-x]", c).onclick = () => { closeDialog(); resolve(""); };
    f.onsubmit = e => {
      e.preventDefault();
      const n = f.n.value.trim().slice(0, 60);
      if (!n) return;
      try { localStorage.setItem("mvg-name", n); } catch {}
      closeDialog();
      resolve(n);
    };
  });
}

// Download all (or the favorites): web size or originals, as one .zip.
function chooseDownload() {
  const all = share.items, favs = all.filter(it => picked.has(it.id));
  const webOk = !!G && all.some(it => it.web);
  const sizeOf = (list, web) => list.reduce((s, it) => s + (web && it.web ? it.webSize || it.size / 6 : it.size || 0), 0);
  const c = dialog(`<h3>Download ${favs.length ? "photos" : `all ${nf.format(all.length)}`}</h3>
    <form>
      ${favs.length ? `<fieldset class="dlg-opts"><legend>Which</legend>
        <label><input type="radio" name="which" value="all" checked><span>All ${nf.format(all.length)} photos</span></label>
        <label><input type="radio" name="which" value="favs"><span>My favorites (${nf.format(favs.length)})</span></label></fieldset>` : ""}
      ${webOk ? `<fieldset class="dlg-opts"><legend>Size</legend>
        <label><input type="radio" name="size" value="web" checked><span>Web size <small data-s="web"></small><br><small>For phones, sharing and social media</small></span></label>
        <label><input type="radio" name="size" value="orig"><span>Full resolution <small data-s="orig"></small><br><small>The originals, for printing</small></span></label></fieldset>` : ""}
      <p class="dlg-note" hidden></p>
      <div class="dlg-actions"><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">${ic("download")}Download .zip</button></div>
    </form>`);
  const f = $("form", c);
  const list = () => (f.which?.value === "favs" ? favs : all);
  const web = () => webOk && f.size?.value === "web";
  const update = () => {
    for (const el of $$("[data-s]", f)) el.textContent = `· about ${fmtBytes(sizeOf(list(), el.dataset.s === "web"))}`;
    const big = sizeOf(list(), web()) > 2e9 && !window.showSaveFilePicker;
    const note = $(".dlg-note", f);
    note.hidden = !big;
    note.textContent = "That's a big download for this browser - on a phone it may not finish. On a computer (Chrome or Edge) it goes straight to disk, or pick your favorites first.";
  };
  f.addEventListener("change", update);
  update();
  $("[data-x]", c).onclick = closeDialog;
  f.onsubmit = e => {
    e.preventDefault();
    downloadZip(list(), web());
  };
}
async function downloadZip(list, web) {
  const ctl = new AbortController();
  const c = dialog(`<h3>Preparing your download</h3><p class="dlg-prog-t">Starting…</p>
    <div class="dlg-bar"><i style="width:0%"></i></div>
    <div class="dlg-actions"><button class="btn" data-x>Cancel</button></div>`);
  $("[data-x]", c).onclick = () => ctl.abort();
  const files = list.map(it => {
    const w = web && it.web;
    const dot = (it.name || it.title || "photo").lastIndexOf(".");
    const nm = it.name || it.title || `photo-${it.id}`;
    return {
      name: w && dot > 0 ? `${nm.slice(0, dot)} (web)${nm.slice(dot)}` : nm,
      url: fileUrl(it, w ? "?download=1&web=1" : "?download=1"),
      size: w ? it.webSize || it.size / 6 : it.size || 0,
      date: pbDate(it.takenAt) || new Date(),
    };
  });
  const zipName = `${share.title}${web ? " (web size)" : ""}.zip`.replace(/[\\/:*?"<>|]/g, "_");
  try {
    const r = await saveZip(files, {
      name: zipName, signal: ctl.signal,
      onProgress: p => {
        $(".dlg-prog-t", c).textContent = `Photo ${nf.format(p.file + 1)} of ${nf.format(p.files)} · ${fmtBytes(p.bytes)}`;
        $(".dlg-bar i", c).style.width = `${p.total ? Math.min(100, (p.bytes / p.total) * 100) : ((p.file + 1) / p.files) * 100}%`;
      },
    });
    if (r === "cancelled") return closeDialog();
    const d = dialog(`<h3>Done</h3><p>${esc(zipName)} is in your downloads.</p><div class="dlg-actions"><button class="btn primary" data-ok>OK</button></div>`);
    $("[data-ok]", d).onclick = closeDialog;
  } catch (e) {
    alertBox(`The download stopped: ${e.message || e}. Try again, or download fewer photos at a time.`);
  }
}
// One photo from the viewer: web size or original when there's a choice.
function downloadOne(it) {
  if (!(G && it.web)) return download(it);
  const c = dialog(`<h3>Download this photo</h3>
    <div class="dlg-actions dlg-stack">
      <button class="btn" data-w="web">Web size<small>${it.webSize ? ` · ${fmtBytes(it.webSize)}` : ""}</small></button>
      <button class="btn primary" data-w="orig">Full resolution<small>${it.size ? ` · ${fmtBytes(it.size)}` : ""}</small></button>
      <button class="btn ghost" data-x>Cancel</button></div>`);
  c.onclick = e => {
    const b = e.target.closest("[data-w],[data-x]");
    if (!b) return;
    closeDialog();
    if (b.dataset.w) download(it, b.dataset.w === "web");
  };
}

// ---------- viewer ----------
function open(i) {
  vi = i;
  $("#viewer").hidden = false;
  document.body.style.overflow = "hidden";
  render();
}
function close() {
  $("#viewer").hidden = true;
  $("#vStage").innerHTML = "";
  document.body.style.overflow = "";
  vi = -1;
}
function step(d) {
  const list = shown(), at = list.indexOf(share.items[vi]), n = at + d;
  if (n < 0 || n >= list.length) return;
  vi = share.items.indexOf(list[n]);
  render();
}
function render() {
  const it = share.items[vi], list = shown(), at = list.indexOf(it);
  const stage = $("#vStage");
  $("#vName").textContent = `${it.title}  ·  ${at + 1} / ${list.length}`;
  stage.innerHTML = it.kind === "file"
    ? `<div class="nopreview"><div class="big">${ic("file")}</div><p>${esc(it.name || it.title)}</p>${share.allowDownload ? `<button class="btn primary" data-v="download">${ic("download")}Download</button>` : ""}</div>`
    : it.kind === "video"
    ? `<video src="${fileUrl(it)}" controls autoplay playsinline ${it.poster ? `poster="${fileUrl(it, "?poster=1")}"` : ""}></video>`
    : `<img alt="" src="${viewUrl(it)}">`;
  const img = $("img", stage);
  if (img) img.onerror = () => (stage.innerHTML = `<div class="nopreview"><div class="big">${ic("alert")}</div><p>This file can't be shown in the browser.</p></div>`);
  $('[data-v="prev"]').hidden = at <= 0;
  $('[data-v="next"]').hidden = at >= list.length - 1;
  $('[data-v="heart"]').dataset.heart = it.id;
  updatePickUi();
  const next = list[at + 1];
  if (next && (next.kind === "image" || next.kind === "gif")) new Image().src = viewUrl(next); // preload
}
function download(it, web = false) {
  const a = document.createElement("a");
  a.href = fileUrl(it, web ? "?download=1&web=1" : "?download=1");
  a.download = it.name || it.title;
  document.body.append(a);
  a.click();
  a.remove();
}

$("#grid").addEventListener("click", e => {
  const h = e.target.closest("[data-heart]");
  if (h) return togglePick(h.dataset.heart);
  const t = e.target.closest(".tile");
  if (t) open(+t.dataset.i);
});
$("#gHero").addEventListener("click", e => {
  const a = e.target.closest("[data-g]")?.dataset.g;
  if (a === "all") chooseDownload();
  if (a === "favs") {
    onlyPicks = !onlyPicks;
    renderGrid();
  }
});
$("#viewer").addEventListener("click", e => {
  const a = e.target.closest("[data-v]")?.dataset.v;
  if (a === "close") close();
  if (a === "prev") step(-1);
  if (a === "next") step(1);
  if (a === "download") downloadOne(share.items[vi]);
  if (a === "heart") togglePick(share.items[vi].id);
});
$("#dlg").addEventListener("mousedown", e => { if (e.target.id === "dlg" && !$("#dlg .dlg-bar")) closeDialog(); });
document.addEventListener("keydown", e => {
  if (!$("#dlg").hidden) { if (e.key === "Escape" && !$("#dlg .dlg-bar")) closeDialog(); return; }
  if ($("#viewer").hidden) return;
  if (e.key === "Escape") close();
  if (e.key === "ArrowLeft") step(-1);
  if (e.key === "ArrowRight") step(1);
  if ((e.key === "f" || e.key === "F") && G?.picks) togglePick(share.items[vi].id);
});
let touchX = null;
$("#vStage").addEventListener("touchstart", e => (touchX = e.touches.length === 1 ? e.touches[0].clientX : null), { passive: true });
$("#vStage").addEventListener("touchend", e => {
  if (touchX === null || $("video", $("#vStage"))) return;
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1);
  touchX = null;
});
// Plain share links: everything as one .zip too (one download after another gets stopped by browsers after a few).
$("#dlAll").onclick = () => downloadZip(share.items, false);

load();
