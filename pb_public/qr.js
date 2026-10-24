// QR codes for links (Sites > QR code). A small encoder of our own - byte mode (UTF-8), error correction level M,
// versions 1-40, the mask with the lowest penalty - the same as the desktop windows' one in scripts/mv-qr.ps1 (keep
// the two in step). qrSvg() for showing it, qrPng() for saving or sharing it. Always dark on white: cameras need it.

// Level M, by version (index 0 unused).
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
  26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];

function rawModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) { const n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; }
  return r;
}
const dataCodewords = ver => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];

function mul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z & 0xff;
}

// The code as rows of modules (true = dark).
export function qrMatrix(text) {
  const data = new TextEncoder().encode(text);
  let ver = 1, capacity = 0;
  for (; ver <= 40; ver++) {
    capacity = dataCodewords(ver) * 8;
    if (4 + (ver < 10 ? 8 : 16) + data.length * 8 <= capacity) break;
  }
  if (ver > 40) throw new Error("Too long for a QR code");

  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4); // byte mode
  put(data.length, ver < 10 ? 8 : 16);
  for (const b of data) put(b, 8);
  put(0, Math.min(4, capacity - bits.length)); // terminator
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const codewords = new Uint8Array(bits.length / 8);
  bits.forEach((b, i) => { if (b) codewords[i >> 3] |= 1 << (7 - (i & 7)); });

  const size = ver * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };
  drawFunctions(set, ver, size);
  drawData(m, fn, interleave(codewords, ver), size);

  let best = 0, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(m, fn, mask, size); drawFormat(set, mask, size);
    const score = penalty(m, size);
    if (score < bestScore) { best = mask; bestScore = score; }
    applyMask(m, fn, mask, size); // (undo: masking is its own inverse)
  }
  applyMask(m, fn, best, size); drawFormat(set, best, size);
  return m;
}

function drawFunctions(set, ver, size) {
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]])
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  const align = alignmentPositions(ver, size), last = align.length - 1;
  for (let i = 0; i < align.length; i++) for (let j = 0; j < align.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
      set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  drawFormat(set, 0, size); // (reserves the area; drawn for real once the mask is chosen)
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const v = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const b = ((v >>> i) & 1) !== 0, a = size - 11 + (i % 3), c = Math.floor(i / 3);
      set(a, c, b); set(c, a, b);
    }
  }
}

function alignmentPositions(ver, size) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2, step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
  const r = new Array(n); r[0] = 6;
  for (let i = n - 1, pos = size - 7; i >= 1; i--, pos -= step) r[i] = pos;
  return r;
}

function drawFormat(set, mask, size) {
  const data = (0 << 3) | mask; // level M = 0b00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412, bit = i => ((bits >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
}

function interleave(data, ver) {
  const nb = BLOCKS[ver], ecc = ECC_PER_BLOCK[ver], raw = Math.floor(rawModules(ver) / 8);
  const nShort = nb - (raw % nb), shortLen = Math.floor(raw / nb);
  // Reed-Solomon generator for this many ECC codewords.
  const div = new Uint8Array(ecc); div[ecc - 1] = 1;
  let root = 1;
  for (let i = 0; i < ecc; i++) {
    for (let j = 0; j < ecc; j++) { div[j] = mul(div[j], root); if (j + 1 < ecc) div[j] ^= div[j + 1]; }
    root = mul(root, 2);
  }
  const blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const len = shortLen - ecc + (i < nShort ? 0 : 1);
    const block = new Uint8Array(shortLen + 1);
    block.set(data.subarray(k, k + len), 0);
    const rem = new Uint8Array(ecc);
    for (let n = 0; n < len; n++) {
      const f = data[k + n] ^ rem[0];
      rem.copyWithin(0, 1); rem[ecc - 1] = 0;
      for (let j = 0; j < ecc; j++) rem[j] ^= mul(div[j], f);
    }
    block.set(rem, shortLen + 1 - ecc);
    k += len; blocks.push(block);
  }
  const result = [];
  for (let i = 0; i <= shortLen; i++)
    for (let j = 0; j < nb; j++)
      if (i !== shortLen - ecc || j >= nShort) result.push(blocks[j][i]);
  return result;
}

function drawData(m, fn, data, size) {
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && i < data.length * 8) { m[y][x] = ((data[i >> 3] >>> (7 - (i & 7))) & 1) !== 0; i++; }
      }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];
function applyMask(m, fn, mask, size) {
  const inv = MASKS[mask];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && inv(x, y)) m[y][x] = !m[y][x];
}

// The standard's four penalty rules (runs, 2x2 blocks, finder-like patterns, dark/light balance).
const FINDER = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
function penalty(m, size) {
  let score = 0, dark = 0;
  for (let pass = 0; pass < 2; pass++)
    for (let a = 0; a < size; a++) {
      let run = 0, prev = false;
      const at = b => (pass === 0 ? m[a][b] : m[b][a]);
      for (let b = 0; b < size; b++) {
        const c = at(b);
        if (b > 0 && c === prev) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else run = 1;
        prev = c;
        if (b >= 10) {
          let f1 = true, f2 = true;
          for (let k = 0; k < 11; k++) {
            const v = at(b - 10 + k) ? 1 : 0;
            if (v !== FINDER[k]) f1 = false;
            if (v !== FINDER[10 - k]) f2 = false;
          }
          if (f1) score += 40;
          if (f2) score += 40;
        }
      }
    }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (m[y][x]) dark++;
    if (x < size - 1 && y < size - 1) { const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3; }
  }
  const total = size * size, off = Math.floor((Math.abs(dark * 20 - total * 10) + total - 1) / total) - 1; // 10 points per 5% away from half dark
  if (off > 0) score += off * 10;
  return score;
}

// An <svg> of the code with the usual quiet zone (4 modules), scaling to whatever size it's shown at.
export function qrSvg(text, label = "QR code") {
  const m = qrMatrix(text), n = m.length, full = n + 8;
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) d += `M${x + 4} ${y + 4}h1v1h-1z`;
  return `<svg class="qr" viewBox="0 0 ${full} ${full}" role="img" aria-label="${label.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)}" shape-rendering="crispEdges"><rect width="${full}" height="${full}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

// A PNG of the code (scale = pixels per module), with an optional caption under it - for saving or sharing.
export function qrPng(text, { scale = 12, caption = "" } = {}) {
  const m = qrMatrix(text), n = m.length, side = (n + 8) * scale, capH = caption ? Math.round(scale * 4) : 0;
  const c = document.createElement("canvas");
  c.width = side; c.height = side + capH;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#000";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) g.fillRect((x + 4) * scale, (y + 4) * scale, scale, scale);
  if (caption) {
    g.font = `600 ${Math.round(scale * 1.6)}px system-ui, "Segoe UI", sans-serif`;
    g.textAlign = "center"; g.textBaseline = "middle";
    let t = caption;
    while (t.length > 4 && g.measureText(t).width > side - scale * 4) t = t.slice(0, -2);
    if (t !== caption) t = t.slice(0, -1) + "…";
    g.fillText(t, side / 2, side + capH / 2 - scale);
  }
  return new Promise(resolve => c.toBlob(resolve, "image/png"));
}
