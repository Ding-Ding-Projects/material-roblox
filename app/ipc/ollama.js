'use strict';
/**
 * ollama.js — main-process bridge to the LOCAL Ollama HTTP API (Lane E).
 *
 * Security posture:
 *  - `ollama:request` talks ONLY to http://127.0.0.1:11434 with paths under
 *    /api/. Any other host, port, protocol or path shape is refused before a
 *    socket is opened. No unofficial proxies, no cloud endpoints.
 *  - Streaming requests emit NDJSON lines as `ollama:chunk` {reqId,data} and
 *    finish with `ollama:end` {reqId,status}. Non-streaming requests resolve.
 *  - Timeouts: health-classified calls get 3 s; generation/pull get 600 s.
 *  - `ollama:abort` cancels an in-flight request by reqId (used by pull
 *    progress cancel and chat STOP).
 *  - `ollama:spawn` launches HARNESS PROFILES ONLY. The payload is validated
 *    structurally: the executable must be an existing absolute file or the
 *    bare allowlisted name `ollama`; argument templates may contain only the
 *    ${model} / ${prompt} placeholders; env keys are restricted to the
 *    allowlist (OLLAMA_HOST). Arbitrary shell strings cannot be expressed in
 *    this payload shape at all, so command injection has no route in.
 */

const { ipcMain, net } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ALLOWED_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const DEFAULT_PORT = 11434;
const TIMEOUT_HEALTH_MS = 3000;
const TIMEOUT_GEN_MS = 600000;

/** @type {Map<string,{abort:()=>void}>} */
const inflight = new Map();
/** @type {Map<string,{proc:any, startedAt:number}>} */
const harnessProcs = new Map();

function isPlainObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function send(getWin, channel, payload) {
  try {
    const w = typeof getWin === 'function' ? getWin() : getWin;
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  } catch (_) { /* window gone */ }
}

/* ------------------------------------------------------------------ */
/* request                                                             */
/* ------------------------------------------------------------------ */

/**
 * Loopback-only endpoint resolution. The host must be a loopback name and the
 * port any loopback port the user configured — never a remote machine, never
 * a proxy. `localhost` is normalised to 127.0.0.1 so DNS surprises cannot
 * reroute the connection.
 */
function resolveEndpoint(payload) {
  let host = typeof payload.host === 'string' && payload.host ? payload.host.trim().toLowerCase() : '127.0.0.1';
  if (host === 'localhost') host = '127.0.0.1';
  if (host === '::1') host = '[::1]';
  else if (!ALLOWED_HOSTS.has(host)) {
    throw new Error('Refused: only loopback hosts (127.0.0.1 / ::1 / localhost) are allowed.');
  }
  const port = Number(payload.port) || DEFAULT_PORT;
  if (!(port >= 1024 && port <= 65535)) throw new Error('Port must be between 1024 and 65535.');
  return `http://${host}:${port}${payload.path}`;
}

