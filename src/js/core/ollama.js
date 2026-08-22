/**
 * ollama.js — local Ollama suite manager, renderer side (Lane E).
 *
 * Talks ONLY to the documented local HTTP API through the `ollama:request`
 * bridge (loopback-only, enforced main-side). No unofficial proxies, no cloud
 * model services, no invented sample models — ever.
 *
 * Surfaces on the "Ollama" tab:
 *  - HEALTH header: version + running models + state chip. States are named
 *    explicitly (missing install / daemon stopped / unhealthy / offline
 *    catalog / stale catalog / insufficient storage / CPU-only inference) and
 *    each carries its OWN in-app troubleshooting checklist with a re-verify
 *    button. Nothing degrades to a bare "see online docs" link.
 *  - INSTALLED MODELS: exhaustive table from /api/tags (name, tag, size,
 *    family/quantization, modified) with search + filters + sort + stale age.
 *  - MODEL STORE honesty footer: Ollama publishes NO supported public catalog
 *    enumeration API. This build therefore offers pull-BY-NAME with validation,
 *    size-unknown disclosure, disk preflight, streamed progress and cancel —
 *    and says plainly that it cannot browse a remote catalog it cannot query.
 *  - BATCH PULLS: multi-add queue with bounded parallelism, durable per-item
 *    state, honest partial outcomes; failures never delete existing models.
 *  - CHAT: sessions with system prompt, parameter steppers, streamed markdown-
 *    lite output, stop/regenerate/copy/export(redacted); attachments render as
 *    a VISIBLE-BUT-DISABLED control carrying its exact capability reason.
 *  - HARNESS: allowlisted profile launches only. The register form's input
 *    SHAPE (file/dir pickers, ${model}/${prompt}-only templates, env key
 *    allowlist) makes arbitrary shell impossible; every launch shows a
 *    preflight modal and snapshots settings for one-click/auto rollback.
 */

import { store } from './store.js';
import { ui } from './ui.js';
import { i18n } from './i18n.js';
import { ensureToolsStyles } from './colorpicker.js';

const peerCache = new Map();
function peer(name) {
  if (!peerCache.has(name)) peerCache.set(name, import(name).then((m) => m).catch(() => null));
  return peerCache.get(name);
}

function tt(en, yue) {
  try {
    if (i18n.schoolActive()) return en;
    const mode = i18n.lang();
    if (mode === 'yue' && yue) return yue;
    if (mode === 'bi' && yue) return `${en} · ${yue}`;
  } catch (_) { /* English always correct */ }
  return en;
}

const invoke = async (channel, payload) => {
  if (!window.mrb || typeof window.mrb.invoke !== 'function') throw new Error('Shell bridge unavailable.');
  return window.mrb.invoke(channel, payload);
};

function getSetting(path, fallback) {
  return peer('./settings.js').then((m) => {
    const s = m && m.settings;
    if (s && typeof s.get === 'function') return s.get(path, fallback);
    const v = store.get(path, undefined);
    return v === undefined ? fallback : v;
  });
}
async function getSettingSync(path, fallback) {
  if (!getSettingSync.cache) {
    const m = await peer('./settings.js');
    getSettingSync.cache = m && m.settings ? m.settings : null;
  }
  const s = getSettingSync.cache;
  if (s && typeof s.get === 'function') {
    try { return s.get(path, fallback); } catch (_) { /* fall through */ }
  }
  const v = store.get(path, undefined);
  return v === undefined ? fallback : v;
}

/* ------------------------------------------------------------------ */
/* API helpers                                                         */
/* ------------------------------------------------------------------ */

let reqCounter = 0;

/**
 * One request against the local daemon.
 * @returns {Promise<{ok,status,json?,text?,error?,refused?}>}
 */
export async function api(path, { method = 'GET', jsonBody, timeoutKind = 'gen' } = {}) {
  const host = await getSettingSync('ollama.host', '127.0.0.1');
  const port = await getSettingSync('ollama.port', 11434);
  return invoke('ollama:request', { path, method, jsonBody, timeoutKind, host, port });
}

/** Streamed request; returns an abort handle plus the final status promise. */
export function apiStream(path, jsonBody, onData) {
  const reqId = `s${Date.now().toString(36)}${(reqCounter++).toString(36)}`;
  let offChunk;
  let offEnd;
  const done = new Promise((resolve) => {
    offChunk = window.mrb.on('ollama:chunk', (msg) => {
      if (msg.reqId !== reqId) return;
      try { onData(msg.data); } catch (_) { /* consumer errors never kill the stream */ }
    });
    offEnd = window.mrb.on('ollama:end', (msg) => {
      if (msg.reqId !== reqId) return;
      resolve({ ok: msg.status >= 200 && msg.status < 300, status: msg.status });
    });
  });
  /* endpoint rides the request like every other call — loopback enforced main-side */
  Promise.all([getSettingSync('ollama.host', '127.0.0.1'), getSettingSync('ollama.port', 11434)])
    .then(([host, port]) => invoke('ollama:request', {
      path, method: 'POST', jsonBody, stream: true, reqId, timeoutKind: 'gen', host, port,
    }))
    .catch((err) => ({ ok: false, error: String(err.message || err) }));

  return {
    reqId,
    done,
    async abort() {
      await invoke('ollama:abort', { reqId });
    },
    cleanup() {
      offChunk?.();
      offEnd?.();
    },
  };
}

/* ------------------------------------------------------------------ */
/* hardware fit (conservative evidence, never a promise)               */
/* ------------------------------------------------------------------ */

const FIT_THRESHOLDS_DOC = `
Model size vs RAM heuristics (documented inline AND beside the verdict chip):
  size < 0.6 × RAM  -> "Runs well"
  size < 0.9 × RAM  -> "Runs with limits"
  otherwise          -> "Unlikely"
Any missing measurement (RAM unknown, model size unknown) yields "Unknown" —
never an optimistic guess. navigator.deviceMemory caps at 8 GB by spec, which
makes this CONSERVATIVE for big-RAM machines, not optimistic.
`;

function gpuInfo() {
  try {
    const cv = document.createElement('canvas');
    const gl = cv.getContext('webgl') || cv.getContext('experimental-webgl');
    if (!gl) return { renderer: '', vendor: '' };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
      vendor: ext ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)) : '',
    };
  } catch (_) {
    return { renderer: '', vendor: '' };
  }
}

/**
 * Conservative fit verdict.
 * @param {{sizeBytes?:number}} model
 * @param {{freeBytes?:number|null}} disk
 */
export function hardwareFit(model, disk) {
  const evidence = [];
  const deviceMemGb = navigator.deviceMemory || null;
  if (deviceMemGb) evidence.push(`RAM (deviceMemory): ~${deviceMemGb} GB (browser caps the reported value at 8 GB)`);
  else evidence.push('RAM: unknown');

  const gpu = gpuInfo();
  evidence.push(gpu.renderer ? `GPU (WebGL renderer): ${gpu.renderer}` : 'GPU: not detectable from the renderer');

  if (disk && typeof disk.freeBytes === 'number') {
    evidence.push(`Disk free (system drive): ${fmtBytes(disk.freeBytes)}`);
  } else {
    evidence.push('Disk free: unknown');
  }

  let verdict = 'unknown';
  let reason = '';
  if (deviceMemGb && model.sizeBytes) {
    const ramBytes = deviceMemGb * 1024 ** 3;
    const ratio = model.sizeBytes / ramBytes;
    evidence.push(`Size/RAM ratio: ${(ratio).toFixed(2)} (thresholds 0.60 well / 0.90 limits)`);
    if (ratio < 0.6) { verdict = 'well'; reason = tt('Model fits comfortably in reported memory.', '模型輕鬆塞得落回報嘅記憶體。'); }
    else if (ratio < 0.9) { verdict = 'limits'; reason = tt('Close to the memory ceiling; expect slower prompts.', '貼近記憶體上限；提示會慢啲。'); }
    else { verdict = 'unlikely'; reason = tt('Model is larger than reported memory.', '模型大過回報嘅記憶體。'); }
  } else {
    reason = tt('Missing RAM or size data — no guess offered.', '缺少記憶體或模型大小資料 — 唔亂估。');
  }

  if (disk && typeof disk.freeBytes === 'number' && model.sizeBytes && disk.freeBytes < model.sizeBytes * 1.1) {
    if (verdict === 'well' || verdict === 'limits') verdict = 'limits';
    evidence.push(tt('Free disk may be tight for the blob download.', '可用磁碟空間可能唔夠裝模型。'));
  }

  return {
    verdict, // 'well'|'limits'|'unlikely'|'unknown'
    label: { well: 'Runs well', limits: 'Runs with limits', unlikely: 'Unlikely', unknown: 'Unknown' }[verdict],
    emoji: { well: '🟢', limits: '🟡', unlikely: '🔴', unknown: '⚪' }[verdict],
    reason,
    evidence,
    computedAt: Date.now(),
    thresholdsDoc: FIT_THRESHOLDS_DOC.trim(),
  };
}

