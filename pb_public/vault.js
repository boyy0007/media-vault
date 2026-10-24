// Locked folder crypto. Everything here runs on the device; the server only sees the outputs.
//
// Keys
//   master key (MK)  32 random bytes, made once at setup. Never stored in readable form.
//   passphrase KEK   scrypt(passphrase, salt, N=2^17, r=8, p=1) — wraps MK → vault.wrapped
//   recovery KEK     HKDF-SHA256(recovery key) — wraps MK → vault.recovery
//   file key (FK)    32 random bytes per item, wrapped with MK → vault_items.key
// Cipher: XChaCha20-Poly1305 (authenticated: any tampering or a wrong key fails to decrypt).
//
// Encrypted file format (files and thumbnails):
//   "MVE1" | version 0x01 | chunk size (u32 BE) | 16-byte random nonce prefix
//   then each chunk = ciphertext + 16-byte tag, nonce = prefix | chunk index (u32 BE) | last? (u32 BE)
//   The "last" flag means a truncated or reordered file is rejected, not silently accepted.
//
// WebCrypto isn't available on plain-http pages (how phones reach the vault on the LAN), so this uses
// the audited pure-JS noble libraries instead. crypto.getRandomValues works on http pages.

import { xchacha20poly1305, scryptAsync, hkdf, sha256 } from "./vendor/noble.js";

const KDF = { alg: "scrypt", N: 2 ** 17, r: 8, p: 1 };
const CHUNK = 4 * 1024 * 1024;
const MAGIC = [0x4d, 0x56, 0x45, 0x31]; // "MVE1"
const HEADER = 4 + 1 + 4 + 16;
const TAG = 16;
const enc = new TextEncoder(), dec = new TextDecoder();
const AAD = {
  pass: enc.encode("media-vault:mk:passphrase:v1"),
  recovery: enc.encode("media-vault:mk:recovery:v1"),
  fileKey: enc.encode("media-vault:file-key:v1"),
  meta: enc.encode("media-vault:meta:v1"),
};

export const random = n => crypto.getRandomValues(new Uint8Array(n));
export const b64 = u8 => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// Small values (keys, metadata): base64(nonce | ciphertext+tag).
function seal(key, data, aad) {
  const nonce = random(24);
  const ct = xchacha20poly1305(key, nonce, aad).encrypt(data);
  const out = new Uint8Array(24 + ct.length);
  out.set(nonce);
  out.set(ct, 24);
  return b64(out);
}
function open(key, sealed, aad) {
  const raw = unb64(sealed);
  return xchacha20poly1305(key, raw.subarray(0, 24), aad).decrypt(raw.subarray(24)); // throws if wrong key / tampered
}

const passKey = (pass, kdf) =>
  scryptAsync(enc.encode(pass.normalize("NFKC")), unb64(kdf.salt), { N: kdf.N, r: kdf.r, p: kdf.p, dkLen: 32, maxmem: 2 ** 30 });

// Recovery key: 20 random bytes as 32 base32 characters, shown as 8 groups of 4.
const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1
function toB32(u8) {
  let bits = 0, val = 0, s = "";
  for (const b of u8) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { s += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return s.match(/.{4}/g).join("-");
}
function fromB32(s) {
  s = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length !== 32 || [...s].some(c => !B32.includes(c))) throw new Error("That recovery key isn't valid — it's 32 letters and digits.");
  const out = new Uint8Array(20);
  let bits = 0, val = 0, i = 0;
  for (const c of s) {
    val = (val << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out[i++] = (val >>> (bits - 8)) & 255; bits -= 8; }
  }
  return out;
}
const recoveryKek = rk => hkdf(sha256, rk, enc.encode("media-vault:recovery-salt:v1"), AAD.recovery, 32);

// ---------- session ----------
let MK = null;
export const isUnlocked = () => !!MK;
export function lock() {
  MK?.fill(0);
  MK = null;
}

/** First-time setup. Returns { record, recoveryKey } — the caller must show recoveryKey once. */
export async function createVault(pass) {
  const mk = random(32);
  const kdf = { ...KDF, salt: b64(random(16)) };
  const rk = random(20);
  const record = {
    kdf,
    wrapped: seal(await passKey(pass, kdf), mk, AAD.pass),
    recovery: seal(recoveryKek(rk), mk, AAD.recovery),
  };
  MK = mk;
  return { record, recoveryKey: toB32(rk) };
}