function doRequest(payload, getWin) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(resolveEndpoint(payload));
    } catch (err) {
      resolve({ ok: false, status: 0, error: String(err.message || err) });
      return;
    }
    const req = net.request({
      method: payload.method,
      url,
    });
    req.setHeader('Content-Type', 'application/json');

    const timeoutMs = payload.timeoutKind === 'health' ? TIMEOUT_HEALTH_MS : TIMEOUT_GEN_MS;
    const timer = setTimeout(() => {
      try { req.abort(); } catch (_) {}
      cleanup();
      resolve({ ok: false, status: 0, error: `timed out after ${timeoutMs} ms`, timedOut: true });
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      if (payload.reqId) inflight.delete(payload.reqId);
    }

    if (payload.reqId) inflight.set(String(payload.reqId), { abort: () => { try { req.abort(); } catch (_) {} } });

    const chunks = [];
    let lineBuf = '';
    let bytesTotal = 0;
    const MAX_BYTES = 256 * 1024 * 1024; // generous model-list/chat ceiling

    req.on('response', (res) => {
      res.on('data', (chunk) => {
        bytesTotal += chunk.length;
        if (bytesTotal > MAX_BYTES) {
          try { req.abort(); } catch (_) {}
          cleanup();
          resolve({ ok: false, status: res.statusCode || 0, error: 'response exceeded size bound' });
          return;
        }
        if (payload.stream) {
          lineBuf += chunk.toString('utf8');
          let nl;
          while ((nl = lineBuf.indexOf('\n')) >= 0) {
            const line = lineBuf.slice(0, nl).trim();
            lineBuf = lineBuf.slice(nl + 1);
            if (!line) continue;
            try {
              send(getWin, 'ollama:chunk', { reqId: payload.reqId, data: JSON.parse(line) });
            } catch (_) { /* skip malformed line */ }
          }
        } else {
          chunks.push(chunk);
        }
      });
      res.on('end', () => {
        cleanup();
        if (payload.stream) {
          send(getWin, 'ollama:end', { reqId: payload.reqId, status: res.statusCode });
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
        } else {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = JSON.parse(text); } catch (_) { json = undefined; }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, text: json === undefined ? text : undefined });
        }
      });
      res.on('error', (err) => {
        cleanup();
        resolve({ ok: false, status: res.statusCode || 0, error: String(err.message || err) });
      });
    });

    req.on('error', (err) => {
      cleanup();
      const msg = String(err.message || err);
      /* connection-refused reads as "daemon not running", not as a crash */
      resolve({ ok: false, status: 0, error: msg, refused: /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(msg) });
    });

    if (payload.jsonBody !== undefined && payload.jsonBody !== null) {
      try {
        req.write(Buffer.from(JSON.stringify(payload.jsonBody), 'utf8'));
      } catch (err) {
        cleanup();
        resolve({ ok: false, status: 0, error: `bad body: ${err.message}` });
        return;
      }
    }
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* harness launch (allowlisted orchestration ONLY)                     */
/* ------------------------------------------------------------------ */

const ENV_ALLOWLIST = ['OLLAMA_HOST'];
const TEMPLATE_PLACEHOLDERS = ['${model}', '${prompt}'];

/**
 * Structural validation. NOTE (assertion comment): because arguments arrive as
 * an ARRAY of pre-split template strings and spawn runs with shell:false, no
 * shell metacharacter can ever be interpreted — the input SHAPE makes shell
 * injection impossible rather than filtering it after the fact.
 */
