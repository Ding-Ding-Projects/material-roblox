/**
 * Roblox lane — Marketplace surface.
 *
 * Catalog search with a filter bar (keyword, category, price range, creator,
 * sort), result cards with Robux price chips and Limited badges, batched
 * creator resolution (users + groups), an item detail drawer with sale
 * details and catalog link, cursor pagination, and export of the visible,
 * filtered result set.
 */

import { ui } from '../../../core/ui.js';
import { router } from '../../../core/router.js';
import { settings } from '../../../core/settings.js';
import {
  catalog, users, groups, batchThumbnails, CATEGORY_MAP,
} from '../api.js';
import { tr } from '../peers.js';
import {
  announce, drawer, emptyState, errorState, formatNumber, gridContainer,
  paginationControls, resultCard, skeletonCards, statChip, thumbImg,
} from '../cards.js';
import { createSearchBar } from '../searchbar.js';
import { rowMatcher, regexErrorMessage } from '../safe-regex.js';
import { exportButton } from './helpers.js';

const el = (...args) => ui.el(...args);

const TAB_ID = 'roblox-marketplace';

/** Sort values are the documented SortType vocabulary of /v1/search/items. */
const SORTS = [
  { value: 'Relevance', en: 'Relevance', yue: '相關度' },
  { value: 'PriceAsc', en: 'Price: low → high', yue: '價錢：低至高' },
  { value: 'PriceDesc', en: 'Price: high → low', yue: '價錢：高至低' },
  { value: 'MostFavorited', en: 'Most favorited', yue: '最多收藏' },
];

export async function init() {
  const list = typeof router.list === 'function' ? router.list() : [];
  if (list.some((t) => t && t.id === TAB_ID)) return;
  router.registerTab({
    id: TAB_ID,
    title: tr('roblox.tabs.marketplace', 'Marketplace', '市集'),
    icon: '🛍️',
    group: 'Roblox',
    render: (rootEl) => render(rootEl),
  });
}