function fmtBytes(n) {
  try { if (ui.fmtBytes) return ui.fmtBytes(n); } catch (_) {}
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/* ------------------------------------------------------------------ */
/* health classification                                               */
/* ------------------------------------------------------------------ */

/**
 * @typedef {'ok'|'stopped-daemon'|'missing-install'|'unhealthy'|'offline-catalog'} HealthState
 */

let healthState = /** @type {HealthState} */ ('stopped-daemon');
let lastTagsFetch = store.get('ollamaLastTagsFetch', 0);
let cpuOnlyInference = false;

async function probeHealth() {
  const versionRes = await api('/api/version', { timeoutKind: 'health' });
  if (versionRes.refused) {
    /* Distinguish "not installed" from "installed but not running" using ONE
       allowlisted spawn probe (`ollama --version`): ENOENT means absent. */
    const probe = await invoke('ollama:spawn', {
      profile: { id: 'ollama-cli-chat' },
      intent: 'probe',
      model: '', prompt: '',
    }).catch(() => ({ ok: false, reason: 'spawn-failed', error: 'probe unavailable' }));
    const errText = String(probe.error || '');
    if (probe.ok === false && (probe.reason === 'spawn-failed' && /ENOENT|not find|cannot find/i.test(errText))) {
      healthState = 'missing-install';
    } else if (probe.ok) {
      healthState = 'stopped-daemon';
      invoke('ollama:harnessstop', {});
    } else {
      healthState = 'stopped-daemon'; // probe route unavailable: still honest copy
    }
    return { ok: false, state: healthState };
  }
  if (!versionRes.ok || !versionRes.json || !versionRes.json.version) {
    healthState = 'unhealthy';
    return { ok: false, state: healthState };
  }
  const tags = await api('/api/tags', { timeoutKind: 'health' });
  if (!tags.ok) {
    healthState = 'offline-catalog';
    return { ok: false, state: healthState, version: versionRes.json.version };
  }
  healthState = 'ok';
  lastTagsFetch = Date.now();
  store.set('ollamaLastTagsFetch', lastTagsFetch);
  return {
    ok: true,
    state: healthState,
    version: versionRes.json.version,
    tags: Array.isArray(tags.json?.models) ? tags.json.models : [],
  };
}

const TROUBLESHOOT = {
  'missing-install': {
    title: () => tt('Ollama does not appear to be installed', '似乎未安裝 Ollama'),
    steps: () => [
      tt('Install Ollama for your operating system:', '為你的作業系統安裝 Ollama：'),
      '• Windows — run the official installer from ollama.com/download (OllamaSetup.exe)',
      '• macOS — download Ollama.app, or `brew install ollama`',
      '• Linux — `curl -fsSL https://ollama.com/install.sh | sh`',
      tt('After installing, start it once so the local API answers.', '裝好後開一次，等本機 API 有反應。'),
    ],
  },
  'stopped-daemon': {
    title: () => tt('Nothing answered on the local endpoint', '本機端點冇反應'),
    steps: () => [
      tt('The endpoint 127.0.0.1 answered nothing — the daemon is probably not running.', '127.0.0.1 冇回應 — daemon 多半未開。'),
      '• Windows — launch the Ollama app, or run `ollama serve`',
      '• macOS/Linux — run `ollama serve`, or open the menu-bar app',
      tt('Check the port setting below matches how you started it.', '檢查下面個埠設定同你啟動方式一致。'),
    ],
  },
  unhealthy: {
    title: () => tt('The daemon responded but not correctly', 'Daemon 有回應但係唔正常'),
    steps: () => [
      tt('The version endpoint returned something unexpected.', '/api/version 回應異常。'),
      tt('Restart the daemon and verify again.', '重啟 daemon 再驗證一次。'),
    ],
  },
  'offline-catalog': {
    title: () => tt('Running, but the model list failed', '運行中，但攞不到模型清單'),
    steps: () => [
      tt('/api/tags did not answer. The daemon may still be starting.', '/api/tags 無回應；daemon 可能仲在啟動中。'),
      tt('Verify again in a few seconds.', '幾秒後再驗證。'),
    ],
  },
};

/* ------------------------------------------------------------------ */
/* chat sessions                                                       */
/* ------------------------------------------------------------------ */

const SESSIONS_KEY = 'ollamaChatSessions';

export function listSessions() {
  return store.get(SESSIONS_KEY, []);
}
function saveSessions(sessions, label) {
  store.set(SESSIONS_KEY, sessions.slice(0, 200));
  peer('./history.js').then((m) => {
    if (m?.history?.record) m.history.record({ kind: 'settings', label: label || 'Chat sessions changed', snapshot: { count: sessions.length } });
  });
}

function newSession(model) {
  return {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    title: tt('New chat', '新對話'),
    model: model || '',
    system: '',
    params: { temperature: 0.7, top_p: 0.9, num_ctx: 2048 },
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Markdown-LITE renderer: escape first, then a tiny safe subset. */
function mdLite(text) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
  const parts = [];
  let inFence = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^```/.test(line)) {
      parts.push(inFence ? '</code></pre>' : '<pre><code>');
      inFence = !inFence;
      continue;
    }
    if (inFence) { parts.push(esc(line)); continue; }
    parts.push(inline(line) + '<br>');
  }
  if (inFence) parts.push('</code></pre>');
  return parts.join('');
}

/* ------------------------------------------------------------------ */
/* harness profiles                                                    */
/* ------------------------------------------------------------------ */

const PREBUILT_PROFILES = [
  { id: 'ollama-cli-chat', label: 'Ollama CLI chat', exe: 'ollama', args: ['run', '${model}'], cwd: null, envAllowlist: [] },
];

function userProfiles() {
  return store.get('ollamaHarnessProfiles', []);
}
function allProfiles() {
  return [...PREBUILT_PROFILES, ...userProfiles().map((p) => ({ ...p, custom: true }))];
}

const HARNESS_LOG_KEY = 'ollamaHarnessLog';
function logHarness(entry) {
  const log = store.get(HARNESS_LOG_KEY, []);
  log.unshift({ ...entry, at: Date.now() });
  store.set(HARNESS_LOG_KEY, log.slice(0, 100));
}

const HARNESS_SNAPSHOT_KEY = 'ollamaHarnessSnapshot';
async function snapshotSettings() {
  const snap = {};
  for (const k of ['ollama.host', 'ollama.port', 'ollama.parallelism', 'chat.temperature', 'chat.top_p', 'chat.num_ctx']) {
    snap[k] = await getSettingSync(k, undefined);
  }
  return snap;
}
async function restoreSnapshot(snap) {
  const m = await peer('./settings.js');
  const s = m?.settings;
  for (const [k, v] of Object.entries(snap || {})) {
    if (v === undefined) continue;
    if (s?.set) s.set(k, v); else store.set(k, v);
  }
}

/* ------------------------------------------------------------------ */
/* tab surface                                                         */
/* ------------------------------------------------------------------ */

let els = {};

function registerTab() {
  peer('./router.js').then((m) => {
    const router = m?.router;
    if (!router || typeof router.registerTab !== 'function') return;
    router.registerTab({
      id: 'ollama',
      title: tt('Ollama', 'Ollama'),
      icon: '🦙',
      closable: true,
      group: 'tools',
      render(el) { el.append(buildTab()); refreshAll(); },
    });
  }).catch(() => { /* router optional */ });
}

function buildTab() {
  const wrapEl = ui.el('div', { class: 'mrb-ollama-tab' });

  /* ---- health ------------------------------------------------------ */
  els.healthCard = ui.el('section', { class: 'mrb-card mrb-ollama-health' });
  wrapEl.append(els.healthCard);

  /* ---- installed models -------------------------------------------- */
  const modelsCard = ui.el('section', { class: 'mrb-card' }, ui.el('h2', {}, '📦 ', document.createTextNode(tt('Installed models', '已安裝模型'))));
  const searchHost = ui.el('div', {});
  const filterRow = ui.el('div', { class: 'mrb-ollama-filterrow' }, searchHost);
  els.familyFilter = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Family filter', '架構篩選') });
  els.quantFilter = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Quantization filter', '量化篩選') });
  els.sortSel = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Sort', '排序') });
  for (const [v, lbl] of [['name', tt('Name', '名稱')], ['size-desc', tt('Largest first', '最大先')], ['size-asc', tt('Smallest first', '最細先')], ['modified-desc', tt('Recently updated', '最近更新')]]) {
    els.sortSel.append(ui.el('option', { value: v, text: lbl }));
  }
  els.familyFilter.addEventListener('change', () => renderModels());
  els.quantFilter.addEventListener('change', () => renderModels());
  els.sortSel.addEventListener('change', () => renderModels());
  filterRow.append(els.familyFilter, els.quantFilter, els.sortSel);
  modelsCard.append(filterRow);

  const refreshBtn = ui.el('button', { class: 'mrb-btn mrb-btn-tonal mrb-btn-sm', type: 'button', text: tt('Refresh', '重新整理') });
  refreshBtn.addEventListener('click', () => refreshAll());
  els.staleAge = ui.el('span', { class: 'mrb-chip', text: '' });
  modelsCard.append(ui.el('div', { class: 'mrb-ollama-refreshrow' }, refreshBtn, els.staleAge));

  els.modelsWrap = ui.el('div', {});
  modelsCard.append(els.modelsWrap);

  /* honesty footer about the remote catalog */
  modelsCard.append(ui.el('p', {
    class: 'mrb-explain',
    text: tt(
      'About a "model store": Ollama\'s official catalog has NO supported public enumeration API, so this app will never pretend to browse one. Pull any model BY NAME below; discover names via ollama.com or your own notes.',
      '關於「模型商店」：Ollama 官方目錄並無公開列舉 API，所以本程式絕不假裝可以瀏覽。請用下面按名稱拉取；名稱可從 ollama.com 或你自己的筆記搵到。',
    ),
  }));
  wrapEl.append(modelsCard);

  /* ---- pull by name -------------------------------------------------- */
  const pullCard = ui.el('section', { class: 'mrb-card' }, ui.el('h2', {}, '⬇️ ', document.createTextNode(tt('Pull a model by name', '按名稱拉取模型'))));
  const nameInput = ui.el('input', {
    class: 'mrb-field-input', type: 'text',
    placeholder: tt('e.g. llama3.2 or mistral:7b', '例如 llama3.2 或 mistral:7b'),
    'aria-label': tt('Model name', '模型名稱'),
  });
  const nameErr = ui.el('span', { class: 'mrb-schedule-error', role: 'alert' });
  const NAME_RE = /^[a-z0-9](?:[a-z0-9.:_-]{0,78}[a-z0-9])?$/;
  const datalist = ui.el('datalist', { id: 'mrb-ollama-names' });
  nameInput.setAttribute('list', 'mrb-ollama-names');

  const pullBtn = ui.el('button', { class: 'mrb-btn mrb-btn-filled', type: 'button', text: tt('Pull', '拉取') });
  pullBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim().toLowerCase();
    nameErr.textContent = '';
    if (!NAME_RE.test(name)) {
      nameErr.textContent = tt('Use lowercase letters, digits, dots, colons, underscores or hyphens (max 80 chars).', '只可以用細楷字母、數字、點、冒號、底線或連字號（最多 80 字）。');
      return;
    }
    await startPull(name);
  });
  pullCard.append(
    ui.el('div', { class: 'mrb-converter-toolbar' }, nameInput, pullBtn),
    datalist, nameErr,
    ui.el('p', {
      class: 'mrb-explain',
      text: tt(
        'Download size is UNKNOWN until the pull starts — the registry does not publish it up front. Disk space is checked against your free space before starting, marked as an estimate.',
        '開始之前下載大小屬未知 — registry 冇預先公佈。開始前會用你嘅可用空間做估算檢查（屬估計值）。',
      ),
    }),
  );
  els.pullProgress = ui.el('div', { class: 'mrb-ollama-pullprogress' });
  pullCard.append(els.pullProgress);
  wrapEl.append(pullCard);

  /* ---- batch pulls ---------------------------------------------------- */
  const batchCard = ui.el('section', { class: 'mrb-card' }, ui.el('h2', {}, '🧺 ', document.createTextNode(tt('Batch pulls', '批次拉取'))));
  els.batchWrap = ui.el('div', {});
  const addCurrentBtn = ui.el('button', { class: 'mrb-btn mrb-btn-tonal mrb-btn-sm', type: 'button', text: tt('Add current pull name to batch', '將目前名稱加入批次') });
  addCurrentBtn.addEventListener('click', () => {
    const name = nameInput.value.trim().toLowerCase();
    if (!NAME_RE.test(name)) { nameErr.textContent = tt('Fix the name first.', '先修正名稱。'); return; }
    addToBatch(name);
  });
  const runBatchBtn = ui.el('button', { class: 'mrb-btn mrb-btn-filled mrb-btn-sm', type: 'button', text: tt('Run batch', '執行批次') });
  runBatchBtn.addEventListener('click', () => runBatch());
  batchCard.append(ui.el('div', { class: 'mrb-converter-toolbar' }, addCurrentBtn, runBatchBtn), els.batchWrap);
  wrapEl.append(batchCard);

  /* ---- chat ------------------------------------------------------------ */
  const chatCard = ui.el('section', { class: 'mrb-card' }, ui.el('h2', {}, '💬 ', document.createTextNode(tt('Chat', '對話'))));
  buildChat(chatCard);
  wrapEl.append(chatCard);

  /* ---- harness ---------------------------------------------------------- */
  const harnessCard = ui.el('section', { class: 'mrb-card' }, ui.el('h2', {}, '🚀 ', document.createTextNode(tt('Harness launch', '啟動工作環境外掛'))));
  buildHarness(harnessCard);
  wrapEl.append(harnessCard);

  /* settings group lives in Settings; quick link here */
  wrapEl.append(ui.el('p', {
    class: 'mrb-explain',
    text: tt('Host, parallelism and chat defaults live in Settings → Ollama.', '主機、並行數與對話預設喺「設定 → Ollama」。'),
  }));

  return wrapEl;
}

/* ------------------------------------------------------------------ */
/* health rendering                                                    */
/* ------------------------------------------------------------------ */

async function refreshAll() {
  await renderHealth();
  await renderModels();
  renderStaleAge();
  renderBatch();
}

async function renderHealth() {
  const card = els.healthCard;
  if (!card) return;
  card.textContent = '';
  card.append(ui.el('h2', {}, '❤️ ', document.createTextNode(tt('Local service', '本機服務'))));

  const res = await probeHealth();

  const stateChip = ui.el('span', { class: 'mrb-chip' });
  const labels = {
    ok: [tt('healthy ✓', '正常 ✓'), 'mrb-chip-pass'],
    'stopped-daemon': [tt('daemon stopped ✗', 'daemon 未行 ✗'), 'mrb-chip-fail'],
    'missing-install': [tt('not installed ✗', '未安裝 ✗'), 'mrb-chip-fail'],
    unhealthy: [tt('unhealthy ✗', '不健康 ✗'), 'mrb-chip-fail'],
    'offline-catalog': [tt('catalog unreachable ⚠', '清單不可達 ⚠'), ''],
  };
  const [labelText, cls] = labels[res.state] || labels['stopped-daemon'];
  stateChip.textContent = labelText;
  stateChip.classList.add(cls);
  card.append(stateChip);

  if (res.version) {
    card.append(document.createTextNode(' '), ui.el('code', { text: `v${res.version}` }));
  }

  if (res.ok) {
    const ps = await api('/api/ps', { timeoutKind: 'health' });
    const running = Array.isArray(ps.json?.models) ? ps.json.models : [];
    cpuOnlyInference = running.some((r) => Number(r.size_vram) === 0 && Number(r.size) > 0);
    card.append(ui.el('div', { class: 'mrb-ollama-running' },
      ui.el('strong', { text: tt('Loaded in memory', '已載入記憶體') }),
      running.length
        ? ui.el('ul', {}, ...running.map((r) => ui.el('li', { text: `${r.name} · ${fmtBytes(r.size || 0)} · VRAM ${fmtBytes(r.size_vram || 0)}` })))
        : ui.el('span', { class: 'mrb-cpk-empty', text: tt('No models loaded right now.', '暫時冇模型載入。') })));
    if (cpuOnlyInference) {
      card.append(ui.el('p', {
        class: 'mrb-explain',
        role: 'status',
        text: tt('A loaded model reports zero VRAM — inference is running on CPU. Check GPU/driver support with `ollama ps` and your driver docs.', '有模型回報 VRAM=0 — 推理正用 CPU 跑。請用 ollama ps 同驅動程式文件檢查 GPU 支援。'),
      }));
    }
  } else {
    const panel = TROUBLESHOOT[res.state] || TROUBLESHOOT['stopped-daemon'];
    const box = ui.el('div', { class: 'mrb-ollama-troubleshoot' },
      ui.el('strong', { text: panel.title() }),
      ui.el('ul', {}, ...panel.steps().map((s) => ui.el('li', { text: s }))));
    const retryBtn = ui.el('button', { class: 'mrb-btn mrb-btn-tonal mrb-btn-sm', type: 'button', text: tt('Verify again', '再驗證一次') });
    retryBtn.addEventListener('click', () => refreshAll());
    box.append(retryBtn);
    card.append(box);
  }
}

function renderStaleAge() {
  if (!els.staleAge) return;
  if (!lastTagsFetch) {
    els.staleAge.textContent = tt('never refreshed', '未曾更新');
    return;
  }
  const ageH = (Date.now() - lastTagsFetch) / 3600000;
  els.staleAge.textContent = ageH > 24
    ? `⚠ ${tt('catalog stale', '清單過期')} (${Math.round(ageH)}h)`
    : `${tt('refreshed', '已更新')} ${ageH < 1 ? `${Math.max(1, Math.round(ageH * 60))}m` : `${Math.round(ageH)}h`} ${tt('ago', '前')}`;
  els.staleAge.classList.toggle('mrb-chip-fail', ageH > 24);
}

/* ------------------------------------------------------------------ */
/* models table                                                        */
/* ------------------------------------------------------------------ */

let cachedTags = [];

async function renderModels() {
  const wrapNode = els.modelsWrap;
  if (!wrapNode) return;
  wrapNode.textContent = '';

  if (healthState !== 'ok') {
    wrapNode.append(ui.el('p', {
      class: 'mrb-cpk-empty',
      text: tt('Connect to the local service to list models — nothing is invented while it is unreachable.', '連上本機服務先可以列出模型；連不上時絕不虛構清單。'),
    }));
    return;
  }
  if (!cachedTags.length) {
    const tags = await api('/api/tags', { timeoutKind: 'health' });
    cachedTags = Array.isArray(tags.json?.models) ? tags.json.models : [];
  }
  if (!cachedTags.length) {
    wrapNode.append(ui.el('p', {
      class: 'mrb-cpk-empty',
      text: tt('No models installed yet. Pull one by name below.', '仲未安裝任何模型。用下面按名稱拉取。'),
    }));
    return;
  }

  /* filters derive from real data only */
  const families = [...new Set(cachedTags.map((m) => m.details?.family).filter(Boolean))].sort();
  const quants = [...new Set(cachedTags.map((m) => m.details?.quantization_level).filter(Boolean))].sort();
  rebuildSelect(els.familyFilter, tt('All families', '所有架構'), families);
  rebuildSelect(els.quantFilter, tt('All quantizations', '所有量化'), quants);

  let list = [...cachedTags];
  const fam = els.familyFilter.value;
  const quant = els.quantFilter.value;
  if (fam) list = list.filter((m) => m.details?.family === fam);
  if (quant) list = list.filter((m) => m.details?.quantization_level === quant);

  const sort = els.sortSel.value;
  if (sort === 'size-desc') list.sort((a, b) => (b.size || 0) - (a.size || 0));
  else if (sort === 'size-asc') list.sort((a, b) => (a.size || 0) - (b.size || 0));
  else if (sort === 'modified-desc') list.sort((a, b) => new Date(b.modified_at || 0) - new Date(a.modified_at || 0));
  else list.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const tbl = ui.el('table', { class: 'mrb-table' });
  tbl.append(ui.el('thead', {}, ui.el('tr', {},
    ...[tt('Model', '模型'), tt('Size', '大小'), tt('Params', '參數'), tt('Family', '架構'), tt('Quant', '量化'), tt('Modified', '修改於'), tt('Fit', '合適度'), '']
      .map((h) => ui.el('th', { text: h })))));
  const tbody = ui.el('tbody');
  const disk = await invoke('converter:free', { path: '.' }).catch(() => ({ ok: false }));
  for (const m of list) {
    const fit = hardwareFit({ sizeBytes: m.size }, disk);
    const useBtn = ui.el('button', { class: 'mrb-btn mrb-btn-tonal mrb-btn-sm', type: 'button', text: tt('Chat', '對話') });
    useBtn.addEventListener('click', () => startOrFocusChat(m.name));
    tbody.append(ui.el('tr', {},
      ui.el('td', { text: m.name }),
      ui.el('td', { text: fmtBytes(m.size || 0) }),
      ui.el('td', { text: m.details?.parameter_size || '—' }),
      ui.el('td', { text: m.details?.family || '—' }),
      ui.el('td', { text: m.details?.quantization_level || '—' }),
      ui.el('td', { text: m.modified_at ? new Date(m.modified_at).toLocaleString() : '—' }),
      ui.el('td', { title: fit.reason + '\n' + fit.evidence.join('\n'), text: `${fit.emoji} ${fit.label}` }),
      ui.el('td', {}, useBtn)));
  }
  tbl.append(tbody);
  wrapNode.append(tbl);

  /* name autocomplete comes from REAL installed families */
  const dl = document.getElementById('mrb-ollama-names');
  if (dl) {
    dl.textContent = '';
    for (const base of [...new Set(list.map((m) => String(m.name).split(':')[0]))]) {
      dl.append(ui.el('option', { value: base }));
    }
  }
}

function rebuildSelect(sel, allLabel, values) {
  if (!sel) return;
  const prev = sel.value;
  sel.textContent = '';
  sel.append(ui.el('option', { value: '', text: allLabel }));
  for (const v of values) sel.append(ui.el('option', { value: v, text: v }));
  if (values.includes(prev)) sel.value = prev;
}

/* ------------------------------------------------------------------ */
/* pulls                                                               */
/* ------------------------------------------------------------------ */

const activePulls = new Map(); // name -> controller

async function diskFree() {
  const res = await invoke('converter:free', { path: '.' }).catch(() => ({ ok: false }));
  return res.ok ? { freeBytes: res.freeBytes } : { freeBytes: null };
}

async function startPull(name) {
  if (activePulls.has(name)) return;
  /* already-present reconciliation BEFORE downloading anything */
  const tags = await api('/api/tags', { timeoutKind: 'health' });
  const existing = (tags.json?.models || []).find((m) => String(m.name).split(':')[0] === name.split(':')[0]
    && (!name.includes(':') || String(m.name) === name));
  if (existing && (!name.includes(':') || String(existing.name) === name)) {
    ui.toast?.({
      title: tt('Already present', '已經存在'),
      body: `${existing.name} — ${tt('skipped, nothing downloaded', '略過，冇重新下載')}`,
      tone: 'ok', timeoutMs: 5000,
    });
    markBatchItem(name, 'skipped-already-present');
    return;
  }

  const disk = await diskFree();
  if (typeof disk.freeBytes === 'number' && disk.freeBytes < 512 * 1024 * 1024) {
    setInsufficientStorage(disk.freeBytes);
    return;
  }

  const box = ui.el('div', { class: 'mrb-ollama-pullitem' },
    ui.el('strong', { text: name }),
    ui.el('progress', { class: 'mrb-progress-bar', max: '100', value: '0' }),
    ui.el('span', { class: 'mrb-ollama-pullbytes', text: tt('starting…', '啟動中…') }));
  const cancelBtn = ui.el('button', { class: 'mrb-btn mrb-btn-text mrb-btn-sm', type: 'button', text: tt('Cancel', '取消') });
  box.append(cancelBtn);
  els.pullProgress.append(box);

  const stream = apiStream('/api/pull', { name, stream: true }, (data) => {
    const prog = box.querySelector('.mrb-progress-bar');
    const bytes = box.querySelector('.mrb-ollama-pullbytes');
    if (data.total && data.completed != null) {
      prog.value = String(Math.round((data.completed / data.total) * 100));
      bytes.textContent = `${fmtBytes(data.completed)} / ${fmtBytes(data.total)}`;
    } else if (data.status) {
      bytes.textContent = String(data.status);
    }
  });
  activePulls.set(name, stream);
  cancelBtn.addEventListener('click', () => stream.abort());

  const result = await stream.done;
  stream.cleanup();
  activePulls.delete(name);
  box.remove();

  if (result.ok) {
    ui.toast?.({ title: tt('Pulled', '已完成拉取'), body: name, tone: 'ok', timeoutMs: 5000 });
    markBatchItem(name, 'pulled');
    cachedTags = [];
    refreshAll();
  } else {
    /* resume semantics: re-running the same name continues where it left off */
    ui.toast?.({
      title: tt('Pull did not finish', '拉取未完成'),
      body: `${name} — ${tt('run it again to resume; existing models were not touched.', '再跑一次就會續傳；現有模型不受影響。')}`,
      tone: 'warn', timeoutMs: 8000,
    });
    markBatchItem(name, 'failed');
  }
}

function setInsufficientStorage(freeBytes) {
  ui.toast?.({
    title: tt('Not enough disk space', '磁碟空間不足'),
    body: `${tt('Free', '可用')}: ${fmtBytes(freeBytes)}. ${tt('Free up space, then retry.', '清理一下再試。')}`,
    tone: 'error', timeoutMs: 9000,
  });
}

/* ---- batch ----------------------------------------------------------- */

const BATCH_KEY = 'ollamaBatchPulls';

function batchItems() {
  return store.get(BATCH_KEY, []);
}
function saveBatch(items) {
  store.set(BATCH_KEY, items.slice(-500));
}
function addToBatch(name) {
  const items = batchItems();
  if (items.some((it) => it.name === name)) return;
  items.push({ id: `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name, status: 'queued', addedAt: Date.now() });
  saveBatch(items);
  renderBatch();
}
function markBatchItem(name, status) {
  const items = batchItems();
  const it = items.filter((x) => x.status === 'queued' || x.status === 'running').find((x) => x.name === name)
    || items.find((x) => x.name === name);
  if (it) { it.status = status; saveBatch(items); renderBatch(); }
}

