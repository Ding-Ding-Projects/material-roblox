'use strict';

/**
 * TOTP (RFC 6238 over RFC 4226 HOTP) — computed entirely in the MAIN process.
 *
 * Secret handling rules enforced here:
 *  - Seeds are written ONLY through this module and only into the encrypted
 *    store below (Electron safeStorage, i.e. the OS credential backing).
 *    They never reach localStorage, logs, exports, or the renderer beyond the
 *    one deliberate reveal during pairing (which the renderer feature owns).
 *  - No handler ever returns a secret. `totp:list` returns parameters only.
 *  - No handler logs payload contents; nothing here characterizes secret
 *    length or composition in errors.
 *
 * Storage note: the shell's `vault:*` handlers are renderer-facing IPC with no
 * contract-defined programmatic API for sibling main modules, so this file
 * keeps its own safeStorage-backed store under `userData/secrets/totp.json`.
 * Guarantees match the vault contract: ciphertext at rest via the OS-backed
 * key, plaintext never on disk, never in logs or exports.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

const ALGOS = new Set(['sha1', 'sha256', 'sha512']);
const DIGITS = new Set([6, 7, 8]);
const PERIOD_MIN = 1;
const PERIOD_MAX = 3600;
const SECRET_MIN_BYTES = 10;
const SECRET_MAX_BYTES = 128;
const ENTRY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;
const B32_RE = /^[A-Z2-7]+=*$/;

/** Uppercase, strip separators/padding, validate RFC 4648 base32 alphabet. */
function normalizeBase32(input) {
  const s = String(input == null ? '' : input).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!s || !B32_RE.test(s)) throw new Error('That secret is not valid base32 — check for stray characters.');
  return s;
}

/** RFC 4648 base32 → bytes (no padding accepted after normalization). */
function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s) {
    const idx = alphabet.indexOf(ch);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function base32Encode(buf) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/**
 * RFC 4226 HOTP: HMAC over the 8-byte big-endian counter, dynamic truncation,
 * reduction mod 10^digits, zero-padded to `digits`.
 */
function hotp(secretBuf, counter, algo, digits) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac(algo, secretBuf).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const bin =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  const mod = 10 ** digits;
  return String(bin % mod).padStart(digits, '0');
}

function constantTimeCodeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// Encrypted entry store
// ---------------------------------------------------------------------------

let storeCache = null;

function storeFile() {
  return path.join(app.getPath('userData'), 'secrets', 'totp.json');
}

function assertEncryptionAvailable() {
  if (!safeStorage || typeof safeStorage.encryptString !== 'function' || !safeStorage.isEncryptionAvailable()) {
    throw new Error('The system credential encryption is unavailable right now, so secrets cannot be stored. Start the app normally (not as a different user) and try again.');
  }
}

function loadStore() {
  if (storeCache) return storeCache;
  storeCache = { entries: {} };
  try {
    const raw = fs.readFileSync(storeFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      storeCache = parsed;
    }
  } catch {
    // Missing or unreadable file starts an empty store; entries were never
    // logged anywhere so there is nothing to recover by echoing them.
  }
  if (!storeCache.entries || typeof storeCache.entries !== 'object') storeCache = { entries: {} };
  return storeCache;
}

/** Atomic-ish persist: temp file then rename, with a short bounded retry. */
function persistStore() {
  const file = storeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(storeCache), 'utf8');
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      const busy = err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY');
      if (!busy) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
  try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  throw lastErr || new Error('Could not save the secrets store.');
}

function putEntry(entryId, secretB32, params) {
  assertEncryptionAvailable();
  const plain = JSON.stringify({ v: 1, secret: secretB32, params });
  const blob = safeStorage.encryptString(plain).toString('base64');
  loadStore().entries[entryId] = { v: 1, blob };
  persistStore();
}

function getEntry(entryId) {
  const rec = loadStore().entries[entryId];
  if (!rec) return null;
  try {
    const plain = safeStorage.decryptString(Buffer.from(String(rec.blob), 'base64'));
    const obj = JSON.parse(plain);
    if (!obj || typeof obj.secret !== 'string' || !obj.params) return null;
    return obj;
  } catch {
    return null;
  }
}

