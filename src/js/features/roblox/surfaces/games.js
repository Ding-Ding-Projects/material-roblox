/**
 * Roblox lane — Games surface.
 *
 * Universe/place details (icon, creator, playing/visits/favorites/maxPlayers,
 * created/updated, genre, description), a media gallery with simple lightbox,
 * a paginated badges section with rarity chips computed from win rates,
 * place links, local favorites, and a two-universe side-by-side comparison
 * table with delta arrows.
 */

import { ui } from '../../../core/ui.js';
import { router } from '../../../core/router.js';
import { settings } from '../../../core/settings.js';
import {
  games, batchThumbnails, getFavoriteGames, isFavoriteGame,
  toggleFavoriteGame,
} from '../api.js';
import { tr } from '../peers.js';
import {
  announce, deltaArrow, drawer, emptyState, errorState, formatDate,
  formatNumber, gridContainer, paginationControls, resultCard, richText,
  skeletonCards, thumbImg, statChip,
} from '../cards.js';
import { createSearchBar } from '../searchbar.js';
import { exportButton } from './helpers.js';

const el = (...args) => ui.el(...args);

const TAB_ID = 'roblox-games';
const PLACE_URL = (placeId) => `https://www.roblox.com/games/${placeId}`;

export async function init() {
  const tabs = typeof router.list === 'function' ? router.list() : [];
  if (tabs.some((t) => t && t.id === TAB_ID)) return;
  router.registerTab({
    id: TAB_ID,
    title: tr('roblox.tabs.games', 'Games', '遊戲'),
    icon: '🎮',
    group: 'Roblox',
    render: (rootEl) => render(rootEl),
  });
}

