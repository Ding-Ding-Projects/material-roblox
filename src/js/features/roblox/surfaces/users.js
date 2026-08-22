/**
 * Roblox lane — Users surface.
 *
 * Profile view (headshot / full-body toggle, names, dates, safely rendered
 * description, stat row, username history, wearing-assets gallery) plus a
 * search that accepts comma-separated usernames for a result grid.
 */

import { ui } from '../../../core/ui.js';
import { router } from '../../../core/router.js';
import { store } from '../../../core/store.js';
import { settings } from '../../../core/settings.js';
import {
  users, friends, avatar, batchThumbnails,
  resolveUserInput, resolveManyInputs, isSavedUser, toggleSavedUser, getSelf,
} from '../api.js';
import { tr } from '../peers.js';
import {
  announce, emptyState, errorState, formatDate, formatNumber, gridContainer,
  resultCard, richText, skeletonCards, thumbImg, badgeChip,
} from '../cards.js';
import { createSearchBar } from '../searchbar.js';

const el = (...args) => ui.el(...args);

const TAB_ID = 'roblox-users';
const PROFILE_URL = (id) => `https://www.roblox.com/users/${id}/profile`;

export async function init() {
  const tabs = typeof router.list === 'function' ? router.list() : [];
  if (tabs.some((t) => t && t.id === TAB_ID)) return;
  router.registerTab({
    id: TAB_ID,
    title: tr('roblox.tabs.users', 'Users', '用户'),
    icon: '🧑',
    group: 'Roblox',
    render: (rootEl) => render(rootEl),
  });
}

/* ── Layout ─────────────────────────────────────────────────────────────────── */

let bar = null;

async function render(rootEl) {
  rootEl.textContent = '';
  rootEl.className = 'rbx-surface';

  const body = el('div', { class: 'rbx-users__body' });
  rootEl.append(
    el('h1', {}, tr('roblox.users.title', 'Users', '用户')),
    el('p', { class: 'rbx-muted' }, tr(
      'roblox.users.hint',
      'Look up a profile by username or ID, or paste several comma-separated usernames.',
      '用用户名或 ID 查詢檔案，或者用逗號分隔貼上多個用户名。')));

  bar = await createSearchBar({
    placeholder: tr('roblox.users.searchPlaceholder', 'Username, ID, or name1, name2…', '用户名、ID、或 name1, name2……'),
    ariaLabel: tr('roblox.users.searchLabel', 'User lookup', '用户查詢'),
    historyKey: 'users',
    submitLabel: tr('roblox.users.go', 'Find', '搵'),
    onQuery: (q) => runLookup(body, q),
  });
  rootEl.appendChild(bar.root);
  rootEl.appendChild(body);

  // Handoff from Home quick lookup or saved lists.
  const pending = store.get('roblox:pendingUser', null);
  if (pending && pending.id != null) {
    store.remove('roblox:pendingUser');
    if (bar.input) bar.setValue(String(pending.name || pending.id), { run: false });
    showProfile(body, pending.id);
    return;
  }

  body.appendChild(emptyState('🔍',
    tr('roblox.users.emptyTitle', 'Search for a player', '搜尋一個玩家'),
    tr('roblox.users.emptyBody',
      'Enter a username or numeric ID above to load a profile.',
      '喺上面輸入用户名或數字 ID 就會載入檔案。')));
}

async function runLookup(body, q) {
  body.textContent = '';
  if (!q) {
    body.appendChild(emptyState('🔍',
      tr('roblox.users.emptyTitle', 'Search for a player', '搜尋一個玩家'), ''));
    return;
  }
  const multi = q.split(',').length > 1;
  if (multi) return showGrid(body, q);
  try {
    const user = await resolveUserInput(q);
    showProfile(body, user.id, user);
  } catch (err) {
    body.textContent = '';
    body.appendChild(errorState(err, { retry: () => runLookup(body, q) }));
  }
}

/* ── Multi-name result grid ─────────────────────────────────────────────────── */

