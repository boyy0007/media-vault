// 360° photos and videos: a small WebGL viewer (drag to look around, wheel / pinch to zoom).
//
// Projections (media.pano):
//   "equirect" — a stitched 360 (2:1 panorama): what Insta360 Studio / the app export, and most 360 cameras.
//   "fisheye"  — Insta360's raw dual-fisheye files (.insp photos, .insv / .lrv videos): two circular lens
//                images side by side, front lens on the left, back lens on the right (the same layout ffmpeg's
//                v360=dfisheye expects). They're stitched here with a fixed lens model, so the seam is only
//                approximate; exporting from Insta360's app gives a cleaner result.
// No library: one full-screen triangle, and the fragment shader turns each pixel's view ray into a texture
// coordinate. Works on plain-http pages (WebGL doesn't need a secure context).

const LENS_FOV = 193; // degrees each Insta360 lens sees (ffmpeg's suggested ih_fov/iv_fov for these cameras)

// The view ray for a screen point → texture coordinate. Shared by the WebGL 2 and WebGL 1 shaders.
const LOOKUP = `
uniform float yaw, pitch, fov, aspect, mode, lens;
const float PI = 3.14159265;
vec2 lookup(vec2 v) {
  float f = tan(fov * 0.5);
  vec3 d = normalize(vec3(v.x * f * aspect, v.y * f, 1.0));
  float cp = cos(pitch), sp = sin(pitch);
  d = vec3(d.x, d.y * cp + d.z * sp, -d.y * sp + d.z * cp);
  float cy = cos(yaw), sy = sin(yaw);
  d = vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy);
  if (mode < 0.5) return vec2(0.5 + atan(d.x, d.z) / (2.0 * PI), 0.5 - asin(clamp(d.y, -1.0, 1.0)) / PI);
  bool front = d.z >= 0.0;
  float t = acos(clamp(abs(d.z), 0.0, 1.0)) / (lens * 0.5);
  vec2 q = normalize(vec2(front ? d.x : -d.x, d.y) + 1e-6) * t * 0.5;
  return vec2((front ? 0.25 : 0.75) + q.x * 0.5, 0.5 - q.y);
}`;
// WebGL 2: mipmapped photos, so zoomed-out detail doesn't shimmer while panning. Where the texture
// coordinate jumps (the panorama's wrap-around seam, the line between the two lenses) the screen-space
// gradient is huge and would pick the blurriest level, drawing a line — those pixels use full detail instead.
const VS2 = `#version 300 es
in vec2 p; out vec2 v; void main() { v = p; gl_Position = vec4(p, 0.0, 1.0); }`;
const FS2 = `#version 300 es
precision highp float;
in vec2 v; out vec4 o; uniform sampler2D tex;
${LOOKUP}
void main() {
  vec2 uv = lookup(v), gx = dFdx(uv), gy = dFdy(uv);
  if (max(dot(gx, gx), dot(gy, gy)) > 0.01) { gx = vec2(0.0); gy = vec2(0.0); }
  o = textureGrad(tex, uv, gx, gy);
}`;
// WebGL 1 fallback (no mipmaps for non-power-of-two textures there).
const VS1 = `attribute vec2 p; varying vec2 v; void main() { v = p; gl_Position = vec4(p, 0.0, 1.0); }`;
const FS1 = `precision highp float;
varying vec2 v; uniform sampler2D tex;
${LOOKUP}
void main() { gl_FragColor = texture2D(tex, lookup(v)); }`;

// Biggest texture side used. Bigger photos are scaled down once on open: 8192×4096 is ~170 MB of GPU
// memory with mipmaps, and beyond that panning gets heavy on most graphics chips.
const TEX_CAP = 8192;

function setup(canvas, preserve = false) {
  const opts = { antialias: false, preserveDrawingBuffer: preserve, powerPreference: "high-performance" };
  let gl = canvas.getContext("webgl2", opts);
  const v2 = !!gl;
  if (!gl) gl = canvas.getContext("webgl", opts);
  if (!gl) throw new Error("This device can't show 360° views (WebGL is off)");
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, v2 ? VS2 : VS1));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, v2 ? FS2 : FS1));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  for (const [k, val] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) {
    gl.texParameteri(gl.TEXTURE_2D, k, val);
  }
  const u = Object.fromEntries(["yaw", "pitch", "fov", "aspect", "mode", "lens"].map(n => [n, gl.getUniformLocation(prog, n)]));
  return { gl, u, v2, max: Math.min(TEX_CAP, gl.getParameter(gl.MAX_TEXTURE_SIZE)) };
}

