/**
 * Roblox lane — Home surface.
 *
 * Landing tab: greeting, quick lookup (username or numeric ID with
 * auto-detection), service health chips from cheap public probes, recent
 * lookups, saved-user quick access, and a getting-started checklist that
 * links to the Session tab while unauthenticated. This surface is
 * intentionally dim-sum-free: no startup draws, no dish imagery.
 */

import { ui } from '../../../core/ui.js';
import { router } from '../../../core/router.js';
import { store } from '../../../core/store.js';
import {
  checkServices, resolveUserInput, getSavedUsers, getRecentLookups,
  hasSession, getSelf, pushRecentLookup,
} from '../api.js';
import { tr, voice } from '../peers.js';
import { announce, emptyState, errorState, healthDot, thumbImg, formatDate } from '../cards.js';

const el = (...args) => ui.el(...args);

const TAB_ID = 'roblox-home';
let healthCache = null;

export async function init() {
  const tabs = typeof router.list === 'function' ? router.list() : [];
  if (tabs.some((t) => t && t.id === TAB_ID)) return;
  router.registerTab({
    id: TAB_ID,
    title: tr('roblox.tabs.home', 'Home', '主頁'),
    icon: '🏠',
    group: 'Roblox',
    render: (root) => render(root),
  });
}

function render(rootEl) {
  rootEl.textContent = '';
  rootEl.className = 'rbx-surface';

  rootEl.appendChild(greeting());
  rootEl.appendChild(quickLookupCard());
  rootEl.appendChild(healthCard());
  rootEl.appendChild(savedCard());
  rootEl.appendChild(recentCard());
  if (!hasSession()) rootEl.appendChild(checklistCard());
}

function greeting() {
  const self = getSelf();
  const hour = new Date().getHours();
  const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const name = self ? (self.displayName || self.name) : null;
  const text = name
    ? tr('roblox.home.greetingUser', `Good ${part}, ${name}`, `${part === 'morning' ? '早晨' : part === 'afternoon' ? '午安' : '晚安'}，${name}`)
    : tr('roblox.home.greeting', `Good ${part}`, `${part === 'morning' ? '早晨' : part === 'afternoon' ? '午安' : '晚安'}`);
  return el('header', { class: 'rbx-home__greeting' },
    el('h1', {}, text),
    el('p', { class: 'rbx-muted' }, tr(
      'roblox.home.tagline',
      'Browse Roblox profiles, friends, groups, games and the catalog — politely rate-limited.',
      '瀏覽 Roblox 個人檔案、朋友、群組、遊戲同市集 — 自動節流，有禮貌咁用 API。')));
}

/* ── Quick lookup ───────────────────────────────────────────────────────────── */

function quickLookupCard() {
  const input = el('input', {
    type: 'text',
    class: 'mrb-field',
    placeholder: tr('roblox.home.lookupPlaceholder', 'Username or user ID…', '用户名或用户 ID……'),
    spellcheck: 'false',
    autocomplete: 'off',
    enterkeyhint: 'go',
    'aria-label': tr('roblox.home.lookupLabel', 'Quick lookup: username or numeric user ID', '快速查詢：用户名或數字用户 ID'),
  });

  const status = el('p', { class: 'rbx-lookup__status', 'aria-live': 'polite' });
  const result = el('div', { class: 'rbx-lookup__result' });

  const go = async () => {
    const q = input.value.trim();
    if (!q) return;
    status.textContent = voice('info', tr('roblox.home.looking', 'Looking up…', '查詢中……'));
    result.textContent = '';
    try {
      const user = await resolveUserInput(q);
      pushRecentLookup({ key: `u${user.id}`, id: user.id, name: user.name, at: new Date().toISOString() });
      status.textContent = '';
      announce(tr('roblox.home.found', `Found ${user.name}`, `搵到 ${user.name}`));
      renderLookupResult(result, user);
    } catch (err) {
      status.textContent = '';
      result.textContent = '';
      result.appendChild(errorState(err, { retry: go }));
      announce(tr('roblox.home.lookupFailed', 'Lookup failed', '查詢失敗'));
    }
  };

  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); go(); } });

  return el('section', { class: 'rbx-card rbx-home__card' },
    el('h2', {}, tr('roblox.home.lookupTitle', 'Quick lookup', '快速查詢')),
    el('p', { class: 'rbx-muted' }, tr(
      'roblox.home.lookupHint',
      'Type a username or a numeric ID — numbers are treated as IDs automatically.',
      '輸入用户名或數字 ID — 純數字會自動當係 ID 處理。')),
    el('div', { class: 'rbx-lookup__row' },
      input,
      el('button', { type: 'button', class: 'mrb-btn filled', onclick: go },
        tr('roblox.home.go', 'Look up', '查詢'))),
    status, result);
}

