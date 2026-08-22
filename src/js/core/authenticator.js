'use strict';

/**
 * Built-in TOTP authenticator ("Authenticator" tab).
 *
 * Security posture implemented here:
 *  - Seeds are generated or pasted ONCE and immediately stored through the
 *    `totp:*` main-process handlers into OS-backed encrypted storage. They
 *    NEVER enter localStorage, exports, logs, or telemetry.
 *  - Pairing confirmation is mandatory: an entry exists only after ONE live
 *    code verifies against it; otherwise the stored seed is deleted and the
 *    user is told so plainly.
 *  - There is deliberately NO secrets export anywhere in this app. Exports of
 *    entries are redacted (no seeds), say so in the payload, and carry a
 *    `-redacted` filename suffix. Absence IS the safeguard — stated in the
 *    in-app help popover rather than hidden.
 *  - The QR image-file scan route ships visibly DISABLED with the exact
 *    reason, because decoding QR bitmaps in-app would need a heavy detector;
 *    paste-the-URI and manual entry cover the same need honestly.
 */

import { store } from './store.js';
import { i18n } from './i18n.js';
import { ui } from './ui.js';
import * as qr from './qr.js';

const ENTRIES_KEY = 'mrb:authEntries';
const GROUP_KEY = 'mrb:auth.groupByIssuer';

let routerMod = null;
let paletteMod = null;
let settingsMod = null;
let exporterMod = null;
let regexbuilderMod = null;
let locksMod = null;

/** @type {Array<any>} */
let entries = [];
/** @type {Map<string,{code:string,nextCode:string,secondsRemaining:number}>} */
const codeCache = new Map();
let ticker = null;
let searchController = null;
let searchQuery = '';
let currentPanel = null;

function ipc(channel, payload) {
  try {
    if (window.mrb && typeof window.mrb.invoke === 'function') {
      return window.mrb.invoke(channel, payload);
    }
  } catch {
    /* bridge missing */
  }
  return Promise.reject(new Error('The app bridge is unavailable.'));
}

function tr(key, en, yue) {
  try {
    const out = i18n.t(key);
    if (out && out !== key) return out;
  } catch {
    /* catalogs unavailable */
  }
  let lang = 'en';
  try {
    lang = i18n.lang();
  } catch {
    /* default English */
  }
  if (lang === 'yue' && typeof yue === 'string') return yue;
  if (lang === 'bi' && typeof yue === 'string') return `${en} · ${yue}`;
  return en;
}

function getSetting(path, fallback) {
  if (settingsMod && settingsMod.settings) {
    try {
      const v = settingsMod.settings.get(path, fallback);
      if (v !== undefined) return v;
    } catch {
      /* fall through */
    }
  }
  const stored = store.get(`mrb:setting:${path}`, fallback);
  return stored === undefined ? fallback : stored;
}

// ---------------------------------------------------------------------------
// Base32 + URI helpers
// ---------------------------------------------------------------------------

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function randomB32(bytes = 20) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function normalizeBase32Input(raw) {
  return String(raw == null ? '' : raw).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
}

function isValidBase32(s) {
  return /^[A-Z2-7]{16,}$/.test(s);
}

/**
 * Parse an otpauth://totp/ URI honoring issuer/account/secret/algorithm/
 * digits/period, applying the documented defaults sha1/6/30.
 */
export function parseOtpauth(uri) {
  const text = String(uri || '').trim();
  const match = /^otpauth:\/\/totp\/([^?]*)\??(.*)$/i.exec(text);
  if (!match) throw new Error('That does not look like an otpauth://totp/ URI.');
  const [, labelPart, queryPart] = match;
  let issuer = '';
  let account = '';
  const decodedLabel = decodeURIComponent(labelPart || '');
  const colon = decodedLabel.indexOf(':');
  if (colon >= 0) {
    issuer = decodedLabel.slice(0, colon).trim();
    account = decodedLabel.slice(colon + 1).trim();
  } else {
    account = decodedLabel.trim();
  }
  const params = {};
  for (const pair of queryPart.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    params[decodeURIComponent(pair.slice(0, eq)).toLowerCase()] = decodeURIComponent(pair.slice(eq + 1));
  }
  if (!params.secret) throw new Error('The URI carries no secret parameter.');
  const secret = normalizeBase32Input(params.secret);
  if (!isValidBase32(secret)) throw new Error('The secret parameter is not valid base32.');
  const algo = String(params.algorithm || 'sha1').toLowerCase();
  if (!['sha1', 'sha256', 'sha512'].includes(algo)) throw new Error('Unsupported algorithm in URI.');
  const digits = Number(params.digits || 6);
  if (![6, 7, 8].includes(digits)) throw new Error('Unsupported digit count in URI.');
  const period = Math.round(Number(params.period || 30));
  if (!Number.isInteger(period) || period < 1 || period > 3600) throw new Error('Unsupported period in URI.');
  const queryIssuer = String(params.issuer || '').trim();
  if (!issuer && queryIssuer) issuer = queryIssuer;
  return { issuer, account, secret, algo, digits, period };
}

function buildOtpauthUri({ issuer, account, secret, algo, digits, period }) {
  const label = issuer ? `${encodeURIComponent(issuer)}:${encodeURIComponent(account || '')}` : encodeURIComponent(account || '');
  const query = new URLSearchParams({
    secret,
    digits: String(digits),
    period: String(period),
    algorithm: algo.toUpperCase(),
  });
  if (issuer) query.set('issuer', issuer);
  return `otpauth://totp/${label}?${query.toString()}`;
}

function groupDigits(code) {
  const c = String(code || '');
  if (c.length === 8) return `${c.slice(0, 4)} ${c.slice(4)}`;
  return c.replace(/(\d{3})(?=\d)/g, '$1 ');
}

function groupSecret(secret) {
  return String(secret || '').replace(/(.{4})/g, '$1 ').trim();
}

function loadEntries() {
  const raw = store.get(ENTRIES_KEY, []);
  entries = Array.isArray(raw) ? raw.filter((e) => e && typeof e.entryId === 'string') : [];
}

function saveEntries() {
  // Metadata only — this store must never contain a seed.
  store.set(ENTRIES_KEY, entries);
}

