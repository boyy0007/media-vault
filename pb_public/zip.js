// "Download all" for client galleries (share.js): one .zip made in the browser from the gallery's files, so a client
// doesn't get a hundred separate downloads (which browsers stop after a few). Files are stored as they are - photos
// and videos are compressed already - with ZIP64 when the whole thing could pass 4 GB, which Windows, macOS and phones
// all open. Where the browser can write a file as it goes (showSaveFilePicker: Chrome, Edge) nothing much is kept in
// memory; elsewhere the zip is put together in memory and then saved.
//
// saveZip(files, { name, onProgress, signal }) - files: [{ name, url, size, date }] (size: a guess is fine; it only
// decides ZIP64). Resolves to "saved" or "cancelled".

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crcUpdate(crc, bytes) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Names inside the zip: no folders or odd characters, and no two the same ("IMG_1.jpg", "IMG_1 (2).jpg").
function uniqueNames(files) {
  const seen = new Set();
  return files.map(f => {
    let n = String(f.name || "file").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 200) || "file";
    if (seen.has(n.toLowerCase())) {
      const dot = n.lastIndexOf("."), stem = dot > 0 ? n.slice(0, dot) : n, ext = dot > 0 ? n.slice(dot) : "";
      for (let i = 2; seen.has(n.toLowerCase()); i++) n = `${stem} (${i})${ext}`;
    }
    seen.add(n.toLowerCase());
    return n;
  });
}

class Bytes {
  constructor(n) { this.buf = new Uint8Array(n); this.v = new DataView(this.buf.buffer); this.o = 0; }
  u16(x) { this.v.setUint16(this.o, x, true); this.o += 2; return this; }
  u32(x) { this.v.setUint32(this.o, x >>> 0, true); this.o += 4; return this; }
  u64(x) { this.v.setBigUint64(this.o, BigInt(x), true); this.o += 8; return this; }
  raw(b) { this.buf.set(b, this.o); this.o += b.length; return this; }
}

const FLAGS = 0x0808; // bit 3: sizes and CRC come after the data; bit 11: names are UTF-8
const MAX32 = 0xffffffff;

export async function saveZip(files, { name = "photos.zip", onProgress = () => {}, signal, zip64 } = {}) {
  const names = uniqueNames(files);
  const total = files.reduce((s, f) => s + (f.size || 0), 0);
  // ZIP64 if the data alone could come near 4 GB (sizes are estimates, so with room to spare).
  const z64 = zip64 ?? total > 3.5 * 1024 ** 3;
  const ver = z64 ? 45 : 20;

  // Where the bytes go: a file on disk as it's made, or pieces of a Blob.
  let out, parts = null;
  if (window.showSaveFilePicker) {
    let handle;
    try {
      handle = await showSaveFilePicker({ suggestedName: name, types: [{ description: "Zip file", accept: { "application/zip": [".zip"] } }] });
    } catch (e) {
      if (e.name === "AbortError") return "cancelled";
      throw e;
    }
    out = await handle.createWritable();
  } else parts = [];
  const write = async chunk => { if (parts) parts.push(chunk); else await out.write(chunk); };

  let offset = 0, done = 0;
  const central = [];
  try {
    for (let i = 0; i < files.length; i++) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const f = files[i], nameBytes = new TextEncoder().encode(names[i]);
      const { time, date } = dosTime(f.date instanceof Date && !isNaN(f.date) ? f.date : new Date());
      const localOffset = offset;
      const local = new Bytes(30 + nameBytes.length + (z64 ? 20 : 0));
      local.u32(0x04034b50).u16(ver).u16(FLAGS).u16(0).u16(time).u16(date).u32(0)
        .u32(z64 ? MAX32 : 0).u32(z64 ? MAX32 : 0).u16(nameBytes.length).u16(z64 ? 20 : 0).raw(nameBytes);
      if (z64) local.u16(0x0001).u16(16).u64(0).u64(0);
      await write(local.buf);
      offset += local.buf.length;

      const res = await fetch(f.url, { signal });
      if (!res.ok) throw new Error(`Couldn't download ${names[i]} (${res.status}).`);
      let crc = 0, size = 0;
      if (parts) {
        // (In memory: the file's own Blob goes in as it is; reading it once is enough for the CRC.)
        const blob = await res.blob();
        const reader = blob.stream().getReader();
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          crc = crcUpdate(crc, value); size += value.length;
          onProgress({ file: i, files: files.length, bytes: done + size, total });
        }
        parts.push(blob);
      } else {
        const reader = res.body.getReader();
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          crc = crcUpdate(crc, value); size += value.length;
          await out.write(value);
          onProgress({ file: i, files: files.length, bytes: done + size, total });
        }
      }
      offset += size; done += size;

      const desc = new Bytes(z64 ? 24 : 16);
      desc.u32(0x08074b50).u32(crc);
      if (z64) desc.u64(size).u64(size); else desc.u32(size).u32(size);
      await write(desc.buf);
      offset += desc.buf.length;
      central.push({ nameBytes, time, date, crc, size, localOffset });
    }

    // The table of contents at the end.
    const cdStart = offset;
    for (const c of central) {
      const cd = new Bytes(46 + c.nameBytes.length + (z64 ? 28 : 0));
      cd.u32(0x02014b50).u16(ver).u16(ver).u16(FLAGS).u16(0).u16(c.time).u16(c.date).u32(c.crc)
        .u32(z64 ? MAX32 : c.size).u32(z64 ? MAX32 : c.size).u16(c.nameBytes.length).u16(z64 ? 28 : 0).u16(0)
        .u16(0).u16(0).u32(0).u32(z64 ? MAX32 : c.localOffset).raw(c.nameBytes);
      if (z64) cd.u16(0x0001).u16(24).u64(c.size).u64(c.size).u64(c.localOffset);
      await write(cd.buf);
      offset += cd.buf.length;
    }
    const cdSize = offset - cdStart;
    if (z64) {
      const end64 = new Bytes(56 + 20);
      end64.u32(0x06064b50).u64(44).u16(ver).u16(ver).u32(0).u32(0).u64(central.length).u64(central.length).u64(cdSize).u64(cdStart);
      end64.u32(0x07064b50).u32(0).u64(offset).u32(1);
      await write(end64.buf);
    }
    const end = new Bytes(22);
    end.u32(0x06054b50).u16(0).u16(0).u16(z64 ? 0xffff : central.length).u16(z64 ? 0xffff : central.length)
      .u32(z64 ? MAX32 : cdSize).u32(z64 ? MAX32 : cdStart).u16(0);
    await write(end.buf);
  } catch (e) {
    if (out) await out.abort().catch(() => {});
    if (e.name === "AbortError") return "cancelled";
    throw e;
  }

  if (out) await out.close();
  else {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(parts, { type: "application/zip" }));
    a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  return "saved";
}
