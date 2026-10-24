`noble.js` = @noble/ciphers 1.3.0 (XChaCha20-Poly1305) + @noble/hashes 1.8.0 (scrypt, HKDF, SHA-256),
MIT licensed, by Paul Miller (https://paulmillr.com/noble), independently audited. Bundled into one ES
module with esbuild 0.25.5 from entry:

    export { xchacha20poly1305 } from "@noble/ciphers/chacha";
    export { scryptAsync } from "@noble/hashes/scrypt";
    export { hkdf } from "@noble/hashes/hkdf";
    export { sha256 } from "@noble/hashes/sha256";

    esbuild entry.js --bundle --format=esm --target=es2020 --legal-comments=inline --outfile=noble.js

Used instead of WebCrypto because WebCrypto only exists on https/localhost pages, and phones reach the
vault over plain http on the LAN.