function newEntryId() {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return `a:${[...buf].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function clockOffsetSec() {
  const v = Number(getSetting('auth.clockOffsetSec', 0));
  return Number.isFinite(v) ? v : 0;
}

async function fetchCode(entry) {
  try {
    const res = await ipc('totp:code', { entryId: entry.entryId, offsetSec: clockOffsetSec() });
    if (res && res.ok) {
      codeCache.set(entry.entryId, {
        code: res.code,
        nextCode: res.nextCode,
        secondsRemaining: res.secondsRemaining,
      });
      return codeCache.get(entry.entryId);
    }
  } catch {
    /* offline vault or missing entry renders as dashes below */
  }
  return null;
}

// ---------------------------------------------------------------------------
// List surface
// ---------------------------------------------------------------------------

let liveRegion = null;

function ensureLiveRegion() {
  if (liveRegion || !document.body) return;
  liveRegion = ui.el('div', { class: 'mrb-sr-only', 'aria-live': 'polite' });
  document.body.appendChild(liveRegion);
}

function visibleEntries() {
  let list = entries.slice();
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    list = list.filter((e) =>
      `${e.issuer || ''} ${e.account || ''}`.toLowerCase().includes(q)
    );
  }
  return list;
}

function ringSvg(secondsRemaining, period) {
  const NS = 'http://www.w3.org/2000/svg';
  const size = 28;
  const r = 11;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, secondsRemaining / period));
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'mrb-auth-ring');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS(NS, 'circle');
  track.setAttribute('cx', String(size / 2));
  track.setAttribute('cy', String(size / 2));
  track.setAttribute('r', String(r));
  track.setAttribute('class', 'mrb-auth-ring-track');
  const bar = document.createElementNS(NS, 'circle');
  bar.setAttribute('cx', String(size / 2));
  bar.setAttribute('cy', String(size / 2));
  bar.setAttribute('r', String(r));
  bar.setAttribute('class', 'mrb-auth-ring-bar');
  bar.style.strokeDasharray = `${c}`;
  bar.style.strokeDashoffset = `${c * (1 - frac)}`;
  svg.append(track, bar);
  return svg;
}

function renderRow(entry) {
  const row = ui.el('li', { class: 'mrb-list-row mrb-auth-row', 'data-entry-row': entry.entryId });

  const tile = ui.el('span', { class: 'mrb-auth-tile', 'aria-hidden': 'true' });
  tile.textContent = (entry.issuer || entry.account || '?').trim().charAt(0).toUpperCase();

  const nameWrap = ui.el('div', { class: 'mrb-auth-names' });
  const nameLine = ui.el('span', { class: 'mrb-auth-name' });
  nameLine.textContent = entry.issuer || tr('auth.unnamedEntry', '(unnamed)');
  const acctLine = ui.el('span', { class: 'mrb-auth-account' });
  acctLine.textContent = entry.account || '';
  nameWrap.append(nameLine, acctLine);

  const codeWrap = ui.el('div', { class: 'mrb-auth-codewrap' });
  const codeEl = ui.el('span', { class: 'mrb-auth-code' });
  const secsEl = ui.el('span', { class: 'mrb-auth-secs', role: 'timer' });
  const ringHolder = ui.el('span', { class: 'mrb-auth-ringholder' });
  codeWrap.append(codeEl, secsEl, ringHolder);

  const peekBtn = ui.el('button', {
    class: 'mrb-btn mrb-btn--text mrb-auth-min',
    type: 'button',
    onclick: async () => {
      const cached = codeCache.get(entry.entryId);
      if (cached) peekOut.textContent = `${tr('auth.next', 'Next:')} ${groupDigits(cached.nextCode)}`;
      const fresh = await fetchCode(entry);
      if (fresh) peekOut.textContent = `${tr('auth.next', 'Next:')} ${groupDigits(fresh.nextCode)}`;
    },
  });
  peekBtn.textContent = tr('auth.peekNext', 'Next');
  const peekOut = ui.el('span', { class: 'mrb-auth-nextpeek', 'aria-live': 'off' });

  const copyBtn = ui.el('button', {
    class: 'mrb-btn mrb-btn--tonal mrb-auth-min',
    type: 'button',
    onclick: async () => {
      const cached = codeCache.get(entry.entryId) || (await fetchCode(entry));
      if (!cached) return;
      try {
        await ui.copyText(cached.code);
        ui.toast({ title: tr('auth.copied', 'Code copied.', '已複製驗證碼。'), tone: 'ok', timeoutMs: 3000 });
      } catch {
        ui.toast({ title: tr('auth.copyFail', 'Copy failed.', '複製唔到。'), tone: 'error' });
      }
    },
  });
  copyBtn.textContent = tr('auth.copy', 'Copy');

  const editBtn = ui.el('button', {
    class: 'mrb-btn mrb-btn--text mrb-auth-min',
    type: 'button',
    onclick: () => openEditor(entry),
  });
  editBtn.textContent = tr('auth.edit', 'Edit');

  const delBtn = ui.el('button', {
    class: 'mrb-btn mrb-btn--text mrb-auth-danger mrb-auth-min',
    type: 'button',
    onclick: () => {
      ui.superConfirm({
        title: tr('auth.deleteTitle', `Delete “${entry.issuer || entry.account}”?`, `刪除「${entry.issuer || entry.account}」？`),
        detailHtml: tr(
          'auth.deleteDetail',
          'This removes the stored seed permanently. Codes for this entry stop working immediately.',
          '會永久刪除儲存咗嘅密鑰，即刻失效，冇得返轉頭。'
        ),
        confirmLabel: tr('auth.deleteConfirm', 'Delete entry', '刪除條目'),
        onConfirm: async () => {
          try {
            await ipc('totp:remove', { entryId: entry.entryId });
          } catch {
            /* seed may already be gone; metadata cleanup continues */
          }
          entries = entries.filter((e) => e.entryId !== entry.entryId);
          saveEntries();
          codeCache.delete(entry.entryId);
          renderCurrent();
        },
      });
    },
  });
  delBtn.textContent = tr('auth.delete', 'Delete');

  const upDown = ui.el('span', { class: 'mrb-auth-reorder' });
  const mkMove = (delta, glyph, label) =>
    ui.el(
      'button',
      {
        class: 'mrb-btn mrb-btn--text mrb-auth-min',
        type: 'button',
        'aria-label': `${label} ${(entry.issuer || entry.account || '')}`,
        onclick: () => {
          const idx = entries.findIndex((e) => e.entryId === entry.entryId);
          const to = idx + delta;
          if (idx < 0 || to < 0 || to >= entries.length) return;
          const [moved] = entries.splice(idx, 1);
          entries.splice(to, 0, moved);
          saveEntries();
          renderCurrent();
        },
      },
      glyph
    );
  upDown.append(mkMove(-1, '↑', tr('auth.moveUp', 'Move up')), mkMove(1, '↓', tr('auth.moveDown', 'Move down')));

  const select = ui.el('input', {
    type: 'checkbox',
    class: 'mrb-auth-select',
    'data-bulk-id': entry.entryId,
    'aria-label': tr('auth.selectForBulk', `Select ${entry.issuer || entry.account} for bulk action`, `揀「${entry.issuer || entry.account}」做批次操作`),
  });

  const paint = () => {
    const cached = codeCache.get(entry.entryId);
    if (!cached) {
      codeEl.textContent = '– – –  – – –';
      secsEl.textContent = '';
      ringHolder.textContent = '';
      return;
    }
    codeEl.textContent = groupDigits(cached.code);
    secsEl.textContent = `${cached.secondsRemaining}s`;
    ringHolder.textContent = '';
    ringHolder.appendChild(ringSvg(cached.secondsRemaining, entry.period || 30));
    // Announce a rolled code ONLY while this row has focus, and politely.
    const active = document.activeElement instanceof Element ? document.activeElement : null;
    const focusedRow = active && active.closest('[data-entry-row]');
    if (
      focusedRow &&
      focusedRow.getAttribute('data-entry-row') === entry.entryId &&
      liveRegion &&
      secsEl.dataset.lastCode !== cached.code
    ) {
      liveRegion.textContent = `${entry.issuer || ''} ${tr('auth.newCode', 'new code', '新驗證碼')} ${groupDigits(cached.code)}`;
    }
    secsEl.dataset.lastCode = cached.code;
  };
  paint();

  row.append(select, tile, nameWrap, codeWrap, peekBtn, peekOut, copyBtn, editBtn, delBtn, upDown);
  row._paint = paint;
  return row;
}

function renderCurrent() {
  if (currentPanel && typeof currentPanel.render === 'function') currentPanel.render(currentPanel.el);
}

function renderList(bodyEl) {
  bodyEl.textContent = '';
  const wrap = ui.el('div', { class: 'mrb-auth-listwrap' });

  // Search bar wired to the shared regex builder when available.
  const searchWrap = ui.el('div', { class: 'mrb-field mrb-field--row mrb-auth-searchrow' });
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'mrb-field__input';
  search.placeholder = tr('auth.searchPlaceholder', 'Search entries…', '搜尋條目…');
  search.setAttribute('aria-label', tr('auth.searchLabel', 'Search authenticator entries', '搜尋驗證器條目'));
  search.value = searchQuery;
  search.addEventListener('input', () => {
    searchQuery = search.value;
    paintRows();
  });
  searchWrap.appendChild(search);
  if (regexbuilderMod && typeof regexbuilderMod.attachSearch === 'function') {
    try {
      searchController = regexbuilderMod.attachSearch(search, {
        onQuery: (q) => {
          searchQuery = q.plain != null ? q.plain : q.raw || search.value;
          paintRows();
        },
      });
    } catch {
      /* builder unavailable: plain filtering above keeps working */
    }
  }

  const groupToggleId = 'mrb-auth-groupby';
  const groupToggle = document.createElement('input');
  groupToggle.type = 'checkbox';
  groupToggle.className = 'mrb-switch';
  groupToggle.id = groupToggleId;
  groupToggle.checked = !!store.get(GROUP_KEY, false);
  const groupLabel = ui.el('label', { class: 'mrb-auth-grouplabel', for: groupToggleId });
  groupLabel.textContent = tr('auth.groupByIssuer', 'Group by issuer', '按服務分組');
  groupToggle.addEventListener('change', () => {
    store.set(GROUP_KEY, groupToggle.checked);
    paintRows();
  });
  searchWrap.append(groupToggle, groupLabel);

  const rowsHolder = ui.el('ul', { class: 'mrb-list mrb-auth-list', role: 'list' });
  const paintRows = () => {
    rowsHolder.textContent = '';
    let list = visibleEntries();
    if (list.length === 0) {
      const empty = ui.el('li', { class: 'mrb-auth-empty' });
      empty.textContent =
        entries.length === 0
          ? tr('auth.emptyAll', 'No authenticator entries yet — add one above.', '仲未有條目——喺上面加一個啦。')
          : tr('auth.emptyFiltered', 'No entries match that search.', '冇條目符合搜尋。');
      rowsHolder.appendChild(empty);
      updateBulkBar();
      return;
    }
    if (groupToggle.checked) {
      const groups = new Map();
      for (const e of list) {
        const g = e.issuer || tr('auth.noIssuer', '(no issuer)');
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(e);
      }
      for (const [name, groupEntries] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const head = ui.el('li', { class: 'mrb-auth-grouphead' });
        head.textContent = name;
        rowsHolder.appendChild(head);
        for (const e of groupEntries) rowsHolder.appendChild(renderRow(e));
      }
    } else {
      for (const e of list) rowsHolder.appendChild(renderRow(e));
    }
    updateBulkBar();
  };
  paintRows();

  // Bulk bar
  const bulkBar = ui.el('div', { class: 'mrb-auth-bulkbar' });
  const countBadge = ui.el('span', { class: 'mrb-badge' });
  const delSelected = ui.el('button', { class: 'mrb-btn mrb-btn--danger', type: 'button', disabled: true });
  delSelected.textContent = tr('auth.bulkDelete', 'Delete selected…', '刪除所選…');
  delSelected.addEventListener('click', () => {
    const ids = [...rowsHolder.querySelectorAll('input[data-bulk-id]:checked')].map((elNode) => elNode.getAttribute('data-bulk-id'));
    if (ids.length === 0) return;
    ui.superConfirm({
      title: tr('auth.bulkTitle', `Delete ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'}?`, `刪除 ${ids.length} 個條目？`),
      detailHtml: tr(
        'auth.bulkDetail',
        'Their stored seeds are removed permanently and their codes stop working.',
        '相關密鑰會永久刪除，驗證碼即刻失效。'
      ),
      confirmLabel: tr('auth.bulkConfirm', 'Delete selected', '刪除所選'),
      onConfirm: async () => {
        for (const id of ids) {
          try {
            await ipc('totp:remove', { entryId: id });
          } catch {
            /* continue cleaning metadata regardless */
          }
        }
        entries = entries.filter((e) => !ids.includes(e.entryId));
        saveEntries();
        ids.forEach((id) => codeCache.delete(id));
        renderCurrent();
      },
    });
  });
  // Function declaration, not a const arrow: renderList() above calls this
  // during first paint, so it must be hoisted or the tab dies on load (TDZ).
  function updateBulkBar() {
    const checked = rowsHolder.querySelectorAll('input[data-bulk-id]:checked').length;
    countBadge.textContent = tr('auth.selectedCount', `${checked} selected`, `已揀 ${checked} 個`);
    delSelected.disabled = checked === 0;
  }
  rowsHolder.addEventListener('change', updateBulkBar);
  bulkBar.append(countBadge, delSelected);

  // Export (redacted)
  const exportBtn = ui.el('button', { class: 'mrb-btn mrb-btn--outlined', type: 'button' });
  exportBtn.textContent = tr('auth.export', 'Export (redacted)…', '匯出（已隱去密鑰）…');
  exportBtn.addEventListener('click', () => exportRedacted());
  const helpBtn = ui.el('button', { class: 'mrb-btn mrb-btn--text', type: 'button' });
  helpBtn.textContent = tr('auth.aboutSecrets', 'Why is there no secrets backup?', '點解冇密鑰備份？');
  helpBtn.addEventListener('click', (event) => {
    const panel = ui.el('div', { class: 'mrb-card mrb-auth-helppanel', role: 'dialog', 'aria-label': tr('auth.helpTitle', 'About secret backups', '關於密鑰備份') });
    panel.textContent = tr(
      'auth.helpBody',
      'There is no secrets export anywhere in this app — not behind a confirmation, not in a file menu, nowhere. That absence is the safeguard: a seed can leave this computer only by being re-enrolled somewhere by you. Every entry export is redacted and says so.',
      '成個應用程式都冇任何密鑰匯出——唔係收埋喺確認框後面，而係真係冇呢個功能。冇咗匯出途徑，密鑰只可以由你親自重新登記先會離開呢部電腦。所有條目匯出都已隱去密鑰，並且會講明。'
    );
    const anchor = event.target instanceof Element ? event.target : bodyEl;
    ui.anchored(anchor, panel, {});
  });

  wrap.append(searchWrap, rowsHolder, bulkBar, exportBtn, helpBtn);
  bodyEl.appendChild(wrap);
}

