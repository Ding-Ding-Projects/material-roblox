/**
 * Roblox lane — Presence surface (session-gated).
 *
 * A presence board for saved users: dot + LastOnline / UserLocation /
 * UserPresenceType columns when the API returns them, polling on the
 * registered `roblox.presenceIntervalSec` setting (30 s floor enforced),
 * a pause toggle, and a snapshot export. Without a session it explains
 * exactly what connecting unlocks; without saved users it links to Users.
 */

import { ui } from '../../../core/ui.js';
import { router } from '../../../core/router.js';
import { store } from '../../../core/store.js';
import { settings } from '../../../core/settings.js';
import {
  presence, getSavedUsers, hasSession,
} from '../api.js';
import { tr } from '../peers.js';
import {
  announce, emptyState, errorState, formatDate, presenceDot, thumbImg,
} from '../cards.js';
import { exportButton } from './helpers.js';

const el = (...args) => ui.el(...args);

const TAB_ID = 'roblox-presence';
const PAUSE_KEY = 'roblox:presencePaused';
/** Hard floor regardless of what the setting slider allows. */
const MIN_INTERVAL_SEC = 30;

export async function init() {
  const list = typeof router.list === 'function' ? router.list() : [];
  if (list.some((t) => t && t.id === TAB_ID)) return;
  router.registerTab({
    id: TAB_ID,
    title: tr('roblox.tabs.presence', 'Presence', '在線狀態'),
    icon: '🟢',
    group: 'Roblox',
    render: (rootEl) => render(rootEl),
  });
}

async function render(rootEl) {
  rootEl.textContent = '';
  rootEl.className = 'rbx-surface';
  rootEl.appendChild(el('h1', {}, tr('roblox.presence.title', 'Presence board', '在線狀態板')));

  const body = el('div', {});
  rootEl.appendChild(body);

  if (!hasSession()) {
    body.appendChild(el('section', { class: 'rbx-card rbx-home__card' },
      el('h2', {}, '🔌 ', tr('roblox.presence.connectTitle', 'Presence needs a connected session', '在線狀態需要連接 session')),
      el('p', {}, tr('roblox.presence.connectBody',
        'Roblox only exposes who-is-online through authenticated endpoints. Connect once on the Session tab and this board polls your saved users at a polite interval.',
        'Roblox 只會喺已驗證嘅 API 提供在線狀態。喺 Session 分頁連接一次，呢塊板就會以有禮貌嘅間隔輪詢你收藏嘅用户。')),
      el('div', { class: 'rbx-actions' },
        el('button', { type: 'button', class: 'mrb-btn filled', onclick: () => router.navigate('roblox-session') },
          tr('roblox.presence.openSession', 'Open Session', '開啟 Session')))));
    announce(tr('roblox.presence.noSessionAnnounce', 'Presence needs a session', '在線狀態需要 session'));
    return;
  }

  await paintBoard(body);
}