async function showGrid(body, raw) {
  body.textContent = '';
  body.appendChild(skeletonCards(4));
  let found = [];
  let missing = [];
  try {
    ({ found, missing } = await resolveManyInputs(raw));
  } catch (err) {
    body.textContent = '';
    body.appendChild(errorState(err));
    announce(tr('roblox.users.gridFailed', 'Batch lookup failed', '批量查詢失敗'));
    return;
  }
  body.textContent = '';

  if (!found.length) {
    body.appendChild(emptyState('🫥',
      tr('roblox.users.noneFound', 'No matching users', '搵唔到符合嘅用户'),
      missing.length ? `Not found: ${missing.join(', ')}` : '', null));
    return;
  }

  const thumbs = await batchThumbnails(found.map((u) => ({
    type: 'AvatarHeadShot', targetId: u.id, size: '150x150',
  })));

  const grid = gridContainer({ minCol: 220, label: tr('roblox.users.resultsLabel', 'User results', '用户結果') });
  for (const u of found) {
    const t = thumbs.get(String(u.id));
    grid.appendChild(resultCard({
      thumb: /^https?:/.test(t || '') ? t : null,
      thumbAlt: `${u.name} headshot`,
      title: u.displayName || u.name,
      subtitle: `@${u.name} · ID ${u.id}`,
      actions: [{
        label: tr('roblox.users.openProfile', 'Profile', '檔案'),
        kind: 'filled',
        onClick: () => showProfile(body, u.id, u),
      }],
    }));
  }
  body.appendChild(grid);
  const missNote = missing.length
    ? el('p', { class: 'rbx-muted' }, `Not found: ${missing.join(', ')}`)
    : null;
  if (missNote) body.appendChild(missNote);
  announce(tr('roblox.users.gridFound', `Found ${found.length} users`, `搵到 ${found.length} 個用户`));
}

/* ── Profile view ───────────────────────────────────────────────────────────── */

