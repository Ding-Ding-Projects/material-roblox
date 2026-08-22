#!/usr/bin/env node
/**
 * Guarantee the Electron binary exists after dependency installation.
 *
 * WHY THIS EXISTS: `node_modules/electron/install.js` can silently no-op on
 * some Node runtimes - it prints a cache hit, exits 0, and extracts NOTHING
 * (dist/ holds at most an empty locales folder and path.txt is missing).
 * Re-running it changes nothing. So every check here is EXISTENCE-BASED:
 * exit codes and progress are decided by whether the files are really on
 * disk, never by a child process's reported success.
 *
 * Recovery ladder:
 *   1. dist/electron.exe + path.txt present            -> done (exit 0)
 *   2. run install.js synchronously; re-check          -> done (exit 0)
 *   3. extract the matching zip from the @electron/get cache,
 *      verifying SHA-256 against electron's own checksums.json -> done (exit 0)
 *
 * Exit codes: 1 missing package/metadata, 2 checksum verification failure,
 * 3 extraction failure, 4 final size assertion failure.
 *
 * Requires devDependency: fflate.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const electronDir = path.join(projectRoot, 'node_modules', 'electron');

const IS_WINDOWS = process.platform === 'win32';
const EXE_NAME = IS_WINDOWS ? 'electron.exe' : 'electron';
const MIN_BINARY_BYTES = 50 * 1024 * 1024;

function log(message) {
  console.log('[ensure-electron] ' + message);
}

function fail(code, message) {
  console.error('[ensure-electron] FAILED (exit ' + code + '): ' + message);
  process.exit(code);
}

function binaryPresent() {
  const exePath = path.join(electronDir, 'dist', EXE_NAME);
  const pathTxt = path.join(electronDir, 'dist', 'path.txt');
  try {
    return fs.existsSync(exePath) && fs.statSync(exePath).size > 0 && fs.existsSync(pathTxt);
  } catch {
    return false;
  }
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Locate the newest cached zip for the exact declared version. */
function findCachedZip(version) {
  const candidates = [];
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'electron', 'Cache'));
  }
  candidates.push(path.join(os.homedir(), '.electron', 'Cache'));
  candidates.push(path.join(os.homedir(), '.cache', 'electron'));

  const prefix = 'electron-v' + version + '-';
  let best = null;
  let bestMtime = -1;
  for (const cacheRoot of candidates) {
    if (!fs.existsSync(cacheRoot)) continue;
    let subdirs = [];
    try {
      subdirs = fs.readdirSync(cacheRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of subdirs) {
      const dirPath = path.join(cacheRoot, entry.name);
      let files = [];
      try {
        files = fs.readdirSync(dirPath);
      } catch {
        continue;
      }
      for (const fileName of files) {
        if (!fileName.startsWith(prefix) || !fileName.endsWith('.zip')) continue;
        const filePath = path.join(dirPath, fileName);
        try {
          const mtime = fs.statSync(filePath).mtimeMs;
          if (mtime > bestMtime) {
            bestMtime = mtime;
            best = { filePath, fileName };
          }
        } catch {
          /* unreadable candidate is skipped */
        }
      }
    }
  }
  return best;
}

function verifyChecksum(zipPath, version, fileName) {
  const checksums = readJsonSafe(path.join(electronDir, 'checksums.json'));
  if (!checksums || typeof checksums !== 'object') {
    fail(2, "checksums.json is missing next to the electron package; refusing to use an unverified binary.");
  }
  const expected =
    checksums[fileName] ||
    checksums['./' + fileName] ||
    checksums['win32_x64/' + fileName];
  if (!expected || typeof expected !== 'string') {
    fail(2, 'No checksum recorded for "' + fileName + '" in checksums.json.');
  }
  const actual = createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
  if (actual.toLowerCase() !== String(expected).toLowerCase()) {
    fail(
      2,
      'SHA-256 mismatch for ' + fileName + ': expected ' + expected + ', got ' + actual +
        '. Delete the cached zip and reinstall.'
    );
  }
  log('Checksum verified: ' + fileName);
}

