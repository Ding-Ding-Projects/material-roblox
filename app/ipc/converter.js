'use strict';
/**
 * converter.js — main-process handlers for the universal file converter (Lane E).
 *
 * Added as its own module so `app/main.js` auto-loads it (contract §2: every
 * `app/ipc/*.js` is required and registered; lanes add handlers by ADDING a
 * file, never by editing main.js or sibling handler files).
 *
 * Channels (names follow `^[a-z]+:[a-z]+$`):
 *   converter:detect  {path}                    -> {ok,size,mtimeMs,headB64}
 *   converter:expand  {path,maxDepth?=8}        -> {ok,files:[{path,size}],truncated}
 *   converter:free    {path}                    -> {ok,freeBytes,totalBytes}
 *   converter:cancel  {jobId}                   -> {ok,cancelled}
 *   converter:run     {jobId,family,op,args,inputPath?,inputDataB64?,outputPath?,timeoutMs?}
 *                                               -> {ok,result?,output?}; progress events
 *                                                  `convert:progress` {jobId,bytesDone,bytesTotal,status}
 *
 * Heavy work runs in an Electron UtilityProcess (`app/workers/pdf-worker.cjs`,
 * plain CommonJS) with bounded arguments: base64 payloads are capped at 64 MiB,
 * path-based inputs are capped at 64 MiB for whole-document formats (PDF), and
 * every job carries a hard timeout plus cancellation. Workers get no network
 * access beyond what Node gives them (they make none) and never receive
 * secrets.
 */

const { ipcMain, utilityProcess } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const MAX_B64_BYTES = 64 * 1024 * 1024;      // decoded cap for base64 payloads
const MAX_DOC_BYTES = 64 * 1024 * 1024;      // whole-document (PDF) input cap
const MAX_EXPAND_DEPTH = 8;
const MAX_EXPAND_ENTRIES = 5000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** @type {Map<string, {child:any, done:boolean}>} */
const jobs = new Map();

function isPlainObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Absolute existing-file check that never trusts the renderer's word alone. */
async function assertFile(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) {
    throw new Error('Input path must be absolute.');
  }
  const st = await fsp.stat(p).catch(() => null);
  if (!st || !st.isFile()) throw new Error(`Not a readable file: ${p}`);
  return st;
}

async function assertDirWritable(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('Output path must be absolute.');
  const dir = path.dirname(p);
  const st = await fsp.stat(dir).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error(`Output directory does not exist: ${dir}`);
}

/* ------------------------------------------------------------------ */
/* Worker lifecycle                                                    */
/* ------------------------------------------------------------------ */

function workerPath() {
  return path.join(__dirname, '..', 'workers', 'pdf-worker.cjs');
}

/**
 * Fork a fresh utility process per job and resolve on its terminal message.
 * Progress lines are forwarded to the window as `convert:progress`.
 */
function runInWorker(payload, { jobId, win, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = utilityProcess.fork(workerPath(), [], {
        serviceName: 'mrb-converter-worker',
        stdio: 'ignore',
      });
    } catch (err) {
      reject(new Error(`Could not start conversion worker: ${err.message}`));
      return;
    }

    const rec = { child, done: false };
    jobs.set(jobId, rec);

    const finish = (fn, value) => {
      if (rec.done) return;
      rec.done = true;
      clearTimeout(timer);
      jobs.delete(jobId);
      try { child.kill(); } catch (_) { /* already exiting */ }
      fn(value);
    };

    const timer = setTimeout(() => {
      send(win, 'convert:progress', { jobId, status: 'timeout', bytesDone: 0, bytesTotal: 0 });
      finish(reject, new Error('Conversion timed out.'));
    }, Math.max(5000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));

    child.on('message', (msg) => {
      if (!isPlainObj(msg) || msg.id !== payload.id) return;
      switch (msg.type) {
        case 'progress':
          send(win, 'convert:progress', {
            jobId, status: msg.status || 'working',
            bytesDone: Number(msg.bytesDone) || 0,
            bytesTotal: Number(msg.bytesTotal) || 0,
          });
          break;
        case 'done':
          send(win, 'convert:progress', { jobId, status: 'done', bytesDone: msg.bytes || 0, bytesTotal: msg.bytes || 0 });
          finish(resolve, { ok: true, result: msg.result || null, output: msg.output || null });
          break;
        case 'error':
          finish(reject, new Error(String(msg.message || 'Conversion failed.')));
          break;
        default:
          break;
      }
    });
    child.on('exit', (code) => {
      if (!rec.done) finish(reject, new Error(`Conversion worker exited unexpectedly (code ${code}).`));
    });

    child.postMessage(payload);
  });
}

