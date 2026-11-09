// QuickJS host polyfills required by songloft-plugin-miot.
//
// Two distinct crypto surfaces are used by the plugin:
//   1) src/utils/crypto.ts   -> global `crypto.md5/randomBytes/...`
//   2) src/miio/client.ts    -> `__go_crypto_*`, `__go_buffer_*`, and a
//      fallback `go.crypto.*` object (MiIO RC4 + SHA1/SHA256 signing).
//
// Node 24's WebCrypto has none of these synchronous helpers, so we install
// them onto globalThis.crypto while preserving the prototype chain so
// getRandomValues/subtle keep working for other code.

import { createHash, createCipheriv, randomBytes as nodeRandomBytes } from 'node:crypto';

class HexBuf {
  constructor(bytes) {
    this.buf = Buffer.from(bytes);
    this._hex = this.buf.toString('hex');
    this.length = this.buf.length;
  }
  toString(fmt = 'hex') {
    return fmt === 'base64' ? this.buf.toString('base64') : this._hex;
  }
}

function md5(str) {
  return createHash('md5').update(String(str), 'utf8').digest('hex');
}
function sha1Hex(value) {
  return createHash('sha1').update(String(value), 'utf8').digest('hex');
}
function sha256OfHex(dataHex) {
  return createHash('sha256').update(Buffer.from(String(dataHex), 'hex')).digest('hex');
}
function randomBuf(size) {
  return new HexBuf(nodeRandomBytes(Math.max(0, Number(size) || 0)));
}

// RC4 is disabled by default in OpenSSL 3, so implement it directly.
function rc4Bytes(keyBuf, dataBuf) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + keyBuf[i % keyBuf.length]) & 0xff;
    const t = S[i]; S[i] = S[j]; S[j] = t;
  }
  const out = Buffer.allocUnsafe(dataBuf.length);
  let a = 0;
  j = 0;
  for (let n = 0; n < dataBuf.length; n++) {
    a = (a + 1) & 0xff;
    j = (j + S[a]) & 0xff;
    const t = S[a]; S[a] = S[j]; S[j] = t;
    out[n] = dataBuf[n] ^ S[(S[a] + S[j]) & 0xff];
  }
  return out;
}
function rc4Hex(keyHex, dataHex) {
  return rc4Bytes(Buffer.from(keyHex, 'hex'), Buffer.from(dataHex, 'hex')).toString('hex');
}

// The first surface: methods called on the global `crypto` object.
const poly = {
  md5,
  randomBytes: randomBuf,
  sha1: sha1Hex,
  sha256Bytes: (arg) => new HexBuf(Buffer.from(sha256OfHex(arg?._hex ?? ''), 'hex')),
  rc4: (key, data) => new HexBuf(Buffer.from(rc4Hex(key?._hex ?? '', data?._hex ?? ''), 'hex')),
  aesEncrypt: (data, _mode, key, iv) => {
    // No call sites in the plugin (dead code in utils/crypto.ts), kept for parity.
    const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8');
    const ivBuf = Buffer.isBuffer(iv) ? iv : Buffer.from(String(iv ?? ''), 'utf8');
    const c = createCipheriv('aes-128-cbc', keyBuf.subarray(0, 16), ivBuf.subarray(0, 16));
    return new HexBuf(Buffer.concat([c.update(Buffer.from(String(data), 'utf8')), c.final()]));
  },
  rsaEncrypt: () => { throw new Error('crypto.rsaEncrypt is not implemented (no call sites)'); },
};

let target = globalThis.crypto;
if (!target || typeof target !== 'object') {
  target = {};
  Object.defineProperty(globalThis, 'crypto', { value: target, configurable: true, writable: true });
}
let ok = true;
for (const [k, v] of Object.entries(poly)) {
  try {
    Object.defineProperty(target, k, { value: v, configurable: true, writable: true, enumerable: false });
  } catch {
    ok = false;
    break;
  }
}
if (!ok || typeof target.md5 !== 'function') {
  const fallback = Object.create(target);
  Object.assign(fallback, poly);
  Object.defineProperty(globalThis, 'crypto', { value: fallback, configurable: true, writable: true });
  target = fallback;
}

// The second surface: go.* fallback + __go_* globals used by miio/client.ts.
globalThis.go = { crypto: target };

globalThis.__go_crypto_random_bytes = (size) => nodeRandomBytes(Number(size) || 0).toString('hex');
globalThis.__go_crypto_sha256_bytes = (dataHex) => sha256OfHex(String(dataHex));
globalThis.__go_crypto_sha1 = (value) => sha1Hex(String(value));
globalThis.__go_crypto_rc4 = (keyHex, dataHex) => rc4Hex(String(keyHex), String(dataHex));

globalThis.__go_buffer_from = (value, enc = 'utf8') =>
  Buffer.from(String(value), enc === 'base64' ? 'base64' : 'utf8').toString('hex');
globalThis.__go_buffer_to_string = (value, enc = 'utf8') =>
  Buffer.from(String(value), 'hex').toString(enc === 'base64' ? 'base64' : 'utf8');

// atob/btoa are native in Node >= 16, but keep the SSDP path safe.
if (typeof globalThis.atob !== 'function') {
  globalThis.atob = (s) => Buffer.from(String(s), 'base64').toString('binary');
}
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (s) => Buffer.from(String(s), 'binary').toString('base64');
}

export { rc4Hex, sha256OfHex };