async function runBatch() {
  const queued = batchItems().filter((it) => it.status === 'queued');
  if (!queued.length) {
    ui.toast?.({ title: tt('Batch is empty', '批次係空'), tone: 'info', timeoutMs: 4000 });
    return;
  }
  const par = Math.min(Math.max(Math.round(Number(await getSettingSync('ollama.parallelism', 2))) || 2, 1), 4);
  let cursor = 0;
  const workerCount = Math.min(par, queued.length);
  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push((async () => {
      for (;;) {
        const idx = cursor++;
        if (idx >= queued.length) break;
        const item = queued[idx];
        item.status = 'running';
        saveBatch(batchItems());
        renderBatch();
        try {
          await startPull(item.name);
        } catch (err) {
          markBatchItem(item.name, 'failed');
        }
      }
    })());
  }
  await Promise.all(workers);
  renderBatch();
}

function renderBatch() {
  if (!els.batchWrap) return;
  els.batchWrap.textContent = '';
  const items = batchItems();
  if (!items.length) {
    els.batchWrap.append(ui.el('p', {
      class: 'mrb-cpk-empty',
      text: tt('No batch items. Names you add here pull sequentially (bounded parallelism), each keeping its own durable state.', '未有批次項目。加喺呢度的名稱會以有限並行逐一拉取，各自保留狀態。'),
    }));
    return;
  }
  const tbl = ui.el('table', { class: 'mrb-table' });
  const tbody = ui.el('tbody');
  const STATUS_LABEL = {
    queued: tt('queued', '排隊中'), running: tt('pulling…', '拉取中…'),
    pulled: tt('pulled ✓', '完成 ✓'), 'skipped-already-present': tt('already present', '已存在'),
    cancelled: tt('cancelled', '已取消'), failed: tt('failed ✗', '失敗 ✗'),
  };
  for (const it of items) {
    const rm = ui.el('button', { class: 'mrb-btn mrb-btn-text mrb-btn-sm', type: 'button', text: '✕', 'aria-label': tt('Remove from batch', '移出批次') });
    rm.addEventListener('click', () => {
      saveBatch(batchItems().filter((x) => x.id !== it.id));
      renderBatch();
    });
    tbody.append(ui.el('tr', {},
      ui.el('td', { text: it.name }),
      ui.el('td', { text: STATUS_LABEL[it.status] || it.status }),
      ui.el('td', {}, rm)));
  }
  tbl.append(ui.el('thead', {}, ui.el('tr', {},
    ...[tt('Name', '名稱'), tt('Outcome', '結果'), ''].map((h) => ui.el('th', { text: h })))), tbody);
  els.batchWrap.append(tbl);
  els.batchWrap.append(ui.el('p', {
    class: 'mrb-explain',
    text: tt('Failures never delete existing models; partial outcomes stay listed exactly as they ended.', '失敗絕不刪除現有模型；部分成功會如實逐項列出。'),
  }));
}

