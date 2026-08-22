'use strict';

/**
 * Small filesystem helpers shared by the IPC handler modules.
 *
 * Files whose names start with "_" are helper modules, not handlers:
 * main.js deliberately skips them when it auto-registers app/ipc/*.js.
 */

const fs = require('fs');
const path = require('path');

/** Windows sharing violations that a short retry genuinely clears. */
const TRANSIENT_WRITE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const WRITE_ATTEMPTS = 5;
const WRITE_RETRY_MS = 300;

/** Blocking sleep for the retry loop; the pauses are milliseconds long. */
function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function isTransientWriteError(err) {
  return Boolean(err && typeof err === 'object' && TRANSIENT_WRITE_CODES.has(err.code));
}

/**
 * Atomic write: unique temp file in the destination directory, then rename.
 * The rename is retried briefly on EPERM/EACCES/EBUSY because antivirus,
 * search indexing, sync clients and sibling writers routinely hold the
 * destination open for a few milliseconds on Windows. Every attempt is a
 * complete indivisible rename, so retrying never tears a write.
 */
function atomicWriteFileSync(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    '.' + path.basename(filePath) + '.' + process.pid + '.' + Date.now() + '.tmp'
  );
  let lastError = null;
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, filePath);
      return;
    } catch (err) {
      lastError = err;
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* the temp file may not exist yet; nothing to clean */
      }
      if (!isTransientWriteError(err) || attempt === WRITE_ATTEMPTS) {
        break;
      }
      sleepSync(WRITE_RETRY_MS);
    }
  }
  throw lastError;
}

/** Read a JSON file, returning `fallback` for missing or malformed files. */
function readJsonFileSync(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

module.exports = {
  atomicWriteFileSync,
  readJsonFileSync,
  sleepSync,
  isTransientWriteError,
};