function renderLookupResult(container, user) {
  container.textContent = '';
  const card = el('article', { class: 'rbx-lookup__hit' });
  const head = el('div', { class: 'rbx-lookup__head' });
  head.appendChild(thumbImg(null, { size: 64, alt: user.name, letter: user.name }));
  head.appendChild(el('div', {},
    el('strong', {}, user.displayName || user.name),
    el('div', { class: 'rbx-muted' }, `@${user.name} · ID ${user.id}`)));
  card.appendChild(head);
  card.appendChild(el('div', { class: 'rbx-actions' },
    el('button', {
      type: 'button', class: 'mrb-btn filled',
      onclick: () => router.navigate('roblox-users'),
    }, tr('roblox.home.openProfile', 'Open profile', '開啟個人檔案'))));
  container.appendChild(card);
  // Stash the resolved user for the Users tab to pick up.
  store.set('roblox:pendingUser', user);
}

/* ── Service health ─────────────────────────────────────────────────────────── */

function healthCard() {
  const grid = el('div', { class: 'rbx-health', role: 'list' });
  const updated = el('p', { class: 'rbx-muted rbx-health__updated', 'aria-live': 'polite' });

  const card = el('section', { class: 'rbx-card rbx-home__card' },
    el('div', { class: 'rbx-toolbar' },
      el('h2', {}, tr('roblox.home.healthTitle', 'Service status', '服務狀態')),
      el('button', {
        type: 'button', class: 'mrb-btn tonal',
        onclick: () => runProbes(true),
      }, tr('roblox.home.healthRefresh', 'Refresh', '刷新'))),
    grid, updated);

  async function runProbes(force) {
    if (healthCache && !force) {
      paint(healthCache);
      return;
    }
    grid.textContent = '';
    grid.appendChild(el('p', { class: 'rbx-muted' },
      tr('roblox.home.probing', 'Probing Roblox services…', '正在測試 Roblox 服務……')));
    updated.textContent = '';
    try {
      const results = await checkServices();
      healthCache = results;
      paint(results);
    } catch {
      grid.textContent = '';
      grid.appendChild(errorState(
        { message: 'Could not probe services.', status: 0, hint: 'Check your network connection.' },
        { retry: () => runProbes(true) }));
    }
  }

  function paint(results) {
    grid.textContent = '';
    for (const r of results) {
      grid.appendChild(el('div', { class: 'rbx-health__item', role: 'listitem' },
        healthDot(r.status),
        el('span', { class: 'rbx-health__name' }, tr(`roblox.svc.${r.key}`, r.en, r.yue)),
        el('span', { class: 'rbx-muted rbx-health__latency' },
          r.latencyMs != null ? `${r.latencyMs} ms` : tr('roblox.home.noReply', 'no reply', '冇回應'))));
    }
    const anyDown = results.some((r) => r.status === 'down');
    updated.textContent = voice(anyDown ? 'warn' : 'ok', `${formatDate(new Date().toISOString(), { withTime: true })} — ` +
      tr('roblox.home.checkedAt', 'checked just now', '啱啱檢查完'));
    announce(tr('roblox.home.healthDone',
      `Service check finished: ${results.filter((r) => r.status === 'ok').length} of ${results.length} healthy`,
      `服務檢查完成：${results.filter((r) => r.status === 'ok').length} / ${results.length} 正常`));
  }

  runProbes(false);
  return card;
}

/* ── Saved users ────────────────────────────────────────────────────────────── */