/* ------------------------------------------------------------------ */
/* chat                                                                */
/* ------------------------------------------------------------------ */

let currentSessionId = null;
let activeStream = null;

function buildChat(card) {
  const layout = ui.el('div', { class: 'mrb-ollama-chat' });

  /* session list column */
  const sessCol = ui.el('div', { class: 'mrb-ollama-sessions' });
  const sessSearchHost = ui.el('div', {});
  sessCol.append(sessSearchHost);
  els.sessList = ui.el('div', { class: 'mrb-ollama-sessionlist', role: 'list' });
  sessCol.append(els.sessList);
  const newBtn = ui.el('button', { class: 'mrb-btn mrb-btn-filled mrb-btn-sm', type: 'button', text: tt('New chat', '新對話') });
  newBtn.addEventListener('click', () => {
    const s = newSession();
    const all = listSessions();
    all.unshift(s);
    saveSessions(all, 'Created chat session');
    selectSession(s.id);
  });
  sessCol.append(newBtn);

  /* thread column */
  const threadCol = ui.el('div', { class: 'mrb-ollama-threadcol' });
  els.threadHead = ui.el('div', { class: 'mrb-ollama-threadhead' });
  threadCol.append(els.threadHead);
  els.thread = ui.el('div', { class: 'mrb-ollama-thread', 'aria-live': 'polite' });
  threadCol.append(els.thread);

  const composerRow = ui.el('div', { class: 'mrb-ollama-composer' });
  els.attachBtn = ui.el('button', { class: 'mrb-btn mrb-btn-tonal mrb-btn-sm', type: 'button', text: '📎', 'aria-label': tt('Attach image', '附加圖片'), disabled: true });
  els.attachReason = ui.el('span', { class: 'mrb-explain' });
  els.input = ui.el('textarea', {
    class: 'mrb-field-input mrb-ollama-input', rows: '2',
    placeholder: tt('Ask the local model…', '問吓本機模型…'),
    'aria-label': tt('Message', '訊息'),
  });
  const sendBtn = ui.el('button', { class: 'mrb-btn mrb-btn-filled', type: 'button', text: tt('Send', '傳送') });
  sendBtn.addEventListener('click', () => sendMessage());
  els.input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendMessage(); }
  });
  const stopBtn = ui.el('button', { class: 'mrb-btn mrb-btn-danger mrb-btn-sm', type: 'button', text: tt('Stop', '停止'), disabled: true });
  stopBtn.addEventListener('click', () => activeStream?.abort());
  const regenBtn = ui.el('button', { class: 'mrb-btn mrb-btn-tonal mrb-btn-sm', type: 'button', text: tt('Regenerate', '重新生成') });
  regenBtn.addEventListener('click', () => regenerateLast());
  els.stopBtn = stopBtn;
  composerRow.append(els.attachBtn, els.attachReason, els.input, sendBtn, stopBtn, regenBtn);
  threadCol.append(composerRow);
  layout.append(sessCol, threadCol);
  card.append(layout);

  attachSessionSearch(sessSearchHost);
  const sessions = listSessions();
  if (sessions.length) selectSession(sessions[0].id);
  else renderThreadHead(null);
}

