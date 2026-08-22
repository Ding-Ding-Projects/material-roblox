/**
 * Roblox lane — Friends surface.
 *
 * Friends / Followers / Following lists for a target user (defaults to the
 * connected session's own account), count chips, chunked row rendering,
 * presence dots when a session exists, an explicit THIS PAGE vs ALL LOADED
 * select-all scope, and bulk actions: export (selected / all-filtered),
 * remove-from-saved (destructive, super-confirmed), open profile.
 */

import { ui } from '../../../core/ui.js';
import { router } from '../../../core/router.js';
import { store } from '../../../core/store.js';
import {
  friends, users, presence, hasSession, getSelf,
  isSavedUser, toggleSavedUser, getSavedUsers,
} from '../api.js';
import { tr } from '../peers.js';
import {
  announce, emptyState, errorState, formatNumber,
  paginationControls, presenceDot, thumbImg,
} from '../cards.js';
import { createSearchBar } from '../searchbar.js';
import { rowMatcher, regexErrorMessage } from '../safe-regex.js';
import {
  bulkBarShell, createSelection, exportButton, runDestructiveBatch,
  selectAllControl, updateBulkCount,
} from './helpers.js';

const el = (...args) => ui.el(...args);

const TAB_ID = 'roblox-friends';
/** Rows render in chunks so a 250-friend list never blocks the frame. */
const RENDER_CHUNK = 60;

export async function init() {
  const tabs = typeof router.list === 'function' ? router.list() : [];
  if (tabs.some((t) => t && t.id === TAB_ID)) return;
  router.registerTab({
    id: TAB_ID,
    title: tr('roblox.tabs.friends', 'Friends', '朋友'),
    icon: '👥',
    group: 'Roblox',
    render: (rootEl) => render(rootEl),
  });
}

/* ── Surface state (per render) ─────────────────────────────────────────────── */

