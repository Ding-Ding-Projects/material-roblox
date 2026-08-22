/**
 * Material Roblox — notification journal + reviewable centre (Lane C).
 *
 * `ui.toast` stays the single toast surface (Lane A owns it); this module
 * wraps AROUND it by listening for the `mrb-toast-shown` DOM events ui fires,
 * journalling each one (newest-first, hard-capped at 200 entries, FIFO
 * eviction) into the persistent store, and offering a reviewable centre:
 *
 *   • bell button near the frameless titlebar with an unread badge
 *   • grouped Today / Earlier list, unread dot per new-since-last-open item
 *   • search wired through regexbuilder.attachSearch (plain default, regex
 *     opt-in, per-field owned state)
 *   • tone filter chips + quick date-range presets, composing with search
 *   • per-item restore-as-toast and delete (warn/error singles delete only
 *     through the explicit confirmation gate)
 *   • bulk select/dismiss/delete/export built ON this lane's bulk engine;
 *     export honours the ACTIVE filters and says exactly what it exported
 *   • Clear-all behind the two-key super confirmation
 *
 * The errors-and-warnings-persist-until-dismissed rule belongs to the toast
 * layer; this centre never auto-deletes anything — every removal is an
 * explicit user action. Auto-dismiss timers are mirrored by simply keeping
 * the journal entry: a dismissed toast remains reviewable here, which is the
 * entire point of the centre.
 */

import { store } from './store.js';
import { i18n } from './i18n.js';
import { ui } from './ui.js';
import { bulk } from './bulk.js';
import { exportData } from './exporter.js';

/* ── Journal ────────────────────────────────────────────────────────────── */

const MAX_JOURNAL = 200;

function getJournal() {
  const v = store.get('notifJournal', []);
  return Array.isArray(v) ? v : [];
}
function setJournal(items) {
  store.set('notifJournal', items.slice(0, MAX_JOURNAL));
}
function getLastOpened() {
  return Number(store.get('notifLastOpen', 0)) || 0;
}

/** True when the toast layer reported this entry (defensive shape check). */
function normalizeEntry(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const title = String(detail.title || '').trim();
  const body = String(detail.body || '');
  if (!title && !body) return null;
  return {
    id: String(detail.id || `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`),
    title,
    body,
    tone: ['info', 'ok', 'warn', 'error'].includes(detail.tone) ? detail.tone : 'info',
    at: Number.isFinite(detail.at) ? detail.at : Date.now(),
    actionsMeta: Array.isArray(detail.actions)
      ? detail.actions.map((a) => ({ label: String((a && a.label) || '') })).filter((a) => a.label)
      : [],
    read: false,
  };
}

function onToastShown(e) {
  const entry = normalizeEntry(e && e.detail);
  if (!entry) return;
  const journal = getJournal();
  if (journal.some((j) => j.id === entry.id)) return; // same event twice
  setJournal([entry, ...journal]);
}

/* ── Localized copy helpers (CONTRACT §8 fallback pattern) ──────────────── */

function tr(key, en, yue) {
  let translated = null;
  let mode = 'en';
  try {
    const v = i18n.t(key);
    if (v && v !== key) translated = v;
    if (typeof i18n.lang === 'function') mode = i18n.lang();
  } catch { /* catalogs unavailable — local copy stands */ }
  const primary = translated || en;
  if (mode === 'bi' && yue && yue !== primary) return `${primary} · ${yue}`;
  return primary;
}

/* ── Bell button ────────────────────────────────────────────────────────── */

let bellBtn = null;

function unreadCount() {
  const since = getLastOpened();
  return getJournal().filter((j) => !j.read && j.at > since).length;
}

function refreshBell() {
  if (!bellBtn) return;
  const n = unreadCount();
  bellBtn.dataset.unread = n > 0 ? String(Math.min(n, 99)) : '';
  bellBtn.setAttribute('aria-label',
    n > 0 ? tr('notify.bellN', `Notification centre, ${n} unread`, `通知中心，${n} 個未讀`)
          : tr('notify.bell', 'Notification centre', '通知中心'));
}