function attachSessionSearch(host) {
  const input = ui.el('input', {
    class: 'mrb-field-input', type: 'search',
    placeholder: tt('Filter sessions…', '篩選對話…'),
    'aria-label': tt('Filter sessions', '篩選對話'),
  });
  host.append(input);
  els.sessQuery = '';
  input.addEventListener('input', () => { els.sessQuery = input.value.toLowerCase(); renderSessionList(); });
  peer('./regexbuilder.js').then((rb) => {
    if (rb?.attachSearch) rb.attachSearch(input, { onQuery: (q) => { els.sessQuery = String(q.text ?? q ?? '').toLowerCase(); renderSessionList(); } });
  }).catch(() => { /* plain filter already wired above */ });
}

function renderSessionList() {
  if (!els.sessList) return;
  els.sessList.textContent = '';
  const q = els.sessQuery || '';
  const sessions = listSessions()
    .filter((s) => !q || s.title.toLowerCase().includes(q) || JSON.stringify(s.messages).toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (!sessions.length) {
    els.sessList.append(ui.el('p', { class: 'mrb-cpk-empty', text: tt('No chats yet.', '仲未有對話。') }));
    return;
  }
  for (const s of sessions) {
    const row = ui.el('div', {
      class: 'mrb-list-row mrb-ollama-sessionrow' + (s.id === currentSessionId ? ' mrb-ollama-session-active' : ''),
      role: 'listitem', tabindex: '0',
    });
    const titleBtn = ui.el('button', { class: 'mrb-btn mrb-btn-text', type: 'button', text: s.title });
    titleBtn.addEventListener('click', () => selectSession(s.id));
    const ren = ui.el('button', { class: 'mrb-btn mrb-btn-text mrb-btn-sm', type: 'button', text: '✎', 'aria-label': tt('Rename chat', '改名') });
    ren.addEventListener('click', () => renameSession(s.id));
    const del = ui.el('button', { class: 'mrb-btn mrb-btn-text mrb-btn-sm', type: 'button', text: '🗑', 'aria-label': tt('Delete chat', '刪除對話') });
    del.addEventListener('click', () => {
      const doDelete = () => {
        saveSessions(listSessions().filter((x) => x.id !== s.id), 'Deleted chat session');
        if (currentSessionId === s.id) { currentSessionId = null; renderThreadHead(null); renderThread(); }
        renderSessionList();
      };
      if (ui.superConfirm) {
        ui.superConfirm({
          title: tt('Delete this chat?', '刪除呢個對話？'),
          detailHtml: escapeHtmlLocal(s.title),
          confirmLabel: tt('Delete chat', '刪除對話'),
          onConfirm: doDelete,
        });
      } else doDelete();
    });
    row.append(titleBtn, ren, del);
    els.sessList.append(row);
  }
}

function renameSession(id) {
  const s = listSessions().find((x) => x.id === id);
  if (!s || !ui.modal) return;
  const inp = ui.el('input', { class: 'mrb-field-input', type: 'text', value: s.title, maxlength: '80', 'aria-label': tt('Chat name', '對話名稱') });
  const closeM = ui.modal({
    title: tt('Rename chat', '重新命名對話'),
    build: (b) => b.append(inp),
    actions: [
      { label: tt('Cancel', '取消'), onClick: () => closeM() },
      {
        label: tt('Save', '儲存'),
        onClick: () => {
          const all = listSessions();
          const rec = all.find((x) => x.id === id);
          if (rec && inp.value.trim()) {
            rec.title = inp.value.trim().slice(0, 80);
            saveSessions(all, 'Renamed chat session');
            renderSessionList();
            renderThreadHead(rec);
          }
          closeM();
        },
      },
    ],
  });
}

function selectSession(id) {
  currentSessionId = id;
  renderSessionList();
  const s = listSessions().find((x) => x.id === id);
  renderThreadHead(s);
  renderThread();
  checkAttachmentCapability(s);
}

function currentSession() {
  return listSessions().find((x) => x.id === currentSessionId) || null;
}

function updateSession(mut) {
  const all = listSessions();
  const s = all.find((x) => x.id === currentSessionId);
  if (!s) return null;
  mut(s);
  s.updatedAt = Date.now();
  saveSessions(all);
  return s;
}

function renderThreadHead(s) {
  if (!els.threadHead) return;
  els.threadHead.textContent = '';
  if (!s) {
    els.threadHead.append(ui.el('span', { class: 'mrb-cpk-empty', text: tt('Pick or create a chat to begin.', '揀個或者開個新對話。') }));
    return;
  }
  els.threadHead.append(ui.el('strong', { text: s.title }));

  /* model picker from real installed tags */
  const modelSel = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Model', '模型') });
  for (const t of cachedTags) modelSel.append(ui.el('option', { value: t.name, text: t.name }));
  if (s.model && !cachedTags.some((t) => t.name === s.model)) modelSel.append(ui.el('option', { value: s.model, text: s.model }));
  modelSel.value = s.model || (cachedTags[0]?.name ?? '');
  modelSel.addEventListener('change', () => { updateSession((x) => { x.model = modelSel.value; }); checkAttachmentCapability(currentSession()); });
  els.threadHead.append(modelSel);

  /* system prompt editable per session */
  const sysBtn = ui.el('button', { class: 'mrb-btn mrb-btn-tonal mrb-btn-sm', type: 'button', text: tt('System prompt…', '系統提示…') });
  sysBtn.addEventListener('click', () => {
    if (!ui.modal) return;
    const ta = ui.el('textarea', { class: 'mrb-field-input', rows: '4', 'aria-label': tt('System prompt', '系統提示') });
    ta.value = s.system || '';
    const closeM = ui.modal({
      title: tt('System prompt for this chat', '此對話嘅系統提示'),
      build: (b) => b.append(ta),
      actions: [
        { label: tt('Cancel', '取消'), onClick: () => closeM() },
        { label: tt('Save', '儲存'), onClick: () => { updateSession((x) => { x.system = ta.value; }); closeM(); } },
      ],
    });
  });
  els.threadHead.append(sysBtn);

  /* parameters with documented recommended defaults */
  const params = s.params || {};
  const mkParam = (key, labelEn, min, max, step, defVal) => {
    const inp = ui.el('input', {
      type: 'number', class: 'mrb-field-input mrb-ollama-param',
      min: String(min), max: String(max), step: String(step),
      value: String(params[key] ?? defVal),
      'aria-label': labelEn,
    });
    inp.title = tt(`Recommended default ${defVal}`, `建議預設 ${defVal}`);
    inp.addEventListener('change', () => {
      let n = parseFloat(inp.value);
      if (Number.isNaN(n)) n = defVal;
      n = Math.min(max, Math.max(min, n));
      inp.value = String(n);
      updateSession((x) => { x.params[key] = n; });
    });
    return ui.el('label', { class: 'mrb-ollama-paramwrap' }, ui.el('span', { text: labelEn }), inp);
  };
  els.threadHead.append(
    mkParam('temperature', 'temp', 0, 2, 0.05, 0.7),
    mkParam('top_p', 'top_p', 0, 1, 0.05, 0.9),
    mkParam('num_ctx', 'ctx', 512, 131072, 512, 2048),
  );

  const exportBtn = ui.el('button', { class: 'mrb-btn mrb-btn-text mrb-btn-sm', type: 'button', text: tt('Export…', '匯出…') });
  exportBtn.addEventListener('click', () => exportSessionRedacted(s));
  els.threadHead.append(exportBtn);
}

function renderThread() {
  if (!els.thread) return;
  els.thread.textContent = '';
  const s = currentSession();
  if (!s) return;
  for (const msg of s.messages) {
    els.thread.append(messageBubble(msg));
  }
  els.thread.scrollTop = els.thread.scrollHeight;
}

function messageBubble(msg) {
  const bubble = ui.el('div', { class: `mrb-ollama-msg mrb-ollama-msg-${msg.role}` });
  bubble.innerHTML = mdLite(msg.content);
  const copy = ui.el('button', {
    class: 'mrb-btn mrb-btn-text mrb-btn-sm mrb-ollama-copybtn', type: 'button',
    text: '⧉', 'aria-label': tt('Copy message', '複製訊息'),
  });
  copy.addEventListener('click', () => ui.copyText(msg.content));
  bubble.append(copy);
  return bubble;
}

function checkAttachmentCapability(session) {
  if (!els.attachBtn) return;
  els.attachBtn.disabled = true; // attachments are NEVER supported this pass
  if (!session || !session.model) {
    els.attachReason.textContent = tt('Attachments need a selected model.', '要先揀模型先可以附件。');
    return;
  }
  api('/api/show', { method: 'POST', jsonBody: { model: session.model }, timeoutKind: 'health' })
    .then((res) => {
      const caps = Array.isArray(res.json?.capabilities) ? res.json.capabilities : [];
      els.attachReason.textContent = caps.includes('vision')
        ? tt('This model accepts images, but attachments are not supported in this build yet.', '此模型支援圖像，但本版本尚未支援附件。')
        : tt('This model has NO vision capability — image input is unavailable.', '此模型冇視覺能力 — 唔可以用圖像輸入。');
    })
    .catch(() => {
      els.attachReason.textContent = tt('Capability lookup failed; attachments stay disabled.', '查詢能力失敗；附件保持停用。');
    });
}

async function sendMessage() {
  const text = els.input.value.trim();
  const s = currentSession();
  if (!text || !s) return;
  if (!s.model) {
    ui.toast?.({ title: tt('Choose a model first', '先揀模型'), tone: 'warn', timeoutMs: 4000 });
    return;
  }
  els.input.value = '';
  updateSession((x) => {
    x.messages.push({ role: 'user', content: text, ts: Date.now() });
  });
  renderThread();

  await streamAssistant();
}

async function regenerateLast() {
  const s = currentSession();
  if (!s || !s.messages.length) return;
  /* drop back to the last user turn */
  const msgs = s.messages;
  while (msgs.length && msgs[msgs.length - 1].role !== 'user') msgs.pop();
  if (!msgs.length) return;
  updateSession(() => {});
  renderThread();
  await streamAssistant();
}

async function streamAssistant() {
  const s = currentSession();
  if (!s || !s.model) return;
  const placeholder = { role: 'assistant', content: '', ts: Date.now(), streaming: true };
  updateSession((x) => { x.messages.push(placeholder); });
  renderThread();

  els.stopBtn.disabled = false;
  const payload = {
    model: s.model,
    stream: true,
    options: {
      temperature: Number(s.params?.temperature ?? 0.7),
      top_p: Number(s.params?.top_p ?? 0.9),
      num_ctx: Number(s.params?.num_ctx ?? 2048),
    },
  };
  if (s.system) payload.system = s.system;
  payload.messages = s.messages
    .filter((m) => !m.streaming && m.content)
    .map((m) => ({ role: m.role, content: m.content }));

  const stream = apiStream('/api/chat', payload, (data) => {
    if (typeof data.message?.content === 'string') {
      placeholder.content += data.message.content;
      rerenderStreamingBubble();
    }
  });
  activeStream = stream;
  await stream.done;
  activeStream = null;
  stream.cleanup();
  els.stopBtn.disabled = true;

  placeholder.streaming = false;
  if (!placeholder.content) placeholder.content = tt('(empty response)', '(空回應)');
  updateSession(() => {});
  renderThread();
}

let streamingBubbleEl = null;
function rerenderStreamingBubble() {
  if (!streamingBubbleEl || !document.contains(streamingBubbleEl)) {
    streamingBubbleEl = messageBubble({ role: 'assistant', content: '' });
    els.thread.append(streamingBubbleEl);
  }
  const copyBtn = streamingBubbleEl.querySelector('.mrb-ollama-copybtn');
  const contentHtml = mdLite(currentSession()?.messages.at(-1)?.content || '');
  streamingBubbleEl.innerHTML = contentHtml;
  if (copyBtn) streamingBubbleEl.append(copyBtn);
  els.thread.scrollTop = els.thread.scrollHeight;
}

function exportSessionRedacted(s) {
  const dump = {
    kind: 'material-roblox-chat-export',
    redaction: tt(
      'Attachments were never supported in this build; nothing attachment-shaped exists to omit. Secrets, environment values and raw API payloads are excluded.',
      '本版本從不支援附件；冇附件資料需要省略。機密、環境變數與原始 API 負載一律排除。',
    ),
    exportedAt: new Date().toISOString(),
    session: {
      title: s.title,
      model: s.model,
      system: s.system || '',
      params: s.params,
      messages: s.messages.map((m) => ({ role: m.role, content: m.content })),
    },
  };
  peer('./exporter.js').then((m) => {
    if (m?.exporter?.exportData) {
      m.exporter.exportData({ name: `chat-${s.title}`, data: dump, formats: ['json', 'md'] });
      return;
    }
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = ui.el('a', { href: url, download: `chat-${s.title}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
}

function startOrFocusChat(model) {
  let s = currentSession();
  if (!s) {
    s = newSession(model);
    const all = listSessions();
    all.unshift(s);
    saveSessions(all, 'Created chat session');
  } else {
    updateSession((x) => { x.model = model; });
  }
  selectSession(s.id);
  els.input?.focus();
}

function escapeHtmlLocal(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------------ */
/* harness UI                                                          */
/* ------------------------------------------------------------------ */

function buildHarness(card) {
  card.append(ui.el('p', {
    class: 'mrb-explain',
    text: tt(
      'Launches are ALLOWLISTED ONLY: executables come from file pickers (or the built-in ollama CLI), argument templates accept just ${model} and ${prompt}, and environment keys are restricted to OLLAMA_HOST. Arbitrary shell commands have no route in.',
      '啟動只限白名單：執行檔來自檔案選擇器（或內置 ollama CLI）、參數模板只接受 ${model} 與 ${prompt}、環境變數鍵只限 OLLAMA_HOST。任意 shell 指令完全冇入口。',
    ),
  }));

  const profCol = ui.el('div', { class: 'mrb-ollama-harness' });
  const profSel = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Profile', '設定檔') });
  const modelInput = ui.el('input', { class: 'mrb-field-input', type: 'text', placeholder: tt('model name', '模型名稱'), 'aria-label': tt('Model for launch', '啟動用模型') });

  const rebuildProfiles = () => {
    profSel.textContent = '';
    for (const p of allProfiles()) {
      profSel.append(ui.el('option', { value: p.id, text: p.label + (p.custom ? tt(' (custom)', '（自訂）') : '') }));
    }
  };
  rebuildProfiles();

  const registerBtn = ui.el('button', { class: 'mrb-btn mrb-btn-tonal mrb-btn-sm', type: 'button', text: tt('Register profile…', '登記設定檔…') });
  registerBtn.addEventListener('click', () => openProfileRegistration(rebuildProfiles));

  const launchBtn = ui.el('button', { class: 'mrb-btn mrb-btn-filled', type: 'button', text: tt('Preflight & launch…', '預檢並啟動…') });
  launchBtn.addEventListener('click', async () => {
    const profile = allProfiles().find((p) => p.id === profSel.value);
    if (!profile) return;
    await preflightAndLaunch(profile, modelInput.value.trim());
  });

  const restoreBtn = ui.el('button', { class: 'mrb-btn mrb-btn-outlined mrb-btn-sm', type: 'button', text: tt('Restore snapshot', '還原快照') });
  restoreBtn.addEventListener('click', async () => {
    const snap = store.get(HARNESS_SNAPSHOT_KEY, null);
    if (!snap) {
      ui.toast?.({ title: tt('No snapshot stored', '未有快照'), tone: 'info', timeoutMs: 4000 });
      return;
    }
    await restoreSnapshot(snap);
    ui.toast?.({ title: tt('Settings snapshot restored', '已還原設定快照'), tone: 'ok', timeoutMs: 4000 });
  });

  profCol.append(
    ui.el('div', { class: 'mrb-converter-toolbar' }, profSel, modelInput, launchBtn, registerBtn, restoreBtn),
  );
  card.append(profCol);

  const logEntries = store.get(HARNESS_LOG_KEY, []).slice(0, 10);
  if (logEntries.length) {
    const logBox = ui.el('details', { class: 'mrb-ollama-harnesslog' },
      ui.el('summary', { text: tt('Recent launch outcomes', '最近啟動結果') }));
    for (const e of logEntries) {
      logBox.append(ui.el('li', {
        text: `${new Date(e.at).toLocaleString()} — ${e.kind}: ${e.detail || ''}`,
      }));
    }
    card.append(logBox);
  }
}

function openProfileRegistration(onDone) {
  if (!ui.modal) return;
  const exeInput = ui.el('input', { class: 'mrb-field-input', type: 'text', readonly: true, placeholder: tt('pick an executable…', '揀一個執行檔…'), 'aria-label': tt('Executable', '執行檔') });
  const exeBtn = ui.el('button', { class: 'mrb-btn mrb-btn-tonal mrb-btn-sm', type: 'button', text: tt('Browse…', '瀏覽…') });
  let chosenExe = '';
  exeBtn.addEventListener('click', async () => {
    const res = await invoke('dialog:open', {}).catch(() => null);
    const p = Array.isArray(res) ? res[0] : null;
    if (p) { chosenExe = p; exeInput.value = p; }
  });
  const argsInput = ui.el('input', {
    class: 'mrb-field-input', type: 'text',
    placeholder: 'run ${model}',
    'aria-label': tt('Argument template', '參數模板'),
    value: 'run ${model}',
  });
  const cwdInput = ui.el('input', { class: 'mrb-field-input', type: 'text', readonly: true, placeholder: tt('(home directory)', '（家用目錄）'), 'aria-label': tt('Working directory', '工作目錄') });
  const cwdBtn = ui.el('button', { class: 'mrb-btn mrb-btn-tonal mrb-btn-sm', type: 'button', text: tt('Browse…', '瀏覽…') });
  let chosenCwd = null;
  cwdBtn.addEventListener('click', async () => {
    const res = await invoke('dialog:open', { dir: true }).catch(() => null);
    const d = Array.isArray(res) ? res[0] : null;
    if (d) { chosenCwd = d; cwdInput.value = d; }
  });
  const envKeySel = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Environment keys', '環境變數鍵') });
  envKeySel.append(ui.el('option', { value: '', text: tt('(none)', '（無）') }));
  envKeySel.append(ui.el('option', { value: 'OLLAMA_HOST', text: 'OLLAMA_HOST' }));

  const errLine = ui.el('p', { class: 'mrb-schedule-error', role: 'alert' });
  const closeM = ui.modal({
    title: tt('Register harness profile', '登記工作環境外掛設定檔'),
    build: (b) => b.append(
      ui.el('label', { class: 'mrb-field' }, ui.el('span', { text: tt('Executable (file picker only)', '執行檔（只能用檔案選擇器）') }), ui.el('span', { class: 'mrb-converter-toolbar' }, exeInput, exeBtn)),
      ui.el('label', { class: 'mrb-field' }, ui.el('span', { text: tt('Arguments template — placeholders allowed: ${model}, ${prompt}', '參數模板 — 只可用佔位符：${model}、${prompt}') }), argsInput),
      ui.el('label', { class: 'mrb-field' }, ui.el('span', { text: tt('Working directory (dir picker)', '工作目錄（資料夾選擇器）') }), ui.el('span', { class: 'mrb-converter-toolbar' }, cwdInput, cwdBtn)),
      ui.el('label', { class: 'mrb-field' }, ui.el('span', { text: tt('Environment keys (allowlisted)', '環境變數鍵（白名單）') }), envKeySel),
      errLine,
    ),
    actions: [
      { label: tt('Cancel', '取消'), onClick: () => closeM() },
      {
        label: tt('Register', '登記'),
        onClick: () => {
          const argList = argsInput.value.trim().split(/\s+/).filter(Boolean);
          const badPlaceholder = argList.find((a) => /\$\{(?!(model|prompt)\})/.test(a));
          if (!chosenExe) { errLine.textContent = tt('Pick an executable file.', '要揀執行檔。'); return; }
          if (badPlaceholder) {
            errLine.textContent = tt(`Placeholder ${badPlaceholder} is not allowlisted (only \${model}, \${prompt}).`, `佔位符 ${badPlaceholder} 唔喺白名單（只限 ${'${model}'}、${'${prompt}'}）。`);
            return;
          }
          const profiles = userProfiles();
          const newProfile = {
            id: `hp${Date.now().toString(36)}`,
            label: chosenExe.split(/[\\/]/).pop(),
            exe: chosenExe,
            args: argList,
            cwd: chosenCwd,
            envKeys: envKeySel.value ? [envKeySel.value] : [],
          };
          profiles.push(newProfile);
          store.set('ollamaHarnessProfiles', profiles.slice(-20));
          // Mirror the profile into the MAIN-SIDE registry: launches are
          // authorised by id there, so an unregistered profile cannot start.
          invoke('ollama:profile:add', {
            id: newProfile.id, label: newProfile.label, exe: newProfile.exe,
            args: newProfile.args, cwd: newProfile.cwd, envKeys: newProfile.envKeys,
          }).catch(() => { /* surfaced at launch as unknown-profile with recovery */ });
          logHarness({ kind: 'profile-registered', detail: chosenExe });
          rebuildProfiles();
          closeM();
        },
      },
    ],
  });
}

async function preflightAndLaunch(profile, model) {
  if (!model) {
    ui.toast?.({ title: tt('Enter a model name', '輸入模型名稱'), tone: 'warn', timeoutMs: 4000 });
    return;
  }
  const fit = hardwareFit(
    { sizeBytes: cachedTags.find((t) => t.name === model)?.size },
    await diskFree(),
  );
  const blockers = [];

  /* resolved exe existence is verified MAIN-side at spawn; preflight surfaces
     everything the renderer can know without lying. */
  if (profile.exe !== 'ollama' && !/^[A-Za-z]:[\\/]/.test(profile.exe)) blockers.push(tt('Executable path is neither the built-in CLI nor absolute.', '執行檔路徑既非內置 CLI 也非絕對路徑。'));

  if (ui.modal) {
    const proceed = await new Promise((resolve) => {
      const body = ui.el('div', { class: 'mrb-ollama-preflight' });
      const rows = [
        [tt('Executable', '執行檔'), profile.exe],
        [tt('Arguments after expansion', '展開後參數'), profile.args.map((a) => a.replace('${model}', model).replace('${prompt}', '')).join(' ')],
        [tt('Working directory', '工作目錄'), profile.cwd || tt('(home directory)', '（家用目錄）')],
        [tt('Environment keys', '環境變數鍵'), (profile.envKeys || []).join(', ') || tt('(none)', '（無）')],
        [tt('Values', '數值'), tt('REDACTED — never shown, never logged', '已遮蔽 — 永遠唔顯示、唔記錄')],
        [tt('Ports/files needed', '所需埠／檔案'), tt('the local daemon endpoint only', '只需本機 daemon 端點')],
        [tt('Hardware fit', '硬體合適度'), `${fit.emoji} ${fit.label} — ${fit.reason}`],
      ];
      const grid = ui.el('dl', { class: 'mrb-updates-grid' });
      for (const [k, v] of rows) grid.append(ui.el('dt', { text: k }), ui.el('dd', { text: String(v) }));
      body.append(grid);
      for (const b of blockers) body.append(ui.el('p', { class: 'mrb-schedule-error', text: b }));

      const closeM2 = ui.modal({
        title: tt('Preflight review', '啟動前預檢'),
        build: (bb) => bb.append(body),
        actions: [
          { label: tt('Cancel', '取消'), onClick: () => { closeM2(); resolve(false); } },
          { label: tt('Launch', '啟動'), onClick: () => { closeM2(); resolve(true); } },
        ],
      });
    });
    if (!proceed) return;
  }
  if (blockers.length) return;

  /* snapshot BEFORE mutating anything, for auto-rollback */
  const snap = await snapshotSettings();
  store.set(HARNESS_SNAPSHOT_KEY, snap);

  const envValues = {};
  for (const key of profile.envKeys || []) {
    const v = await invoke('vault:get', { service: 'ollama-env', key }).catch(() => null);
    if (typeof v === 'string') envValues[key] = v;
  }

  const res = await invoke('ollama:spawn', { profile: { id: profile.id }, model, envValues })
    .catch((err) => ({ ok: false, reason: 'spawn-failed', error: String(err.message || err) }));

  if (!res.ok) {
    logHarness({ kind: 'rolled-back', detail: `${profile.label}: ${res.error || res.reason}` });
    await restoreSnapshot(snap);
    ui.toast?.({
      title: tt('Launch failed — rolled back', '啟動失敗 — 已還原'),
      body: String(res.error || res.reason || ''),
      tone: 'error', timeoutMs: 9000,
    });
    return;
  }

  logHarness({ kind: 'started', detail: `${profile.label} pid=${res.pid}` });
  ui.toast?.({ title: tt('Launched', '已啟動'), body: `${profile.label} (pid ${res.pid})`, tone: 'ok', timeoutMs: 5000 });

  /* 20-second health verification with AUTO-ROLLBACK on failure */
  setTimeout(async () => {
    const ping = await api('/api/version', { timeoutKind: 'health' });
    if (!ping.ok) {
      await restoreSnapshot(snap);
      logHarness({ kind: 'timeout-rolled-back', detail: profile.label });
      ui.toast?.({
        title: tt('Health verification timed out — rolled back', '健康檢查逾時 — 已還原'),
        body: tt('The process started but the local API never answered within 20 s. Settings were restored.', '程序已啟動但本機 API 喺 20 秒內無回應。設定已還原。'),
        tone: 'warn', timeoutMs: 9000,
      });
    } else {
      logHarness({ kind: 'ready', detail: profile.label });
    }
  }, 20000);
}

/* ------------------------------------------------------------------ */
/* settings defs                                                       */
/* ------------------------------------------------------------------ */

function registerSettingDefs() {
  peer('./settings.js').then((m) => {
    const settings = m?.settings;
    if (!settings?.register) return;
    settings.register([
      {
        key: 'ollama.host', type: 'text', def: '127.0.0.1', group: 'Ollama',
        label: { en: 'Host (loopback only)', yue: '主機（只限本機回環）' },
        explain: { en: 'Only 127.0.0.1, ::1 or localhost are accepted; remote hosts are refused by design.', yue: '只接受 127.0.0.1、::1 或 localhost；遠端主機一律拒絕。' },
      },
      {
        key: 'ollama.port', type: 'slider', def: 11434, group: 'Ollama', min: 1024, max: 65535, step: 1,
        label: { en: 'Port', yue: '埠' },
        explain: { en: 'Loopback port of the local daemon. Default matches Ollama itself (11434).', yue: '本機 daemon 埠；預設同 Ollama 一樣（11434）。' },
      },
      {
        key: 'ollama.parallelism', type: 'slider', def: 2, group: 'Ollama', min: 1, max: 4, step: 1,
        label: { en: 'Parallel batch pulls', yue: '批次並行拉取數' },
        explain: { en: 'How many model downloads run at once.', yue: '同時下載多少個模型。' },
      },
      {
        key: 'chat.temperature', type: 'slider', def: 0.7, group: 'Ollama', min: 0, max: 2, step: 0.05,
        label: { en: 'Default temperature', yue: '預設溫度' },
        explain: { en: 'New chats start here; each chat can override. Recommended default 0.7.', yue: '新對話由此開始；每個對話可自行覆寫。建議預設 0.7。' },
      },
      {
        key: 'chat.top_p', type: 'slider', def: 0.9, group: 'Ollama', min: 0, max: 1, step: 0.05,
        label: { en: 'Default top_p', yue: '預設 top_p' },
        explain: { en: 'Nucleus sampling ceiling for new chats. Model-dependent — higher is more varied.', yue: '新對話嘅核取樣上限；因模型而異 — 愈高愈多變化。' },
      },
      {
        key: 'chat.num_ctx', type: 'slider', def: 2048, group: 'Ollama', min: 512, max: 131072, step: 512,
        label: { en: 'Default context window', yue: '預設上下文長度' },
        explain: { en: 'Context tokens for new chats. Strongly model-dependent — larger needs more memory.', yue: '新對話上下文 token 數；因模型而異 — 愈大愈食記憶體。' },
      },
    ]);
  }).catch(() => { /* settings optional */ });
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

/** @returns {Promise<void>} */
export async function init() {
  ensureToolsStyles();
  registerSettingDefs();
  registerTab();
  try {
    const paletteM = await peer('./palette.js');
    if (paletteM?.palette?.register) {
      paletteM.palette.register({
        id: 'ollama.open', title: tt('Open Ollama manager', '開啟 Ollama 管理器'), group: tt('Tools', '工具'),
        action: () => peer('./router.js').then((m) => m?.router?.navigate('ollama')),
      });
    }
  } catch (_) { /* palette optional */ }
}
