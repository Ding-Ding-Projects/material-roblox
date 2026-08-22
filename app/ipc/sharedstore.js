'use strict';

/**
 * Shared cross-application settings record.
 *
 * A small JSON file in the user's shared application-data folder carries the
 * School-mode switch so every cooperating app sees the same state live:
 *   %APPDATA%/MaterialRobloxShared/school-mode.json
 *   { active: false, name: 'School mode', updatedAt: <ISO string> }
 *
 * Channels:
 *   sharedstore:read    {}                 -> record object
 *   sharedstore:write   { patch }          -> record object
 *
 * The file is watched; every change is pushed to all windows as a
 * 'sharedstore:changed' event carrying the fresh record (debounced 200 ms).
 * Credentials are never stored in this record.
 */

const { BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWriteFileSync, readJsonFileSync } = require('./_fsutil.js');

const DIR_NAME = 'MaterialRobloxShared';
const FILE_NAME = 'school-mode.json';
const DEBOUNCE_MS = 200;
const MAX_PATCH_JSON_BYTES = 4096;
const MAX_NAME_LENGTH = 100;

let watcher = null;
let debounceTimer = null;
let lastSentJson = '';

function sharedDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, DIR_NAME);
}

function sharedFilePath() {
  return path.join(sharedDir(), FILE_NAME);
}

function defaultRecord() {
  return {
    active: false,
    name: 'School mode',
    updatedAt: new Date(0).toISOString(),
  };
}

/** Coerce anything on disk into the bounded, known shape. */
function sanitizeRecord(raw) {
  const record = defaultRecord();
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (typeof raw.active === 'boolean') record.active = raw.active;
    if (typeof raw.name === 'string' && raw.name.trim()) {
      record.name = raw.name.trim().slice(0, MAX_NAME_LENGTH);
    }
  }
  return record;
}

function readRecord() {
  try {
    fs.mkdirSync(sharedDir(), { recursive: true });
  } catch {
    /* an unwritable shared folder is reported by the write path */
  }
  const raw = readJsonFileSync(sharedFilePath(), null);
  return sanitizeRecord(raw);
}

function writeRecord(patch) {
  const current = readRecord();
  const merged = sanitizeRecord({ ...current, ...patch });
  merged.updatedAt = new Date().toISOString();
  atomicWriteFileSync(sharedFilePath(), JSON.stringify(merged, null, 2));
  return merged;
}

function broadcast(record) {
  const json = JSON.stringify(record);
  lastSentJson = json;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('sharedstore:changed', record);
  }
}

function scheduleBroadcast() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    try {
      const record = readRecord();
      if (JSON.stringify(record) !== lastSentJson) broadcast(record);
    } catch (err) {
      console.warn('[sharedstore] Could not re-read the shared record:', err && err.message);
    }
  }, DEBOUNCE_MS);
}

function startWatching() {
  if (watcher) return;
  try {
    watcher = fs.watch(sharedDir(), (_event, fileName) => {
      // Windows sometimes reports null filenames; only skip definite misses.
      if (fileName && fileName !== FILE_NAME) return;
      scheduleBroadcast();
    });
    watcher.on('error', (err) => {
      console.warn('[sharedstore] Watcher error:', err && err.message);
      try {
        watcher.close();
      } catch {
        /* already closed */
      }
      watcher = null;
    });
  } catch (err) {
    console.warn('[sharedstore] Could not watch the shared folder:', err && err.message);
  }
}

exports.register = function register({ ipcMain }) {
  startWatching();

  ipcMain.handle('sharedstore:read', () => readRecord());

  ipcMain.handle('sharedstore:write', (_event, payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload.patch)) {
      throw new TypeError('Expected { patch } with an object.');
    }
    const patch = payload.patch;
    if (JSON.stringify(patch).length > MAX_PATCH_JSON_BYTES) {
      throw new Error('That change is too large for the shared record.');
    }
    const allowed = {};
    if (Object.prototype.hasOwnProperty.call(patch, 'active')) {
      if (typeof patch.active !== 'boolean') throw new TypeError('active must be true or false.');
      allowed.active = patch.active;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
      if (typeof patch.name !== 'string' || !patch.name.trim()) {
        throw new TypeError('name must be a non-empty string.');
      }
      allowed.name = patch.name.trim().slice(0, MAX_NAME_LENGTH);
    }
    if (Object.keys(allowed).length === 0) {
      throw new Error('Nothing recognizable to change. Only active and name are accepted.');
    }
    const record = writeRecord(allowed);
    broadcast(record);
    return record;
  });
};