/**
 * Inject the bell near the frameless titlebar. Everything is guarded: when
 * the shell has not landed yet (or renames its classes) the centre stays
 * reachable through the command palette, and we log once instead of throwing.
 */
function injectBell() {
  try {
    const bar = document.querySelector('.mrb-titlebar');
    if (!bar) return;
    // Inline SVG bell — no CDN, no emoji in control chrome.
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'mrb-cx-bell-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M12 3a6 6 0 0 0-6 6v3.1l-1.6 3.2A1 1 0 0 0 5.3 17h13.4a1 1 0 0 0 .9-1.7L18 12.1V9a6 6 0 0 0-6-6Zm-2 15a2 2 0 0 0 4 0h-4Z');
    svg.appendChild(p);
    bellBtn = ui.el('button', {
      class: 'mrb-btn mrb-btn--text mrb-cx-bell', type: 'button',
      title: tr('notify.bell', 'Notification centre', '通知中心'),
      'aria-label': tr('notify.bell', 'Notification centre', '通知中心'),
    }, svg);
    bellBtn.addEventListener('click', () => center());
    const controls = bar.querySelector('.mrb-titlebar-buttons, .mrb-window-controls, [data-mrb-window-controls]');
    if (controls) bar.insertBefore(bellBtn, controls);
    else bar.appendChild(bellBtn);
    refreshBell();
  } catch (err) {
    console.warn('[mrb/notify] bell injection skipped:', err && err.message);
  }
}

/* ── Centre drawer ──────────────────────────────────────────────────────── */

let drawerClose = null;
/** While the centre is open, journal changes repaint the visible list. */
let activeRender = null;

function onJournalChanged() {
  refreshBell();
  if (activeRender) activeRender();
}