function extractZip(zipPath) {
  const distDir = path.join(electronDir, 'dist');
  let entries;
  try {
    const buffer = fs.readFileSync(zipPath);
    entries = unzipSync(buffer, { filter: (file) => !file.name.endsWith('/') });
  } catch (err) {
    fail(3, 'Could not read or unpack the cached archive: ' + (err && err.message));
  }

  const resolvedDist = path.resolve(distDir);
  for (const [name, data] of Object.entries(entries)) {
    const target = path.resolve(distDir, name);
    if (!target.startsWith(resolvedDist + path.sep) && target !== resolvedDist) {
      fail(3, 'Archive entry escapes the destination directory: ' + name);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(data));
    // Preserve the executable bit outside Windows where the mode bit matters.
    if (!IS_WINDOWS && !path.extname(name)) {
      try {
        fs.chmodSync(target, 0o755);
      } catch {
        /* best effort on filesystems without modes */
      }
    }
  }
  log('Extracted ' + Object.keys(entries).length + ' file(s) into dist/.');
}

function main() {
  log('Checking Electron binary...');

  if (binaryPresent()) {
    log('Binary already present. Nothing to do.');
    process.exit(0);
  }

  const pkg = readJsonSafe(path.join(electronDir, 'package.json'));
  if (!pkg || typeof pkg.version !== 'string') {
    fail(1, 'node_modules/electron/package.json is missing or unreadable. Run npm install first.');
  }
  const version = pkg.version;
  log('Electron declared version: ' + version);

  // Attempt 1: the package's own installer, run to completion synchronously.
  log('Phase 1: running electron/install.js...');
  const installResult = spawnSync(process.execPath, ['install.js'], {
    cwd: electronDir,
    stdio: 'inherit',
  });
  if (installResult.error) {
    log('install.js could not start: ' + installResult.error.message);
  }
  // Deliberately ignoring installResult.status: it has lied before (exit 0
  // with nothing extracted). Only the existence check below decides.
  if (binaryPresent()) {
    log('Binary present after install.js.');
    assertFinal();
    process.exit(0);
  }

  // Attempt 2: recover from the @electron/get download cache.
  log('Phase 2: install.js produced no binary (known silent no-op). Trying the local cache...');
  const cached = findCachedZip(version);
  if (!cached) {
    fail(
      1,
      'No cached archive found for electron-v' + version +
        '. Clear node_modules/electron and reinstall with network access.'
    );
  }
  log('Found cache: ' + cached.filePath);
  verifyChecksum(cached.filePath, version, cached.fileName);

  const distBefore = path.join(electronDir, 'dist');
  try {
    fs.rmSync(distBefore, { recursive: true, force: true });
    fs.mkdirSync(distBefore, { recursive: true });
    extractZip(cached.filePath);
  } catch (err) {
    fail(3, 'Extraction failed: ' + (err && err.message));
  }

  const pathTxt = path.join(electronDir, 'dist', 'path.txt');
  fs.writeFileSync(pathTxt, EXE_NAME);

  if (!binaryPresent()) {
    fail(3, 'Extraction finished but the binary is still not in place.');
  }

  assertFinal();
  process.exit(0);
}

function assertFinal() {
  const exePath = path.join(electronDir, 'dist', EXE_NAME);
  let size = 0;
  try {
    size = fs.statSync(exePath).size;
  } catch {
    fail(4, 'Final assertion failed: ' + EXE_NAME + ' does not exist.');
  }
  if (size < MIN_BINARY_BYTES) {
    fail(4, 'Final assertion failed: ' + EXE_NAME + ' is only ' + size + ' bytes.');
  }
  log('Verified: ' + exePath + ' (' + Math.round(size / (1024 * 1024)) + ' MB)');
}

main();
