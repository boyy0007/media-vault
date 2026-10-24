/// <reference path="../../pb_data/types.d.ts" />
// Store pages, keys and visitor counts for the hosted sites (like itch.io's game pages and download keys). What a
// page shows comes from pb_sites/access.json (entry.page, written by pb_hooks/sites_lib.js writeAccess(); keep the two
// in step), its pictures and downloads from pb_sites/pages/{site id}/ (publishPage() there).
//
//   /{slug}/                   opened as a page (Sec-Fetch-Dest: document): the store page, when the site has one.
//                              In a frame (the page's own player, Media Vault's in-app frame) or fetched: the site.
//   /{slug}/?play              the site itself in this tab (remembered for the browser session)
//   /{slug}/?key={token}       a key: lets this browser in (cookie mvk-{slug}), then goes on without it
//   /{slug}/__mv/f/{name}      the page's cover and screenshots
//   /{slug}/__mv/dl/{file}     a download (with keyDl, only for key holders and the owner)
//   POST /api/mv/sites         Media Vault collecting the counts (activity(), below)
//
// Counted in this server's own database (pb_sites/pb_migrations/1800000002_site_activity.js), per site per day: page
// views, plays (the site's start page loaded, anywhere but Media Vault's own frame, which adds ?__mvo=1) and downloads,
// once per visitor per 30 minutes each; and how many browsers redeemed each key.

const L = () => require(`${__hooks}/serve_lib.js`);
const pagesDir = (id) => $filepath.join(__hooks, "..", "pages", id);
const now = () => Math.floor(Date.now() / 1000);
const KEY_DAYS = 30;

// ---------- keys ----------
// The cookie is "{key id}.{expiry}.{signature}", signed with the key's own hash, so changing the site's access or
// password doesn't sign key holders out - deleting the key does (it's gone from access.json).
const keySig = (k, slug, exp) => $security.hs256(`key|${slug}|${k.id}|${exp}`, k.hash);
function heldKey(e, slug, a) {
  for (const v of L().cookieValues(e, `mvk-${slug}`)) {
    const [id, exp, sig] = v.split(".");
    const k = (a.keys || []).find((x) => x.id === id);
    if (k && sig && +exp > now() && (!k.exp || k.exp > now()) && $security.equal(sig, keySig(k, slug, exp))) return k;
  }
  return null;
}
// A key holder, or (owner: true) the owner too - their pass cookie, from opening the site in Media Vault.
function keyHolder(e, slug, a, owner = false) {
  if (heldKey(e, slug, a)) return true;
  if (!owner || !a.key) return false;
  return L().cookieValues(e, `mvs-${slug}`).some((v) => {
    const [kind, exp, sig] = v.split(".");
    return kind === "o" && !!sig && +exp > now() && $security.equal(sig, $security.hs256(`pass|${slug}|${kind}|${exp}`, a.key));
  });
}

// ?key= on any address of the site: let this browser in, or say why not. null = no key in the address, else { res }.
function redeem(e, slug, a, rest) {
  const raw = e.request.url.rawQuery || "";
  const m = /(?:^|&)key=([A-Za-z0-9]{24})(?:&|$)/.exec(raw);
  if (!m) return null;
  const hash = $security.sha256(m[1]);
  const k = (a.keys || []).find((x) => $security.equal(x.hash, hash));
  if (!k || (k.exp && k.exp <= now())) {
    return { res: L().page(e, 403, "This key doesn't work", "<p>It was deleted or has expired. Ask whoever sent it for a new one.</p>") };
  }
  const held = heldKey(e, slug, a);
  if (!held || held.id !== k.id) {
    const ok = useKey(k);
    if (!ok) return { res: L().page(e, 403, "This key has been used up", "<p>It has already been used as many times as it allows. Ask whoever sent it for a new one.</p>") };
    const exp = Math.min(now() + KEY_DAYS * 86400, k.exp || Infinity);
    e.response.header().add("Set-Cookie", `mvk-${slug}=${k.id}.${exp}.${keySig(k, slug, exp)}; Path=/${slug}/; Max-Age=${exp - now()}; HttpOnly; `
      + (L().isHttps(e) ? "SameSite=None; Secure; Partitioned" : "SameSite=Lax"));
  }
  const left = raw.split("&").filter((p) => p && !p.startsWith("key=")).join("&");
  return { res: e.redirect(302, `/${slug}/${rest}${left ? "?" + left : ""}`) };
}
// One more browser for this key, unless it's used up.
function useKey(k) {
  for (let i = 0; i < 2; i++) {
    try {
      let r = null;
      try { r = $app.findFirstRecordByData("site_key_uses", "key", k.id); } catch (_) {}
      if (r && k.max && r.getInt("uses") >= k.max) return false;
      if (!r) { r = new Record($app.findCollectionByNameOrId("site_key_uses")); r.set("key", k.id); }
      r.set("uses", r.getInt("uses") + 1);
      $app.save(r);
      return true;
    } catch (_) {} // (two at once: the unique index refuses one, which tries again)
  }
  return !k.max; // (couldn't count it: a key with a device limit is refused rather than let in uncounted)
}