async function render(rootEl) {
  rootEl.textContent = '';
  rootEl.className = 'rbx-surface';

  const state = {
    results: [],
    cursor: '',
    loading: false,
    /** @type {Map<string,string>} `${creatorType}:${id}` → display name */
    creatorNames: new Map(),
    filters: {
      keyword: '', category: '', minPrice: '', maxPrice: '',
      creatorTargetId: '', sortType: 'Relevance',
    },
    /** Local result filter state; predicate over loaded rows or null. */
    filterMatcher: null,
    filterQuery: '',
  };

  /* ── filter bar ──────────────────────────────────────────────────────────── */

  const keywordInput = el('input', {
    type: 'text', class: 'mrb-field',
    placeholder: tr('roblox.market.keywordPlaceholder', 'Keyword…', '關鍵字……'),
    'aria-label': tr('roblox.market.keywordLabel', 'Catalog keyword', '市集關鍵字'),
  });

  const categorySelect = el('select', {
    class: 'mrb-select',
    'aria-label': tr('roblox.market.categoryLabel', 'Category', '分類'),
  }, ...CATEGORY_MAP.map((c) => el('option', { value: c.value }, tr(`roblox.market.cat.${c.value || 'all'}`, c.label, c.yue))));

  const minPrice = el('input', {
    type: 'number', class: 'mrb-field rbx-market__price', min: 0, placeholder: tr('roblox.market.minPrice', 'Min ₽', '最低 R$'),
    'aria-label': tr('roblox.market.minPriceLabel', 'Minimum price in Robux', '最低價（Robux）'),
  });
  const maxPrice = el('input', {
    type: 'number', class: 'mrb-field rbx-market__price', min: 0, placeholder: tr('roblox.market.maxPrice', 'Max ₽', '最高 R$'),
    'aria-label': tr('roblox.market.maxPriceLabel', 'Maximum price in Robux', '最高價（Robux）'),
  });

  const creatorInput = el('input', {
    type: 'text', class: 'mrb-field rbx-market__creator',
    placeholder: tr('roblox.market.creatorPlaceholder', 'Creator user ID…', '創作者用户 ID……'),
    inputmode: 'numeric',
    'aria-label': tr('roblox.market.creatorLabel', 'Creator user ID filter', '創作者用户 ID 篩選'),
  });

  const sortSelect = el('select', {
    class: 'mrb-select',
    'aria-label': tr('roblox.market.sortLabel', 'Sort order', '排序方式'),
  }, ...SORTS.map((s) => el('option', { value: s.value }, tr(`roblox.market.sort.${s.value}`, s.en, s.yue))));

  const applyBtn = el('button', { type: 'button', class: 'mrb-btn filled', onclick: () => applyFilters(true) },
    tr('roblox.market.apply', 'Apply', '套用'));

  const filterBar = el('div', { class: 'rbx-toolbar rbx-market__filters' },
    keywordInput, categorySelect, minPrice, maxPrice, creatorInput, sortSelect, applyBtn);

  /* local result filter — regex-capable, applied client-side to loaded results.
     The keyword field above stays server-side (the catalog search endpoint
     takes plain keywords), so this second bar is what honors regex mode here.
     An invalid pattern keeps the previous grid and reports inline, never throws. */
  const localFilterErr = el('p', { class: 'rbx-muted', role: 'alert', hidden: true });
  const localFilter = await createSearchBar({
    placeholder: tr('roblox.market.filterPlaceholder', 'Filter loaded results…', '篩選已載入結果……'),
    ariaLabel: tr('roblox.market.filterLabel', 'Filter the loaded results locally', '喺本地篩選已載入結果'),
    historyKey: 'marketplace-filter',
    submitLabel: tr('roblox.market.filterApply', 'Filter', '篩選'),
    supportsRegex: true,
    onQuery: (q, ctx) => applyLocalFilter(q, ctx),
  });
  const localFilterWrap = el('div', { class: 'rbx-market__localfilter' }, localFilter.root, localFilterErr);

  /** Fields a marketplace result row is filtered against. */
  const resultFields = (r) => [r.name, creatorNameOf(r), r.itemType || r.assetType || '', r.id];

  function clearLocalFilterError() {
    localFilterErr.textContent = '';
    localFilterErr.hidden = true;
  }

  /** Commit a new local result filter; a bad pattern keeps the last good one. */
  function applyLocalFilter(q, ctx) {
    clearLocalFilterError();
    const raw = String(q ?? '').trim();
    if (!raw) {
      state.filterQuery = '';
      state.filterMatcher = null;
      paint();
      return;
    }
    const wantRegex = ctx && ctx.mode === 'regex';
    const flags = ctx && typeof ctx.flags === 'string' ? ctx.flags : '';
    const built = rowMatcher(raw, { mode: wantRegex ? 'regex' : 'plain', flags }, resultFields);
    if (!built.ok) {
      localFilterErr.textContent = regexErrorMessage(built.error, tr);
      localFilterErr.hidden = false;
      paint();
      return;
    }
    state.filterQuery = raw;
    state.filterMatcher = built.test;
    paint();
  }

  /** Honest empty state when the local filter matches nothing that was loaded. */
  function localFilterEmptyState() {
    return emptyState('🔍',
      tr('roblox.market.filterNoneTitle', 'No loaded result matches this filter', '已載入嘅結果冇一件符合呢個篩選'),
      tr('roblox.market.filterNoneBody',
        `Nothing among the ${state.results.length} loaded items matches "${state.filterQuery}". Widen the pattern or clear it.`,
        `已載入嘅 ${state.results.length} 件物品之中冇一件符合「${state.filterQuery}」。放寬個式或者清除佢。`),
      {
        label: tr('roblox.market.filterClear', 'Clear filter', '清除篩選'),
        onClick: () => {
          localFilter.setValue('');
          applyLocalFilter('', null);
        },
      });
  }

  /* ── results area ────────────────────────────────────────────────────────── */

  const gridSlot = el('div', {});
  const pagerSlot = el('div', {});
  const statusLine = el('p', { class: 'rbx-muted', 'aria-live': 'polite' });

  const exportBtn = await exportButton({
    name: 'roblox-marketplace-results',
    rows: () => state.results.map((r) => ({
      id: r.id, itemType: r.itemType || r.type, name: r.name,
      price: lowestPrice(r), creator: creatorNameOf(r),
      limited: isLimited(r), favorites: r.favoriteCount ?? '',
    })),
  });
  const exportRow = exportBtn ? el('div', { class: 'rbx-toolbar' }, exportBtn) : null;

  rootEl.append(
    el('h1', {}, tr('roblox.market.title', 'Marketplace', '市集')),
    el('p', { class: 'rbx-muted' }, tr(
      'roblox.market.hint',
      'Search the public catalog. Price filters use Robux.',
      '搜尋公開市集。價錢篩選用 Robux。')),
    filterBar,
    localFilterWrap,
    ...(exportRow ? [exportRow] : []),
    gridSlot, pagerSlot, statusLine);

  function collectFilters() {
    state.filters.keyword = keywordInput.value.trim();
    state.filters.category = categorySelect.value;
    state.filters.minPrice = minPrice.value === '' ? null : Number(minPrice.value);
    state.filters.maxPrice = maxPrice.value === '' ? null : Number(maxPrice.value);
    if (!/^\d*$/.test(creatorInput.value.trim())) creatorInput.value = '';
    state.filters.creatorTargetId = creatorInput.value.trim() || null;
    state.filters.sortType = sortSelect.value;
  }

  async function applyFilters(reset) {
    if (state.loading) return;
    state.loading = true;
    collectFilters();
    if (reset) {
      state.results = [];
      state.cursor = '';
      gridSlot.textContent = '';
      gridSlot.appendChild(skeletonCards(8));
      pagerSlot.textContent = '';
    }
    try {
      const res = await catalog.searchItems({
        keyword: state.filters.keyword,
        category: state.filters.category,
        creatorTargetId: state.filters.creatorTargetId,
        sortType: state.filters.sortType,
        limit: 10,
        cursor: reset ? '' : state.cursor,
        currencyType: (state.filters.minPrice != null || state.filters.maxPrice != null) ? 'Robux' : undefined,
        minPrice: state.filters.minPrice,
        maxPrice: state.filters.maxPrice,
      });
      const incoming = res?.data || [];
      state.results = reset ? incoming : mergeById(state.results, incoming);
      state.cursor = res?.nextPageCursor || '';

      await resolveCreators(incoming);
      paint();
      statusLine.textContent = '';
    } catch (err) {
      gridSlot.textContent = '';
      gridSlot.appendChild(errorState(err, { retry: () => applyFilters(reset) }));
      announce(tr('roblox.market.searchFailed', 'Marketplace search failed', '市集搜尋失敗'));
    } finally {
      state.loading = false;
    }
  }

  function mergeById(existing, incoming) {
    const seen = new Set(existing.map((r) => String(r.id)));
    return [...existing, ...incoming.filter((r) => !seen.has(String(r.id)))];
  }

  /** Batch-resolve User creators via users.getByIds; Groups one-by-one. */
  async function resolveCreators(rows) {
    const userIds = new Set();
    const groupIds = new Set();
    for (const r of rows) {
      const c = r.creator || {};
      const idv = c.creatorTargetId ?? c.id ?? c.targetId;
      if (!Number.isFinite(Number(idv))) continue;
      const type = String(c.creatorType || c.type || 'User').toLowerCase();
      if (type.includes('group')) groupIds.add(Number(idv));
      else userIds.add(Number(idv));
    }
    const jobs = [];
    if (userIds.size) {
      jobs.push(users.getByIds([...userIds]).then((res) => {
        for (const u of res?.data || []) state.creatorNames.set(`user:${u.id}`, u.displayName || u.name);
      }).catch(() => { /* names stay unresolved; ids still shown */ }));
    }
    for (const gid of [...groupIds].slice(0, 8)) {
      jobs.push(groups.get(gid).then((g) => {
        if (g?.name) state.creatorNames.set(`group:${gid}`, g.name);
      }).catch(() => { /* as above */ }));
    }
    await Promise.all(jobs);
  }

  function creatorNameOf(r) {
    const c = r.creator || {};
    const idv = c.creatorTargetId ?? c.id ?? c.targetId;
    const type = String(c.creatorType || c.type || 'User').toLowerCase();
    const key = `${type.includes('group') ? 'group' : 'user'}:${idv}`;
    return state.creatorNames.get(key) || (r.creator?.name ?? (idv != null ? `#${idv}` : '—'));
  }

  function lowestPrice(r) {
    if (r.priceStatus) return r.priceStatus;
    if (Number.isFinite(Number(r.price))) return Number(r.price);
    const offers = Array.isArray(r.priceOptions) ? r.priceOptions.map((p) => p.price).filter(Number.isFinite) : [];
    return offers.length ? Math.min(...offers) : null;
  }

  function isLimited(r) {
    // Limited items expose collectible details (serial ranges / copies).
    return Boolean(r.collectibleDetails && (
      r.collectibleDetails.serialNumberLimit != null ||
      r.collectibleDetails.quantityLimitPerUser != null ||
      Array.isArray(r.collectibleDetails.consignedQuantityAvailable)
    )) || Boolean(r.itemRestrictions?.includes?.('Limited')) || Boolean(r.hasLimitedAttraction);
  }

  async function paint() {
    gridSlot.textContent = '';
    pagerSlot.textContent = '';
    if (!state.results.length) {
      gridSlot.appendChild(emptyState('🛒',
        tr('roblox.market.emptyTitle', 'No items matched these filters', '呢組篩選條件搵唔到物品'),
        tr('roblox.market.emptyBody', 'Try removing a price bound or clearing the creator filter.', '試下清除其中一個價格上限或者創作者篩選。'),
        { label: tr('roblox.market.reset', 'Reset filters', '重設篩選'), onClick: resetFilters }));
      announce(tr('roblox.market.emptyAnnounce', 'No marketplace results', '市集冇結果'));
      return;
    }

    // Local filter applies to the loaded set only; the grid shows the match.
    const visible = state.filterMatcher
      ? state.results.filter((r) => state.filterMatcher(r))
      : state.results;
    if (state.filterMatcher && !visible.length) {
      gridSlot.appendChild(localFilterEmptyState());
      announce(tr('roblox.market.filterNoneAnnounce', 'No loaded result matches the filter', '已載入結果冇一件符合篩選'));
      return;
    }

    const thumbs = await batchThumbnails(visible.slice(-30).map((r) => ({
      type: 'Asset', targetId: r.id, size: '420x420',
    })));

    const grid = gridContainer({ minCol: 240, label: tr('roblox.market.gridLabel', 'Marketplace results', '市集結果') });
    for (const r of visible.slice(-60)) {
      const price = lowestPrice(r);
      const t = thumbs.get(String(r.id));
      grid.appendChild(resultCard({
        thumb: /^https?:/.test(t || '') ? t : null,
        thumbAlt: r.name || 'Item image',
        title: r.name || `#${r.id}`,
        subtitle: creatorNameOf(r),
        badges: [
          ...(isLimited(r) ? [{ text: tr('roblox.market.limited', 'Limited', '限定'), tone: 'limited' }] : []),
          ...(price != null ? [{ text: `R$ ${formatNumber(price)}`, tone: 'robux' }] : [{ text: r.priceStatus || tr('roblox.market.noPrice', 'Off sale', '冇賣'), tone: 'muted' }]),
        ],
        meta: {
          [tr('roblox.market.favorites', 'Favorites', '收藏')]: formatNumber(r.favoriteCount),
          [tr('roblox.market.type', 'Type', '類型')]: r.itemType || r.assetType || '—',
        },
        actions: [{
          label: tr('roblox.market.details', 'Details', '詳情'),
          kind: 'filled',
          onClick: (cardEl) => openDetail(r, cardEl),
        }],
      }));
    }
    gridSlot.appendChild(grid);

    pagerSlot.appendChild(paginationControls({
      next: state.cursor ? () => applyFilters(false) : null,
      hint: state.filterMatcher
        ? tr('roblox.market.filteredCount',
          `${formatNumber(visible.length)} match · ${formatNumber(state.results.length)} loaded`,
          `${formatNumber(visible.length)} 件符合 · 已載入 ${formatNumber(state.results.length)}`)
        : tr('roblox.common.loadedCount', `${formatNumber(state.results.length)} loaded`, `已載入 ${formatNumber(state.results.length)}`),
    }));

    announce(tr('roblox.market.loadedAnnounce', `Marketplace: ${state.results.length} items loaded`,
      `市集：已載入 ${state.results.length} 件物品`));
  }

  function resetFilters() {
    keywordInput.value = '';
    categorySelect.value = '';
    minPrice.value = '';
    maxPrice.value = '';
    creatorInput.value = '';
    sortSelect.value = 'Relevance';
    applyFilters(true);
  }

  /* ── item detail drawer ───────────────────────────────────────────────────── */

  async function openDetail(r, anchorEl) {
    drawer(anchorEl, {
      title: r.name || `#${r.id}`,
      build: async (body, close) => {
        body.appendChild(el('p', { class: 'rbx-muted' }, tr('roblox.common.loading', 'Loading…', '載入中……')));
        let full = null;
        try {
          [full] = await catalog.itemDetails([{ itemType: r.itemType === 'Bundle' ? 'Bundle' : 'Item', id: r.id }]);
        } catch { /* fall back to row data */ }
        body.textContent = '';

        const imgWrap = el('div', { class: 'rbx-detail__img' });
        imgWrap.appendChild(thumbImg(null, { size: 240, alt: r.name || '', letter: (r.name || '?') }));
        batchThumbnails([{ type: 'Asset', targetId: r.id, size: '420x420' }])
          .then((t) => {
            const v = t.get(String(r.id));
            if (/^https?:/.test(v || '')) {
              imgWrap.textContent = '';
              imgWrap.appendChild(thumbImg(v, { size: 240, alt: r.name || '', letter: r.name }));
            }
          })
          .catch(() => { /* keep tile */ });
        body.appendChild(imgWrap);

        const d = full || r;
        const rows = [];
        const price = lowestPrice(d) ?? lowestPrice(r);
        rows.push([tr('roblox.market.dPrice', 'Price', '價錢'), price != null ? `R$ ${formatNumber(price)}` : (d.priceStatus || '—')]);
        if (isLimited(d) || isLimited(r)) {
          rows.push([tr('roblox.market.dLimited', 'Limited', '限定'), tr('roblox.common.yes', 'Yes', '係')]);
          const cd = d.collectibleDetails || {};
          if (cd.serialNumberLimit != null) {
            rows.push([tr('roblox.market.dSerialLimit', 'Serial-number limit', '編號上限'), formatNumber(cd.serialNumberLimit)]);
          }
          if (cd.remaining != null) {
            rows.push([tr('roblox.market.dRemaining', 'Remaining copies', '剩餘數量'), formatNumber(cd.remaining)]);
          } else if (cd.unavailableQuantityReason) {
            rows.push([tr('roblox.market.dRemainingNote', 'Remaining copies', '剩餘數量'), cd.unavailableQuantityReason]);
          }
        }
        if (d.favoriteCount != null) rows.push([tr('roblox.market.favorites', 'Favorites', '收藏'), formatNumber(d.favoriteCount)]);
        rows.push([tr('roblox.market.creator', 'Creator', '創作者'), creatorNameOf(d.id ? d : r)]);

        const dl = el('dl', { class: 'rbx-meta' });
        for (const [k, v] of rows) {
          dl.append(el('div', { class: 'rbx-meta__row' }, el('dt', {}, k), el('dd', {}, v)));
        }
        body.appendChild(dl);

        if (d.description && !settingsSafeDesc()) {
          body.appendChild(el('p', { class: 'rbx-desc' }, String(d.description)));
        }

        body.appendChild(el('div', { class: 'rbx-actions' },
          el('button', {
            type: 'button', class: 'mrb-btn filled',
            onclick: () => { try { window.mrb.invoke('shell:openExternal', { url: `https://www.roblox.com/catalog/${r.id}` }); } catch { /* bridge absent */ } },
            title: `https://www.roblox.com/catalog/${r.id}`,
          }, tr('roblox.market.openOnSite', 'Open catalog page ↗', '開啟市集頁面 ↗')),
          el('button', {
            type: 'button', class: 'mrb-btn text',
            onclick: () => { try { ui.copyText(`https://www.roblox.com/catalog/${r.id}`); } catch { /* clipboard unavailable */ } },
          }, tr('roblox.market.copyUrl', 'Copy URL', '複製連結')),
          el('button', { type: 'button', class: 'mrb-btn outlined', onclick: close },
            tr('roblox.drawer.close', 'Close', '關閉'))));
      },
    });
  }

  // Enter inside any numeric filter applies immediately.
  [minPrice, maxPrice, creatorInput].forEach((inp) => inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); applyFilters(true); }
  }));

  /** Safe mode hides free-form descriptions here too. */
  function settingsSafeDesc() {
    return Boolean(settings.get('roblox.safeMode', false));
  }

  // Initial browse: relevance search with no keyword gives the storefront feed.
  applyFilters(true);
}