// Photos bigger than the cap / what the GPU allows are scaled down first.
function fitSource(src, max) {
  const w = src.naturalWidth || src.videoWidth || src.width, h = src.naturalHeight || src.videoHeight || src.height;
  if (src instanceof HTMLVideoElement || (w <= max && h <= max)) return src;
  const s = max / Math.max(w, h);
  const c = document.createElement("canvas");
  c.width = Math.floor(w * s);
  c.height = Math.floor(h * s);
  const g = c.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// Photos: uploaded once, with mipmaps where WebGL 2 allows. Video frames: every frame, no mipmaps.
function upload(ctx, src, still) {
  const { gl } = ctx;
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  if (still && ctx.v2) {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  }
}

function draw(ctx, mode, view, w, h) {
  const { gl, u } = ctx;
  gl.viewport(0, 0, w, h);
  gl.uniform1f(u.yaw, view.yaw);
  gl.uniform1f(u.pitch, view.pitch);
  gl.uniform1f(u.fov, (view.fov * Math.PI) / 180);
  gl.uniform1f(u.aspect, w / h);
  gl.uniform1f(u.mode, mode === "fisheye" ? 1 : 0);
  gl.uniform1f(u.lens, (LENS_FOV * Math.PI) / 180);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

const PITCH_MAX = Math.PI / 2 - 0.001, FOV_MIN = 30, FOV_MAX = 120;
const HOME = { yaw: 0, pitch: 0, fov: 90 };

/**
 * Shows `src` (a loaded <img> or a <video>) as a 360° view filling `box`. Returns { destroy() }.
 * Pointer and wheel events are kept to the canvas so the viewer's swipe / zoom handling doesn't see them.
 *
 * Motion: input moves a target view; each frame the shown view eases towards it (so uneven touch / mouse
 * events still give an even glide), and letting go mid-drag keeps it turning with friction (a flick spins).
 */
export function panoView(box, src, mode) {
  const canvas = document.createElement("canvas");
  canvas.className = "pano-canvas";
  box.append(canvas);
  const ctx = setup(canvas);
  const isVideo = src instanceof HTMLVideoElement;
  if (!isVideo) upload(ctx, fitSource(src, ctx.max), true);
  const cur = { ...HOME }, target = { ...HOME }, vel = { yaw: 0, pitch: 0 };
  let raf = 0, last = 0, dirty = true, dead = false, frameReady = false;
  const ptrs = new Map();
  let pinch = 0, samples = []; // recent { t, yaw, pitch } while dragging, for the release speed

  const clampTarget = () => {
    if (target.pitch > PITCH_MAX || target.pitch < -PITCH_MAX) { target.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, target.pitch)); vel.pitch = 0; }
    target.fov = Math.max(FOV_MIN, Math.min(FOV_MAX, target.fov));
  };
  const frame = t => {
    if (dead) return;
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 1 / 60;
    last = t;
    // Momentum after a flick: exponential friction, stops below a tiny speed.
    if (!ptrs.size && (vel.yaw || vel.pitch)) {
      target.yaw += vel.yaw * dt;
      target.pitch += vel.pitch * dt;
      const k = Math.exp(-dt * 3.5);
      vel.yaw *= k;
      vel.pitch *= k;
      if (Math.hypot(vel.yaw, vel.pitch) < 0.002) vel.yaw = vel.pitch = 0;
      clampTarget();
    }
    // Ease the shown view towards the target (framerate-independent).
    const a = 1 - Math.exp(-dt * 22), z = 1 - Math.exp(-dt * 14);
    let moving = false;
    for (const [key, f] of [["yaw", a], ["pitch", a], ["fov", z]]) {
      const d = target[key] - cur[key];
      if (Math.abs(d) > 1e-5) { cur[key] += d * f; moving = true; } else cur[key] = target[key];
    }
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; dirty = true; }
    if (isVideo && src.readyState >= 2 && (!src.paused || !frameReady || dirty)) { upload(ctx, src, false); frameReady = true; dirty = true; }
    if ((dirty || moving) && (!isVideo || frameReady)) { draw(ctx, mode, cur, w, h); dirty = false; }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  if (isVideo) for (const ev of ["seeked", "loadeddata"]) src.addEventListener(ev, () => (dirty = true));

  const look = (dx, dy) => {
    const k = (cur.fov / canvas.clientHeight) * (Math.PI / 180); // the point under the finger stays under it
    target.yaw -= dx * k;
    target.pitch += dy * k;
    clampTarget();
  };
  const sample = () => {
    const now = performance.now();
    samples.push({ t: now, yaw: target.yaw, pitch: target.pitch });
    while (samples.length > 2 && now - samples[0].t > 100) samples.shift();
  };
  canvas.addEventListener("pointerdown", e => {
    e.stopPropagation();
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    vel.yaw = vel.pitch = 0; // touching stops a spin
    samples = [];
    sample();
    if (ptrs.size === 2) { const [p, q] = [...ptrs.values()]; pinch = Math.hypot(p.x - q.x, p.y - q.y) || 1; }
  });
  canvas.addEventListener("pointermove", e => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    e.stopPropagation();
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size >= 2) {
      const [m, n] = [...ptrs.values()];
      const d = Math.hypot(m.x - n.x, m.y - n.y) || 1;
      target.fov *= pinch / d;
      pinch = d;
      clampTarget();
      samples = [];
      return;
    }
    look(e.clientX - p.x, e.clientY - p.y);
    sample();
  });
  const end = e => {
    if (!ptrs.has(e.pointerId)) return;
    e.stopPropagation();
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = 0;
    if (ptrs.size) { samples = []; return; } // the other finger carries on
    // Release speed over the last ~100 ms; a finger held still before letting go doesn't spin.
    const now = performance.now(), s = samples.filter(x => now - x.t < 120);
    if (e.type === "pointerup" && s.length >= 2) {
      const a = s[0], b = s[s.length - 1], span = Math.max(16, b.t - a.t) / 1000;
      if (now - b.t < 50) { vel.yaw = (b.yaw - a.yaw) / span; vel.pitch = (b.pitch - a.pitch) / span; }
    }
    samples = [];
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    e.stopPropagation();
    target.fov *= Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)); // ctrlKey = trackpad pinch
    clampTarget();
  }, { passive: false });
  canvas.addEventListener("dblclick", e => {
    e.stopPropagation();
    vel.yaw = vel.pitch = 0;
    // Turn back the short way round, not through every full spin made so far.
    cur.yaw = Math.atan2(Math.sin(cur.yaw), Math.cos(cur.yaw));
    Object.assign(target, HOME);
  });

  return {
    destroy() {
      dead = true;
      cancelAnimationFrame(raf);
      ctx.gl.getExtension("WEBGL_lose_context")?.loseContext(); // free the GPU memory now, not at GC
      canvas.remove();
    },
  };
}