async function paintBoard(body) {
  /** @type {Map<number, any>} userId → presence payload */
  const presenceMap = new Map();
  let timer = 0;
  let paused = Boolean(store.get(PAUSE_KEY, false));

  const intervalSec = () => {
    const v = Number(settings.get('roblox.presenceIntervalSec', 120));
    if (!Number.isFinite(v)) return 120;
    return Math.max(MIN_INTERVAL_SEC, v); // floor enforced at read time too
  };

  /* header row: pause toggle, interval readout, last-updated */
  const pauseBtn = el('button', {
    type: 'button', class: 'mrb-btn tonal',
    'aria-pressed': String(paused),
    onclick: () => {
      paused = !paused;
      store.set(PAUSE_KEY, paused);
      pauseBtn.textContent = paused
        ? tr('roblox.presence.resume', '▶ Resume polling', '▶ 繼續輪詢')
        : tr('roblox.presence.pause', '⏸ Pause polling', '⏸ 暫停輪詢');
      pauseBtn.setAttribute('aria-pressed', String(paused));
      if (!paused) tick();
      announce(paused
        ? tr('roblox.presence.pausedAnnounce', 'Presence polling paused', '已暫停在線狀態輪詢')
        : tr('roblox.presence.resumedAnnounce', 'Presence polling resumed', '已恢復在線狀態輪詢'));
    },
  }, paused ? tr('roblox.presence.resume', '▶ Resume polling', '▶ 繼續輪詢')
    : tr('roblox.presence.pause', '⏸ Pause polling', '⏸ 暫停輪詢'));

  const intervalNote = el('p', { class: 'rbx-muted', role: 'note' });
  const updatedLine = el('p', { class: 'rbx-muted', 'aria-live': 'polite' });

  const tableSlot = el('div', {});
  const board = el('section', { class: 'rbx-card rbx-home__card' },
    el('div', { class: 'rbx-toolbar' },
      el('h2', {}, tr('roblox.presence.boardTitle', 'Saved users', '已收藏用户')),
      pauseBtn),
    intervalNote, updatedLine, tableSlot);

  // Export button appended after async resolution (hidden entirely if absent).
  const exportBtn = await exportButton({
    name: 'roblox-presence-snapshot',
    label: tr('roblox.presence.exportSnapshot', 'Export snapshot', '匯出快照'),
    rows: () => snapshotRows(),
  });
  if (exportBtn) board.querySelector('.rbx-toolbar').appendChild(exportBtn);

  body.appendChild(board);

  function snapshotRows() {
    return [...presenceMap.entries()].map(([idv, p]) => {
      const u = getSavedUsers().find((x) => x.id === idv) || { name: String(idv) };
      return {
        userId: idv, name: u.name,
        userPresenceType: p?.userPresenceType,
        lastOnline: p?.lastOnline || '',
        placeId: p?.userLocation?.placeId ?? '',
        lastLocation: p?.userLocation?.lastLocation || '',
        gameInstanceId: p?.gameId || p?.userLocation?.gameInstanceId || '',
        capturedAt: new Date().toISOString(),
      };
    });
  }

  function paintIntervalNote() {
    intervalNote.textContent = tr('roblox.presence.intervalNote',
      `Polling every ${intervalSec()} seconds (minimum 30). Change it under Settings → Roblox.`,
      `每 ${intervalSec()} 秒輪詢一次（最少 30 秒）。可以喺設定 → Roblox 調整。`);
  }

  async function tick() {
    clearTimeout(timer);
    const saved = getSavedUsers();
    if (!saved.length) {
      tableSlot.textContent = '';
      tableSlot.appendChild(emptyState('⭐',
        tr('roblox.presence.noSaved', 'Save some users first', '先收藏幾個用户'),
        tr('roblox.presence.noSavedBody',
          'The board watches your saved list. Save profiles from the Users tab and they appear here.',
          '呢塊板會監察你嘅收藏清單。喺 Users 分頁收藏個人檔案，佢哋就會喺度出現。'),
        { label: tr('roblox.presence.openUsers', 'Open Users', '開啟 Users'), onClick: () => router.navigate('roblox-users') })));
      updatedLine.textContent = '';
      return;
    }
    if (paused) return;

    // Skip work when this tab's DOM has gone away (tab re-rendered).
    if (!tableSlot.isConnected) return;

    const ids = saved.slice(0, 50).map((u) => u.id); // presence API caps at 50
    try {
      const res = await presence.users(ids);
      presenceMap.clear();
      for (const p of res?.userPresences || []) {
        presenceMap.set(Number(p.userId), p);
      }
      paintTable();
      updatedLine.textContent = tr('roblox.presence.updatedAt',
        `Updated ${formatDate(new Date().toISOString(), { withTime: true })}`,
        `更新於 ${formatDate(new Date().toISOString(), { withTime: true })}`);
    } catch (err) {
      tableSlot.textContent = '';
      tableSlot.appendChild(errorState(err, { retry: () => tick() }));
      updatedLine.textContent = tr('roblox.presence.updateFailed', 'Last update failed', '上次更新失敗');
    }
  }

  function paintTable() {
    const saved = getSavedUsers().filter((u) => presenceMap.has(u.id));
    if (!saved.length) return;

    // Resolve names for any presence row not on the saved list (defensive).
    const table = el('table', { class: 'mrb-table rbx-table' },
      el('caption', { class: 'rbx-visually-hidden' },
        tr('roblox.presence.tableCaption', 'Saved users presence', '已收藏用户嘅在線狀態')),
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col' }, tr('roblox.presence.colUser', 'User', '用户')),
        el('th', { scope: 'col' }, tr('roblox.presence.colState', 'State', '狀態')),
        el('th', { scope: 'col' }, tr('roblox.presence.colLocation', 'Location', '位置')),
        el('th', { scope: 'col' }, tr('roblox.presence.colLastOnline', 'Last online', '最後在線')))),
      el('tbody', {}));

    for (const u of saved) {
      const p = presenceMap.get(u.id) || {};
      const loc = p.userLocation || {};
      const stateCell = el('td', {}, presenceDot(p.userPresenceType), ' ',
        presenceLabel(p.userPresenceType));
      const locationCell = el('td', {});
      if (loc.placeId) {
        locationCell.appendChild(el('button', {
          type: 'button', class: 'rbx-linklike',
          title: tr('roblox.presence.openPlace', 'Open place page', '開啟 place 頁面'),
          onclick: () => { try { window.mrb.invoke('shell:openExternal', { url: `https://www.roblox.com/games/${loc.placeId}` }); } catch { /* bridge absent */ } },
        }, loc.lastLocation || `Place ${loc.placeId}`));
      } else {
        locationCell.append(loc.lastLocation || '—');
      }
      table.querySelector('tbody').appendChild(el('tr', {},
        el('td', {}, thumbImg(null, { size: 32, alt: '', letter: u.name }), ` ${u.displayName || u.name}`),
        stateCell,
        locationCell,
        el('td', {}, p.lastOnline ? formatDate(p.lastOnline, { withTime: true }) : '—')));
    }
    tableSlot.textContent = '';
    tableSlot.appendChild(table);
  }

  function presenceLabel(code) {
    const labels = {
      0: ['Offline', '離線'], 1: ['On website', '喺網站'], 2: ['In game', '玩緊遊戲'],
      3: ['In Studio', '用緊 Studio'], 4: ['Invisible', '隱形'],
    };
    const pair = labels[Number(code)] || labels[0];
    return tr(`roblox.presence.state.${code}`, pair[0], pair[1]);
  }

  paintIntervalNote();
  await tick();

  // Poll loop: reschedules itself; interval changes apply on the next tick.
  (function loop() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!paused && tableSlot.isConnected) await tick();
      paintIntervalNote();
      loop();
    }, intervalSec() * 1000);
  })();

  // Stop the timer if the surface unmounts (tab re-render).
  const observer = new MutationObserver(() => {
    if (!tableSlot.isConnected) {
      clearTimeout(timer);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