async function exportRedacted() {
  const statement = tr(
    'auth.exportStatement',
    'REDACTED EXPORT — TOTP secrets are intentionally omitted. This file cannot restore entries.',
    '已隱去密鑰嘅匯出——刻意唔包含 TOTP 密鑰，呢個檔案唔可以還原條目。'
  );
  const rows = visibleEntries().map((e) => ({
    issuer: e.issuer || '',
    account: e.account || '',
    algorithm: e.algo || 'sha1',
    digits: e.digits || 6,
    period: e.period || 30,
    createdAt: new Date(e.createdAt || Date.now()).toISOString(),
  }));

  if (exporterMod && exporterMod.exporter && typeof exporterMod.exporter.exportData === 'function') {
    try {
      await exporterMod.exporter.exportData({
        name: 'material-roblox-authenticator-redacted',
        data: { notice: statement, entries: rows },
        rows,
        formats: ['json', 'csv'],
      });
      return;
    } catch {
      /* fall through to clipboard fallback */
    }
  }
  try {
    await ui.copyText(JSON.stringify({ notice: statement, entries: rows }, null, 2));
    ui.toast({
      title: tr('auth.exportCopied', 'Redacted export copied to the clipboard (export module unavailable).', '已將隱去密鑰嘅匯出複製到剪貼簿（匯出模組用唔到）。'),
      tone: 'ok',
      timeoutMs: 6000,
    });
  } catch {
    ui.toast({ title: tr('auth.exportFail', 'Export failed.', '匯出失敗。'), tone: 'error' });
  }
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

function openEditor(entry) {
  const panel = ui.el('div', { class: 'mrb-card mrb-auth-editor', role: 'dialog' });
  const title = ui.el('h4', {});
  title.textContent = tr('auth.editTitle', `Edit “${entry.issuer || entry.account}”`, `編輯「${entry.issuer || entry.account}」`);

  const mkField = (labelText, value, attrs = {}) => {
    const id = `mrb-ed-${Math.random().toString(36).slice(2, 8)}`;
    const lab = ui.el('label', { class: 'mrb-field__label', for: id });
    lab.textContent = labelText;
    const input = document.createElement(attrs.rows ? 'textarea' : 'input');
    input.id = id;
    if (!attrs.rows) input.type = attrs.type || 'text';
    if (attrs.rows) input.rows = attrs.rows;
    input.className = 'mrb-field__input';
    input.value = value == null ? '' : String(value);
    Object.entries(attrs.extra || {}).forEach(([k, v]) => input.setAttribute(k, v));
    const holder = ui.el('div', { class: 'mrb-field' });
    holder.append(lab, input);
    return { holder, input };
  };

  const issuerF = mkField(tr('auth.issuer', 'Issuer', '服務名'), entry.issuer || '');
  const accountF = mkField(tr('auth.account', 'Account', '帳戶'), entry.account || '');

  const paramRow = ui.el('div', { class: 'mrb-auth-paramrow' });
  const mkSelect = (labelText, options, current) => {
    const sel = document.createElement('select');
    sel.className = 'mrb-select';
    sel.setAttribute('aria-label', labelText);
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = String(opt.value);
      o.textContent = opt.label;
      sel.appendChild(o);
    }
    sel.value = String(current);
    const holder = ui.el('div', { class: 'mrb-field' });
    const lab = ui.el('span', { class: 'mrb-field__label' });
    lab.textContent = labelText;
    holder.append(lab, sel);
    return { holder, sel };
  };
  const algoS = mkSelect(tr('auth.algo', 'Algorithm'), [
    { value: 'sha1', label: 'SHA-1' },
    { value: 'sha256', label: 'SHA-256' },
    { value: 'sha512', label: 'SHA-512' },
  ], entry.algo || 'sha1');
  const digS = mkSelect(tr('auth.digits', 'Digits'), [6, 7, 8].map((d) => ({ value: d, label: String(d) })), entry.digits || 6);
  const perS = mkSelect(tr('auth.period', 'Period (seconds)'), [15, 30, 60, 90, 120].map((p) => ({ value: p, label: String(p) })), entry.period || 30);
  paramRow.append(algoS.holder, digS.holder, perS.holder);

  const errBox = ui.el('p', { class: 'mrb-vocab-status', role: 'alert' });
  const saveBtn = ui.el('button', { class: 'mrb-btn mrb-btn--filled', type: 'button' });
  saveBtn.textContent = tr('auth.save', 'Save changes', '儲存變更');
  saveBtn.addEventListener('click', () => {
    const params = { algo: algoS.sel.value, digits: Number(digS.sel.value), period: Number(perS.sel.value) };
    if (
      (entry.algo || 'sha1') === params.algo &&
      (entry.digits || 6) === params.digits &&
      (entry.period || 30) === params.period
    ) {
      // Metadata-only edit; the seed stays untouched.
      entry.issuer = issuerF.input.value.trim();
      entry.account = accountF.input.value.trim();
      saveEntries();
      renderCurrent();
      return;
    }
    // Parameter changes alter what the stored seed produces — require the
    // same live-code confirmation as fresh pairing before committing them.
    errBox.textContent = tr(
      'auth.paramNeedsConfirm',
      'Changing parameters needs a fresh pairing confirmation — use Delete and Add so a live code can be verified.',
      '改參數要重新配對確認——請用「刪除」再加返，等系統驗證一次即時碼。'
    );
    errBox.className = 'mrb-vocab-status mrb-vocab-status--error';
  });

  const cancelBtn = ui.el('button', { class: 'mrb-btn mrb-btn--text', type: 'button' });
  cancelBtn.textContent = tr('auth.cancel', 'Cancel', '取消');
  panel.append(title, issuerF.holder, accountF.holder, paramRow, errBox, ui.el('div', { class: 'mrb-auth-editoractions' }, saveBtn, cancelBtn));

  const anchor = document.querySelector('[data-entry-row="' + cssEscape(entry.entryId) + '"]') || document.body;
  const close = ui.anchored(anchor, panel, {});
  cancelBtn.addEventListener('click', close);
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Add flows
// ---------------------------------------------------------------------------

function renderAddSection(containerEl) {
  containerEl.textContent = '';

  const card = ui.el('section', { class: 'mrb-card mrb-auth-addcard' });
  const heading = ui.el('h3', {});
  heading.textContent = tr('auth.addHeading', 'Add an entry', '加入條目');

  const routes = ui.el('div', { class: 'mrb-auth-routerows' });
  const pane = ui.el('div', { class: 'mrb-auth-addpane' });

  const uriBtn = ui.el('button', { class: 'mrb-btn mrb-btn--tonal', type: 'button' });
  uriBtn.textContent = tr('auth.routeUri', 'Paste otpauth:// link', '貼上 otpauth:// 連結');
  const manualBtn = ui.el('button', { class: 'mrb-btn mrb-btn--tonal', type: 'button' });
  manualBtn.textContent = tr('auth.routeManual', 'Enter manually or generate', '手動輸入或自動產生');
  const scanBtn = ui.el('button', { class: 'mrb-btn mrb-btn--tonal', type: 'button', disabled: true });
  scanBtn.textContent = tr('auth.routeScan', 'Scan a QR image — unavailable', '掃描 QR 圖片——用唔到');
  const scanNote = ui.el('p', { class: 'mrb-vocab-status' });
  // Honest, visible reason — never hidden behind a tooltip.
  scanNote.textContent = tr(
    'auth.scanDisabledReason',
    'QR image decoding is unavailable in-app; paste the otpauth:// URI or enter the secret manually instead.',
    '應用程式內建嘅 QR 圖像解碼用唔到；請改為貼上 otpauth:// 連結或者手動輸入密鑰。'
  );

  uriBtn.addEventListener('click', () => renderUriRoute(pane));
  manualBtn.addEventListener('click', () => renderManualRoute(pane, null));
  routes.append(uriBtn, manualBtn);
  card.append(heading, routes, scanBtn, scanNote, pane);
  containerEl.appendChild(card);
}

function clearPane(pane) {
  pane.textContent = '';
}

function renderUriRoute(pane) {
  clearPane(pane);
  const field = ui.el('div', { class: 'mrb-field' });
  const lab = ui.el('label', { class: 'mrb-field__label' });
  lab.textContent = tr('auth.pasteLabel', 'Paste the otpauth://totp/ URI', '貼上 otpauth://totp/ 連結');
  const ta = document.createElement('textarea');
  ta.rows = 3;
  ta.className = 'mrb-field__input';
  ta.spellcheck = false;
  field.append(lab, ta);
  const errBox = ui.el('p', { class: 'mrb-vocab-status', role: 'alert' });
  const goBtn = ui.el('button', { class: 'mrb-btn mrb-btn--filled', type: 'button' });
  goBtn.textContent = tr('auth.continue', 'Continue', '繼續');
  goBtn.addEventListener('click', () => {
    errBox.textContent = '';
    try {
      const parsed = parseOtpauth(ta.value);
      startDraftFlow(pane, {
        issuer: parsed.issuer,
        account: parsed.account,
        secretB32: parsed.secret,
        params: { algo: parsed.algo, digits: parsed.digits, period: parsed.period },
      });
    } catch (err) {
      errBox.textContent = err instanceof Error ? err.message : String(err);
    }
  });
  pane.append(field, errBox, goBtn);
  ta.focus();
}

function renderManualRoute(pane, prefill) {
  clearPane(pane);
  const genDefault = !prefill;

  const mkField = (labelText, value, opts = {}) => {
    const id = `mrb-ad-${Math.random().toString(36).slice(2, 8)}`;
    const lab = ui.el('label', { class: 'mrb-field__label', for: id });
    lab.textContent = labelText;
    const input = document.createElement(opts.rows ? 'textarea' : 'input');
    input.id = id;
    if (!opts.rows) input.type = 'text';
    if (opts.rows) input.rows = opts.rows;
    input.className = 'mrb-field__input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = value == null ? '' : String(value);
    const holder = ui.el('div', { class: 'mrb-field' });
    holder.append(lab, input);
    return { holder, input };
  };

  const issuerF = mkField(tr('auth.issuer', 'Issuer (e.g. Example Site)', '服務名（例如：例子網站）'), prefill ? prefill.issuer : '');
  const accountF = mkField(tr('auth.account', 'Account (you@example.com)', '帳戶（you@example.com）'), prefill ? prefill.account : '');

  const secretLab = ui.el('label', { class: 'mrb-field__label' });
  secretLab.textContent = tr('auth.secretLabel', 'Secret (base32)', '密鑰（base32）');
  const secretInput = document.createElement('textarea');
  secretInput.rows = 2;
  secretInput.className = 'mrb-field__input mrb-auth-b32';
  secretInput.autocomplete = 'off';
  secretInput.spellcheck = false;
  // Auto-spacing as the user types: groups of four, uppercase.
  secretInput.addEventListener('input', () => {
    const caretFromEnd = secretInput.value.length - secretInput.selectionStart;
    const cleaned = normalizeBase32Input(secretInput.value);
    secretInput.value = cleaned.replace(/(.{4})/g, '$1 ').trim();
    const pos = Math.max(0, secretInput.value.length - caretFromEnd);
    secretInput.setSelectionRange(pos, pos);
  });
  const secretField = ui.el('div', { class: 'mrb-field' });
  secretField.append(secretLab, secretInput);

  const genWrap = ui.el('div', { class: 'mrb-field mrb-field--row' });
  const genId = 'mrb-auth-generate';
  const genCheck = document.createElement('input');
  genCheck.type = 'checkbox';
  genCheck.className = 'mrb-switch';
  genCheck.id = genId;
  genCheck.checked = !!genDefault;
  const genLabel = ui.el('label', { for: genId });
  genLabel.textContent = tr('auth.generate', 'Generate a new secret for me', '幫我產生新密鑰');
  genWrap.append(genCheck, genLabel);

  const qrArea = ui.el('div', { class: 'mrb-auth-qrarea', hidden: true });
  const revealBtn = ui.el('button', { class: 'mrb-btn mrb-btn--text', type: 'button' });
  revealBtn.textContent = tr('auth.showSecret', 'Show secret', '顯示密鑰');
  const secretEcho = ui.el('code', { class: 'mrb-auth-secretcopy' });
  secretEcho.hidden = true;
  const regenBtn = ui.el('button', { class: 'mrb-btn mrb-btn--text', type: 'button' });
  regenBtn.textContent = tr('auth.regen', 'Regenerate', '重新產生');
  const qrCanvas = document.createElement('canvas');
  qrCanvas.className = 'mrb-auth-qr';
  qrCanvas.setAttribute('role', 'img');
  let generatedSecret = '';

  const redrawQr = () => {
    const draft = draftValues();
    if (!draft || !draft.secretB32) return;
    const uri = buildOtpauthUri({
      issuer: draft.issuer,
      account: draft.account,
      secret: draft.secretB32,
      algo: draft.params.algo,
      digits: draft.params.digits,
      period: draft.params.period,
    });
    try {
      const info = qr.encodeToCanvas(qrCanvas, uri, { scale: 5 });
      qrCanvas.setAttribute(
        'aria-label',
        tr(
          'auth.qrAlt',
          `Pairing QR code for ${draft.issuer || draft.account || 'the new entry'}; ${info.size} by ${info.size} modules. The manual secret beside it works too.`,
          `「${draft.issuer || draft.account || '新條目'}」嘅配對 QR 碼；${info.size}×${info.size} 格。旁邊嘅手動密鑰一樣有效。`
        )
      );
    } catch (err) {
      console.warn('[authenticator] QR drawing failed:', err instanceof Error ? err.message : err);
    }
    secretEcho.textContent = groupSecret(generatedSecret);
  };

  const draftValues = () => {
    const secretB32 = genCheck.checked ? normalizeBase32Input(generatedSecret) : normalizeBase32Input(secretInput.value);
    if (!genCheck.checked && !isValidBase32(secretB32)) return null;
    return {
      issuer: issuerF.input.value.trim(),
      account: accountF.input.value.trim(),
      secretB32,
      params: readParamInputs(),
    };
  };

  const paramRow = ui.el('div', { class: 'mrb-auth-paramrow' });
  const mkSelect = (labelText, options, current) => {
    const sel = document.createElement('select');
    sel.className = 'mrb-select';
    sel.setAttribute('aria-label', labelText);
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = String(opt.value);
      o.textContent = opt.label;
      sel.appendChild(o);
    }
    sel.value = String(current);
    const holder = ui.el('div', { class: 'mrb-field' });
    const lab2 = ui.el('span', { class: 'mrb-field__label' });
    lab2.textContent = labelText;
    holder.append(lab2, sel);
    return { holder, sel };
  };
  const algoS = mkSelect(tr('auth.algo', 'Algorithm'), [
    { value: 'sha1', label: 'SHA-1' },
    { value: 'sha256', label: 'SHA-256' },
    { value: 'sha512', label: 'SHA-512' },
  ], prefill ? prefill.params.algo : 'sha1');
  const digS = mkSelect(tr('auth.digits', 'Digits'), [6, 7, 8].map((d) => ({ value: d, label: String(d) })), prefill ? prefill.params.digits : 6);
  const perS = mkSelect(tr('auth.period', 'Period (seconds)'), [15, 30, 60, 90, 120].map((p) => ({ value: p, label: String(p) })), prefill ? prefill.params.period : 30);
  paramRow.append(algoS.holder, digS.holder, perS.holder);
  const readParamInputs = () => ({ algo: algoS.sel.value, digits: Number(digS.sel.value), period: Number(perS.sel.value) });

  const syncGenerateUi = () => {
    if (genCheck.checked) {
      if (!generatedSecret) generatedSecret = randomB32();
      secretInput.disabled = true;
      secretInput.placeholder = tr('auth.genPlaceholder', 'Generated automatically', '自動產生中');
      qrArea.hidden = false;
      redrawQr();
    } else {
      generatedSecret = '';
      secretInput.disabled = false;
      secretInput.placeholder = '';
      qrArea.hidden = true;
    }
  };
  genCheck.addEventListener('change', syncGenerateUi);
  [algoS.sel, digS.sel, perS.sel].forEach((selNode) => selNode.addEventListener('change', () => {
    if (genCheck.checked) redrawQr();
  }));
  [issuerF.input, accountF.input].forEach((inp) => inp.addEventListener('change', () => {
    if (genCheck.checked) redrawQr();
  }));
  revealBtn.addEventListener('click', () => {
    secretEcho.hidden = !secretEcho.hidden;
    revealBtn.textContent = secretEcho.hidden
      ? tr('auth.showSecret', 'Show secret', '顯示密鑰')
      : tr('auth.hideSecret', 'Hide secret', '收起密鑰');
  });
  regenBtn.addEventListener('click', () => {
    generatedSecret = randomB32();
    redrawQr();
  });

  const errBox = ui.el('p', { class: 'mrb-vocab-status', role: 'alert' });
  const contBtn = ui.el('button', { class: 'mrb-btn mrb-btn--filled', type: 'button' });
  contBtn.textContent = tr('auth.continue', 'Continue', '繼續');
  contBtn.addEventListener('click', () => {
    errBox.textContent = '';
    const draft = draftValues();
    if (!draft) {
      errBox.textContent = tr(
        'auth.badSecret',
        'Enter a valid base32 secret (at least 16 letters/numbers, A–Z and 2–7).',
        '請輸入有效 base32 密鑰（至少16個字符，A–Z 同 2–7）。'
      );
      return;
    }
    startDraftFlow(pane, draft);
  });

  const echoNote = ui.el('p', { class: 'mrb-vocab-status' });
  echoNote.textContent = tr(
    'auth.qrPurpose',
    'Scan with your authenticator app, or type the manual secret below. Both carry the same parameters shown here.',
    '用驗證器 App 掃碼，或者手動輸入下面密鑰；兩者參數一致，同下面顯示相同。'
  );

  qrArea.append(echoNote, qrCanvas, revealBtn, secretEcho, regenBtn);
  pane.append(issuerF.holder, accountF.holder, genWrap, secretField, paramRow, qrArea, errBox, contBtn);
  syncGenerateUi();
}

