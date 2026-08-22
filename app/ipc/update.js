'use strict';
/**
 * update.js — Chrome-style auto-update plumbing (Lane E).
 *
 * Feed: the GitHub Releases API for this repository, reached through Electron's
 * net module (the repo allowlist already covers api.github.com for this
 * project). The feed is UNSIGNED by policy — signing is permanently out of
 * scope — and every surface says so; nothing here claims signature validity.
 *
 * Channels:
 *   update:info     {}                       -> {version, platform, state, ...}
 *   update:check    {}                       -> {ok, state, latest?, notesUrl?}
 *   update:download {assetUrl?}              -> streams to userData/updates,
 *                                               emits `update:progress`
 *   update:restart  {}                       -> spawns the staged Setup.exe /S
 *                                               detached, then quits the app.
 *
 * Failure is never hidden behind a spinner: every terminal condition resolves
 * into a named state (failed + reason / offline) that the renderer card shows.
 * Staged installers older than 7 days are cleaned up on quit without restart.
 */

const { ipcMain, app, net } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const REPO_LATEST = 'https://api.github.com/repos/Ding-Ding-Projects/material-roblox/releases/latest';
const ASSET_RE = /^MaterialRoblox.*\.exe$/i;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const STALE_STAGE_MS = 7 * 24 * 60 * 60 * 1000;

/** @type {{phase:string, version?:string, notesUrl?:string, assetName?:string,
            assetUrl?:string, bytesDone:number, bytesTotal:number, file?:string,
            sha256?:string, error?:string, lastChecked?:string}} */
let state = {
  phase: 'upToDate', // upToDate|checking|available|downloading|readyToRestart|failed|offline
  bytesDone: 0,
  bytesTotal: 0,
};

function updatesDir() {
  return path.join(app.getPath('userData'), 'updates');
}

function send(getWin, channel, payload) {
  try {
    const w = typeof getWin === 'function' ? getWin() : getWin;
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  } catch (_) { /* window gone */ }
}

function setState(patch, getWin) {
  state = { ...state, ...patch };
  send(getWin, 'update:state', publicState());
}

function publicState() {
  const { phase, version, notesUrl, assetName, bytesDone, bytesTotal, sha256, error, lastChecked } = state;
  return { phase, version, notesUrl, assetName, bytesDone, bytesTotal, sha256, error, lastChecked };
}

/* ------------------------------------------------------------------ */
/* check                                                               */
/* ------------------------------------------------------------------ */