function removeEntry(entryId) {
  const store = loadStore();
  if (!(entryId in store.entries)) return false;
  delete store.entries[entryId];
  persistStore();
  return true;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function readParams(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const algo = p.algo === undefined ? 'sha1' : String(p.algo).toLowerCase();
  if (!ALGOS.has(algo)) throw new Error('Algorithm must be sha1, sha256, or sha512.');
  const digits = p.digits === undefined ? 6 : Number(p.digits);
  if (!DIGITS.has(digits)) throw new Error('Digits must be 6, 7, or 8.');
  const period = p.period === undefined ? 30 : Number(p.period);
  if (!Number.isInteger(period) || period < PERIOD_MIN || period > PERIOD_MAX) {
    throw new Error(`Period must be a whole number of seconds between ${PERIOD_MIN} and ${PERIOD_MAX}.`);
  }
  return { algo, digits, period };
}

function readEntryId(raw) {
  const id = String(raw == null ? '' : raw);
  if (!ENTRY_ID_RE.test(id)) throw new Error('Entry identifier contains unsupported characters.');
  return id;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * @param {{ipcMain: Electron.IpcMain, win?: Electron.BrowserWindow, getWin?: () => Electron.BrowserWindow|null}} deps
 */
function register(deps) {
  const { ipcMain } = deps;
  void (typeof deps.getWin === 'function' ? deps.getWin : () => deps.win || null);

  ipcMain.handle('totp:put', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const entryId = readEntryId(p.entryId);
    const secretB32 = normalizeBase32(p.secretB32);
    const secretBytes = base32Decode(secretB32);
    if (secretBytes.length < SECRET_MIN_BYTES || secretBytes.length > SECRET_MAX_BYTES) {
      // States the accepted SIZE RANGE (public RFC guidance), never the
      // caller's actual secret size.
      throw new Error(`Secrets must decode to between ${SECRET_MIN_BYTES} and ${SECRET_MAX_BYTES} bytes.`);
    }
    const params = readParams(p.params);
    putEntry(entryId, secretB32, params);
    return { ok: true };
  });

  ipcMain.handle('totp:list', () => {
    const entries = loadStore().entries;
    const list = [];
    for (const entryId of Object.keys(entries)) {
      const rec = getEntry(entryId);
      if (rec) list.push({ entryId, params: rec.params });
    }
    list.sort((a, b) => a.entryId.localeCompare(b.entryId));
    return { ok: true, entries: list }; // parameters only — no secrets, ever
  });

  ipcMain.handle('totp:code', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const entryId = readEntryId(p.entryId);
    const rec = getEntry(entryId);
    if (!rec) throw new Error('No authenticator entry exists under that identifier.');
    const offsetSec = p.offsetSec === undefined ? 0 : Number(p.offsetSec);
    if (!Number.isFinite(offsetSec) || Math.abs(offsetSec) > 86400) {
      throw new Error('Clock offset must be within ±24 hours.');
    }
    const { secret, params } = rec;
    const secretBytes = base32Decode(normalizeBase32(secret));
    const nowSec = Date.now() / 1000 + offsetSec;
    const counter = Math.floor(nowSec / params.period);
    const code = hotp(secretBytes, counter, params.algo, params.digits);
    const nextCode = hotp(secretBytes, counter + 1, params.algo, params.digits);
    const secondsRemaining = params.period - Math.floor(nowSec % params.period);
    return { ok: true, code, nextCode, secondsRemaining };
  });

  ipcMain.handle('totp:verify', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const entryId = readEntryId(p.entryId);
    const rec = getEntry(entryId);
    if (!rec) throw new Error('No authenticator entry exists under that identifier.');
    const window = p.window === undefined ? 1 : Number(p.window);
    if (!Number.isInteger(window) || window < 0 || window > 10) {
      throw new Error('Verification window must be between 0 and 10 steps.');
    }
    const candidate = String(p.code == null ? '' : p.code).replace(/\D/g, '');
    if (!candidate || candidate.length !== rec.params.digits) {
      return { ok: true, match: false }; // wrong shape is just "did not match"
    }
    const { secret, params } = rec;
    const secretBytes = base32Decode(normalizeBase32(secret));
    const nowSec = Date.now() / 1000;
    const center = Math.floor(nowSec / params.period);
    let match = false;
    for (let t = center - window; t <= center + window; t++) {
      if (t < 0) continue;
      if (constantTimeCodeEqual(candidate, hotp(secretBytes, t, params.algo, params.digits))) {
        match = true;
        break;
      }
    }
    return { ok: true, match };
  });

  ipcMain.handle('totp:remove', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const entryId = readEntryId(p.entryId);
    removeEntry(entryId);
    return { ok: true };
  });
}

module.exports = { register, base32Encode, base32Decode, hotp };
