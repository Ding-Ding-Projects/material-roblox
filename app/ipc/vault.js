'use strict';

/**
 * OS-encrypted secret store over Electron safeStorage.
 *
 * Layout: userData/vault.bin holding
 *   { "<service>": { "<key>": "<base64 safeStorage ciphertext>" } }
 *
 * Channels:
 *   vault:get     { service, key }            -> string | null
 *   vault:set     { service, key, value }     -> { ok: true }
 *   vault:delete  { service, key }            -> { ok: true }
 *   vault:list    { service }                 -> string[]   (keys only)
 *
 * Hard rules enforced here:
 *   - If OS credential encryption is unavailable the handlers REFUSE with an
 *     honest error; there is no plain-text fallback.
 *   - Secret values are never logged and never included in error messages.
 *   - Writes are atomic (temp + rename with transient-error retry).
 *
 * readSecret() is exported for sibling handler modules that need a secret as
 * input to their own work (net.js auth headers); it is not a renderer channel.
 */

const { app, ipcMain, safeStorage } = require('electron');
const path = require('path');
const { atomicWriteFileSync, readJsonFileSync } = require('./_fsutil.js');

const SELECTOR_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_VALUE_CHARS = 65536;

let writeChain = Promise.resolve();

function assertEncryption() {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS credential encryption unavailable. Secrets are refused rather than stored in plain text.'
    );
  }
}

function assertSelector(value, label) {
  if (typeof value !== 'string' || !SELECTOR_PATTERN.test(value)) {
    throw new TypeError(label + ' must be 1-128 letters, digits, dots, dashes, colons or underscores.');
  }
}

function vaultFilePath() {
  return path.join(app.getPath('userData'), 'vault.bin');
}

function readStore() {
  const raw = readJsonFileSync(vaultFilePath(), null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw;
}

/** Serialize mutating work so concurrent calls cannot clobber each other. */
function enqueue(operation) {
  const run = writeChain.then(operation, operation);
  writeChain = run.catch(() => {});
  return run;
}

function persist(store) {
  atomicWriteFileSync(vaultFilePath(), JSON.stringify(store, null, 2));
}

/**
 * Internal-only secret reader. Returns the decrypted value or null when the
 * entry does not exist. Never throws on missing entries; throws honestly when
 * encryption is unavailable or the stored blob cannot be decrypted here.
 */
async function readSecret(service, key) {
  assertSelector(service, 'service');
  assertSelector(key, 'key');
  assertEncryption();
  const store = readStore();
  const bucket = store[service];
  if (!bucket || typeof bucket !== 'object') return null;
  const encoded = bucket[key];
  if (typeof encoded !== 'string' || !encoded) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch {
    throw new Error('A stored secret could not be decrypted on this machine.');
  }
}

exports.readSecret = readSecret;

exports.register = function register({ ipcMain }) {
  ipcMain.handle('vault:get', (_event, payload) =>
    enqueue(async () => {
      if (!payload || typeof payload !== 'object') throw new TypeError('Expected { service, key }.');
      assertSelector(payload.service, 'service');
      assertSelector(payload.key, 'key');
      assertEncryption();
      const value = await readSecret(payload.service, payload.key);
      return value === null ? null : String(value);
    })
  );

  ipcMain.handle('vault:set', (_event, payload) =>
    enqueue(async () => {
      if (!payload || typeof payload !== 'object') {
        throw new TypeError('Expected { service, key, value }.');
      }
      assertSelector(payload.service, 'service');
      assertSelector(payload.key, 'key');
      if (typeof payload.value !== 'string') {
        throw new TypeError('value must be a string.');
      }
      if (payload.value.length > MAX_VALUE_CHARS) {
        throw new Error('That secret is too large to store.');
      }
      assertEncryption();
      const store = readStore();
      const bucket =
        typeof store[payload.service] === 'object' && store[payload.service] !== null
          ? store[payload.service]
          : {};
      bucket[payload.key] = safeStorage.encryptString(payload.value).toString('base64');
      store[payload.service] = bucket;
      persist(store);
      return { ok: true };
    })
  );

  ipcMain.handle('vault:delete', (_event, payload) =>
    enqueue(async () => {
      if (!payload || typeof payload !== 'object') throw new TypeError('Expected { service, key }.');
      assertSelector(payload.service, 'service');
      assertSelector(payload.key, 'key');
      const store = readStore();
      const bucket = store[payload.service];
      if (bucket && typeof bucket === 'object' && Object.prototype.hasOwnProperty.call(bucket, payload.key)) {
        delete bucket[payload.key];
        if (Object.keys(bucket).length === 0) delete store[payload.service];
        persist(store);
      }
      return { ok: true };
    })
  );

  ipcMain.handle('vault:list', (_event, payload) => {
    if (!payload || typeof payload !== 'object') throw new TypeError('Expected { service }.');
    assertSelector(payload.service, 'service');
    // Listing never decrypts and never returns values - keys only.
    const store = readStore();
    const bucket = store[payload.service];
    if (!bucket || typeof bucket !== 'object') return [];
    return Object.keys(bucket).sort();
  });
};