/** A flat, square JPEG looking straight ahead: grid thumbnails for raw dual-fisheye files. */
export async function panoPoster(blob, mode, size = 800) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((ok, fail) => { img.onload = ok; img.onerror = fail; img.src = url; });
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = setup(canvas, true);
    upload(ctx, fitSource(img, ctx.max), true);
    draw(ctx, mode, { yaw: 0, pitch: 0, fov: 100 }, size, size);
    const out = await new Promise(res => canvas.toBlob(res, "image/jpeg", 0.85));
    ctx.gl.getExtension("WEBGL_lose_context")?.loseContext();
    return out;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- detection at upload ----------
const RAW_PHOTO = /\.insp$/i, RAW_VIDEO = /\.(insv|lrv)$/i;
const hasBytes = async (blob, needles) => {
  const s = new TextDecoder("latin1").decode(new Uint8Array(await blob.arrayBuffer()));
  return needles.some(n => s.includes(n));
};
// Google's spherical-video UUID box (v1 metadata) as latin1 text.
const SPHERICAL_UUID = String.fromCharCode(0xff, 0xcc, 0x82, 0x63, 0xf8, 0x55, 0x4a, 0x93, 0x88, 0x14, 0x58, 0x7a, 0x02, 0x52, 0x1f, 0xdd);

/**
 * "equirect", "fisheye" or "" for an upload. kind = "image" | "video"; meta = { width, height }.
 * Photos: Insta360 .insp, or Photo Sphere XMP (GPano:ProjectionType = equirectangular), or an exact 2:1 shape
 * at 360-camera size. Videos: Insta360 .insv/.lrv with both lenses in one 2:1 frame, or spherical metadata
 * (sv3d box / Google's UUID box / GSpherical) near either end of the file, or an exact 2:1 shape at 360 size.
 */
export async function detectPano(file, kind, meta = {}) {
  const name = file.name || "";
  const w = meta.width || 0, h = meta.height || 0;
  const twoToOne = h > 0 && Math.abs(w / h - 2) < 0.01;
  try {
    if (kind === "image") {
      if (RAW_PHOTO.test(name)) return "fisheye";
      if (await hasBytes(file.slice(0, 512 * 1024), ['ProjectionType="equirectangular"', "ProjectionType>equirectangular<"])) return "equirect";
      return twoToOne && w >= 3000 ? "equirect" : "";
    }
    if (kind === "video") {
      if (RAW_VIDEO.test(name)) return twoToOne ? "fisheye" : ""; // single-lens files (one per lens) play flat
      const tags = ["sv3d", "GSpherical", SPHERICAL_UUID];
      const N = 4 * 1024 * 1024;
      if (await hasBytes(file.slice(0, N), tags) || (file.size > N && await hasBytes(file.slice(-N), tags))) return "equirect";
      return twoToOne && w >= 2880 ? "equirect" : "";
    }
  } catch {}
  return "";
}
