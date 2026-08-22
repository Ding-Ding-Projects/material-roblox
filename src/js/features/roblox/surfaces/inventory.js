/**
 * Roblox lane — Inventory surface.
 *
 * Public inventories by asset type with infinite-scroll pagination in
 * chunks of 100, per-item thumbnails, serial numbers when present,
 * copy-asset-id action, an honest privacy-403 state explaining what the
 * owner would need to change, and bulk export of selected / all-loaded rows.
 * Total counts are shown only when the API supplies them — otherwise the
 * surface says "unknown" instead of guessing.
 */

import { ui } from '../../../core/ui.js';
import { router } from '../../../core/router.js';
import {
  inventory, users, batchThumbnails, ASSET_TYPES,
} from '../api.js';
import { tr } from '../peers.js';
import {
  announce, emptyState, errorState, formatNumber, thumbImg,
} from '../cards.js';
import { createSearchBar } from '../searchbar.js';
import { rowMatcher, regexErrorMessage } from '../safe-regex.js';
import {
  bulkBarShell, createSelection, exportButton, selectAllControl,
  updateBulkCount,
} from './helpers.js';

const el = (...args) => ui.el(...args);

const TAB_ID = 'roblox-inventory';

export async function init() {
  const list = typeof router.list === 'function' ? router.list() : [];
  if (list.some((t) => t && t.id === TAB_ID)) return;
  router.registerTab({
    id: TAB_ID,
    title: tr('roblox.tabs.inventory', 'Inventory', '物品欄'),
    icon: '🎒',
    group: 'Roblox',
    render: (rootEl) => render(rootEl),
  });
}