async function showProfile(body, userId, knownUser = null) {
  body.textContent = '';
  const shell = el('div', {});
  body.appendChild(skeletonCards(3));

  let profile;
  try {
    profile = await users.getById(userId);
  } catch (err) {
    body.textContent = '';
    body.appendChild(errorState(err, { retry: () => showProfile(body, userId, knownUser) }));
    announce(tr('roblox.users.profileFailed', 'Profile failed to load', '載入檔案失敗'));
    return;
  }
  body.textContent = '';

  const id = profile.id ?? userId;
  const name = knownUser?.name || profile.name || String(id);
  const displayName = profile.displayName || knownUser?.displayName || name;

  /* hero */
  const hero = el('section', { class: 'rbx-card rbx-hero' });

  let fullBodyUrl = null;
  let headshotUrl = null;
  const media = el('div', { class: 'rbx-hero__media' });
  const imgSlot = el('div', { class: 'rbx-hero__img' });
  media.appendChild(imgSlot);
  hero.appendChild(media);

  const infoCol = el('div', { class: 'rbx-hero__info' });
  infoCol.appendChild(el('h2', { class: 'rbx-hero__name' }, displayName));
  infoCol.appendChild(el('p', { class: 'rbx-muted' }, `@${profile.name || name}`));
  infoCol.appendChild(el('p', { class: 'rbx-muted' },
    `${tr('roblox.users.joined', 'Joined', '加入')} ${formatDate(profile.created)}`));
  if (profile.isBanned) {
    infoCol.appendChild(badgeChip(tr('roblox.users.banned', 'Banned account', '被封禁帳戶'), 'danger'));
  }
  const descTitle = el('h3', { class: 'rbx-hero__desc-title' },
    tr('roblox.users.description', 'Description', '描述'));
  const descBox = el('div', { class: 'rbx-hero__desc' });
  applyDescription(descBox, profile.description);
  infoCol.append(descTitle, descBox);
  hero.appendChild(infoCol);

  /* actions */
  const savedNow = isSavedUser(id);
  const saveBtn = el('button', {
    type: 'button', class: 'mrb-btn tonal',
    onclick: () => {
      const nowSaved = toggleSavedUser({ id, name: profile.name || name, displayName });
      saveBtn.textContent = nowSaved
        ? tr('roblox.users.unsave', '★ Saved — remove', '★ 已收藏 — 移除')
        : tr('roblox.users.save', '☆ Save user', '☆ 收藏');
      announce(nowSaved
        ? tr('roblox.users.savedAnnounce', `Saved ${name}`, `收藏咗 ${name}`)
        : tr('roblox.users.unsavedAnnounce', `Removed ${name}`, `移除咗 ${name}`));
    },
  }, savedNow ? tr('roblox.users.unsave', '★ Saved — remove', '★ 已收藏 — 移除')
    : tr('roblox.users.save', '☆ Save user', '☆ 收藏'));

  const copyBtn = el('button', {
    type: 'button', class: 'mrb-btn text',
    onclick: async () => {
      try { await ui.copyText(PROFILE_URL(id)); } catch { /* clipboard unavailable */ }
    },
    title: PROFILE_URL(id),
  }, tr('roblox.users.copyUrl', 'Copy profile URL', '複製檔案連結'));

  const friendsBtn = el('button', {
    type: 'button', class: 'mrb-btn outlined',
    onclick: () => {
      store.set('roblox:pendingFriendsTarget', { id, name: profile.name || name, displayName });
      router.navigate('roblox-friends');
    },
  }, tr('roblox.users.openFriends', 'Friends →', '朋友 →'));

  const compareBtn = getSelf()
    ? el('button', {
      type: 'button', class: 'mrb-btn text',
      onclick: () => {
        store.set('roblox:pendingCompareA', { id, name: profile.name || name, displayName });
        router.navigate('roblox-compare');
      },
    }, tr('roblox.users.compare', 'Compare…', '比較……'))
    : null;

  hero.appendChild(el('div', { class: 'rbx-actions' },
    ...[saveBtn, copyBtn, friendsBtn, compareBtn].filter(Boolean)));

  /* stats row */
  const stats = el('div', { class: 'rbx-stat-row', role: 'group', 'aria-label': tr('roblox.users.statsLabel', 'Profile statistics', '檔案統計') });
  hero.appendChild(stats);
  loadStats(stats, id);

  /* thumbnail mode toggle */
  const modeRow = el('div', { class: 'rbx-toolbar', role: 'radiogroup', 'aria-label': tr('roblox.users.thumbMode', 'Portrait style', '頭像樣式') });
  const headBtn = el('button', {
    type: 'button', class: 'mrb-btn filled', role: 'radio', 'aria-checked': 'true',
    onclick: () => setMode('head'),
  }, tr('roblox.users.headshot', 'Headshot', '大頭照'));
  const bodyBtn = el('button', {
    type: 'button', class: 'mrb-btn tonal', role: 'radio', 'aria-checked': 'false',
    onclick: () => setMode('body'),
  }, tr('roblox.users.fullBody', 'Full body', '全身'));
  function setMode(mode) {
    const url = mode === 'head' ? headshotUrl : fullBodyUrl;
    imgSlot.textContent = '';
    imgSlot.appendChild(thumbImg(/^https?:/.test(url || '') ? url : null, {
      size: mode === 'head' ? 150 : 300,
      alt: `${displayName} ${mode === 'head' ? 'headshot' : 'full-body avatar'}`,
      letter: name,
    }));
    headBtn.className = `mrb-btn ${mode === 'head' ? 'filled' : 'tonal'}`;
    bodyBtn.className = `mrb-btn ${mode === 'body' ? 'filled' : 'tonal'}`;
    headBtn.setAttribute('aria-checked', String(mode === 'head'));
    bodyBtn.setAttribute('aria-checked', String(mode === 'body'));
  }
  modeRow.append(headBtn, bodyBtn);
  hero.appendChild(modeRow);

  // Headshot and full-body share a targetId in the batch map, so resolve them
  // in two separate batch calls (each keyed by the same target id).
  batchThumbnails([{ type: 'AvatarHeadShot', targetId: id, size: '150x150' }])
    .then((t) => {
      const v = t.get(String(id));
      headshotUrl = /^https?:/.test(v || '') ? v : null;
      if (!fullBodyUrl) setMode('head');
    });
  batchThumbnails([{ type: 'AvatarThumbnail', targetId: id, size: '420x420' }])
    .then((t) => {
      const v = t.get(String(id));
      fullBodyUrl = /^https?:/.test(v || '') ? v : null;
      setMode('head');
    });
  setMode('head');

  /* username history */
  const histDetails = el('details', { class: 'rbx-details' });
  histDetails.appendChild(el('summary', {},
    tr('roblox.users.historyTitle', 'Previous usernames', '以前嘅用户名')));
  const histBody = el('div', { class: 'rbx-details__body' });
  histDetails.appendChild(histBody);
  loadHistory(histBody, id);

  /* wearing assets */
  const wearingCard = el('section', { class: 'rbx-card rbx-home__card' });
  wearingCard.appendChild(el('h3', {}, tr('roblox.users.wearing', 'Currently wearing', '而家著緊')));
  loadWearing(wearingCard, id, name);

  shell.append(hero, histDetails, wearingCard);
  body.appendChild(shell);
  announce(tr('roblox.users.loaded', `Loaded profile ${displayName}`, `已載入 ${displayName} 嘅檔案`));
}

