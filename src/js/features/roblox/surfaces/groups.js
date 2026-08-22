/**
 * Roblox lane — Groups surface.
 *
 * Group lookup by numeric ID or keyword search; group card with icon, member
 * count, description, created date and resolved owner; roles table (rank /
 * member count when the API supplies it); public shout wall when present;
 * and a user-groups viewer that lists another user's memberships with roles.
 * Member-count trend is honestly marked unavailable — Roblox exposes no
 * historical counts.
 */

import { ui } from '../../../core/ui.js';
import { router } from '../../../core/router.js';
import { settings } from '../../../core/settings.js';
import {
  groups, users, batchThumbnails,
} from '../api.js';
import { tr } from '../peers.js';
import {
  announce, emptyState, errorState, formatDate, formatNumber, gridContainer,
  resultCard, richText, skeletonCards, thumbImg,
} from '../cards.js';
import { createSearchBar } from '../searchbar.js';
import { exportButton } from './helpers.js';

const el = (...args) => ui.el(...args);

const TAB_ID = 'roblox-groups';

export async function init() {
  const tabs = typeof router.list === 'function' ? router.list() : [];
  if (tabs.some((t) => t && t.id === TAB_ID)) return;
  router.registerTab({
    id: TAB_ID,
    title: tr('roblox.tabs.groups', 'Groups', '群組'),
    icon: '🏛️',
    group: 'Roblox',
    render: (rootEl) => render(rootEl),
  });
}