function fmtTime(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString()} ${time}`;
}

function isToday(ts) {
  return new Date(ts).toDateString() === new Date().toDateString();
}

/**
 * Open the notification centre (anchored to the bell when present).
 * @returns {Function} close()
 */
export function center(prefillQuery = '') {
  if (drawerClose) { drawerClose(); }

  let queryState = { q: prefillQuery, mode: 'plain', flags: '', valid: true };
  let tones = new Set();            // empty = all tones
  let range = 'all';                // 'all' | 'today' | '7d'

  const drawer = ui.el('div', { class: 'mrb-cx-notifdrawer', role: 'dialog', 'aria-label': tr('notify.title', 'Notification centre', '通知中心') });

  /* Header */
  const head = ui.el('header', { class: 'mrb-cx-nd-head' },
    ui.el('h2', { class: 'mrb-cx-nd-title' }, tr('notify.title', 'Notification centre', '通知中心')));
  const closeBtn = ui.el('button', { class: 'mrb-btn mrb-btn--text', type: 'button', 'aria-label': tr('common.close', 'Close', '關閉') }, '✕');
  head.appendChild(closeBtn);

  /* Toolbar: search + tone chips + range presets */
  const searchWrap = ui.el('div', { class: 'mrb-cx-nd-search' });
  const chipRow = ui.el('div', { class: 'mrb-cx-nd-chips', role: 'group', 'aria-label': tr('notify.tones', 'Filter by tone', '按類別篩選') });
  const rangeSel = ui.el('select', { class: 'mrb-select mrb-cx-nd-range', 'aria-label': tr('notify.range', 'Date range', '日期範圍') },
    ui.el('option', { value: 'all' }, tr('notify.anytime', 'Any time', '任何時間')),
    ui.el('option', { value: 'today' }, tr('notify.today', 'Today', '今日')),
    ui.el('option', { value: '7d' }, tr('notify.last7', 'Last 7 days', '最近 7 日')));

  const toolbar = ui.el('div', { class: 'mrb-cx-nd-toolbar' });
  toolbar.appendChild(searchWrap);

  /* List */
  const listEl = ui.el('ul', { class: 'mrb-cx-nd-list', role: 'list' });
  const emptyAll = ui.el('p', { class: 'mrb-cx-empty', hidden: 'true' },
    tr('notify.emptyAll', 'No notifications yet. When something happens, it will land here.', '仲未有通知。有嘢發生就會喺呢度出現。'));
  const emptyFiltered = ui.el('p', { class: 'mrb-cx-empty', hidden: 'true' },
    tr('notify.emptyFiltered', 'No notifications match the current filters.', '冇通知符合目前嘅篩選條件。'));
  const footLine = ui.el('p', { class: 'mrb-cx-nd-footline', 'aria-live': 'polite' });

  /* Footer actions */
  const clearBtn = ui.el('button', { class: 'mrb-btn mrb-btn--text mrb-cx-danger-text', type: 'button' },
    tr('notify.clearAll', 'Clear all…', '全部清除…'));
  const exportBtn = ui.el('button', { class: 'mrb-btn mrb-btn--outlined', type: 'button' },
    tr('notify.exportVisible', 'Export visible…', '匯出現時顯示…'));
  const foot = ui.el('footer', { class: 'mrb-cx-nd-foot' }, clearBtn, exportBtn);

  drawer.append(head, toolbar, chipRow, rangeSel, listEl, emptyAll, emptyFiltered, footLine, foot);

  /* Tone chips */
  for (const tone of ['info', 'ok', 'warn', 'error']) {
    const b = ui.el('button', {
      class: `mrb-chip mrb-cx-tonetone is-${tone}`, type: 'button',
      'data-tone': tone, 'aria-pressed': 'false',
      title: tr(`notify.tone.${tone}`, `Tone: ${tone}`, `類別：${tone}`),
    }, tone);
    b.addEventListener('click', () => {
      if (tones.has(tone)) tones.delete(tone);
      else tones.add(tone);
      b.classList.toggle('is-on', tones.has(tone));
      b.setAttribute('aria-pressed', tones.has(tone) ? 'true' : 'false');
      render();
    });
    chipRow.appendChild(b);
  }

  rangeSel.addEventListener('change', () => { range = rangeSel.value; render(); });

  /* Search — own attachSearch wiring; per-field owned state. */
  import('./regexbuilder.js').then((rb) => {
    if (!rb || typeof rb.attachSearchableFactory !== 'function') return;
    const s = rb.attachSearchableFactory({
      label: tr('notify.searchLabel', 'Search notifications', '搜尋通知'),
      placeholder: tr('notify.searchPh', 'Search title and body', '搜尋標題同內文'),
      onQuery: (q, meta) => { queryState = { q, ...meta }; render(); },
    });
    searchWrap.appendChild(s.root);
    if (prefillQuery) s.controller.setQuery(prefillQuery, { silent: true });
  }).catch(() => { /* builder peer failed: plain filtering still works below */ });

  function passes(entry) {
    if (tones.size && !tones.has(entry.tone)) return false;
    if (range === 'today' && !isToday(entry.at)) return false;
    if (range === '7d' && entry.at < Date.now() - 7 * 86400000) return false;
    if (queryState.q) {
      const hay = `${entry.title}\n${entry.body}`;
      if (queryState.mode === 'regex' && queryState.valid) {
        let re;
        try { re = new RegExp(queryState.q, queryState.flags); } catch { return false; }
        if (!re.test(hay)) return false;
      } else if (queryState.mode === 'plain') {
        if (!hay.toLowerCase().includes(queryState.q.toLowerCase())) return false;
      }
    }
    return true;
  }

  function visibleEntries() {
    return getJournal().filter(passes);
  }

  function restoreAsToast(entry) {
    // Action closures are never journaled (labels only), so a restored toast
    // carries the message without pretending its original buttons survived.
    ui.toast({
      title: entry.title || undefined,
      body: entry.body,
      tone: entry.tone,
      timeoutMs: 6000,
    });
  }

  function deleteEntries(ids) {
    const set = new Set(ids.map(String));
    setJournal(getJournal().filter((j) => !set.has(j.id)));
    render();
  }

  function deleteOne(entry) {
    const go = () => deleteEntries([entry.id]);
    if (entry.tone === 'warn' || entry.tone === 'error') {
      // Warnings and errors persist until explicitly dismissed — the gate
      // makes sure "explicit" means deliberate even on a fast double-click.
      ui.superConfirm({
        title: tr('notify.delTitle', 'Delete this notification?', '刪除呢則通知？'),
        detailHtml: `<p><strong>${ui.escapeHtml(entry.title || entry.body.slice(0, 80))}</strong></p>` +
          `<pre class="mrb-cx-previewlist">${ui.escapeHtml(entry.body.slice(0, 400))}</pre>`,
        confirmLabel: tr('notify.delete', 'Delete', '刪除'),
        onConfirm: go,
      });
    } else {
      go();
    }
  }

  function renderRow(entry) {
    const li = ui.el('li', {
      class: `mrb-cx-notif-row is-${entry.tone}`,
      'data-mrb-bulk-id': entry.id,
      tabindex: '-1',
    });
    if (!entry.read && entry.at > getLastOpened()) li.classList.add('is-unread');

    const dot = ui.el('span', { class: 'mrb-cx-dot', 'aria-hidden': 'true' });
    const icon = ui.el('span', { class: 'mrb-cx-toneicon', 'aria-hidden': 'true' },
      entry.tone === 'ok' ? '✓' : entry.tone === 'warn' ? '⚠' : entry.tone === 'error' ? '✕' : 'ℹ');
    const titleLine = ui.el('p', { class: 'mrb-cx-nd-title-line' },
      entry.title || tr('notify.untitled', '(no title)', '（冇標題）'));
    const mainKids = [titleLine];
    if (entry.body) mainKids.push(ui.el('p', { class: 'mrb-cx-nd-body', title: entry.body }, entry.body));
    const metaText = entry.actionsMeta.length
      ? `${fmtTime(entry.at)} · ${tr('notify.hadActions', 'had actions (not restorable)', '原有操作按鈕（唔會還原）')}`
      : fmtTime(entry.at);
    mainKids.push(ui.el('p', { class: 'mrb-cx-nd-meta' }, metaText));
    const main = ui.el('div', { class: 'mrb-cx-nd-main' }, ...mainKids);

    const btns = ui.el('div', { class: 'mrb-cx-nd-btns' });
    const restoreB = ui.el('button', { class: 'mrb-btn mrb-btn--text', type: 'button' }, tr('notify.restore', 'Show again', '再顯示'));
    restoreB.addEventListener('click', () => restoreAsToast(entry));
    const delB = ui.el('button', { class: 'mrb-btn mrb-btn--text mrb-cx-danger-text', type: 'button' }, tr('notify.delete', 'Delete', '刪除'));
    delB.addEventListener('click', () => deleteOne(entry));
    btns.append(restoreB, delB);

    li.append(dot, icon, main, btns);
    return li;
  }

  function render() {
    const all = getJournal();
    const vis = visibleEntries();

    emptyAll.hidden = all.length !== 0;
    emptyFiltered.hidden = !(all.length > 0 && vis.length === 0);
    listEl.textContent = '';

    let lastGroup = null;
    for (const entry of [...vis].sort((a, b) => b.at - a.at)) {
      const groupKey = isToday(entry.at) ? 'today' : 'earlier';
      if (groupKey !== lastGroup) {
        lastGroup = groupKey;
        listEl.appendChild(ui.el('li', {
          class: 'mrb-cx-nd-group',
          role: 'presentation',
        }, groupKey === 'today'
          ? tr('notify.todayHead', 'Today', '今日')
          : tr('notify.earlier', 'Earlier', '更早')));
      }
      listEl.appendChild(renderRow(entry));
    }

    const unread = all.filter((j) => !j.read && j.at > getLastOpened()).length;
    footLine.textContent = tr('notify.counts',
      `${vis.length} of ${all.length} shown · ${unread} unread`,
      `顯示 ${all.length} 之中嘅 ${vis.length} 項 · ${unread} 個未讀`);

    bulk.teardown(listEl);
    if (vis.length) {
      bulk.enable(listEl, {
        rowSelector: '.mrb-cx-notif-row',
        getItemId: (row) => row.getAttribute('data-mrb-bulk-id'),
        getLabel: (row) => (row.querySelector('.mrb-cx-nd-title-line') || {}).textContent || '',
        scopeLabel: tr('notify.title', 'Notification centre', '通知中心'),
        actions: [
          {
            id: 'dismiss',
            label: tr('notify.dismissSel', 'Mark selected read', '已選標為已讀'),
            danger: false,
            run: (ids) => {
              const set = new Set(ids.map(String));
              setJournal(getJournal().map((j) => (set.has(j.id) ? { ...j, read: true } : j)));
            },
          },
          {
            id: 'delete',
            label: tr('notify.deleteSel', 'Delete selected…', '刪除已選…'),
            danger: true,
            run: (ids) => deleteEntries(ids),
          },
          {
            id: 'export',
            label: tr('notify.exportSel', 'Export…', '匯出…'),
            danger: false,
            run: () => { exportVisible(); },
          },
        ],
      });
    }
    refreshBell();
  }

  function exportVisible() {
    const vis = visibleEntries();
    exportData({
      name: 'material-roblox-notifications',
      rows: vis.map((v) => ({
        at: new Date(v.at).toISOString(),
        tone: v.tone,
        title: v.title,
        body: v.body,
        actions: v.actionsMeta.map((a) => a.label).join(' | '),
        read: v.read,
      })),
      formats: ['json', 'csv', 'md'],
      chosenDefault: 'json',
      extraNote: tr('notify.exportNote',
        `Exports exactly the ${vis.length} notification(s) currently visible under your active filters — nothing more.`,
        `只會匯出現時符合篩選條件而顯示嘅 ${vis.length} 則通知，唔多唔少。`),
    }).catch(() => { /* dialog reports its own errors inline */ });
  }

  exportBtn.addEventListener('click', exportVisible);

  clearBtn.addEventListener('click', () => {
    ui.superConfirm({
      title: tr('notify.clearTitle', 'Clear the whole notification journal?', '清空成個通知日誌？'),
      detailHtml: `<p>${ui.escapeHtml(tr('notify.clearDetail',
        `This removes all ${getJournal().length} notifications, including warnings and errors. This cannot be undone.`,
        `會移除晒所有 ${getJournal().length} 則通知，包括警告同錯誤。冇得復原。`))}</p>`,
      confirmLabel: tr('notify.clearAll', 'Clear all', '全部清除'),
      onConfirm: () => { setJournal([]); render(); },
    });
  });

  /* Paint, anchor, mark-read. */
  render();
  activeRender = render;
  let anchoredClose = null;
  drawer.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeDrawer(); }
  });
  function closeDrawer() {
    if (anchoredClose) { try { anchoredClose(); } catch { /* already gone */ } }
    drawerClose = null;
    activeRender = null;
  }
  closeBtn.addEventListener('click', closeDrawer);

  const anchor = bellBtn || document.querySelector('.mrb-titlebar') || document.body;
  anchoredClose = ui.anchored(anchor, drawer, { maxHeight: '70vh' }) || (() => {});
  drawerClose = closeDrawer;

  // Opening counts as reading: the unread dots clear on next paint, while the
  // explicit "mark selected read" action still persists per-item read flags.
  store.set('notifLastOpen', Date.now());
  requestAnimationFrame(refreshBell);
  return closeDrawer;
}

/** Prefilled search entry point (command palette uses this). */
export function search(q) {
  return center(String(q || ''));
}

/** Namespaced facade per CONTRACT §6 (`notify.center()`). */
export const notify = { center, search };

/* ── Module init ────────────────────────────────────────────────────────── */

export async function init() {
  try {
    ui.injectCss(new URL('../../styles/features/coreux.css', import.meta.url).href);
  } catch (err) {
    console.warn('[mrb/notify] stylesheet injection failed:', err && err.message);
  }
  window.addEventListener('mrb-toast-shown', onToastShown);
  injectBell();
  if (typeof store.onChange === 'function') store.onChange('notifJournal', onJournalChanged);
}