// ---------- counting ----------
const SEEN_MINUTES = 30;
function count(e, a, field, what = "") {
  if (!a || !/^[a-z0-9]{15}$/.test(a.id || "")) return;
  const store = $app.store(), key = `seen:${field}:${a.id}:${what}:${L().clientIp(e)}`;
  if (store.length() >= 50000 && !store.has(key)) return;
  const last = store.get(key) || 0;
  if (Date.now() - last < SEEN_MINUTES * 60000) return;
  store.set(key, Date.now());
  const day = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < 2; i++) {
    try {
      let r = null;
      try { r = $app.findFirstRecordByFilter("site_stats", "site = {:s} && day = {:d}", { s: a.id, d: day }); } catch (_) {}
      if (!r) { r = new Record($app.findCollectionByNameOrId("site_stats")); r.set("site", a.id); r.set("day", day); }
      r.set(field, r.getInt(field) + 1);
      $app.save(r);
      return;
    } catch (_) {}
  }
}
function clearSeen() {
  const store = $app.store(), cut = Date.now() - SEEN_MINUTES * 60000;
  for (const [k, v] of Object.entries(store.getAll())) {
    if (k.startsWith("seen:") && +v < cut) store.remove(k);
  }
}
const dest = (e) => e.request.header.get("Sec-Fetch-Dest") || "";
// The site's start page was loaded as a page or in a frame (not fetched by its own scripts), and not by Media Vault.
function countPlay(e, a) {
  const d = dest(e);
  if ((d === "document" || d === "iframe") && !/(?:^|&)__mvo=1(?:&|$)/.test(e.request.url.rawQuery || "")) count(e, a, "plays");
}

// ---------- the page ----------
// The store page instead of the site ({ res }), or null for the site. Only for a page load in a tab: the page's player frame,
// Media Vault's frame and the site's own requests get the site, so its links back to ./ keep working.
function maybePage(e, slug, a) {
  if (!a.page) return null;
  const q = e.request.url.rawQuery || "";
  if (/(?:^|&)play(?:=[^&]*)?(?:&|$)/.test(q)) {
    e.response.header().add("Set-Cookie", `mvplay-${slug}=1; Path=/${slug}/; HttpOnly; ` + (L().isHttps(e) ? "SameSite=None; Secure; Partitioned" : "SameSite=Lax"));
    const left = q.split("&").filter((p) => p && !/^play(=|$)/.test(p)).join("&");
    return { res: e.redirect(302, `/${slug}/${left ? "?" + left : ""}`) };
  }
  if (dest(e) !== "document" || L().cookieValues(e, `mvplay-${slug}`).length) return null;
  count(e, a, "views");
  return { res: storePage(e, slug, a) };
}