/**
 * Draft flow: store first, then REQUIRE one live code before arming.
 * A failed or cancelled confirmation deletes the stored seed — an unconfirmed
 * entry never survives.
 */
function startDraftFlow(pane, draft) {
  const entryId = newEntryId();
  const confirmedView = () => {
    clearPane(pane);
    const note = ui.el('p', { class: 'mrb-vocab-status mrb-vocab-status--ok' });
    note.textContent = tr(
      'auth.pairDone',
      'Paired. The entry now appears in your list.',
      '配對完成，條目已經喺列表度。'
    );
    pane.appendChild(note);
    loadEntries();
    renderCurrent();
  };

  const cancelledView = (message) => {
    clearPane(pane);
    const note = ui.el('p', { class: 'mrb-vocab-status mrb-vocab-status--error', role: 'alert' });
    note.textContent = message;
    pane.appendChild(note);
  };

  ipc('totp:put', { entryId, secretB32: draft.secretB32, params: draft.params })
    .then(() => {
      clearPane(pane);
      const lab = ui.el('label', { class: 'mrb-field__label' });
      lab.textContent = tr(
        'auth.confirmLabel',
        `Enter the current ${draft.params.digits}-digit code to finish pairing`,
        `輸入而家嘅 ${draft.params.digits} 位驗證碼完成配對`
      );
      const input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'numeric';
      input.className = 'mrb-field__input mrb-auth-confirm';
      input.autocomplete = 'one-time-code';
      input.maxLength = draft.params.digits;
      const field = ui.el('div', { class: 'mrb-field' });
      field.append(lab, input);
      const errBox = ui.el('p', { class: 'mrb-vocab-status', role: 'alert' });
      const verifyBtn = ui.el('button', { class: 'mrb-btn mrb-btn--filled', type: 'button' });
      verifyBtn.textContent = tr('auth.verify', 'Verify and arm', '驗證並啟用');
      const cancelBtn = ui.el('button', { class: 'mrb-btn mrb-btn--text', type: 'button' });
      cancelBtn.textContent = tr('auth.cancel', 'Cancel', '取消');

      const discard = (message) => {
        // The seed MUST NOT survive a failed or abandoned pairing.
        ipc('totp:remove', { entryId }).catch(() => {});
        cancelledView(message);
      };

      verifyBtn.addEventListener('click', async () => {
        errBox.textContent = '';
        const code = String(input.value || '').replace(/\D/g, '');
        if (!code) {
          errBox.textContent = tr('auth.enterCode', 'Type the code your authenticator shows.', '請輸入驗證器顯示嘅驗證碼。');
          return;
        }
        try {
          const res = await ipc('totp:verify', { entryId, code, window: 1 });
          if (res && res.ok && res.match) {
            entries.push({
              entryId,
              issuer: draft.issuer,
              account: draft.account,
              algo: draft.params.algo,
              digits: draft.params.digits,
              period: draft.params.period,
              createdAt: Date.now(),
            });
            saveEntries(); // metadata only — never the seed
            await fetchCode({ entryId, period: draft.params.period });
            confirmedView();
          } else {
            discard(
              tr(
                'auth.pairFailed',
                'That code did not match, so the entry was discarded. Check the device clock and try again.',
                '驗證碼唔啱，所以條目已作廢。檢查裝置時鐘再試過啦。'
              )
            );
          }
        } catch (err) {
          errBox.textContent = err instanceof Error ? err.message : String(err);
        }
      });
      cancelBtn.addEventListener('click', () =>
        discard(tr('auth.pairCancelled', 'Pairing cancelled — nothing was kept.', '已取消配對，乜都冇留低。'))
      );

      pane.append(field, errBox, ui.el('div', { class: 'mrb-auth-editoractions' }, verifyBtn, cancelBtn));
      input.focus();
    })
    .catch((err) => {
      cancelledView(err instanceof Error ? err.message : String(err));
    });
}