function savedCard() {
  const saved = getSavedUsers();
  const card = el('section', { class: 'rbx-card rbx-home__card' },
    el('h2', {}, tr('roblox.home.savedTitle', 'Saved users', '已收藏用户')));
  if (!saved.length) {
    card.appendChild(emptyState('⭐',
      tr('roblox.home.savedEmpty', 'No saved users yet', '仲未有收藏用户'),
      tr('roblox.home.savedEmptyBody',
        'Save a profile from the Users or Friends tab and it appears here for one-click access.',
        '喺 Users 或 Friends 分頁收藏個人檔案，之後就會喺度一鍵開啟。'),
      { label: tr('roblox.home.openUsers', 'Open Users', '開啟 Users'), onClick: () => router.navigate('roblox-users') }));
    return card;
  }
  const grid = el('div', { class: 'rbx-grid', style: '--rbx-grid-min:180px', role: 'list' });
  for (const u of saved.slice(0, 12)) {
    grid.appendChild(el('div', { class: 'rbx-card rbx-saved', role: 'listitem' },
      thumbImg(null, { size: 56, alt: u.name, letter: u.name }),
      el('div', { class: 'rbx-saved__text' },
        el('strong', {}, u.displayName || u.name),
        el('div', { class: 'rbx-muted' }, `@${u.name}`)),
      el('button', {
        type: 'button', class: 'mrb-btn text',
        'aria-label': `${tr('roblox.home.view', 'View', '查看')} ${u.name}`,
        onclick: () => { store.set('roblox:pendingUser', u); router.navigate('roblox-users'); },
      }, '→')));
  }
  card.appendChild(grid);
  return card;
}

/* ── Recent lookups ─────────────────────────────────────────────────────────── */

function recentCard() {
  const recents = getRecentLookups();
  const card = el('section', { class: 'rbx-card rbx-home__card' },
    el('h2', {}, tr('roblox.home.recentTitle', 'Recent lookups', '最近查詢')));
  if (!recents.length) {
    card.appendChild(emptyState('🕘',
      tr('roblox.home.recentEmpty', 'Nothing looked up yet', '仲未查詢過任何嘢'),
      tr('roblox.home.recentEmptyBody', 'Your lookups appear here, stored only on this device.', '查詢紀錄會喺度顯示，只會儲存喺本機。')));
    return card;
  }
  const chips = el('div', { class: 'rbx-chip-row' });
  for (const r of recents) {
    chips.appendChild(el('button', {
      type: 'button', class: 'mrb-chip',
      title: `${r.name} · ${formatDate(r.at)}`,
      onclick: () => { store.set('roblox:pendingUser', r); router.navigate('roblox-users'); },
    }, `${r.name}`));
  }
  card.appendChild(chips);
  return card;
}

/* ── Getting-started checklist (shown only while unauthenticated) ───────────── */

function checklistCard() {
  const items = [
    {
      done: hasSession(),
      label: tr('roblox.home.stepConnect', 'Connect a session to unlock balance, presence and economy data',
        '連接 session 解鎖餘額、在線狀態同經濟數據'),
      action: () => router.navigate('roblox-session'),
    },
    {
      done: getRecentLookups().length > 0,
      label: tr('roblox.home.stepLookup', 'Look up a player profile', '查詢一個玩家檔案'),
      action: () => router.navigate('roblox-users'),
    },
    {
      done: getSavedUsers().length > 0,
      label: tr('roblox.home.stepSave', 'Save a user for quick access', '收藏一個用户方便快速開啟'),
      action: () => router.navigate('roblox-users'),
    },
  ];
  return el('section', { class: 'rbx-card rbx-home__card' },
    el('h2', {}, tr('roblox.home.checklistTitle', 'Getting started', '開始使用')),
    el('ul', { class: 'rbx-checklist' },
      ...items.map((it) => el('li', {},
        el('span', { class: `rbx-checklist__mark ${it.done ? 'is-done' : ''}`, 'aria-hidden': 'true' }, it.done ? '☑' : '☐'),
        el('button', { type: 'button', class: 'rbx-checklist__label', onclick: it.action }, it.label)))),
    el('p', { class: 'rbx-muted' }, tr(
      'roblox.home.checklistNote',
      'Everything public works without a session; connecting only unlocks your own account data.',
      '所有公開資料唔使 session 都睇到；連接只係解鎖你自己帳戶嘅數據。')));
}