// /{slug}/__mv/…: the page's pictures and downloads.
function serveExtra(e, slug, a, rest) {
  const p = a.page, h = e.response.header();
  if (!p) return L().nothingHere(e);
  const f = /^f\/([^/]+)$/.exec(rest);
  if (f) {
    const ok = (p.cover && (p.cover.full === f[1] || p.cover.wide === f[1])) || (p.shots || []).some((s) => s.full === f[1] || s.thumb === f[1]);
    if (!ok) return L().nothingHere(e);
    h.set("Content-Security-Policy", "sandbox; default-src 'none'");
    return L().send(e, pagesDir(a.id), [f[1]]);
  }
  const d = /^dl\/([^/]+)$/.exec(rest);
  const it = d && (p.downloads || []).find((x) => x.file === d[1]);
  if (!it) return L().nothingHere(e);
  if (a.keyDl && !keyHolder(e, slug, a, true)) {
    return L().page(e, 403, "This download needs a key", "<p>Ask the creator for a key - a personal link - and open it first.</p>");
  }
  count(e, a, "downloads", it.file);
  h.set("Content-Type", "application/octet-stream");
  h.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(it.name)}`);
  h.set("Content-Security-Policy", "sandbox; default-src 'none'");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Cache-Control", "no-cache");
  return e.fileFS($os.dirFS(pagesDir(a.id)), it.file);
}

const esc = (s) => L().esc(s == null ? "" : s);
// Plain text → paragraphs and line breaks, with web addresses made into links.
function prose(text) {
  return String(text || "").split(/\n\s*\n/).map((para) => para.trim()).filter(Boolean).map((para) =>
    `<p>${esc(para).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" target="_blank" rel="noopener nofollow">$1</a>').replace(/\n/g, "<br>")}</p>`).join("");
}