async function render(rootEl) {
  rootEl.textContent = '';
  rootEl.className = 'rbx-surface';

  /** @type {Record<number, any>} universeId → full detail row */
  const cache = new Map();

  const detail = el('div', {});
  const compareWrap = el('section', { class: 'rbx-card rbx-home__card' });

  const bar = await createSearchBar({
    placeholder: tr('roblox.games.placeholder', 'Universe ID or Place ID…', 'Universe ID 或 Place ID……'),
    ariaLabel: tr('roblox.games.searchLabel', 'Universe or place lookup', 'Universe 或 place 查詢'),
    historyKey: 'games',
    submitLabel: tr('roblox.common.go', 'Go', '去'),
    onQuery: (q) => runLookup(q),
  });

  /* compare inputs */
  const cmpA = el('input', { type: 'text', class: 'mrb-field', placeholder: tr('roblox.games.cmpA', 'First universe/place ID', '第一個 universe/place ID'), 'aria-label': tr('roblox.games.cmpA', 'First universe/place ID', '第一個 universe/place ID') });
  const cmpB = el('input', { type: 'text', class: 'mrb-field', placeholder: tr('roblox.games.cmpB', 'Second universe/place ID', '第二個 universe/place ID'), 'aria-label': tr('roblox.games.cmpB', 'Second universe/place ID', '第二個 universe/place ID') });
  const cmpBtn = el('button', { type: 'button', class: 'mrb-btn tonal', onclick: () => runCompare() },
    tr('roblox.games.compareBtn', 'Compare side-by-side', '並排比較'));
  compareWrap.append(
    el('h2', {}, tr('roblox.games.compareTitle', 'Compare two universes', '比較兩個 universe')),
    el('div', { class: 'rbx-toolbar' }, cmpA, cmpB, cmpBtn));
  compareWrap.hidden = true;

  rootEl.append(
    el('h1', {}, tr('roblox.games.title', 'Games', '遊戲')),
    bar.root,
    detail,
    compareWrap,
    favoritesCard());

  function resolveId(raw) {
    const v = String(raw || '').trim();
    if (!/^\d+$/.test(v)) throw {
      status: 400,
      message: tr('roblox.games.badId', 'Enter a numeric Universe or Place ID.', '請輸入數字 Universe 或 Place ID。'),
      hint: 'Example: 920587237 (a place id) — find it in a game URL after /games/.',
    };
    return Number(v);
  }

  /**
   * Load full details for either a universeId or a placeId. Places are
   * resolved to their universe via multiget-place-details first.
   */
  async function loadUniverse(id) {
    if (cache.has(id)) return cache.get(id);
    let rows;
    try {
      rows = await games.getByUniverseIds([id]);
    } catch (err) {
      // A placeId fails here; try resolving as a place before giving up.
      try {
        const uid = await games.universeForPlace(id);
        if (uid !== id) return loadUniverse(uid); // guard: never self-recurse
      } catch {
        throw err;
      }
    }
    const row = rows?.data?.[0];
    if (!row) {
      try {
        const uid = await games.universeForPlace(id);
        if (uid === id) throw new Error('unresolved');
        return loadUniverse(uid);
      } catch {
        throw { status: 404, message: `No universe found for ${id}.`, hint: 'Check that the ID belongs to an experience.' };
      }
    }
    cache.set(row.id, row);
    return row;
  }

  async function runLookup(raw) {
    detail.textContent = '';
    compareWrap.hidden = true;
    if (!String(raw).trim()) return;
    let id;
    try {
      id = resolveId(raw);
    } catch (err) {
      detail.appendChild(errorState(err));
      return;
    }
    detail.appendChild(skeletonCards(3));
    let g;
    try {
      g = await loadUniverse(id);
    } catch (err) {
      detail.textContent = '';
      detail.appendChild(errorState(err, { retry: () => runLookup(raw) }));
      return;
    }
    detail.textContent = '';
    detail.appendChild(await gameDetail(g));
    announce(tr('roblox.games.loadedAnnounce', `Loaded ${g.name}`, `已載入 ${g.name}`));
  }

  async function gameDetail(g) {
    const card = el('section', { class: 'rbx-card rbx-game' });

    /* icon + hero */
    const iconSlot = el('div', { class: 'rbx-hero__img' });
    iconSlot.appendChild(thumbImg(null, { size: 150, alt: g.name || '', letter: g.name || '?' }));
    batchThumbnails([{ type: 'GameIcon', targetId: g.id, size: '512x512' }])
      .then((t) => {
        const v = t.get(String(g.id));
        if (/^https?:/.test(v || '')) {
          iconSlot.textContent = '';
          iconSlot.appendChild(thumbImg(v, { size: 150, alt: `${g.name} icon`, letter: g.name }));
        }
      })
      .catch(() => { /* keep tile */ });

    const info = el('div', { class: 'rbx-hero__info' },
      el('h2', {}, g.name || `#${g.id}`),
      el('p', { class: 'rbx-muted' }, `${tr('roblox.games.by', 'by', '由')} ${g.creator?.name ?? '?'} · universe ${g.id}${g.rootPlaceId ? ` · place ${g.rootPlaceId}` : ''}`),
      el('p', { class: 'rbx-muted' }, `${tr('roblox.games.genre', 'Genre', '類型')}: ${g.genre || '—'}`),
      descBlock(g.description));

    const statsRow = el('div', { class: 'rbx-stat-row' });
    statsRow.append(
      statChip(tr('roblox.games.playing', 'Playing now', '而家玩緊'), formatNumber(g.playing)),
      statChip(tr('roblox.games.visits', 'Visits', '到訪'), formatNumber(g.visits)),
      statChip(tr('roblox.games.favorites', 'Favorites', '收藏'), formatNumber(g.favoritedCount)),
      statChip(tr('roblox.games.maxPlayers', 'Max players', '最多玩家'), formatNumber(g.maxPlayers)),
      statChip(tr('roblox.games.created', 'Created', '建立於'), formatDate(g.created)),
      statChip(tr('roblox.games.updated', 'Updated', '更新於'), formatDate(g.updated)));
    info.appendChild(statsRow);

    /* actions */
    const actions = el('div', { class: 'rbx-actions' });
    if (g.rootPlaceId) {
      actions.appendChild(el('button', {
        type: 'button', class: 'mrb-btn filled',
        onclick: () => { try { window.mrb.invoke('shell:openExternal', { url: PLACE_URL(g.rootPlaceId) }); } catch { /* bridge absent */ } },
        title: PLACE_URL(g.rootPlaceId),
      }, tr('roblox.games.openOnSite', 'Open on roblox.com ↗', '喺 roblox.com 開啟 ↗')));
    }
    const favNow = isFavoriteGame(g.id);
    const favBtn = el('button', {
      type: 'button', class: 'mrb-btn tonal',
      onclick: () => {
        const on = toggleFavoriteGame({ universeId: g.id, name: g.name, rootPlaceId: g.rootPlaceId });
        favBtn.textContent = on
          ? tr('roblox.games.unfavorite', '★ Favorited — remove', '★ 已收藏 — 移除')
          : tr('roblox.games.favorite', '☆ Favorite locally', '☆ 本機收藏');
      },
    }, favNow ? tr('roblox.games.unfavorite', '★ Favorited — remove', '★ 已收藏 — 移除')
      : tr('roblox.games.favorite', '☆ Favorite locally', '☆ 本機收藏'));
    actions.appendChild(favBtn);
    info.appendChild(actions);

    card.append(el('div', { class: 'rbx-hero' }, iconSlot, info));

    /* media gallery */
    const mediaSection = el('div', { class: 'rbx-media' });
    mediaSection.appendChild(el('h3', {}, tr('roblox.games.mediaTitle', 'Media', '媒體')));
    const mediaGrid = gridContainer({ minCol: 180, label: tr('roblox.games.mediaLabel', 'Game media', '遊戲媒體') });
    mediaSection.appendChild(mediaGrid);
    card.appendChild(mediaSection);

    games.getMedia(g.id).then(async (res) => {
      const items = (res?.data || []).filter((m) => m.targetId != null).slice(0, 24);
      if (!items.length) {
        mediaGrid.appendChild(emptyState('🖼️',
          tr('roblox.games.mediaEmpty', 'No public media for this universe', '呢個 universe 冇公開媒體'), ''));
        return;
      }
      const thumbs = await batchThumbnails(items.map((m) => ({
        // Game thumbnails render through the GameThumbnail family; plain
        // uploaded images resolve as Asset entries.
        type: m.type === 'Image' ? 'GameThumbnail' : m.type,
        targetId: m.targetId,
        size: '768x432',
      })));

      for (const m of items) {
        const url = thumbs.get(String(m.targetId));
        const cell = el('button', {
          type: 'button', class: 'rbx-media__cell',
          title: m.altText || m.state || '',
          'aria-label': m.altText || tr('roblox.games.mediaView', 'View media item', '查看媒體'),
          onclick: (ev) => openLightbox(ev.currentTarget, url, m.altText || ''),
        }, thumbImg(/^https?:/.test(url || '') ? url : null, { size: 160, alt: m.altText || '', letter: g.name }));
        mediaGrid.appendChild(cell);
      }
    }).catch(() => {
      mediaGrid.appendChild(emptyState('🖼️',
        tr('roblox.games.mediaEmpty', 'No public media for this universe', '呢個 universe 冇公開媒體'), ''));
    });

    /* badges section (paginated) */
    const badgesCard = el('section', { class: 'rbx-card rbx-home__card' });
    badgesCard.appendChild(el('h3', {}, tr('roblox.games.badgesTitle', 'Badges', '徽章')));
    const badgesBody = el('div', {});
    badgesCard.appendChild(badgesBody);
    card.appendChild(badgesCard);

    let badgeCursor = '';
    let badgeRows = [];
    let badgeExport = await exportButton({
      name: `roblox-universe-${g.id}-badges`,
      rows: () => badgeRows.map((b) => ({
        id: b.id, name: b.name, description: settingsSafeDesc() ? '' : (b.description || ''),
        winRatePercentage: b.statistics?.winRatePercentage ?? '',
        awardedCount: b.statistics?.awardedCount ?? '',
      })),
    });
    const badgesFooter = el('div', {});
    if (badgeExport) badgesFooter.appendChild(badgeExport);

    async function loadBadges(reset) {
      if (reset) { badgeRows = []; badgeCursor = ''; }
      badgesBody.textContent = '';
      badgesBody.appendChild(skeletonCards(4));
      try {
        const res = await games.badges(g.id, { cursor: badgeCursor, limit: 50 });
        badgesBody.textContent = '';
        const incoming = res?.data || [];
        badgeRows = reset ? incoming : dedupeById([...badgeRows, ...incoming]);
        badgeCursor = res?.nextPageCursor || '';

        if (!badgeRows.length) {
          badgesBody.appendChild(emptyState('🏅',
            tr('roblox.games.badgesEmpty', 'No badges for this game', '呢個遊戲冇徽章'), ''));
          return;
        }
        const icons = await batchThumbnails(badgeRows.map((b) => ({ type: 'BadgeIcon', targetId: b.id, size: '150x150' })));
        const grid = gridContainer({ minCol: 220, label: tr('roblox.games.badgesLabel', 'Badges list', '徽章清單') });
        for (const b of badgeRows.slice(-100)) {
          grid.appendChild(resultCard({
            thumb: /^https?:/.test(icons.get(String(b.id)) || '') ? icons.get(String(b.id)) : null,
            thumbAlt: `${b.name} badge icon`,
            title: b.name,
            subtitle: settingsSafeDesc() ? '' : String(b.description || '').slice(0, 80),
            badges: [rarityOf(b)],
            meta: {
              [tr('roblox.games.awardRate', 'Award rate', '獲得率')]:
                b.statistics?.winRatePercentage != null ? `${Number(b.statistics.winRatePercentage).toFixed(2)}%` : '—',
              [tr('roblox.games.awarded', 'Awarded', '已獲得')]: formatNumber(b.statistics?.awardedCount),
            },
          }));
        }
        badgesBody.appendChild(grid);
        badgesFooter.textContent = '';
        badgesFooter.appendChild(paginationControls({
          next: badgeCursor ? () => loadBadges(false) : null,
          hint: tr('roblox.common.loadedCount', `${formatNumber(badgeRows.length)} loaded`, `已載入 ${formatNumber(badgeRows.length)}`),
        }));
        if (badgeExport) badgesFooter.appendChild(badgeExport);
      } catch (err) {
        badgesBody.textContent = '';
        badgesBody.appendChild(errorState(err, { retry: () => loadBadges(reset) }));
      }
    }
    loadBadges(true);
    badgesCard.appendChild(badgesFooter);

    return card;
  }

  /** Rarity bucket from winRatePercentage; unknown renders honestly. */
  function rarityOf(b) {
    const r = Number(b?.statistics?.winRatePercentage);
    if (!Number.isFinite(r)) return { text: tr('roblox.rarity.unknown', 'Rarity unknown', '稀有度不明'), tone: 'muted' };
    if (r >= 50) return { text: tr('roblox.rarity.common', 'Common', '常見'), tone: 'common' };
    if (r >= 10) return { text: tr('roblox.rarity.uncommon', 'Uncommon', '少見'), tone: 'uncommon' };
    if (r >= 1) return { text: tr('roblox.rarity.rare', 'Rare', '稀有'), tone: 'rare' };
    return { text: tr('roblox.rarity.ultra', 'Ultra rare', '極稀有'), tone: 'ultra' };
  }

  function dedupeById(rows) {
    const seen = new Set();
    return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  }

  function descBlock(description) {
    if (settings.get('roblox.safeMode', false)) {
      return el('p', { class: 'rbx-muted' }, tr('roblox.safe.hidden', '[Hidden by safe mode]', '[安全模式已隱藏]'));
    }
    const text = String(description || '').trim();
    if (!text) return el('p', { class: 'rbx-muted' }, tr('roblox.users.noDescription', 'No description.', '冇描述。'));
    return el('p', { class: 'rbx-desc' }, ...richText(text));
  }

  function settingsSafeDesc() {
    return Boolean(settings.get('roblox.safeMode', false));
  }

  /* ── lightbox ──────────────────────────────────────────────────────────────── */

  function openLightbox(anchor, url, caption) {
    if (!/^https?:/.test(url || '')) return;
    drawer(anchor, {
      title: caption || tr('roblox.games.lightboxTitle', 'Media preview', '媒體預覽'),
      build: (body, close) => {
        body.appendChild(el('img', {
          src: url, alt: caption || 'Media preview',
          style: 'max-width:100%;height:auto;border-radius:var(--mrb-shape-md,8px)',
        }));
        body.appendChild(el('div', { class: 'rbx-actions', style: 'margin-top:8px' },
          el('button', { type: 'button', class: 'mrb-btn outlined', onclick: close },
            tr('roblox.drawer.close', 'Close', '關閉'))));
      },
    });
  }

  /* ── comparison ────────────────────────────────────────────────────────────── */

  async function runCompare() {
    compareWrap.hidden = false;
    const old = compareWrap.querySelector('.rbx-compare__table-slot');
    if (old) old.remove();
    const slot = el('div', { class: 'rbx-compare__table-slot' });
    compareWrap.appendChild(slot);

    let a; let b;
    try {
      a = await loadUniverse(resolveId(cmpA.value));
      b = await loadUniverse(resolveId(cmpB.value));
    } catch (err) {
      slot.appendChild(errorState(err, { retry: runCompare }));
      return;
    }

    const fields = [
      ['playing', tr('roblox.games.playing', 'Playing now', '而家玩緊'), formatNumber],
      ['visits', tr('roblox.games.visits', 'Visits', '到訪'), formatNumber],
      ['favoritedCount', tr('roblox.games.favorites', 'Favorites', '收藏'), formatNumber],
      ['maxPlayers', tr('roblox.games.maxPlayers', 'Max players', '最多玩家'), formatNumber],
    ];
    const tbody = [];
    for (const [key, label, fmt] of fields) {
      tbody.push(el('tr', {},
        el('th', { scope: 'row' }, label),
        el('td', {}, fmt(a[key])),
        el('td', {}, fmt(b[key])),
        el('td', {}, deltaArrow(a[key], b[key]))));
    }
    tbody.push(el('tr', {},
      el('th', { scope: 'row' }, tr('roblox.games.updated', 'Updated', '更新於')),
      el('td', {}, formatDate(a.updated)),
      el('td', {}, formatDate(b.updated)),
      el('td', {},
        (() => {
          const ta = a.updated ? Date.parse(a.updated) : NaN;
          const tb = b.updated ? Date.parse(b.updated) : NaN;
          if (!Number.isFinite(ta) || !Number.isFinite(tb)) return '—';
          const newer = ta > tb ? tr('roblox.games.newerLeft', 'left is newer', '左邊較新')
            : ta < tb ? tr('roblox.games.newerRight', 'right is newer', '右邊較新')
              : tr('roblox.games.sameAge', 'same age', '一樣新');
          return newer;
        })())));

    const table = el('table', { class: 'mrb-table rbx-table' },
      el('caption', { class: 'rbx-visually-hidden' }, tr('roblox.games.compareCaption', 'Two universes compared', '兩個 universe 比較')),
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col' }, tr('roblox.games.statCol', 'Stat', '統計')),
        el('th', { scope: 'col' }, a.name || '#'),
        el('th', { scope: 'col' }, b.name || '#'),
        el('th', { scope: 'col' }, 'Δ'))),
      el('tbody', {}, ...tbody));
    slot.appendChild(table);
    announce(tr('roblox.games.compareDone', 'Comparison ready below.', '比較表已準備好。'));
  }

  /* ── favorites list ──────────────────────────────────────────────────────── */

  function favoritesCard() {
    const favs = getFavoriteGames();
    const wrap = el('section', { class: 'rbx-card rbx-home__card', hidden: !favs.length });
    if (!favs.length) return wrap;
    wrap.appendChild(el('h2', {}, tr('roblox.games.favoritesTitle', 'Locally favorited games', '本機收藏嘅遊戲')));
    const chips = el('div', { class: 'rbx-chip-row' });
    for (const f of favs.slice(0, 12)) {
      chips.appendChild(el('button', {
        type: 'button', class: 'mrb-chip',
        onclick: () => runLookup(String(f.universeId)),
        title: f.name || String(f.universeId),
      }, f.name || `#${f.universeId}`));
    }
    wrap.appendChild(chips);
    return wrap;
  }
}