function fetchLatest() {
  return new Promise((resolve, reject) => {
    const req = net.request(REPO_LATEST);
    req.setHeader('Accept', 'application/vnd.github+json');
    req.setHeader('User-Agent', 'MaterialRoblox-Updater');
    const timer = setTimeout(() => { try { req.abort(); } catch (_) {} reject(new Error('release lookup timed out')); }, 15000);
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        res.resume();
        reject(new Error(`release lookup returned HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(new Error(`bad release payload: ${err.message}`));
        }
      });
      res.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
    req.end();
  });
}

/**
 * Compare dotted numeric versions after stripping a leading v and any build
 * suffix ("1.2.3-beta.4+build.9" -> [1,2,3] with prerelease flag).
 */
function semverParts(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function isNewer(candidate, current) {
  const a = semverParts(candidate);
  const b = semverParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

async function doCheck(getWin) {
  setState({ phase: 'checking' }, getWin);
  let rel;
  try {
    rel = await fetchLatest();
  } catch (err) {
    /* offline keeps the LAST known good state silently — never fakes success */
    setState({ phase: 'offline', error: String(err.message || err), lastChecked: new Date().toISOString() }, getWin);
    return { ok: false, state: publicState() };
  }
  const tag = typeof rel.tag_name === 'string' ? rel.tag_name : '';
  const draft = !!rel.draft;
  const prerelease = !!rel.prerelease;
  if (!tag || draft) {
    setState({ phase: 'upToDate', lastChecked: new Date().toISOString() }, getWin);
    return { ok: true, state: publicState() };
  }
  const newer = isNewer(tag, app.getVersion());
  if (!newer || prerelease) {
    setState({ phase: 'upToDate', version: tag, lastChecked: new Date().toISOString() }, getWin);
    return { ok: true, state: publicState() };
  }

  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const asset = assets.find((a) => ASSET_RE.test(String(a.name || '')));
  setState({
    phase: 'available',
    version: tag,
    notesUrl: typeof rel.html_url === 'string' ? rel.html_url : REPO_LATEST.replace('/releases/latest', '/releases'),
    assetName: asset ? asset.name : undefined,
    assetUrl: asset ? asset.browser_download_url : undefined,
    assetDigest: asset && typeof asset.digest === 'string' ? asset.digest : undefined,
    bytesTotal: asset ? Number(asset.size) || 0 : 0,
    lastChecked: new Date().toISOString(),
  }, getWin);
  return { ok: true, state: publicState(), updateAvailable: true };
}

/* ------------------------------------------------------------------ */
/* download                                                            */
/* ------------------------------------------------------------------ */

function downloadAsset(getWin) {
  return new Promise((resolve) => {
    if (!state.assetUrl) {
      resolve({ ok: false, error: 'no staged asset URL — run check first' });
      return;
    }
    const dir = updatesDir();
    fs.mkdirSync(dir, { recursive: true });
    // The name comes from a release API response: reduce it to a safe file
    // component so it can never traverse or smuggle characters into a path.
    const safeName = String(state.assetName || 'MaterialRobloxSetup.exe').replace(/[^A-Za-z0-9._-]/g, '_');
    const dest = path.join(dir, safeName);
    const tmp = `${dest}.part-${process.pid}`;
    const hash = crypto.createHash('sha256');
    const ws = fs.createWriteStream(tmp);

    setState({ phase: 'downloading', bytesDone: 0, file: dest }, getWin);
    let lastEmit = 0;

    const req = net.request(state.assetUrl); // release-asset hosts are in the repo allowlist
    const timer = setTimeout(() => { try { req.abort(); } catch (_) {} fail(new Error('download timed out')); }, 30 * 60 * 1000);
    let settled = false;
    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      fs.unlink(tmp, () => {});
      setState({ phase: 'failed', error: String(err.message || err) }, getWin);
      resolve({ ok: false, error: String(err.message || err) });
    }

    req.on('response', async (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // net follows redirects automatically; an explicit location here means
        // something unusual happened — treat as failure rather than loop.
        fail(new Error(`unexpected redirect (${res.statusCode})`));
        return;
      }
      if (res.statusCode !== 200) {
        fail(new Error(`asset download returned HTTP ${res.statusCode}`));
        return;
      }
      const total = Number(res.headers['content-length']) || state.bytesTotal || 0;
      setState({ bytesTotal: total }, getWin);
      res.on('data', (chunk) => {
        hash.update(chunk);
        ws.write(chunk, () => {});
        state.bytesDone += chunk.length;
        if (state.bytesDone > MAX_DOWNLOAD_BYTES) {
          fail(new Error(`download exceeded the ${MAX_DOWNLOAD_BYTES / 1048576} MB safety cap`));
          return;
        }
        const now = Date.now();
        if (now - lastEmit > 250) {
          lastEmit = now;
          send(getWin, 'update:progress', { bytesDone: state.bytesDone, bytesTotal: total });
        }
      });
      res.on('end', () => {
        ws.end(() => {
          if (settled) return;
          const digest = hash.digest('hex');
          const size = state.bytesDone;
          if (total && Math.abs(size - total) > 4096) {
            fail(new Error(`truncated download (${size} of ${total} bytes)`));
            return;
          }
          // Verify against GitHub's published digest when the API supplied one.
          if (state.assetDigest) {
            const expected = String(state.assetDigest).replace(/^sha256:/i, '').toLowerCase();
            if (expected && digest !== expected) {
              fail(new Error('SHA-256 mismatch against the release digest — download discarded.'));
              return;
            }
          }
          fs.renameSync(tmp, dest); // same directory: atomic on completion
          setState({
            phase: 'readyToRestart',
            sha256: digest,
            bytesDone: size,
            bytesTotal: total || size,
          }, getWin);
          send(getWin, 'update:progress', { bytesDone: size, bytesTotal: total || size });
          settled = true;
          clearTimeout(timer);
          resolve({ ok: true, file: dest, sha256: digest, bytes: size });
        });
      });
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* restart + cleanup                                                   */
/* ------------------------------------------------------------------ */

function spawnInstallerThenQuit() {
  if (state.phase !== 'readyToRestart' || !state.file || !fs.existsSync(state.file)) {
    return { ok: false, reason: 'nothing staged' };
  }
  try {
    const { spawn } = require('child_process');
    const child = spawn(state.file, ['/S'], {
      cwd: path.dirname(state.file),
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    child.unref();
    setTimeout(() => app.quit(), 400); // let the detached installer take the baton
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err.message || err) };
  }
}

async function cleanupStaleStages() {
  const dir = updatesDir();
  try {
    const entries = await fsp.readdir(dir).catch(() => []);
    const now = Date.now();
    for (const name of entries) {
      if (!ASSET_RE.test(name)) continue;
      const full = path.join(dir, name);
      const st = await fsp.stat(full).catch(() => null);
      if (st && now - st.mtimeMs > STALE_STAGE_MS) {
        await fsp.unlink(full).catch(() => {});
      }
    }
  } catch (_) { /* best-effort housekeeping */ }
}

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

/**
 * @param {{ipcMain?:any, win?:any, getWin?:()=>any}} ctx
 */
function register(ctx) {
  const ipc = ctx.ipcMain || ipcMain;
  const getWin = () => (typeof ctx.getWin === 'function' ? ctx.getWin() : ctx.win);

  ipc.handle('update:info', () => ({
    ok: true,
    version: app.getVersion(),
    platform: process.platform,
    state: publicState(),
  }));

  ipc.handle('update:check', async () => doCheck(getWin()));
  ipc.handle('update:download', async () => {
    if (state.phase !== 'available') return { ok: false, error: `cannot download from phase "${state.phase}"` };
    return downloadAsset(getWin());
  });

  ipc.handle('update:restart', () => {
    /* Unsaved-work protection lives renderer-side ('mrb-unsaved-guard'); main
       only refuses when there is genuinely nothing staged. */
    return spawnInstallerThenQuit();
  });

  app.whenReady().then(() => { cleanupStaleStages(); });
}

module.exports = { register };