function storePage(e, slug, a) {
  const p = a.page;
  const proto = L().isHttps(e) ? "https" : "http";
  const host = (e.request.header.get("X-Forwarded-Host") || e.request.host || "").split(",")[0].trim();
  const abs = (name) => `${proto}://${host}/${slug}/__mv/f/${encodeURIComponent(name)}`;
  const shots = p.shots || [], downloads = p.downloads || [];
  const locked = a.keyDl && !keyHolder(e, slug, a, true);
  const h = e.response.header();
  h.set("Cache-Control", "no-store");
  h.set("Referrer-Policy", "same-origin");
  const playBtn = p.play ? `<button class="btn primary big" id="play"><svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg>Play</button>` : "";
  const dlBtn = downloads.length ? `<a class="btn big" href="#downloads"><svg viewBox="0 0 24 24" class="line"><path d="M12 3v12m-5-5 5 5 5-5M5 21h14"/></svg>Download</a>` : "";
  return e.html(200, `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.tagline)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(p.title)}">
${p.tagline ? `<meta property="og:description" content="${esc(p.tagline)}">` : ""}
${p.cover ? `<meta property="og:image" content="${esc(abs(p.cover.wide))}"><meta name="twitter:card" content="summary_large_image">` : ""}
<meta name="theme-color" content="#0e0f13">
<style>
:root { --bg: #0e0f13; --panel: #171920; --panel-2: #20232c; --text: #eceef3; --muted: #9097a7; --line: rgba(255,255,255,.09);
  --accent: #7c6cff; --accent-2: #a196ff; color-scheme: dark; }
@media (prefers-color-scheme: light) { :root { --bg: #f5f6f8; --panel: #fff; --panel-2: #eef0f4; --text: #14161b; --muted: #5c6370;
  --line: rgba(15,20,35,.1); --accent-2: #5b4be0; color-scheme: light; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--accent-2); }
/* The banner stays dark in both themes: its text is white over the cover. */
.hero { position: relative; min-height: clamp(260px, 46vw, 500px); display: flex; align-items: flex-end; overflow: hidden;
  background: radial-gradient(120% 120% at 20% 0%, color-mix(in srgb, var(--accent) 50%, transparent), transparent 62%), #15161c; }
.hero img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.hero::after { content: ""; position: absolute; inset: 0; background: linear-gradient(to bottom, transparent 30%, rgba(0,0,0,.72)); }
.hero-text { position: relative; z-index: 1; width: 100%; max-width: 1080px; margin: 0 auto; padding: 0 max(20px, env(safe-area-inset-left)) 28px; color: #fff; }
h1 { margin: 0; font-size: clamp(30px, 5vw, 52px); line-height: 1.1; letter-spacing: -.02em; text-shadow: 0 2px 18px rgba(0,0,0,.45); }
.tagline { margin: 10px 0 0; font-size: clamp(15px, 1.8vw, 19px); color: rgba(255,255,255,.88); max-width: 720px; text-shadow: 0 1px 10px rgba(0,0,0,.5); }
.cta { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 22px; }
.btn { display: inline-flex; align-items: center; gap: 8px; height: 42px; padding: 0 18px; border-radius: 12px; border: 1px solid rgba(255,255,255,.22);
  background: rgba(255,255,255,.12); color: #fff; font: 600 15px system-ui, sans-serif; text-decoration: none; cursor: pointer;
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); transition: transform .15s, background .15s; }
.btn:hover { background: rgba(255,255,255,.2); }
.btn.primary { background: var(--accent); border-color: transparent; box-shadow: 0 8px 28px color-mix(in srgb, var(--accent) 45%, transparent); }
.btn.primary:hover { background: color-mix(in srgb, var(--accent) 85%, #fff); transform: translateY(-1px); }
.btn.big { height: 50px; padding: 0 26px; font-size: 16px; border-radius: 14px; }
.btn svg { width: 18px; height: 18px; fill: currentColor; }
.btn svg.line { fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
main { max-width: 1080px; margin: 0 auto; padding: 28px max(20px, env(safe-area-inset-left)) 56px; display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 32px; align-items: start; }
.shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; margin-bottom: 28px; }
.shots button { padding: 0; border: 0; border-radius: 12px; overflow: hidden; background: var(--panel-2); cursor: zoom-in; aspect-ratio: 16 / 10; }
.shots img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .3s; }
.shots button:hover img { transform: scale(1.04); }
.about p { margin: 0 0 14px; }
.about { font-size: 16px; overflow-wrap: anywhere; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 12px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 18px; margin-bottom: 16px; }
.dl { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.dl li { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: var(--panel-2); border-radius: 12px; }
.dl .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: 14px; }
.dl .sz { color: var(--muted); font-size: 12.5px; white-space: nowrap; }
.dl a { flex: none; display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; background: var(--accent); color: #fff; }
.dl a svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.locked { color: var(--muted); font-size: 14px; margin: 0 0 12px; }
.meta { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin: 0; font-size: 14px; }
.meta dt { color: var(--muted); } .meta dd { margin: 0; text-align: right; }
@media (max-width: 820px) { main { grid-template-columns: 1fr; gap: 8px; } }
/* the player: the site full screen, with one see-through back button that fades when left alone */
#player { position: fixed; inset: 0; z-index: 10; background: #000; }
#player[hidden], #lb[hidden] { display: none; }
#player iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; }
#back { position: absolute; z-index: 2; top: calc(10px + env(safe-area-inset-top)); left: calc(10px + env(safe-area-inset-left)); width: 40px; height: 40px;
  display: grid; place-items: center; border: 0; border-radius: 10px; background: rgba(0,0,0,.35); color: #fff; cursor: pointer; opacity: .7;
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); transition: opacity .4s, background .15s; }
#back:hover, #back:focus-visible { opacity: 1; background: rgba(0,0,0,.6); transition-duration: .15s; }
#back.idle:not(:focus-visible) { opacity: 0; }
#back svg, #lb button svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
#ld { position: absolute; inset: 0; z-index: 1; display: grid; place-content: center; justify-items: center; gap: 14px; background: #0b0b0e; color: #fff;
  font-weight: 600; transition: opacity .3s, visibility 0s; }
#ld.done { opacity: 0; visibility: hidden; transition: opacity .3s, visibility 0s .3s; }
#ld i { width: 34px; height: 34px; border-radius: 50%; border: 3px solid rgba(255,255,255,.14); border-top-color: var(--accent); animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
/* screenshots, big */
#lb { position: fixed; inset: 0; z-index: 20; background: rgba(0,0,0,.92); display: grid; place-items: center; }
#lb img { max-width: calc(100vw - 32px); max-height: calc(100vh - 96px); border-radius: 8px; box-shadow: 0 20px 60px rgba(0,0,0,.6); }
#lb button { position: absolute; width: 44px; height: 44px; display: grid; place-items: center; border: 0; border-radius: 50%; background: rgba(255,255,255,.12); color: #fff; cursor: pointer; }
#lb button:hover { background: rgba(255,255,255,.22); }
#lb button[hidden] { display: none; }
#lbX { top: 16px; right: 16px; } #lbP { left: 16px; top: 50%; transform: translateY(-50%); } #lbN { right: 16px; top: 50%; transform: translateY(-50%); }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }
</style></head><body>
<header class="hero">
  ${p.cover ? `<img src="__mv/f/${esc(encodeURIComponent(p.cover.wide))}" alt="">` : ""}
  <div class="hero-text">
    <h1>${esc(p.title)}</h1>
    ${p.tagline ? `<p class="tagline">${esc(p.tagline)}</p>` : ""}
    ${playBtn || dlBtn ? `<div class="cta">${playBtn}${dlBtn}</div>` : ""}
  </div>
</header>
<main>
  <section>
    ${shots.length ? `<div class="shots">${shots.map((s, i) => `<button data-i="${i}" aria-label="Screenshot ${i + 1}"><img src="__mv/f/${esc(encodeURIComponent(s.thumb))}" alt="" loading="lazy"></button>`).join("")}</div>` : ""}
    ${p.about ? `<div class="about">${prose(p.about)}</div>` : ""}
  </section>
  <aside>
    ${downloads.length ? `<div class="card" id="downloads"><h2>Downloads</h2>
      ${locked ? `<p class="locked">These downloads need a key. Ask the creator for one - a personal link - and open it first.</p>` : ""}
      <ul class="dl">${downloads.map((d) => `<li><span class="nm" title="${esc(d.name)}">${esc(d.name)}</span><span class="sz">${esc(L().fmtBytes(d.size))}</span>
        ${locked ? "" : `<a href="__mv/dl/${esc(encodeURIComponent(d.file))}" download aria-label="Download ${esc(d.name)}"><svg viewBox="0 0 24 24"><path d="M12 3v12m-5-5 5 5 5-5M5 21h14"/></svg></a>`}</li>`).join("")}</ul></div>` : ""}
    ${p.updated ? `<div class="card"><dl class="meta"><dt>Updated</dt><dd><time datetime="${esc(String(p.updated).replace(" ", "T"))}"></time></dd></dl></div>` : ""}
  </aside>
</main>
<div id="player" hidden>
  <iframe title="${esc(p.title)}" allow="fullscreen; autoplay; gamepad; clipboard-write; pointer-lock"></iframe>
  <button id="back" aria-label="Back" title="Back (Esc)"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg></button>
  <div id="ld"><i></i><span>${esc(p.title)}</span></div>
</div>
<div id="lb" hidden><img alt="">
  <button id="lbX" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
  <button id="lbP" aria-label="Previous"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg></button>
  <button id="lbN" aria-label="Next"><svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg></button>
</div>
<script>
const $ = (s) => document.querySelector(s);
for (const t of document.querySelectorAll("time[datetime]")) {
  const d = new Date(t.getAttribute("datetime"));
  if (!isNaN(d)) t.textContent = d.toLocaleDateString(undefined, { dateStyle: "medium" });
}
// The player: a fresh frame each time (changing src would add history entries), the browser's fullscreen where it
// allows, a history entry so Back closes it, and a back button that fades out and comes back at the corner.
const P = $("#player"), B = $("#back"), LD = $("#ld");
let hideT = 0, wasIdle = false, playing = 0;
function show(ms = 2500) { B.classList.remove("idle"); clearTimeout(hideT); if (ms) hideT = setTimeout(() => B.classList.add("idle"), ms); }
function frame(src) {
  const old = P.querySelector("iframe"), f = old.cloneNode(false);
  f.removeAttribute("src");
  if (src) { f.addEventListener("load", () => { LD.classList.add("done"); show(); }); f.src = src; }
  old.replaceWith(f);
}
function play() {
  P.hidden = false; LD.classList.remove("done"); document.body.style.overflow = "hidden";
  P.requestFullscreen?.().catch(() => {});
  playing = Date.now(); history.pushState({ play: playing }, "");
  frame("./"); show(3000);
}
function stop() {
  if (P.hidden) return;
  P.hidden = true; document.body.style.overflow = ""; clearTimeout(hideT); frame("");
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (history.state && history.state.play === playing) history.back();
  playing = 0;
}
$("#play")?.addEventListener("click", play);
B.addEventListener("pointerenter", (e) => { if (e.pointerType !== "touch") show(0); });
B.addEventListener("pointerleave", (e) => { if (e.pointerType !== "touch") show(1500); });
B.addEventListener("pointerdown", () => { wasIdle = B.classList.contains("idle"); });
B.onclick = () => { if (wasIdle) { wasIdle = false; return show(); } stop(); };
addEventListener("popstate", (e) => { if (playing && !(e.state && e.state.play === playing)) stop(); });
// Screenshots, big.
const SHOTS = ${JSON.stringify(shots.map((s) => "__mv/f/" + encodeURIComponent(s.full))).replace(/</g, "\\u003c")};
const LB = $("#lb"), LI = LB.querySelector("img");
let at = 0;
function openShot(i) { at = (i + SHOTS.length) % SHOTS.length; LI.src = SHOTS[at]; LB.hidden = false; }
document.querySelectorAll(".shots button").forEach((b) => (b.onclick = () => openShot(+b.dataset.i)));
$("#lbX").onclick = () => (LB.hidden = true);
$("#lbP").onclick = () => openShot(at - 1);
$("#lbN").onclick = () => openShot(at + 1);
$("#lbP").hidden = $("#lbN").hidden = SHOTS.length < 2;
LB.addEventListener("click", (e) => { if (e.target === LB) LB.hidden = true; });
addEventListener("keydown", (e) => {
  if (!LB.hidden) {
    if (e.key === "Escape") LB.hidden = true;
    if (e.key === "ArrowLeft") openShot(at - 1);
    if (e.key === "ArrowRight") openShot(at + 1);
  } else if (!P.hidden && e.key === "Escape") stop();
});
</script>
</body></html>`);
}

