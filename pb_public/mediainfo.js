// Reads "date taken" and GPS location from a photo or video, without loading the whole file.
//   mediaInfo(size, read) → { date?, lat?, lng? } or null
// read(start, end) resolves to the bytes in [start, end) as a Uint8Array (fewer at the end of the file), so the
// same code works on a File at upload and on a stored file through HTTP range requests (rangeReader()).
// Understands: JPEG (and Insta360 .insp) EXIF, HEIC/HEIF/AVIF Exif items, PNG eXIf, WebP EXIF, and the
// location phones write into MP4/MOV videos (©xyz, or Apple's com.apple.quicktime.location.ISO6709).

const HEAD = 256 * 1024;
const MAX_BOX = 48 * 1024 * 1024; // biggest moov/meta box we'll fetch (a moov is ~1 MB per 10 min of video)

const dvOf = u8 => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
const fourcc = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

export async function mediaInfo(size, read) {
  try {
    const head = await read(0, Math.min(size, HEAD));
    const dv = dvOf(head);
    if (dv.byteLength < 12) return null;
    if (dv.getUint16(0) === 0xffd8) return jpeg(dv);
    if (dv.getUint32(0) === 0x89504e47) return png(dv);
    if (fourcc(dv, 0) === "RIFF" && fourcc(dv, 8) === "WEBP") return await webp(size, read, dv);
    if (/^(ftyp|moov|mdat|free|wide|skip)$/.test(fourcc(dv, 4))) return await isobmff(size, read, head);
  } catch {}
  return null;
}

// A reader for a stored file: one range request per read; the first 256 KB is fetched once and reused.
// Returns { size, read } or null when the file can't be fetched.
export async function rangeReader(url) {
  const get = async (a, b) => {
    const res = await fetch(url, { headers: { Range: `bytes=${a}-${b - 1}` } });
    if (res.status === 206) return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // The server ignored the range: read from the start only as far as needed, then stop the download.
    const out = new Uint8Array(b), rd = res.body.getReader();
    let n = 0;
    while (n < b) {
      const { done, value } = await rd.read();
      if (done) break;
      out.set(value.subarray(0, b - n), n);
      n += value.length;
    }
    rd.cancel().catch(() => {});
    return { res, bytes: out.subarray(a, Math.min(n, b)) };
  };
  try {
    const { res, bytes } = await get(0, HEAD);
    const total = +(res.headers.get("Content-Range") || "").split("/")[1] || +res.headers.get("Content-Length") || bytes.length;
    return {
      size: total,
      read: (a, b) => (b <= bytes.length ? Promise.resolve(bytes.subarray(a, b)) : get(a, b).then(r => r.bytes)),
    };
  } catch {
    return null;
  }
}

function jpeg(dv) {
  let off = 2;
  while (off + 10 < dv.byteLength) {
    const marker = dv.getUint16(off), len = dv.getUint16(off + 2);
    if ((marker & 0xff00) !== 0xff00) return null;
    if (marker === 0xffe1 && dv.getUint32(off + 4) === 0x45786966) return tiff(dv, off + 10); // "Exif"
    if (marker === 0xffda) return null; // image data starts: no EXIF
    off += 2 + len;
  }
  return null;
}

function png(dv) {
  for (let off = 8; off + 8 <= dv.byteLength;) {
    const len = dv.getUint32(off), type = fourcc(dv, off + 4);
    if (type === "eXIf") return tiff(dv, off + 8);
    if (type === "IDAT" || type === "IEND") return null;
    off += 12 + len;
  }
  return null;
}

async function webp(size, read, dv) {
  for (let off = 12, i = 0; off + 8 <= size && i < 64; i++) {
    const h = off + 8 <= dv.byteLength ? dv : dvOf(await read(off, off + 8));
    const at = h === dv ? off : 0;
    const type = fourcc(h, at), len = h.getUint32(at + 4, true);
    if (type === "EXIF") {
      const d = dvOf(await read(off + 8, off + 8 + Math.min(len, HEAD)));
      return tiff(d, d.getUint32(0) === 0x45786966 ? 6 : 0); // some writers keep the "Exif\0\0" prefix
    }
    off += 8 + len + (len & 1);
  }
  return null;
}

// ---- ISO base media (HEIC/AVIF photos, MP4/MOV videos): walk the top-level boxes ----
async function isobmff(size, read, head) {
  for (let off = 0, i = 0; off + 8 <= size && i < 200; i++) {
    const h = dvOf(off + 16 <= head.length ? head.subarray(off, off + 16) : await read(off, off + 16));
    if (h.byteLength < 8) break;
    let len = h.getUint32(0), hdr = 8;
    const type = fourcc(h, 4);
    if (len === 1) { len = Number(h.getBigUint64(8)); hdr = 16; }
    else if (len === 0) len = size - off;
    if (len < hdr) break;
    // A file has one of these (HEIF photos: meta, videos: moov); after it there's nothing more to find.
    if (type === "meta" || type === "moov") {
      if (len > MAX_BOX) return null;
      const box = off + len <= head.length ? head.subarray(off, off + len) : await read(off, off + len);
      return type === "meta" ? await heif(box, hdr, read) : movie(box);
    }
    off += len;
  }
  return null;
}

// The children of a box, as { type, start (of the payload), end } within buf.
function children(buf, from, to) {
  const dv = dvOf(buf), out = [];
  for (let off = from; off + 8 <= to;) {
    let len = dv.getUint32(off), hdr = 8;
    if (len === 1) { len = Number(dv.getBigUint64(off + 8)); hdr = 16; } else if (len === 0) len = to - off;
    if (len < hdr || off + len > to) break;
    out.push({ type: fourcc(dv, off + 4), start: off + hdr, end: off + len });
    off += len;
  }
  return out;
}

