/**
 * vscode.js — VS Code integration (Lane E).
 *
 * The `vscode:open` channel and its install detection live in Lane A's shell
 * handler; this module is the renderer-side consumer so exports, history
 * snapshots and app-data folders can be handed to VS Code as a workspace root.
 *
 * Availability is learned from the channel itself: a successful open marks VS
 * Code present, `{ok:false,reason:'not-installed'}` marks it absent, and the
 * verdict is cached for the session. When it is missing the user gets an honest
 * toast with the official download link — never a silent failure and never a
 * different editor opened on their behalf.
 */

import { ui } from './ui.js';
import { i18n } from './i18n.js';

function tt(en, yue) {
  try {
    if (i18n.schoolActive()) return en;
    const mode = i18n.lang();
    if (mode === 'yue' && yue) return yue;
    if (mode === 'bi' && yue) return `${en} · ${yue}`;
  } catch (_) { /* English always correct */ }
  return en;
}

const DOWNLOAD_URL = 'https://code.visualstudio.com/';

/** @type {boolean|null} null = never probed */
let availabilityCache = null;

/**
 * Best-known availability of VS Code. Cached from the last open attempt;
 * `null` until the first probe.
 * @returns {boolean|null}
 */
export function isAvailable() {
  return availabilityCache;
}

async function invokeOpen(payload) {
  if (!window.mrb || typeof window.mrb.invoke !== 'function') {
    throw new Error(tt('Shell bridge unavailable.', '殼層橋接不可用。'));
  }
  try {
    return await window.mrb.invoke('vscode:open', payload);
  } catch (err) {
    /* Channel missing entirely (older build) reads as not-installed-plus-blocker */
    return { ok: false, reason: 'channel-unavailable', error: String((err && err.message) || err) };
  }
}

function notInstalledToast() {
  availabilityCache = false;
  ui.toast?.({
    title: tt('VS Code not found', '搵唔到 VS Code'),
    body: tt(
      'Nothing was opened. Install Visual Studio Code to use this action:',
      '未有嘢被打開。安裝 Visual Studio Code 就可以用呢個功能：',
    ) + ' ' + DOWNLOAD_URL,
    tone: 'warn',
    timeoutMs: 10000,
    actions: [{
      label: tt('Open download page', '開啟下載頁'),
      onClick: () => { window.mrb?.invoke?.('shell:openExternal', { url: DOWNLOAD_URL }); },
    }],
  });
}

/**
 * Open a folder as a workspace root in VS Code.
 * @param {string} path absolute folder path
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function openFolder(path) {
  if (!path || typeof path !== 'string') {
    return { ok: false, reason: 'bad-path' };
  }
  const res = await invokeOpen({ path, kind: 'folder' });
  if (res && res.ok) {
    availabilityCache = true;
    return { ok: true };
  }
  const reason = (res && res.reason) || 'error';
  if (reason === 'not-installed') notInstalledToast();
  else {
    ui.toast?.({
      title: tt('Could not open in VS Code', '開唔到 VS Code'),
      body: String((res && (res.error || res.reason)) || ''),
      tone: 'error', timeoutMs: 8000,
    });
  }
  return { ok: false, reason };
}

/**
 * Open a single file in VS Code.
 * @param {string} path absolute file path
 */
export async function openFile(path) {
  if (!path || typeof path !== 'string') return { ok: false, reason: 'bad-path' };
  const res = await invokeOpen({ path, kind: 'file' });
  if (res && res.ok) {
    availabilityCache = true;
    return { ok: true };
  }
  const reason = (res && res.reason) || 'error';
  if (reason === 'not-installed') notInstalledToast();
  else {
    ui.toast?.({
      title: tt('Could not open in VS Code', '開唔到 VS Code'),
      body: String((res && (res.error || res.reason)) || ''),
      tone: 'error', timeoutMs: 8000,
    });
  }
  return { ok: false, reason };
}

/**
 * Ask the shell to reveal the app's own data directory as a workspace root.
 * The userData path is resolved main-side; this payload carries the logical
 * target only, never a guessed absolute path.
 */
export async function openAppData() {
  const res = await invokeOpen({ target: 'userData' });
  if (res && res.ok) {
    availabilityCache = true;
    return { ok: true };
  }
  const reason = (res && res.reason) || 'error';
  if (reason === 'not-installed') notInstalledToast();
  else if (reason === 'unsupported' || reason === 'channel-unavailable') {
    ui.toast?.({
      title: tt('Not available in this build', '呢個版本未支援'),
      body: tt('The installed shell does not expose the app-data target yet.', '目前殼層仲未提供應用程式資料夾目標。'),
      tone: 'info', timeoutMs: 7000,
    });
  } else {
    ui.toast?.({
      title: tt('Could not open in VS Code', '開唔到 VS Code'),
      body: String((res && (res.error || res.reason)) || ''),
      tone: 'error', timeoutMs: 8000,
    });
  }
  return { ok: false, reason };
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

/** @returns {Promise<void>} */
export async function init() {
  try {
    const paletteM = await import('./palette.js').catch(() => null);
    const routerM = await import('./router.js').catch(() => null);
    if (paletteM && paletteM.palette && typeof paletteM.palette.register === 'function') {
      paletteM.palette.register({
        id: 'vscode.openAppData',
        title: tt('Open app data in VS Code', '喺 VS Code 開啟應用程式資料'),
        group: tt('Tools', '工具'),
        keywords: ['vs code', 'editor', 'appdata'],
        action: () => { openAppData(); },
      });
    }
    if (routerM && routerM.router && typeof routerM.router.navigate === 'function' && paletteM && paletteM.palette) {
      paletteM.palette.register({
        id: 'vscode.status',
        title: tt('Check VS Code availability', '檢查 VS Code 可用性'),
        group: tt('Tools', '工具'),
        keywords: ['vs code', 'detect'],
        control: (rowEl) => {
          const chip = ui.el('span', {
            class: 'mrb-chip',
            text: isAvailable() == null ? tt('unknown yet', '未知') : (isAvailable() ? tt('installed ✓', '已安裝 ✓') : tt('not found ✗', '搵唔到 ✗')),
          });
          rowEl.append(chip);
        },
        teleport: 'settings',
      });
    }
  } catch (_) { /* optional peers degrade alone */ }
}