// ---------------------------------------------------------------------------
// Tab composition
// ---------------------------------------------------------------------------

function renderTab(el) {
  el.textContent = '';
  currentPanel = { render: renderTab, el };

  const header = ui.el('div', { class: 'mrb-auth-head' });
  const title = ui.el('h2', {});
  title.textContent = tr('auth.title', 'Authenticator', '驗證器');
  const pledge = ui.el('p', { class: 'mrb-auth-pledge' });
  pledge.textContent = tr(
    'auth.localOnly',
    'Everything stays on this computer. No account, no sync, no network.',
    '全部資料只留喺呢部電腦：冇帳冇帳戶、冇同步、唔過網。'
  );
  header.append(title, pledge);
  el.appendChild(header);

  // Honest ornamental-lock banner: an OTP lock whose seed lives HERE.
  maybeOrnamentalBanner(el);

  const offset = clockOffsetSec();
  if (offset !== 0) {
    const skewNote = ui.el('p', { class: 'mrb-card mrb-auth-skew', role: 'status' });
    skewNote.textContent = tr(
      'auth.skewActive',
      `Codes use a manual clock offset of ${offset} seconds — they may mismatch servers.`,
      `目前用手動時鐘偏移 ${offset} 秒——驗證碼可能同伺服器對唔上。`
    );
    el.appendChild(skewNote);
  }

  const addHost = ui.el('div', {});
  renderAddSection(addHost);
  el.appendChild(addHost);

  const listHost = ui.el('div', {});
  renderList(listHost);
  el.appendChild(listHost);

  ensureLiveRegion();
}

