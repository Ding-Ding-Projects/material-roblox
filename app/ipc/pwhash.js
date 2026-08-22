'use strict';

/**
 * Password hashing IPC — PBKDF2-SHA-256, evaluated in the MAIN process.
 *
 * Why main-side hashing: verification decisions are made in the privileged
 * process (the "server-side grading" principle used across this app). The
 * renderer only ever sends a candidate password over IPC and receives a
 * boolean; it never sees the salt, the iteration count tuning, or the derived
 * hash unless it asked for them to STORE them (the storing path returns the
 * parameters once, for persistence into the OS-backed vault by the caller).
 *
 * Secrets discipline:
 *  - Nothing in this file logs, echoes, or characterizes password values,
 *    lengths, or composition. Payloads are validated by type/size only.
 *  - Hashes are stored by the CALLER (locks feature) in the encrypted vault,
 *    never in localStorage.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { app } = require('electron');

const KEY_LENGTH_BYTES = 32; // SHA-256 digest size
const SALT_LENGTH_BYTES = 16;
const ITER_DEFAULT = 210000;
const ITER_MIN = 100000;
const ITER_MAX = 2000000;
const MAX_PASSWORD_CHARS = 1024;

/** @param {unknown} v @returns {string} */
function asString(v) {
  return typeof v === 'string' ? v : '';
}

/**
 * Strict base64 decode: Node's Buffer.from ignores invalid characters
 * silently, which would turn garbage into arbitrary bytes — so validate the
 * alphabet/shape first and confirm the canonical re-encoding round-trips.
 */
function b64decodeStrict(s) {
  const raw = String(s == null ? '' : s).trim();
  const body = raw.replace(/=+$/, '');
  if (!body || !/^[A-Za-z0-9+/]+$/.test(body) || raw.length % 4 !== 0) {
    throw new Error('Malformed base64 value.');
  }
  const buf = Buffer.from(raw, 'base64');
  const canon = buf.toString('base64').replace(/=+$/, '');
  if (canon !== body) throw new Error('Malformed base64 value.');
  return buf;
}

function pbkdf2(passwordBuf, saltBuf, iterations) {
  return crypto.pbkdf2Sync(passwordBuf, saltBuf, iterations, KEY_LENGTH_BYTES, 'sha256');
}

/**
 * Constant-time comparison of two equal-purpose buffers.
 * Length differences return false immediately; the derived-hash length is a
 * public constant (32 bytes), so this leaks nothing about the candidate.
 */
function safeEqual(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * @param {{ipcMain: Electron.IpcMain, win?: Electron.BrowserWindow, getWin?: () => Electron.BrowserWindow|null}} deps
 */
function register(deps) {
  const { ipcMain } = deps;
  const getWin = typeof deps.getWin === 'function' ? deps.getWin : () => deps.win || null;
  void getWin; // handlers below do not need the window; accepted for uniform registration shape.

  ipcMain.handle('pwhash:make', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const password = asString(p.password);
    if (!password) throw new Error('Enter a password first.');
    if (password.length > MAX_PASSWORD_CHARS) {
      throw new Error('That password is far longer than any passphrase needs to be (limit 1024 characters).');
    }
    let iterations = ITER_DEFAULT;
    if (p.iterations !== undefined) {
      iterations = Number(p.iterations);
      if (!Number.isInteger(iterations) || iterations < ITER_MIN || iterations > ITER_MAX) {
        throw new Error(`Iteration count must be an integer between ${ITER_MIN} and ${ITER_MAX}.`);
      }
    }
    const salt = crypto.randomBytes(SALT_LENGTH_BYTES);
    const hash = pbkdf2(Buffer.from(password, 'utf8'), salt, iterations);
    // Single structured result; the password itself is never returned or logged.
    return {
      ok: true,
      saltB64: salt.toString('base64'),
      iter: iterations,
      hashB64: hash.toString('base64'),
    };
  });

  ipcMain.handle('pwhash:verify', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const password = asString(p.password);
    if (!password) throw new Error('Enter the password to check.');
    if (password.length > MAX_PASSWORD_CHARS) {
      // Deliberately vague: same failure shape as a wrong guess.
      return { ok: true, match: false };
    }
    let salt;
    let stored;
    let iterations;
    try {
      salt = b64decodeStrict(p.saltB64);
      stored = b64decodeStrict(p.hashB64);
    } catch {
      throw new Error('Stored credential record is unreadable — remove the lock and create it again.');
    }
    if (salt.length < 8 || stored.length !== KEY_LENGTH_BYTES) {
      throw new Error('Stored credential record is unreadable — remove the lock and create it again.');
    }
    iterations = Number(p.iter);
    if (!Number.isInteger(iterations) || iterations < ITER_MIN || iterations > ITER_MAX) {
      throw new Error('Stored iteration count is out of range — remove the lock and create it again.');
    }
    const candidate = pbkdf2(Buffer.from(password, 'utf8'), salt, iterations);
    return { ok: true, match: safeEqual(candidate, stored) };
  });

  /**
   * app:paths — filesystem locations the recovery copy must name verbatim.
   * userData: this app's own data folder (deleting it resets every toy lock).
   * sharedDir: the cross-app shared records folder (%APPDATA%\material-roblox),
   * reported for display only — this file never creates or deletes it.
   */
  ipcMain.handle('app:paths', () => {
    const userData = app.getPath('userData');
    const sharedDir = path.join(app.getPath('appData'), 'material-roblox');
    return { ok: true, userData, sharedDir, platform: process.platform };
  });
}

module.exports = { register };