async function render(rootEl) {
  rootEl.textContent = '';
  rootEl.className = 'rbx-surface';

  const state = {
    userId: null,
    userName: '',
    typeId: ASSET_TYPES[0].id,
    rows: [],
    cursor: '',
    loading: false,
    ended: false,
    sel: createSelection(),
    total: null,
    /** Rows already rendered; pages can be shorter than 100. */
    painted: 0,
    /** Local filter state: predicate over loaded rows, or null when inactive. */
    filterMatcher: null,
    filterQuery: '',
  };

  /* target + type controls */
  const bar = await createSearchBar({
    placeholder: tr('roblox.inv.placeholder', 'User ID or username…', '用户 ID 或用户名……'),
    ariaLabel: tr('roblox.inv.searchLabel', 'Inventory owner lookup', '物品欄擁有者查詢'),
    historyKey: 'inventory',
    submitLabel: tr('roblox.inv.load', 'Load inventory', '載入物品欄'),
    onQuery: (q) => switchOwner(q),
  });

  /* local item filter — regex-capable, applied client-side to loaded rows.
     The owner lookup above stays server-side (Roblox resolves users by exact
     name or id), so this second bar is what honors regex mode here. An
     invalid pattern keeps the previous view and reports inline, never throws. */
  const filterErr = el('p', { class: 'rbx-muted', role: 'alert', hidden: true });
  const itemFilter = await createSearchBar({
    placeholder: tr('roblox.inv.filterPlaceholder', 'Filter loaded items…', '篩選已載入物品……'),
    ariaLabel: tr('roblox.inv.filterLabel', 'Filter the loaded items locally', '喺本地篩選已載入物品'),
    historyKey: 'inventory-filter',
    submitLabel: tr('roblox.inv.filterApply', 'Filter', '篩選'),
    supportsRegex: true,
    onQuery: (q, ctx) => applyLocalFilter(q, ctx),
  });

  const typeSelect = el('select', {
    class: 'mrb-select',
    'aria-label': tr('roblox.inv.typeLabel', 'Asset type', '物品類型'),
    onchange: () => { state.typeId = Number(typeSelect.value); load(true); },
  }, ...ASSET_TYPES.map((t) => el('option', { value: String(t.id) }, tr(`roblox.inv.asset.${t.id}`, t.label, t.yue))));
  typeSelect.value = String(state.typeId);

  /* bulk bar */
  const bulk = bulkBarShell();
  state.sel.onChange(() => {
    updateBulkCount(bulk.count, state.sel, state.rows.length);
    state.sel.announceSelection();
  });
  const scopeSelect = selectAllControl({
    scope: () => state.sel.scopeAllLoaded(),
    setScope: (v) => state.sel.setScopeAllLoaded(v),
    applyPage: () => state.sel.selectPageOnly(state.rows.map((r) => r.id)),
  });
  // Mount the scope dropdown between the count readout and the actions.
  bulk.root.insertBefore(scopeSelect, bulk.actions);
  bulk.actions.append(
    el('button', { type: 'button', class: 'mrb-btn text', onclick: () => state.sel.selectPageOnly(state.rows.map((r) => r.id)) },
      tr('roblox.bulk.checkAll', 'Check all', '全部剔選')),
    el('button', { type: 'button', class: 'mrb-btn text', onclick: () => state.sel.invert(state.rows.map((r) => r.id)) },
      tr('roblox.bulk.invert', 'Invert', '反選')),
    el('button', { type: 'button', class: 'mrb-btn text', onclick: () => state.sel.clear() },
      tr('roblox.bulk.clearSel', 'Clear selection', '清除選擇')));

  const exportSelected = await exportButton({
    name: 'roblox-inventory-selected',
    label: tr('roblox.inv.exportSelected', 'Export selected', '匯出已選'),
    rows: () => state.rows.filter((r) => state.sel.ids().includes(r.id)),
  });
  if (exportSelected) bulk.actions.appendChild(exportSelected);

  const exportAll = await exportButton({
    name: 'roblox-inventory-all-loaded',
    label: tr('roblox.inv.exportAll', 'Export all loaded', '匯出所有已載入'),
    formats: ['json', 'csv'],
    rows: () => state.rows.map((r) => ({
      assetId: r.id, name: r.name, serial: r.serialNumber ?? '',
      assetTypeId: state.typeId, ownerUserId: state.userId,
    })),
  });
  if (exportAll) bulk.actions.appendChild(exportAll);

  /* list */
  const listWrap = el('div', { class: 'rbx-list', role: 'list' });
  const sentinel = el('div', { class: 'rbx-inv__sentinel', 'aria-hidden': 'true' });
  const statusLine = el('p', { class: 'rbx-muted', 'aria-live': 'polite' });

  rootEl.append(
    el('h1', {}, tr('roblox.inv.title', 'Inventory', '物品欄')),
    el('p', { class: 'rbx-muted' }, tr(
      'roblox.inv.hint',
      'Browse an account’s public inventory by asset type. Private inventories stay private — see the note when one refuses.',
      '按物品類型瀏覽公開物品欄。私人物品欄會保持私人 — 拒絕嗰陣會有說明。')),
    bar.root,
    el('div', { class: 'rbx-inv__filter' }, itemFilter.root, filterErr),
    el('div', { class: 'rbx-toolbar' }, typeSelect, bulk.root),
    listWrap, sentinel, statusLine);

  /** Fields an inventory row is filtered against. */
  const itemFields = (r) => [r.name, r.serialNumber, r.id];

  function clearFilterError() {
    filterErr.textContent = '';
    filterErr.hidden = true;
  }

  /** Commit a new local filter; a bad pattern keeps the last good one. */
  function applyLocalFilter(q, ctx) {
    clearFilterError();
    const raw = String(q ?? '').trim();
    const wantRegex = ctx && ctx.mode === 'regex';
    const flags = ctx && typeof ctx.flags === 'string' ? ctx.flags : '';

    if (!raw) {
      state.filterQuery = '';
      state.filterMatcher = null;
      if (state.rows.length) paint(false);
      return;
    }
    const built = rowMatcher(raw, { mode: wantRegex ? 'regex' : 'plain', flags }, itemFields);
    if (!built.ok) {
      filterErr.textContent = regexErrorMessage(built.error, tr);
      filterErr.hidden = false;
      if (state.rows.length) paint(false); // keep the previous view on screen
      return;
    }
    // Commit even before anything loads: the filter shown in the input is
    // then exactly the one applied whenever a list loads.
    state.filterQuery = raw;
    state.filterMatcher = built.test;
    if (state.rows.length) paint(false);
  }

  /** Honest note when the local filter matches nothing that was loaded. */
  function filterEmptyNote() {
    return el('div', { class: 'rbx-card rbx-home__card', role: 'status' },
      el('p', {}, tr('roblox.inv.filterNoneTitle',
        `No loaded item matches "${state.filterQuery}".`,
        `已載入嘅物品冇一件符合「${state.filterQuery}」。`)),
      el('div', { class: 'rbx-actions' },
        el('button', {
          type: 'button', class: 'mrb-btn text',
          onclick: () => {
            itemFilter.setValue('');
            applyLocalFilter('', null);
          },
        }, tr('roblox.inv.filterClear', 'Clear filter', '清除篩選'))));
  }

  /* infinite scroll */
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) load(false);
  }, { rootMargin: '400px' });
  io.observe(sentinel);

  async function switchOwner(raw) {
    const q = String(raw || '').trim();
    if (!q) return;
    try {
      let idv;
      let name = q;
      if (/^\d+$/.test(q)) {
        idv = Number(q);
        const p = await users.getById(idv).catch(() => null);
        if (p?.name) name = p.name;
      } else {
        const res = await users.byUsernames([q]);
        const hit = res?.data?.[0];
        if (!hit) throw { status: 404, message: `No user named "${q}".`, hint: 'Usernames are exact.' };
        idv = hit.id;
        name = hit.name;
      }
      state.userId = idv;
      state.userName = name;
      load(true);
    } catch (err) {
      listWrap.textContent = '';
      listWrap.appendChild(errorState(err));
    }
  }

  async function load(reset) {
    if (state.loading || state.userId == null) return;
    if (!reset && (state.ended || !state.cursor)) return;
    state.loading = true;
    if (reset) {
      state.rows = [];
      state.cursor = '';
      state.ended = false;
      state.sel.resetRows();
      state.sel.clear();
      state.total = null;
      listWrap.textContent = '';
      listWrap.appendChild(el('p', { class: 'rbx-muted' }, tr('roblox.common.loading', 'Loading…', '載入中……')));
    }
    try {
      const page = await inventory.getUserAssets(state.userId, state.typeId, { cursor: reset ? '' : state.cursor, limit: 100 });
      const incoming = (page?.data || []).map((it) => ({
        id: String(it.id),
        name: it.name || '',
        serialNumber: it.serialNumber,
        userAssetId: it.userAssetId,
      }));
      state.rows = reset ? incoming : merge(state.rows, incoming);
      state.cursor = page?.nextPageCursor || '';
      if (!state.cursor) state.ended = true;
      // The endpoint returns no total count; state.total stays null and the
      // status line reports "unknown" instead of guessing.
      // Awaited so `loading` stays true until rows are actually on screen;
      // otherwise the scroll sentinel can trigger a duplicate page.
      await paint(reset);
      if (reset && !incoming.length) {
        listWrap.textContent = '';
        listWrap.appendChild(emptyState('🎒',
          tr('roblox.inv.emptyTitle', 'No items of this type', '呢個類型冇物品'),
          `${state.userName} — ${tr('roblox.inv.emptyBody', 'nothing in this category is public.', '呢個分類冇公開嘅物品。')}`,
          null));
      }
    } catch (err) {
      listWrap.textContent = '';
      if (err && err.status === 403) {
        // Privacy state: explain exactly what is happening and what would change it.
        listWrap.appendChild(el('div', { class: 'rbx-card rbx-home__card rbx-inv__privacy', role: 'alert' },
          el('h2', {}, '🔒 ', tr('roblox.inv.privateTitle', 'This inventory is private', '呢個物品欄係私人嘅')),
          el('p', {}, tr('roblox.inv.privateBody1',
            `${state.userName || 'This user'} has set their inventory to private, so its contents cannot be listed.`,
            `${state.userName || '呢個用户'} 將物品欄設為私人，所以內容唔可以列出。`)),
          el('p', {}, tr('roblox.inv.privateBody2',
            'Only the account owner can change this, in Roblox account Settings → Privacy → Inventory.',
            '只有帳戶擁有者可以先改，位置喺 Roblox 帳戶設定 → 私隱 → 物品欄。')),
          el('p', { class: 'rbx-muted' }, tr('roblox.inv.privateBody3',
            'There is nothing to fix on this app’s side — retrying will not change the answer.',
            '本 App 呢邊冇嘢可以修 — 重試都唔會改變結果。'))));
      } else {
        listWrap.appendChild(errorState(err, { retry: () => load(reset) }));
      }
      announce(tr('roblox.inv.loadFailed', 'Inventory failed to load', '載入物品欄失敗'));
    } finally {
      state.loading = false;
    }
  }

  function merge(existing, incoming) {
    const seen = new Set(existing.map((r) => r.id));
    return [...existing, ...incoming.filter((r) => !seen.has(r.id))];
  }

  async function paint(reset) {
    // With a local filter active the list rebuilds from the matching subset;
    // without one the append-only incremental path is unchanged.
    const filtering = Boolean(state.filterMatcher);
    if (reset || filtering) { listWrap.textContent = ''; state.painted = 0; }
    const visible = filtering ? state.rows.filter((r) => state.filterMatcher(r)) : state.rows;
    const frag = document.createDocumentFragment();
    // Append only rows that are not on screen yet — pages may be shorter
    // than 100, so an index-based tail would duplicate earlier rows.
    const fresh = reset || filtering ? visible : state.rows.slice(state.painted);
    const thumbs = fresh.length
      ? await batchThumbnails(fresh.map((r) => ({ type: 'Asset', targetId: r.id, size: '150x150' })))
      : new Map();

    for (const r of fresh) {
      const cb = state.sel.makeCheckbox(r.id, tr('roblox.inv.rowSelect', `Select ${r.name || r.id}`, `揀 ${r.name || r.id}`));
      const url = thumbs.get(String(r.id));
      const row = el('div', { class: 'rbx-row', role: 'listitem' },
        cb,
        thumbImg(/^https?:/.test(url || '') ? url : null, { size: 44, alt: r.name || '', letter: (r.name || '?') }),
        el('div', { class: 'rbx-row__main' },
          el('strong', {}, r.name || tr('roblox.inv.unnamed', '(unnamed item)', '（冇名物品）')),
          el('span', { class: 'rbx-muted' },
            r.serialNumber != null
              ? tr('roblox.inv.serial', `#${r.serialNumber}`, `#${r.serialNumber}`)
              : `ID ${r.id}`)),
        el('span', { class: 'rbx-row__side' },
          el('button', {
            type: 'button', class: 'mrb-btn text',
            onclick: async () => { try { await ui.copyText(r.id); } catch { /* clipboard unavailable */ } },
            title: tr('roblox.inv.copyIdTitle', `Copy asset ID ${r.id}`, `複製物品 ID ${r.id}`),
            'aria-label': tr('roblox.inv.copyId', `Copy asset ID`, '複製物品 ID'),
          }, tr('roblox.inv.copyId', 'Copy ID', '複製 ID'))));
      state.sel.registerRow(row, r.id);
      frag.appendChild(row);
    }
    listWrap.appendChild(frag);
    if (filtering && !visible.length && state.rows.length) {
      listWrap.appendChild(filterEmptyNote());
    }
    state.painted = state.rows.length;

    // Honest total: the API does not return one; say unknown rather than guess.
    // With a filter active, shown-vs-loaded are reported separately.
    statusLine.textContent = filtering
      ? tr('roblox.inv.filteredStatus',
        `${formatNumber(visible.length)} of ${formatNumber(state.rows.length)} loaded match this filter${state.ended ? ' — end of list' : ''}`,
        `已載入 ${formatNumber(state.rows.length)} 項之中有 ${formatNumber(visible.length)} 項符合篩選${state.ended ? ' — 到底' : ''}`)
      : tr('roblox.inv.loadedStatus',
        `${formatNumber(state.rows.length)} loaded${state.ended ? ' — end of list' : ''} · total: ${state.total != null ? formatNumber(state.total) : 'unknown'}`,
        `已載入 ${formatNumber(state.rows.length)}${state.ended ? ' — 到底' : ''} · 總數：${state.total != null ? formatNumber(state.total) : '不明'}`);
    if (reset) {
      announce(tr('roblox.inv.loadedAnnounce', `Inventory loaded: ${state.rows.length} items`, `物品欄已載入：${state.rows.length} 件`));
    }
  }

  // Pending handoff from Users tab is not used here; owner must be chosen.
  listWrap.appendChild(emptyState('🎒',
    tr('roblox.inv.startTitle', 'Choose an owner above', '喺上面揀一個擁有者'),
    tr('roblox.inv.startBody', 'Enter a username or user ID, pick an asset type, and the public list loads here.',
      '輸入用户名或用户 ID、揀物品類型，公開清單就會喺度載入。'),
    null));
}