// ---------- Media Vault collecting the counts ----------
// POST /api/mv/sites { sites: [ids], keys: [ids] }: the counts of every site and key, after dropping those of sites
// and keys that don't exist any more. Same rule as the galleries' /api/mv/activity (pubshare_lib.js): only straight
// from this PC, with the key in pb_sites/.sync-key.
function activity(e) {
  let key = "";
  try { key = toString($os.readFile($filepath.join(__hooks, "..", ".sync-key"))).trim(); } catch (_) {}
  const local = /^(127\.0\.0\.1|::1)$/.test(e.remoteIP()) && !e.request.header.get("X-Forwarded-For");
  if (!local || key.length < 32 || !$security.equal(e.request.header.get("X-MV-Key") || "", key)) return e.json(404, { message: "Not found" });
  let body = {};
  try { body = e.requestInfo().body || {}; } catch (_) {}
  const ids = (v) => (Array.isArray(v) && v.every((x) => /^[a-z0-9]{15}$/.test(String(x))) ? JSON.stringify(v.map(String)) : null);
  const sites = ids(body.sites), keys = ids(body.keys);
  if (sites) $app.db().newQuery("DELETE FROM site_stats WHERE site NOT IN (SELECT value FROM json_each({:keep}))").bind({ keep: sites }).execute();
  if (keys) $app.db().newQuery("DELETE FROM site_key_uses WHERE key NOT IN (SELECT value FROM json_each({:keep}))").bind({ keep: keys }).execute();

  const day = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);
  const sum = (since) => {
    const rows = arrayOf(new DynamicModel({ site: "", views: 0, plays: 0, downloads: 0 }));
    $app.db().newQuery("SELECT site, SUM(views) AS views, SUM(plays) AS plays, SUM(downloads) AS downloads FROM site_stats WHERE day >= {:d} GROUP BY site")
      .bind({ d: since }).all(rows);
    return rows;
  };
  const stats = {};
  for (const [span, since] of [["all", "0000-00-00"], ["week", day(6)], ["today", day(0)]]) {
    for (const r of sum(since)) {
      const s = stats[r.site] || (stats[r.site] = { all: zero(), week: zero(), today: zero() });
      s[span] = { views: r.views, plays: r.plays, downloads: r.downloads };
    }
  }
  const uses = {};
  for (const r of $app.findRecordsByFilter("site_key_uses", "id != ''", "", 100000, 0)) uses[r.getString("key")] = r.getInt("uses");
  return e.json(200, { stats, keys: uses });
}
const zero = () => ({ views: 0, plays: 0, downloads: 0 });

module.exports = { redeem, keyHolder, heldKey, maybePage, countPlay, serveExtra, activity, clearSeen };