// HEIF: the Exif metadata is an item of type "Exif"; iinf names the items, iloc says where their bytes are.
async function heif(meta, hdr, read) {
  const dv = dvOf(meta);
  const kids = children(meta, hdr + 4, meta.length); // meta is a full box: 4 bytes of version/flags first
  const iinf = kids.find(k => k.type === "iinf"), iloc = kids.find(k => k.type === "iloc"), idat = kids.find(k => k.type === "idat");
  if (!iinf || !iloc) return null;
  let exifId = -1;
  const iv = dv.getUint8(iinf.start);
  for (const e of children(meta, iinf.start + 4 + (iv === 0 ? 2 : 4), iinf.end)) {
    if (e.type !== "infe") continue;
    const v = dv.getUint8(e.start);
    if (v < 2) continue;
    const id = v === 2 ? dv.getUint16(e.start + 4) : dv.getUint32(e.start + 4);
    const typeAt = e.start + 4 + (v === 2 ? 2 : 4) + 2;
    if (fourcc(dv, typeAt) === "Exif") { exifId = id; break; }
  }
  if (exifId < 0) return null;
  let p = iloc.start;
  const v = dv.getUint8(p); p += 4;
  const sizes = dv.getUint16(p); p += 2;
  const offSize = sizes >> 12, lenSize = (sizes >> 8) & 15, baseSize = (sizes >> 4) & 15, idxSize = v > 0 ? sizes & 15 : 0;
  const num = n => { let x = 0; for (let i = 0; i < n; i++) x = x * 256 + dv.getUint8(p + i); p += n; return x; };
  const count = num(v < 2 ? 2 : 4);
  for (let i = 0; i < count; i++) {
    const id = num(v < 2 ? 2 : 4);
    const method = v > 0 ? num(2) & 15 : 0;
    num(2); // data reference index
    const base = num(baseSize);
    const extents = num(2);
    let first = null;
    for (let x = 0; x < extents; x++) {
      if (idxSize) num(idxSize);
      const eo = num(offSize), el = num(lenSize);
      first ??= [eo, el];
    }
    if (id !== exifId || !first) continue;
    const at = base + first[0], len = Math.min(first[1], HEAD);
    let bytes;
    if (method === 0) bytes = await read(at, at + len);
    else if (method === 1 && idat) bytes = meta.subarray(idat.start + at, idat.start + at + len);
    else return null;
    const d = dvOf(bytes);
    return tiff(d, 4 + d.getUint32(0)); // payload starts with the offset to the TIFF header
  }
  return null;
}

// Videos: Android and most cameras write moov/udta/©xyz = "+37.3349-122.0090+012.345/" (ISO 6709); iPhones put
// the same text in moov/meta under the key com.apple.quicktime.location.ISO6709 (the value comes after the key list).
function movie(moov) {
  const text = new TextDecoder("latin1").decode(moov);
  const marks = [text.indexOf("©xyz"), text.indexOf("com.apple.quicktime.location.ISO6709")].filter(i => i >= 0);
  if (!marks.length) return null;
  const m = /([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)/.exec(text.slice(Math.min(...marks)));
  if (!m) return null;
  const lat = +m[1], lng = +m[2];
  return ok(lat, lng) ? { lat: +lat.toFixed(6), lng: +lng.toFixed(6) } : null;
}

const ok = (lat, lng) => (lat || lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

// A TIFF/EXIF block starting at offset t of dv: DateTimeOriginal (or DateTime) and the GPS position.
function tiff(dv, t) {
  const le = dv.getUint16(t) === 0x4949;
  const u16 = o => dv.getUint16(t + o, le), u32 = o => dv.getUint32(t + o, le);
  const ifd = at => { const out = {}; for (let i = 0, n = u16(at); i < n; i++) out[u16(at + 2 + i * 12)] = at + 2 + i * 12; return out; };
  const str = e => { const n = u32(e + 4), at = n > 4 ? u32(e + 8) : e + 8; let s = ""; for (let i = 0; i < n - 1; i++) s += String.fromCharCode(dv.getUint8(t + at + i)); return s; };
  const ifd0 = ifd(u32(4));
  const out = {};
  let s = null;
  try { if (ifd0[0x8769]) { const ex = ifd(u32(ifd0[0x8769] + 8)); if (ex[0x9003]) s = str(ex[0x9003]); } } catch {}
  try { if (!s && ifd0[0x0132]) s = str(ifd0[0x0132]); } catch {}
  const m = s?.match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
  if (m && m[1] !== "0000") out.date = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  // GPS IFD: 1/3 = N/S, E/W refs (inline ASCII); 2/4 = degrees, minutes, seconds as 3 rationals.
  try {
    if (ifd0[0x8825]) {
      const g = ifd(u32(ifd0[0x8825] + 8));
      const dms = e => { const at = u32(e + 8); let v = 0; for (let i = 0; i < 3; i++) { const den = u32(at + i * 8 + 4); v += den ? u32(at + i * 8) / den / 60 ** i : 0; } return v; };
      if (g[2] && g[4]) {
        let lat = dms(g[2]), lng = dms(g[4]);
        if (g[1] && String.fromCharCode(dv.getUint8(t + g[1] + 8)) === "S") lat = -lat;
        if (g[3] && String.fromCharCode(dv.getUint8(t + g[3] + 8)) === "W") lng = -lng;
        if (ok(lat, lng)) Object.assign(out, { lat: +lat.toFixed(6), lng: +lng.toFixed(6) });
      }
    }
  } catch {}
  return out;
}