async function maybeOrnamentalBanner(el) {
  try {
    if (!locksMod) {
      const mod = await import('./locks.js');
      locksMod = mod && mod.locks ? mod.locks : mod;
    }
    const listFn = locksMod && typeof locksMod.listLocks === 'function' ? locksMod.listLocks : null;
    if (!listFn) return;
    const otpLocks = listFn().filter(
      (l) => l.method === 'totp' && typeof l.credRef === 'string' && l.credRef.startsWith('lock:')
    );
    if (otpLocks.length === 0) return;
    const banner = ui.el('p', { class: 'mrb-card mrb-auth-ornamental' });
    banner.textContent = tr(
      'auth.ornamental',
      'This lock’s key lives inside this very app — ornamental by design.',
      '把鎖嘅鎖匙就收喺同一個 App 入面——設計上就係裝飾性質。'
    );
    el.insertBefore(banner, el.children[1] || null);
  } catch {
    /* locks module absent: banner simply does not apply */
  }
}

// ---------------------------------------------------------------------------

export async function init() {
  try {
    ui.injectCss(new URL('../../styles/features/delight.css', import.meta.url).href);
  } catch {
    /* styling degrades */
  }
  await qr.init();

  const loads = await Promise.allSettled([
    import('./router.js'),
    import('./palette.js'),
    import('./settings.js'),
    import('./exporter.js'),
    import('./regexbuilder.js'),
  ]);
  routerMod = loads[0].status === 'fulfilled' ? loads[0].value : null;
  paletteMod = loads[1].status === 'fulfilled' ? loads[1].value : null;
  settingsMod = loads[2].status === 'fulfilled' ? loads[2].value : null;
  exporterMod = loads[3].status === 'fulfilled' ? loads[3].value : null;
  regexbuilderMod = loads[4].status === 'fulfilled' ? loads[4].value : null;

  if (settingsMod && settingsMod.settings && typeof settingsMod.settings.register === 'function') {
    try {
      settingsMod.settings.register([
        {
          key: 'auth.clockOffsetSec',
          type: 'slider',
          def: 0,
          min: -3600,
          max: 3600,
          step: 15,
          unit: 's',
          group: 'Authenticator',
          label: { en: 'Clock offset (seconds)', yue: '時鐘偏移（秒）' },
          explain: {
            en: 'If this device’s clock drifts, codes can be shifted to match. Non-zero offsets show a visible notice on the Authenticator tab because mismatched clocks are the usual cause of rejected codes.',
            yue: '裝置時鐘有偏差可以先校返；偏移非零時驗證器分頁會顯示提示，因為時鐘唔準係驗證失敗最常見原因。',
          },
        },
      ]);
    } catch {
      /* settings surface unavailable */
    }
  }

  loadEntries();

  if (routerMod && routerMod.router && typeof routerMod.router.registerTab === 'function') {
    try {
      routerMod.router.registerTab({
        id: 'authenticator',
        title: tr('auth.tabTitle', 'Authenticator', '驗證器'),
        icon: '🔐',
        closable: false,
        render: (elNode) => renderTab(elNode),
      });
    } catch {
      /* router unavailable */
    }
  }

  if (paletteMod && paletteMod.palette && typeof paletteMod.palette.register === 'function') {
    try {
      paletteMod.palette.register({
        id: 'authenticator.open',
        title: tr('auth.paletteTitle', 'Open Authenticator', '開啟驗證器'),
        keywords: 'totp 2fa otp codes authenticator',
        action: () => {
          if (routerMod && routerMod.router) routerMod.router.navigate('authenticator');
        },
      });
    } catch {
      /* palette unavailable */
    }
  }

  window.addEventListener('mrb-locks-changed', () => {
    if (routerMod && routerMod.router && routerMod.router.current && routerMod.router.current() === 'authenticator') {
      renderCurrent();
    }
  });

  if (ticker) clearInterval(ticker);
  ticker = setInterval(async () => {
    for (const entry of entries) {
      const cached = codeCache.get(entry.entryId);
      if (!cached) {
        await fetchCode(entry);
        continue;
      }
      cached.secondsRemaining -= 1;
      if (cached.secondsRemaining <= 0) await fetchCode(entry);
    }
    document.querySelectorAll('.mrb-auth-row').forEach((rowEl) => {
      const id = rowEl.getAttribute('data-entry-row');
      const entry = entries.find((e) => e.entryId === id);
      if (entry && typeof rowEl._paint === 'function') rowEl._paint();
    });
  }, 1000);
}