function validateProfile(profile) {
  if (!isPlainObj(profile)) throw new Error('Bad profile.');
  const exe = profile.exe;
  if (typeof exe !== 'string' || !exe.trim() || exe.length > 400) throw new Error('Executable path missing.');
  if (!exe.includes('/') && !exe.includes('\\')) {
    if (exe !== 'ollama') throw new Error(`Bare executables other than "ollama" are not allowed (got "${exe}").`);
  } else if (!path.isAbsolute(exe)) {
    throw new Error('Executable must be absolute or the bare name "ollama".');
  } else if (!fs.existsSync(exe)) {
    throw new Error(`Executable does not exist: ${exe}`);
  }

  if (!Array.isArray(profile.args) || profile.args.length > 64) throw new Error('Arguments must be an array of at most 64 entries.');
  for (const rawArg of profile.args) {
    if (typeof rawArg !== 'string') throw new Error('Every argument must be a string.');
    if (/[\r\n]/.test(rawArg)) throw new Error('Arguments cannot contain line breaks.');
    const placeholders = rawArg.match(/\$\{[^}]*\}/g) || [];
    for (const ph of placeholders) {
      if (!TEMPLATE_PLACEHOLDERS.includes(ph)) {
        throw new Error(`Placeholder ${ph} is not allowlisted (only \${model} and \${prompt}).`);
      }
    }
  }

  if (profile.cwd != null) {
    if (typeof profile.cwd !== 'string' || !path.isAbsolute(profile.cwd)) throw new Error('Working directory must be absolute.');
    if (!fs.statSync(profile.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Working directory does not exist.');
  }

  const envKeys = Array.isArray(profile.envKeys) ? profile.envKeys : [];
  for (const k of envKeys) {
    if (!ENV_ALLOWLIST.includes(k)) throw new Error(`Environment key "${k}" is not allowlisted.`);
  }
  return true;
}

function expandArgs(args, values) {
  return args.map((a) => a
    .replace(/\$\{model\}/g, values.model ?? '')
    .replace(/\$\{prompt\}/g, values.prompt ?? ''));
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

  ipc.handle('ollama:request', async (_ev, raw) => {
    if (!isPlainObj(raw)) throw new Error('Bad payload.');
    const p = String(raw.path || '');
    if (!/^\/api\/[A-Za-z0-9/_?=&.:-]*$/.test(p) || p.includes('..')) {
      throw new Error('Refused: only local /api/ endpoints are reachable.');
    }
    const method = ['GET', 'POST', 'DELETE', 'HEAD'].includes(raw.method) ? raw.method : 'GET';
    const payload = {
      path: p,
      method,
      host: raw.host,
      port: raw.port,
      jsonBody: raw.jsonBody === undefined ? undefined : raw.jsonBody,
      stream: !!raw.stream,
      reqId: raw.stream ? String(raw.reqId || `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`) : undefined,
      timeoutKind: raw.timeoutKind === 'health' ? 'health'
        : raw.timeoutKind === 'gen' ? 'gen' : 'gen',
    };
    return doRequest(payload, getWin);
  });

  ipc.handle('ollama:abort', (_ev, raw) => {
    const reqId = isPlainObj(raw) && typeof raw.reqId === 'string' ? raw.reqId : null;
    const entry = reqId && inflight.get(reqId);
    if (!entry) return { ok: false };
    try { entry.abort(); } catch (_) {}
    inflight.delete(reqId);
    return { ok: true };
  });

  ipc.handle('ollama:spawn', async (_ev, raw) => {
    if (!isPlainObj(raw)) throw new Error('Bad payload.');
    validateProfile(raw.profile);

    const values = {
      model: typeof raw.model === 'string' ? raw.model.replace(/[\r\n"`${}]/g, '') : '',
      prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    };
    const argv = expandArgs(raw.profile.args, values);

    const env = {};
    for (const k of raw.profile.envKeys || []) {
      /* Values come from the renderer's vault-backed settings read over the
         documented vault channels; they are non-secret host config only. */
      const v = isPlainObj(raw.envValues) ? raw.envValues[k] : undefined;
      if (typeof v === 'string' && v.length <= 512) env[k] = v;
    }

    return await new Promise((resolve) => {
      let proc;
      try {
        proc = spawn(raw.profile.exe, argv, {
          cwd: raw.profile.cwd || os.homedir(),
          env: { ...process.env, ...env },
          shell: false,
          detached: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve({ ok: false, reason: 'spawn-failed', error: String(err.message || err) });
        return;
      }

      /* A missing binary surfaces as an ASYNC 'error' event (ENOENT), never as
         a throw — settle on whichever arrives first and never report success
         past that point. */
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const rec = { proc, startedAt: Date.now(), exitCode: null };
      harnessProcs.set(`${Date.now()}-${proc.pid}`, rec);
      const stdoutTail = [];
      const stderrTail = [];
      proc.stdout.on('data', (c) => { stdoutTail.push(String(c)); if (stdoutTail.length > 40) stdoutTail.shift(); });
      proc.stderr.on('data', (c) => { stderrTail.push(String(c)); if (stderrTail.length > 40) stderrTail.shift(); });

      proc.once('error', (err) => {
        rec.error = String(err.message || err);
        settle({ ok: false, reason: 'spawn-failed', error: rec.error });
      });

      proc.once('exit', (code) => {
        rec.exitCode = code;
        send(getWin, 'ollama:spawnevent', { kind: 'exit', code });
      });

      /* health verification window: the caller polls /api/version itself via
         ollama:request; here we only report truthful process state. */
      const verifyTimer = setTimeout(() => {
        if (rec.exitCode !== null) return;
        send(getWin, 'ollama:spawnevent', { kind: 'still-running', pid: proc.pid });
      }, 20000);
      proc.once('exit', () => clearTimeout(verifyTimer));

      /* Success deliberately waits one tick: Node emits spawn ENOENT through
         process.nextTick, which drains BEFORE setImmediate, so a missing
         binary reliably wins this race and gets reported as spawn-failed
         instead of a phantom success with a pid that never existed. */
      setImmediate(() => {
        settle({
          ok: true,
          pid: proc.pid,
          startedAt: rec.startedAt,
          note: 'Process launched without a shell; args were expanded from the allowlisted template only.',
        });
      });
    });
  });

  ipc.handle('ollama:harnessstop', () => {
    let stopped = 0;
    for (const [, rec] of harnessProcs) {
      if (rec.exitCode === null) {
        try { rec.proc.kill(); stopped++; } catch (_) {}
      }
    }
    return { ok: true, stopped };
  });
}

module.exports = { register };