async function render(rootEl) {
  rootEl.textContent = '';
  rootEl.className = 'rbx-surface';

  const state = {
    target: store.get('roblox:pendingFriendsTarget', null) || getSelf(),
    view: 'friends',
    rows: [],
    pageIds: [],
    cursor: '',
    loading: false,
    presenceMap: new Map(),
    sel: createSelection(),
    /** Local filter state: predicate over loaded rows, or null when inactive. */
    filterMatcher: null,
    filterQuery: '',
  };

  if (state.target) store.remove('roblox:pendingFriendsTarget');

  /* target picker */
  const lookupInput = el('input', {
    type: 'text', class: 'mrb-field',
    placeholder: tr('roblox.friends.lookupPlaceholder', 'Username or ID to browse', '輸入用户名或 ID 嚟睇'),
    'aria-label': tr('roblox.friends.lookupLabel', 'Target user for the list', '列表目標用户'),
    value: state.target ? String(state.target.name || state.target.id) : '',
  });
  const lookupBtn = el('button', { type: 'button', class: 'mrb-btn tonal', onclick: () => switchTarget(lookupInput.value) },
    tr('roblox.friends.load', 'Load', '載入'));

  async function switchTarget(q) {
    try {
      let resolved;
      if (!q.trim()) {
        const self = getSelf();
        if (!self) throw { status: 401, message: 'No session connected.', hint: 'Connect on the Session tab or type a username.' };
        resolved = self;
      } else if (/^\d+$/.test(q.trim())) {
        resolved = { id: Number(q.trim()), name: q.trim(), displayName: q.trim() };
      } else {
        resolved = await resolveByName(q.trim());
      }
      state.target = resolved;
      await loadView(true);
    } catch (err) {
      announce(tr('roblox.friends.targetFail', 'Could not load that user’s list', '載入唔到嗰個用户嘅清單'));
      listWrap.textContent = '';
      listWrap.appendChild(errorState(err));
    }
  }

  async function resolveByName(name) {
    // Local helper to avoid importing api.resolveUserInput twice per render.
    const res = await users.byUsernames([name]);
    const hit = res?.data?.[0];
    if (!hit) throw { status: 404, message: `No user named "${name}".`, hint: 'Usernames are exact.' };
    return { id: hit.id, name: hit.name, displayName: hit.displayName || hit.name };
  }

  /* view switcher */
  const VIEWS = [
    ['friends', () => tr('roblox.friends.tabFriends', 'Friends', '朋友')],
    ['followers', () => tr('roblox.friends.tabFollowers', 'Followers', '粉絲')],
    ['followings', () => tr('roblox.friends.tabFollowing', 'Following', '跟緊')],
  ];
  const tabBar = el('div', { class: 'rbx-segmented', role: 'tablist', 'aria-label': tr('roblox.friends.viewLabel', 'List type', '清單類型') });
  const viewButtons = new Map();
  for (const [key, label] of VIEWS) {
    const b = el('button', {
      type: 'button', role: 'tab',
      'aria-selected': String(state.view === key),
      onclick: () => { state.view = key; syncTabs(); loadView(true); },
    }, label());
    viewButtons.set(key, b);
    tabBar.appendChild(b);
  }
  function syncTabs() {
    for (const [key, b] of viewButtons) {
      b.setAttribute('aria-selected', String(state.view === key));
      b.className = state.view === key ? 'mrb-btn filled' : 'mrb-btn tonal';
    }
  }
  syncTabs();

  /* counts header */
  const countsRow = el('div', { class: 'rbx-stat-row' });

  /* bulk bar */
  const bulk = bulkBarShell();
  state.sel.onChange(() => {
    updateBulkCount(bulk.count, state.sel, state.sel.scopeAllLoaded()
      ? state.sel.allLoadedIds().length : state.pageIds.length);
    state.sel.announceSelection();
  });

  const scopeSelect = selectAllControl({
    scope: () => state.sel.scopeAllLoaded(),
    setScope: (v) => state.sel.setScopeAllLoaded(v),
    applyPage: () => state.sel.selectPageOnly(state.pageIds),
  });
  // The scope dropdown sits between the count readout and the actions.
  bulk.root.insertBefore(scopeSelect, bulk.actions);
  bulk.actions.append(
    el('button', {
      type: 'button', class: 'mrb-btn text',
      onclick: () => { state.sel.selectPageOnly(state.pageIds); },
      title: tr('roblox.bulk.checkPageTitle', 'Check every row on this page', '剔選本頁所有行'),
    }, tr('roblox.bulk.checkPage', 'Check all', '全部剔選')),
    el('button', {
      type: 'button', class: 'mrb-btn text',
      onclick: () => { state.sel.invert(state.pageIds); },
    }, tr('roblox.bulk.invert', 'Invert', '反選')),
    el('button', {
      type: 'button', class: 'mrb-btn text',
      onclick: () => { state.sel.clear(); },
    }, tr('roblox.bulk.clearSel', 'Clear selection', '清除選擇')));

  const exportSelected = await exportButton({
    name: 'roblox-friends-selected',
    label: tr('roblox.friends.exportSelected', 'Export selected', '匯出已選'),
    rows: () => state.rows.filter((r) => state.sel.ids().includes(String(r.id))),
  });
  if (exportSelected) bulk.actions.appendChild(exportSelected);

  const exportFiltered = await exportButton({
    name: `roblox-${state.view}-all-loaded`,
    label: tr('roblox.friends.exportAll', 'Export all loaded', '匯出所有已載入'),
    formats: ['json', 'csv'],
    rows: () => state.rows,
  });
  if (exportFiltered) bulk.actions.appendChild(exportFiltered);

  const removeSavedBtn = el('button', {
    type: 'button', class: 'mrb-btn danger',
    onclick: () => {
      const ids = state.sel.ids().map(Number);
      if (!ids.length) return;
      runDestructiveBatch({
        detailHtml: `<p>${tr('roblox.friends.removeBody',
          'Remove <strong>{{n}}</strong> selected user(s) from your saved list? This only affects this app\'s saved-users record; nothing happens on Roblox.',
          '將已揀嘅 <strong>{{n}}</strong> 個用户由收藏清單移除？只會影響本 App 嘅收藏紀錄；Roblox 嗰邊唔會有任何改變。').replace('{{n}}', String(ids.length))}</p>`,
        confirmLabel: tr('roblox.friends.removeConfirm', 'Remove from saved', '從收藏移除'),
        action: () => {
          const mapById = new Map(getSavedUsers().map((u) => [u.id, u]));
          ids.forEach((idv) => {
            const u = mapById.get(idv);
            if (u) toggleSavedUser(u);
          });
          paintRows();
        },
      });
    },
    title: tr('roblox.friends.removeTitle', 'Remove selected users from this app’s saved list', '將已選用户從本 App 收藏清單移除'),
  }, tr('roblox.friends.removeSaved', 'Remove from saved', '從收藏移除'));
  bulk.actions.appendChild(removeSavedBtn);

  /* local result filter — regex-capable, applied client-side to loaded rows.
     The server list endpoints take no query, so filtering here is the only
     kind that exists; an invalid pattern keeps the previous view and shows
     an inline error instead of throwing or blanking the list. */
  const filterErr = el('p', { class: 'rbx-muted', role: 'alert', hidden: true });
  const filterBar = await createSearchBar({
    placeholder: tr('roblox.friends.filterPlaceholder', 'Filter loaded names…', '篩選已載入嘅名……'),
    ariaLabel: tr('roblox.friends.filterLabel', 'Filter the loaded list locally', '喺本地篩選已載入清單'),
    historyKey: 'friends-filter',
    submitLabel: tr('roblox.friends.filterApply', 'Filter', '篩選'),
    supportsRegex: true,
    onQuery: (q, ctx) => applyLocalFilter(q, ctx),
  });
  const filterWrap = el('div', { class: 'rbx-friends__filter' }, filterBar.root, filterErr);

  /* list + pagination */
  const listWrap = el('div', { class: 'rbx-list', role: 'list' });
  const pagerSlot = el('div', {});
  const statusLine = el('p', { class: 'rbx-muted', 'aria-live': 'polite' });

  rootEl.append(
    el('h1', {}, tr('roblox.friends.title', 'Friends', '朋友')),
    el('div', { class: 'rbx-toolbar rbx-friends__target' }, lookupInput, lookupBtn, tabBar),
    countsRow,
    bulk.root,
    filterWrap,
    listWrap,
    pagerSlot,
    statusLine);

  /** Fields a row is filtered against. */
  const friendFields = (u) => [u.name, u.displayName, u.id];

  function clearFilterError() {
    filterErr.textContent = '';
    filterErr.hidden = true;
  }

  /**
   * Commit a new local filter. A regex that fails to compile keeps the last
   * good predicate in place and reports why inline — never a throw.
   */
  function applyLocalFilter(q, ctx) {
    clearFilterError();
    const raw = String(q ?? '').trim();
    if (!raw) {
      state.filterQuery = '';
      state.filterMatcher = null;
      paintRows();
      return;
    }
    const wantRegex = ctx && ctx.mode === 'regex';
    const flags = ctx && typeof ctx.flags === 'string' ? ctx.flags : '';
    const built = rowMatcher(raw, { mode: wantRegex ? 'regex' : 'plain', flags }, friendFields);
    if (!built.ok) {
      filterErr.textContent = regexErrorMessage(built.error, tr);
      filterErr.hidden = false;
      paintRows();
      return;
    }
    state.filterQuery = raw;
    state.filterMatcher = built.test;
    paintRows();
  }

  /** Rows on screen after the local filter; identical rows when it is off. */
  function visibleRows() {
    if (!state.filterMatcher) return state.rows;
    return state.rows.filter((r) => state.filterMatcher(r));
  }

  /** Honest empty state when the filter matches nothing that was loaded. */
  function filterEmptyState() {
    return emptyState('🔍',
      tr('roblox.friends.filterNoneTitle', 'Nothing matches this filter', '呢個篩選條件搵唔到嘢'),
      tr('roblox.friends.filterNoneBody',
        `No loaded row matches "${state.filterQuery}". Widen the pattern or clear it.`,
        `已載入嘅資料冇一項符合「${state.filterQuery}」。放寬個式或者清除佢。`),
      {
        label: tr('roblox.friends.filterClear', 'Clear filter', '清除篩選'),
        onClick: () => {
          filterBar.setValue('');
          applyLocalFilter('', null);
        },
      });
  }

  async function loadCounts(idv) {
    countsRow.textContent = '';
    const defs = [
      [tr('roblox.friends.tabFriends', 'Friends', '朋友'), () => friends.count(idv)],
      [tr('roblox.friends.tabFollowers', 'Followers', '粉絲'), () => friends.followerCount(idv)],
      [tr('roblox.friends.tabFollowing', 'Following', '跟緊'), () => friends.followingCount(idv)],
    ];
    for (const [label, fn] of defs) {
      const chip = el('span', { class: 'rbx-statchip' },
        el('strong', {}, '…'), el('span', { class: 'rbx-statchip__label' }, label));
      countsRow.appendChild(chip);
      fn().then((r) => { chip.querySelector('strong').textContent = formatNumber(r?.count); })
        .catch(() => { chip.querySelector('strong').textContent = '—'; });
    }
  }

  function fetchPage({ reset }) {
    if (!state.target) throw { status: 400, message: 'Pick a user first.', hint: 'Type a username above.' };
    const idv = state.target.id;
    const cursor = reset ? '' : state.cursor;
    if (state.view === 'friends') return friends.list(idv).then((r) => ({ data: r?.data || [], nextPageCursor: r?.nextPageCursor ?? null }));
    if (state.view === 'followers') return friends.followers(idv, { cursor }).then((r) => ({ data: r?.data || [], nextPageCursor: r?.nextPageCursor ?? null }));
    return friends.followings(idv, { cursor }).then((r) => ({ data: r?.data || [], nextPageCursor: r?.nextPageCursor ?? null }));
  }

  async function loadView(reset) {
    if (state.loading) return;
    state.loading = true;
    if (reset) {
      state.rows = [];
      state.sel.clear();
      state.cursor = '';
    }
    listWrap.textContent = '';
    listWrap.appendChild(el('p', { class: 'rbx-muted' }, tr('roblox.common.loading', 'Loading…', '載入中……')));
    statusLine.textContent = '';
    try {
      const page = await fetchPage({ reset });
      const incoming = page.data.map((u) => ({
        id: String(u.id), name: u.name, displayName: u.displayName || u.name,
      }));
      state.rows = reset ? incoming : dedupe([...state.rows, ...incoming]);
      state.pageIds = state.rows.slice(-RENDER_CHUNK * 2).map((r) => r.id);
      state.sel.setAllLoaded(state.rows.map((r) => r.id));
      state.cursor = page.nextPageCursor || '';
      countsRowUpdate();
      paintRows();
      maybePresence();
    } catch (err) {
      listWrap.textContent = '';
      listWrap.appendChild(errorState(err, { retry: () => loadView(reset) }));
      announce(tr('roblox.friends.loadFailed', 'List failed to load', '載入清單失敗'));
    } finally {
      state.loading = false;
    }
  }

  function countsRowUpdate() {
    if (state.rows.length && !countsRow.childNodes.length) {
      if (state.target) loadCounts(state.target.id);
    }
  }

  function dedupe(rows) {
    const seen = new Set();
    return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  }

  /** Presence dots need a session and are capped to the first 50 loaded rows. */
  function maybePresence() {
    if (!hasSession() || !state.rows.length) return;
    const slice = state.rows.slice(0, 50).map((r) => Number(r.id)).filter(Number.isFinite);
    presence.users(slice).then((res) => {
      for (const p of res?.userPresences || []) {
        state.presenceMap.set(String(p.userId), p.userPresenceType);
      }
      paintRows();
    }).catch(() => { /* presence stays absent; dots simply don't show */ });
  }

  function paintRows() {
    listWrap.textContent = '';
    pagerSlot.textContent = '';
    if (!state.rows.length) {
      listWrap.appendChild(emptyState('🫥',
        tr('roblox.friends.emptyTitle', 'Nobody here', '呢度冇人'),
        state.target
          ? `${state.target.displayName || state.target.name} — ${tr('roblox.friends.emptyBody', 'this list is empty.', '呢個清單係空嘅。')}`
          : tr('roblox.friends.emptyBody2', 'Load a user above to see their list.', '喺上面載入一個用户就會見到佢嘅清單。'),
        hasSession() ? null : {
          label: tr('roblox.friends.connect', 'Connect session', '連接 session'),
          onClick: () => router.navigate('roblox-session'),
        }));
      return;
    }

    const rows = visibleRows();
    if (!rows.length && state.filterMatcher) {
      // Filter matched nothing that was loaded — distinct from an empty list.
      listWrap.appendChild(filterEmptyState());
      announce(tr('roblox.friends.filterNoneAnnounce', 'No rows match the filter', '冇任何一項符合篩選條件'));
      return;
    }

    // Chunked rendering keeps long lists responsive.
    const frag = document.createDocumentFragment();
    const total = rows.length;
    let done = 0;
    const renderChunk = () => {
      const end = Math.min(done + RENDER_CHUNK, total);
      for (let i = done; i < end; i += 1) frag.appendChild(rowEl(rows[i], i));
      done = end;
      if (done < total) requestAnimationFrame(renderChunk);
      else finishPaint();
    };
    const finishPaint = () => {
      listWrap.textContent = '';
      listWrap.appendChild(frag);
      // The followers/followings APIs hand out forward cursors only, so this
      // pager offers Next-when-available and an honest Start-over instead of
      // pretending there is a previous page. With a filter active the counts
      // say shown-vs-loaded so the two numbers are never conflated.
      pagerSlot.appendChild(paginationControls({
        next: state.cursor ? () => loadView(false) : null,
        hint: state.filterMatcher
          ? tr('roblox.friends.filteredCount',
            `${formatNumber(rows.length)} match · ${formatNumber(state.rows.length)} loaded`,
            `${formatNumber(rows.length)} 項符合 · 已載入 ${formatNumber(state.rows.length)}`)
          : tr('roblox.friends.loadedCount', `${formatNumber(total)} loaded`, `已載入 ${formatNumber(total)}`),
        prevLabel: tr('roblox.pager.restart', '↺ Start over', '↺ 從頭再嚟'),
        nextLabel: tr('roblox.pager.next', 'Load more →', '載入更多 →'),
        prev: total ? () => loadView(true) : null,
      }));
      announce(tr('roblox.friends.loadedAnnounce', `List loaded: ${total} rows`, `清單已載入：${total} 行`));
    };
    requestAnimationFrame(renderChunk);
  }

  function rowEl(u, index) {
    const cb = state.sel.makeCheckbox(u.id, tr('roblox.friends.rowSelect', `Select ${u.name}`, `揀 ${u.name}`));
    const row = el('div', { class: 'rbx-row', role: 'listitem' },
      cb,
      thumbImg(null, { size: 44, alt: '', letter: u.name }),
      el('div', { class: 'rbx-row__main' },
        el('strong', {}, u.displayName || u.name),
        el('span', { class: 'rbx-muted' }, `@${u.name} · ${u.id}`)),
      el('span', { class: 'rbx-row__side' },
        hasSession() && state.presenceMap.has(u.id)
          ? presenceDot(state.presenceMap.get(u.id))
          : null,
        isSavedUser(u.id)
          ? el('span', { class: 'rbx-chip rbx-chip--muted', title: tr('roblox.friends.savedChip', 'Saved in this app', '本 App 已收藏') }, '★')
          : null,
        el('button', {
          type: 'button', class: 'mrb-btn text',
          onclick: () => {
            store.set('roblox:pendingUser', u);
            router.navigate('roblox-users');
          },
        }, tr('roblox.friends.profile', 'Profile', '檔案'))));
    state.sel.registerRow(row, u.id);
    void index;
    return row;
  }

  /* initial load */
  if (state.target) {
    await loadView(true);
  } else {
    listWrap.appendChild(emptyState('👤',
      tr('roblox.friends.noTarget', 'Choose whose list to browse', '揀一個用户嚟睇清單'),
      hasSession()
        ? tr('roblox.friends.noTargetBody', 'Your own lists load by default once connected.', '連接之後預設會載入你自己嘅清單。')
        : tr('roblox.friends.noTargetBody2', 'Connect a session to default to your own lists, or type any username above.',
          '連接 session 就會預設用你自己嘅清單，或者喺上面輸入任何用户名。'),
      { label: tr('roblox.friends.openSession', 'Open Session', '開啟 Session'), onClick: () => router.navigate('roblox-session') }));
  }
}