/** Unlock with the passphrase. Throws "Wrong passphrase" if it doesn't match. */
export async function unlock(vault, pass) {
  const kek = await passKey(pass, vault.kdf);
  try { MK = open(kek, vault.wrapped, AAD.pass); }
  catch { throw new Error("Wrong passphrase"); }
}

/** Forgotten passphrase: unlock with the recovery key, then set a new passphrase. Returns the vault patch. */
export async function recover(vault, recoveryKey, newPass) {
  let mk;
  try { mk = open(recoveryKek(fromB32(recoveryKey)), vault.recovery, AAD.recovery); }
  catch (e) { throw new Error(e.message.includes("recovery key") ? e.message : "That recovery key doesn't match this locked folder."); }
  MK = mk;
  return rewrap(newPass);
}

/** New passphrase for the current (unlocked) master key. Files don't need re-encrypting. */
export async function rewrap(newPass) {
  if (!MK) throw new Error("Locked");
  const kdf = { ...KDF, salt: b64(random(16)) };
  return { kdf, wrapped: seal(await passKey(newPass, kdf), MK, AAD.pass) };
}

// ---------- items ----------
export function newFileKey() {
  if (!MK) throw new Error("Locked");
  const fk = random(32);
  return { fk, wrapped: seal(MK, fk, AAD.fileKey) };
}
export function fileKey(item) {
  if (!MK) throw new Error("Locked");
  return open(MK, item.key, AAD.fileKey);
}
export const sealMeta = (fk, meta) => seal(fk, enc.encode(JSON.stringify(meta)), AAD.meta);
export const openMeta = (fk, sealed) => JSON.parse(dec.decode(open(fk, sealed, AAD.meta)));

const nonceFor = (prefix, i, last) => {
  const n = new Uint8Array(24);
  n.set(prefix);
  const dv = new DataView(n.buffer);
  dv.setUint32(16, i);
  dv.setUint32(20, last ? 1 : 0);
  return n;
};
const tick = () => new Promise(r => setTimeout(r, 0));

/** Encrypt a Blob/File chunk by chunk. onProgress(0..1). Returns a Blob of ciphertext. */
export async function encryptBlob(fk, blob, onProgress) {
  const prefix = random(16);
  const head = new Uint8Array(HEADER);
  head.set(MAGIC);
  head[4] = 1;
  new DataView(head.buffer).setUint32(5, CHUNK);
  head.set(prefix, 9);
  const parts = [head];
  const n = Math.max(1, Math.ceil(blob.size / CHUNK));
  for (let i = 0; i < n; i++) {
    const plain = new Uint8Array(await blob.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer());
    parts.push(xchacha20poly1305(fk, nonceFor(prefix, i, i === n - 1)).encrypt(plain));
    onProgress?.((i + 1) / n);
    await tick();
  }
  return new Blob(parts, { type: "application/octet-stream" });
}

/** Decrypt a Blob produced by encryptBlob. Throws if anything was altered or cut short. */
export async function decryptBlob(fk, blob, type = "", onProgress) {
  const head = new Uint8Array(await blob.slice(0, HEADER).arrayBuffer());
  if (head.length < HEADER || MAGIC.some((b, i) => head[i] !== b) || head[4] !== 1) throw new Error("Not a locked-folder file");
  const chunk = new DataView(head.buffer).getUint32(5);
  const prefix = head.slice(9, 25);
  const body = blob.size - HEADER;
  const n = Math.max(1, Math.ceil(body / (chunk + TAG)));
  const parts = [];
  for (let i = 0; i < n; i++) {
    const start = HEADER + i * (chunk + TAG);
    const ct = new Uint8Array(await blob.slice(start, start + chunk + TAG).arrayBuffer());
    try { parts.push(xchacha20poly1305(fk, nonceFor(prefix, i, i === n - 1)).decrypt(ct)); }
    catch { throw new Error("This file is damaged or was tampered with"); }
    onProgress?.((i + 1) / n);
    await tick();
  }
  return new Blob(parts, { type });
}

export const passphraseProblem = p =>
  p.length < 10 ? "Use at least 10 characters — a few unrelated words works well." : "";