async function render(rootEl) {
  rootEl.textContent = '';
  rootEl.className = 'rbx-surface';

  const results = el('div', {});
  const detail = el('div', {});

  const bar = await createSearchBar({
    placeholder: tr('roblox.groups.placeholder', 'Group ID or name to search…', '群組 ID 或名稱……'),
    ariaLabel: tr('roblox.groups.searchLabel', 'Group lookup', '群組查詢'),
    historyKey: 'groups',
    submitLabel: tr('roblox.common.go', 'Go', '去'),
    onQuery: (q) => runLookup(q),
  });

  /* user-groups viewer */
  const ugInput = el('input', {
    type: 'text', class: 'mrb-field',
    placeholder: tr('roblox.groups.ugPlaceholder', 'User ID or username…', '用户 ID 或用户名……'),
    'aria-label': tr('roblox.groups.ugLabel', 'List a user’s group memberships', '列出用户嘅群組成員身分'),
  });
  const ugBtn = el('button', { type: 'button', class: 'mrb-btn tonal', onclick: () => showUserGroups(ugInput.value) },
    tr('roblox.groups.ugButton', 'Their groups', '佢嘅群組'));

  rootEl.append(
    el('h1', {}, tr('roblox.groups.title', 'Groups', '群組')),
    bar.root,
    el('section', { class: 'rbx-card rbx-home__card' },
      el('h2', {}, tr('roblox.groups.ugTitle', 'User’s group memberships', '用户群組成員身分')),
      el('div', { class: 'rbx-toolbar' }, ugInput, ugBtn),
      el('div', { id: 'rbx-ug-result' })),
    el('h2', {}, tr('roblox.groups.resultsTitle', 'Search results', '搜尋結果')),
    results,
    el('h2', {}, tr('roblox.groups.detailTitle', 'Group detail', '群組詳情')),
    detail);

  async function runLookup(q) {
    results.textContent = '';
    detail.textContent = '';
    if (!q.trim()) return;

    if (/^\d+$/.test(q.trim())) {
      await showGroupDetail(Number(q.trim()));
      return;
    }
    results.appendChild(skeletonCards(4));
    try {
      const res = await groups.search(q.trim(), { limit: 10 });
      results.textContent = '';
      const rows = res?.data || [];
      if (!rows.length) {
        results.appendChild(emptyState('🏛️',
          tr('roblox.groups.noResults', 'No groups matched', '冇符合嘅群組'),
          tr('roblox.groups.noResultsBody', 'Try a shorter part of the name.', '試下名稱嘅短啲部分。')));
        announce(tr('roblox.groups.noneAnnounce', 'No groups found', '搵唔到群組'));
        return;
      }
      const icons = await batchThumbnails(rows.map((g) => ({ type: 'GroupIcon', targetId: g.id, size: '150x150' })));
      const grid = gridContainer({ minCol: 240, label: tr('roblox.groups.gridLabel', 'Group results', '群組結果') });
      for (const g of rows) {
        const t = icons.get(String(g.id));
        grid.appendChild(resultCard({
          thumb: /^https?:/.test(t || '') ? t : null,
          thumbAlt: `${g.name} icon`,
          title: g.name,
          subtitle: g.description ? String(g.description).slice(0, 90) : '',
          badges: g.memberCount != null
            ? [{ text: `${formatNumber(g.memberCount)} ${tr('roblox.groups.members', 'members', '成員')}`, tone: 'neutral' }]
            : [],
          actions: [{
            label: tr('roblox.groups.view', 'View', '查看'),
            kind: 'filled',
            onClick: () => showGroupDetail(g.id),
          }],
        }));
      }
      results.appendChild(grid);
      announce(tr('roblox.groups.foundAnnounce', `Found ${rows.length} groups`, `搵到 ${rows.length} 個群組`));
    } catch (err) {
      results.textContent = '';
      results.appendChild(errorState(err, { retry: () => runLookup(q) }));
    }
  }

  async function showGroupDetail(groupId) {
    detail.textContent = '';
    detail.appendChild(skeletonCards(2));
    let g;
    try {
      [g] = await Promise.all([groups.get(groupId)]);
    } catch (err) {
      detail.textContent = '';
      detail.appendChild(errorState(err, { retry: () => showGroupDetail(groupId) }));
      return;
    }

    detail.textContent = '';

    /* owner resolution */
    const ownerId = g?.owner?.id ?? g?.owner?.userId;
    const card = el('section', { class: 'rbx-card rbx-group' });

    const iconSlot = el('div', { class: 'rbx-hero__img' });
    iconSlot.appendChild(thumbImg(null, { size: 120, alt: g.name, letter: g.name }));
    batchThumbnails([{ type: 'GroupIcon', targetId: groupId, size: '420x420' }])
      .then((t) => {
        iconSlot.textContent = '';
        iconSlot.appendChild(thumbImg(t.get(String(groupId)), { size: 120, alt: g.name, letter: g.name }));
      });

    const info = el('div', { class: 'rbx-hero__info' },
      el('h3', {}, g.name || `#${groupId}`),
      el('p', { class: 'rbx-muted' }, `ID ${g.id ?? groupId}`),
      el('p', {},
        `${tr('roblox.groups.members', 'Members', '成員')}: `,
        el('strong', {}, formatNumber(g.memberCount))),
      el('p', { class: 'rbx-muted' },
        `${tr('roblox.groups.created', 'Created', '建立於')} ${formatDate(g.created)}`));

    const descBox = el('div', { class: 'rbx-hero__desc' });
    if (settings.get('roblox.safeMode', false)) {
      descBox.appendChild(el('p', { class: 'rbx-muted' },
        tr('roblox.safe.hidden', '[Hidden by safe mode]', '[安全模式已隱藏]')));
    } else {
      descBox.appendChild(el('p', { class: 'rbx-desc' }, ...richText(g.description || '')));
    }
    info.appendChild(descBox);
    info.appendChild(el('p', { class: 'rbx-muted', title: tr('roblox.groups.trendWhy',
      'Roblox does not publish historical member counts.', 'Roblox 冇公開歷史成員數。') },
    `↕ ${tr('roblox.groups.trendNa', 'member-count trend: not available', '成員數趨勢：冇提供')}`));

    card.append(el('div', { class: 'rbx-hero' }, iconSlot, info));

    const ownerLine = el('p', { class: 'rbx-owner-line' },
      `${tr('roblox.groups.owner', 'Owner', '擁有人')}: `, el('span', { class: 'rbx-muted' }, '…'));
    card.appendChild(ownerLine);
    if (Number.isFinite(Number(ownerId))) {
      users.getById(ownerId).then((u) => {
        ownerLine.lastChild.textContent = u?.name ? `@${u.name} · ${u.id}` : String(ownerId);
      }).catch(() => { ownerLine.lastChild.textContent = String(ownerId); });
    } else {
      ownerLine.lastChild.textContent = tr('roblox.groups.ownerNone', 'none on record', '冇紀錄');
    }

    /* shout wall (public field when present) */
    try {
      const v1 = await groups.getV1(groupId);
      const shout = v1?.shout;
      if (shout && shout.body) {
        const wall = el('div', { class: 'rbx-shout' },
          el('h4', {}, tr('roblox.groups.shoutTitle', 'Latest shout', '最新公告')),
          el('blockquote', { class: 'rbx-shout__body' },
            el('p', {}, ...richText(shout.body)),
            el('footer', { class: 'rbx-muted' },
              `${shout.poster?.user?.username || shout.poster?.username || ''} · ${formatDate(shout.created, { withTime: true })}`)));
        card.appendChild(wall);
      }
    } catch { /* shout wall is optional metadata */ }

    /* roles table */
    const rolesWrap = el('div', { class: 'rbx-roles' });
    rolesWrap.appendChild(el('h4', {}, tr('roblox.groups.rolesTitle', 'Roles', '角色')));
    const tableSlot = el('div', {});
    rolesWrap.appendChild(tableSlot);
    card.appendChild(rolesWrap);

    /* export roles */
    let rolesData = [];
    const exportRoles = await exportButton({
      name: `roblox-group-${groupId}-roles`,
      label: tr('roblox.groups.exportRoles', 'Export roles', '匯出角色'),
      rows: () => rolesData.map((r) => ({
        groupId, groupName: g.name, roleId: r.id, name: r.name, rank: r.rank,
        memberCount: r.memberCount ?? '',
      })),
    });
    if (exportRoles) rolesWrap.appendChild(exportRoles);

    groups.roles(groupId).then(async (res) => {
      rolesData = res?.roles || [];
      tableSlot.textContent = '';
      if (!rolesData.length) {
        tableSlot.appendChild(el('p', { class: 'rbx-muted' },
          tr('roblox.groups.rolesEmpty', 'No role data returned.', '冇傳回角色資料。')));
        return;
      }
      const sorted = [...rolesData].sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
      const table = el('table', { class: 'mrb-table rbx-table' },
        el('caption', { class: 'rbx-visually-hidden' }, tr('roblox.groups.rolesCaption', 'Group roles by rank', '按階級排列嘅群組角色')),
        el('thead', {}, el('tr', {},
          el('th', { scope: 'col' }, tr('roblox.groups.roleName', 'Role', '角色')),
          el('th', { scope: 'col' }, tr('roblox.groups.roleRank', 'Rank', '階級')),
          el('th', { scope: 'col' }, tr('roblox.groups.roleMembers', 'Members', '成員')))),
        el('tbody', {}, ...sorted.map((r) => el('tr', {},
          el('td', {}, r.name),
          el('td', {}, String(r.rank ?? '—')),
          el('td', {}, r.memberCount != null ? formatNumber(r.memberCount)
            : el('span', { class: 'rbx-muted', title: tr('roblox.groups.membersHidden', 'Not provided by this endpoint', '呢個 API 冇提供') }, '—')))))));
      tableSlot.appendChild(table);
    }).catch((err) => {
      tableSlot.textContent = '';
      tableSlot.appendChild(errorState(err, {}));
    });

    detail.appendChild(card);
    announce(tr('roblox.groups.loadedAnnounce', `Loaded group ${g.name || groupId}`, `已載入群組 ${g.name || groupId}`));
  }

  async function showUserGroups(rawInput) {
    const slot = document.getElementById('rbx-ug-result') || el('div', {});
    slot.textContent = '';
    slot.appendChild(skeletonCards(3));
    let userId;
    try {
      if (!rawInput.trim()) throw { status: 400, message: 'Enter a user ID or username.', hint: '' };
      userId = /^\d+$/.test(rawInput.trim())
        ? Number(rawInput.trim())
        : (await users.byUsernames([rawInput.trim()]))?.data?.[0]?.id;
      if (!Number.isFinite(userId)) throw { status: 404, message: 'User not found.', hint: 'Check spelling.' };
      const res = await groups.userGroups(userId);
      const rows = res?.data || [];
      slot.textContent = '';
      if (!rows.length) {
        slot.appendChild(emptyState('🫥',
          tr('roblox.groups.ugEmpty', 'No group memberships visible', '睇唔到任何群組成員身分'),
          tr('roblox.groups.ugEmptyBody', 'The account may be in no groups or keeps them private.', '可能冇加入群組，或者設為私人。'),
          null));
        return;
      }
      const exportUg = await exportButton({
        name: `roblox-user-${userId}-groups`,
        rows: () => rows.map((r) => ({
          userId, groupId: r.group?.id, groupName: r.group?.name,
          memberCount: r.group?.memberCount, roleName: r.role?.name, rank: r.role?.rank,
        })),
      });
      const list = el('ul', { class: 'rbx-plainlist' });
      for (const r of rows.slice(0, 200)) {
        list.appendChild(el('li', {},
          el('button', {
            type: 'button', class: 'rbx-linklike',
            onclick: () => showGroupDetail(r.group?.id),
          }, r.group?.name || `#${r.group?.id}`),
          el('span', { class: 'rbx-muted' },
            ` · ${r.role?.name || ''}${r.role?.rank != null ? ` (${r.role.rank})` : ''}` +
            (r.group?.memberCount != null ? ` · ${formatNumber(r.group.memberCount)} ${tr('roblox.groups.membersShort', 'members', '人')}` : ''))));
      }
      slot.append(list, ...(exportUg ? [exportUg] : []));
      announce(tr('roblox.groups.ugLoaded', `Loaded ${rows.length} group memberships`, `已載入 ${rows.length} 個群組成員身分`));
    } catch (err) {
      slot.textContent = '';
      slot.appendChild(errorState(err, { retry: () => showUserGroups(rawInput) }));
    }
  }
}