/** Description respects Safe mode and never injects raw HTML. */
function applyDescription(box, description) {
  box.textContent = '';
  const text = String(description || '').trim();
  if (settings.get('roblox.safeMode', false)) {
    box.appendChild(el('p', { class: 'rbx-muted' },
      tr('roblox.safe.hidden', '[Hidden by safe mode]', '[安全模式已隱藏]')));
    return;
  }
  if (!text) {
    box.appendChild(el('p', { class: 'rbx-muted' },
      tr('roblox.users.noDescription', 'No description.', '冇描述。')));
    return;
  }
  box.appendChild(el('p', { class: 'rbx-desc' }, ...richText(text)));
}

async function loadStats(statsEl, id) {
  const defs = [
    { label: tr('roblox.users.friends', 'Friends', '朋友'), fn: () => friends.count(id) },
    { label: tr('roblox.users.followers', 'Followers', '粉絲'), fn: () => friends.followerCount(id) },
    { label: tr('roblox.users.following', 'Following', '跟緊'), fn: () => friends.followingCount(id) },
  ];
  for (const d of defs) {
    const chip = el('span', { class: 'rbx-statchip' },
      el('strong', {}, '…'), el('span', { class: 'rbx-statchip__label' }, d.label));
    statsEl.appendChild(chip);
    d.fn().then((res) => {
      chip.querySelector('strong').textContent = formatNumber(res?.count);
    }).catch(() => {
      chip.querySelector('strong').textContent = '—';
      chip.title = tr('roblox.users.statUnavailable', 'Count unavailable', '攞唔到數字');
    });
  }
}

async function loadHistory(histBody, id) {
  histBody.textContent = '';
  histBody.appendChild(el('p', { class: 'rbx-muted' }, tr('roblox.common.loading', 'Loading…', '載入中……')));
  try {
    const res = await users.usernameHistory(id);
    histBody.textContent = '';
    const rows = res?.data || [];
    if (!rows.length) {
      histBody.appendChild(el('p', { class: 'rbx-muted' },
        tr('roblox.users.historyEmpty', 'No previous usernames on record.', '冇以前用户名紀錄。')));
      return;
    }
    const ul = el('ul', { class: 'rbx-plainlist' });
    rows.forEach((r) => ul.appendChild(el('li', {},
      el('strong', {}, r.name),
      el('span', { class: 'rbx-muted' }, ` · ${formatDate(r.created)}`))));
    histBody.appendChild(ul);
  } catch (err) {
    histBody.textContent = '';
    histBody.appendChild(errorState(err, {}));
  }
}

async function loadWearing(card, id, nameForTile) {
  const placeholder = el('div', { class: 'rbx-grid', style: '--rbx-grid-min:140px' });
  for (let i = 0; i < 4; i += 1) {
    placeholder.appendChild(el('div', { class: 'rbx-card rbx-skel' },
      el('div', { class: 'mrb-skeleton rbx-skel__thumb' })));
  }
  card.appendChild(placeholder);

  let avatarData;
  try {
    avatarData = await avatar.getWearing(id);
  } catch (err) {
    placeholder.remove();
    card.appendChild(errorState(err, {}));
    return;
  }
  const assets = Array.isArray(avatarData?.assets) ? avatarData.assets : [];
  // Remove only the skeleton placeholder — the card keeps its heading.
  placeholder.remove();
  if (!assets.length) {
    card.appendChild(emptyState('👕',
      tr('roblox.users.wearingEmpty', 'Nothing equipped', '冇裝備任何嘢'), ''));
    return;
  }
  const jobs = assets.map((a) => ({ req: { type: 'Asset', targetId: a.id, size: '150x150' } }));
  const slots = assets.map((a) => {
    const tile = el('figure', { class: 'rbx-asset' });
    const slot = el('div', { class: 'rbx-asset__slot' });
    slot.appendChild(thumbImg(null, { size: 120, alt: a.name || 'Asset', letter: nameForTile }));
    tile.appendChild(slot);
    tile.appendChild(el('figcaption', {}, a.name || `#${a.id}`,
      el('span', { class: 'rbx-muted' }, ` · ${a.assetType?.name || ''}`)));
    return tile;
  });
  const grid = el('div', { class: 'rbx-grid', style: '--rbx-grid-min:140px' }, ...slots);
  card.appendChild(grid);
  const map = await batchThumbnails(jobs.map((j) => j.req));
  slots.forEach((tile, i) => {
    const v = map.get(String(assets[i].id));
    const slot = tile.querySelector('.rbx-asset__slot');
    slot.textContent = '';
    slot.appendChild(thumbImg(v, { size: 120, alt: assets[i].name || 'Asset', letter: nameForTile }));
  });
}