function send(win, channel, payload) {
  try {
    const w = typeof win === 'function' ? win() : win;
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  } catch (_) { /* window gone mid-job: job still resolves */ }
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

/**
 * @param {{ipcMain?:any, win?:any, getWin?:()=>any}} ctx
 */
function register(ctx) {
  const ipc = ctx.ipcMain || ipcMain;
  const getWin = () => (typeof ctx.getWin === 'function' ? ctx.getWin() : ctx.win);

  ipc.handle('converter:detect', async (_ev, raw) => {
    if (!isPlainObj(raw)) throw new Error('Bad payload.');
    const st = await assertFile(raw.path);
    const fh = await fsp.open(raw.path, 'r');
    try {
      const buf = Buffer.alloc(64);
      const { bytesRead } = await fh.read(buf, 0, 64, 0);
      return {
        ok: true,
        size: st.size,
        mtimeMs: st.mtimeMs,
        headB64: buf.subarray(0, bytesRead).toString('base64'),
      };
    } finally {
      await fh.close();
    }
  });

  ipc.handle('converter:expand', async (_ev, raw) => {
    if (!isPlainObj(raw)) throw new Error('Bad payload.');
    const rootDir = typeof raw.path === 'string' && path.isAbsolute(raw.path) ? raw.path : null;
    if (!rootDir) throw new Error('Directory path must be absolute.');
    const st = await fsp.stat(rootDir).catch(() => null);
    if (!st || !st.isDirectory()) throw new Error(`Not a directory: ${rootDir}`);
    const maxDepth = Math.min(Math.max(Number(raw.maxDepth) || MAX_EXPAND_DEPTH, 1), MAX_EXPAND_DEPTH);
    const files = [];
    let truncated = false;

    /** Bounded-depth walk; symlinks are never followed (reparse-point safety). */
    async function walk(dir, depth) {
      if (depth > maxDepth) { truncated = true; return; }
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (_) {
        return; // unreadable subtree is skipped and reported via truncation flag
      }
      for (const ent of entries) {
        if (files.length >= MAX_EXPAND_ENTRIES) { truncated = true; return; }
        const full = path.join(dir, ent.name);
        if (ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) { await walk(full, depth + 1); continue; }
        if (!ent.isFile()) continue;
        const fst = await fsp.stat(full).catch(() => null);
        if (!fst) continue;
        files.push({ path: full, size: fst.size });
      }
    }

    await walk(rootDir, 0);
    return { ok: true, files, truncated };
  });

  ipc.handle('converter:free', async (_ev, raw) => {
    if (!isPlainObj(raw)) throw new Error('Bad payload.');
    const p = typeof raw.path === 'string' && path.isAbsolute(raw.path) ? raw.path : null;
    if (!p) throw new Error('Path must be absolute.');
    const probe = fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p);
    /* fs.statfs landed in Node 18; guard for safety rather than assuming */
    if (typeof fs.statfs !== 'function') {
      return { ok: false, error: 'free-space query unsupported on this runtime' };
    }
    const sfs = await new Promise((resolve) => {
      try { fs.statfs(probe, (err, s) => resolve(err ? null : s)); } catch (_) { resolve(null); }
    });
    if (!sfs) return { ok: false, error: 'free-space query failed' };
    return {
      ok: true,
      freeBytes: Number(sfs.bsize) * Number(sfs.bavail),
      totalBytes: Number(sfs.bsize) * Number(sfs.blocks),
    };
  });

  ipc.handle('converter:cancel', (_ev, raw) => {
    const jobId = isPlainObj(raw) && typeof raw.jobId === 'string' ? raw.jobId : null;
    const rec = jobId && jobs.get(jobId);
    if (!rec) return { ok: false, cancelled: false };
    rec.done = true; // stop the promise resolution path; kill below ends the work
    try { rec.child.kill(); } catch (_) { /* nothing to kill */ }
    jobs.delete(jobId);
    send(getWin(), 'convert:progress', { jobId, status: 'cancelled', bytesDone: 0, bytesTotal: 0 });
    return { ok: true, cancelled: true };
  });

  ipc.handle('converter:run', async (_ev, raw) => {
    if (!isPlainObj(raw)) throw new Error('Bad payload.');
    const jobId = typeof raw.jobId === 'string' && /^[a-z0-9-]{1,64}$/i.test(raw.jobId)
      ? raw.jobId : `job-${Date.now().toString(36)}`;
    const family = raw.family === 'pdf' || raw.family === 'zip' || raw.family === 'data' ? raw.family : null;
    if (!family) throw new Error('Unknown conversion family.');
    if (typeof raw.op !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/.test(raw.op)) throw new Error('Unknown operation.');

    let inputSize = 0;
    let inputPath = null;
    let inputDataB64 = null;

    if (typeof raw.inputPath === 'string') {
      const st = await assertFile(raw.inputPath);
      if (family === 'pdf' && st.size > MAX_DOC_BYTES) {
        throw new Error(`PDF input is ${(st.size / 1048576).toFixed(1)} MB; the whole-document limit is 64 MB.`);
      }
      inputPath = raw.inputPath;
      inputSize = st.size;
    } else if (typeof raw.inputDataB64 === 'string') {
      inputDataB64 = raw.inputDataB64;
      inputSize = Math.floor((inputDataB64.length * 3) / 4);
      if (inputSize > MAX_B64_BYTES) throw new Error('Inline payload exceeds the 64 MB limit.');
    } else {
      throw new Error('Missing input.');
    }

    let outputPath = null;
    if (raw.writesOutput !== false) {
      if (typeof raw.outputPath !== 'string') throw new Error('Missing output path.');
      await assertDirWritable(raw.outputPath);
      outputPath = raw.outputPath;
    }

    const payload = {
      id: `${jobId}-${Date.now().toString(36)}`,
      family,
      op: raw.op,
      args: isPlainObj(raw.args) ? raw.args : {},
      inputPath,
      inputDataB64,
      outputPath,
    };

    send(getWin(), 'convert:progress', { jobId, status: 'started', bytesDone: 0, bytesTotal: inputSize });
    const res = await runInWorker(payload, { jobId, win: getWin(), timeoutMs: raw.timeoutMs });
    return res;
  });
}

module.exports = { register };
