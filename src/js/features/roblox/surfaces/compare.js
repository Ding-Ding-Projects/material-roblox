/**
 * Roblox lane — Compare surface.
 *
 * Side-by-side two-user comparison. Overlaps are computed strictly from what
 * the public APIs grant: mutual friends (id intersection with a sample list)
 * and shared group memberships. Badge overlap is honestly declared out of
 * scope — it would require per-game scans this lane does not perform.
 * Exports a Markdown comparison when the exporter peer is present.
 */

import { ui } from '../../../core/ui.js';
import { router } from '../../../core/router.js';
import { store } from '../../../core/store.js';
import {
  users, friends, groups, getSavedUsers, batchThumbnails,
} from '../api.js';
import { tr } from '../peers.js';
import {
  announce, emptyState, errorState, formatDate, formatNumber, thumbImg,
} from '../cards.js';
import { exportButton } from './helpers.js';

const el = (...args) => ui.el(...args);

const TAB_ID = 'roblox-compare';

export async function init() {
  const list = typeof router.list === 'function' ? router.list() : [];
  if (list.some((t) => t && t.id === TAB_ID)) return;
  router.registerTab({
    id: TAB_ID,
    title: tr('roblox.tabs.compare', 'Compare', '比較'),
    icon: '⚖️',
    group: 'Roblox',
    render: (rootEl) => render(rootEl),
  });
}

async function render(rootEl) {
  rootEl.textContent = '';
  rootEl.className = 'rbx-surface';

  /** Resolved endpoints of the comparison. */
  const state = { a: null, b: null };

  const saved = getSavedUsers();
  const savedA = el('select', { class: 'mrb-select', 'aria-label': tr('roblox.compare.savedA', 'Pick first user from saved', '從收藏揀第一個用户') });
  const savedB = el('select', { class: 'mrb-select', 'aria-label': tr('roblox.compare.savedB', 'Pick second user from saved', '從收藏揀第二個用户') });
  for (const sel of [savedA, savedB]) {
    sel.appendChild(el('option', { value: '' }, tr('roblox.compare.pickSaved', '— from saved —', '— 從收藏 —')));
    for (const u of saved.slice(0, 50)) {
      sel.appendChild(el('option', { value: String(u.id) }, `${u.displayName || u.name}`));
      sel.lastChild.value = JSON.stringify(u);
    }
  }

  const manualA = el('input', { type: 'text', class: 'mrb-field', placeholder: tr('roblox.compare.manualA', '…or username/ID', '……或者用户名/ID'), 'aria-label': tr('roblox.compare.manualALabel', 'First user lookup', '第一個用户查詢') });
  const manualB = el('input', { type: 'text', class: 'mrb-field', placeholder: tr('roblox.compare.manualB', '…or username/ID', '……或者用户名/ID'), 'aria-label': tr('roblox.compare.manualBLabel', 'Second user lookup', '第二個用户查詢') });

  const runBtn = el('button', { type: 'button', class: 'mrb-btn filled', onclick: () => run() },
    tr('roblox.compare.runBtn', 'Compare', '比較'));

  /* pending handoff from Users tab */
  const pending = store.get('roblox:pendingCompareA', null);
  if (pending) {
    store.remove('roblox:pendingCompareA');
    manualA.value = String(pending.name || pending.id);
  }

  const resultSlot = el('div', {});

  rootEl.append(
    el('h1', {}, tr('roblox.compare.title', 'Compare users', '比較用户')),
    el('section', { class: 'rbx-card rbx-home__card' },
      el('h2', {}, tr('roblox.compare.pickTitle', 'Pick two players', '揀兩個玩家')),
      el('p', { class: 'rbx-muted' }, tr('roblox.compare.hint',
        'Saved lists fill the dropdowns; typing a name or ID overrides them.',
        '下拉選單會列出收藏；直接輸入用户名或 ID 會覆蓋。')),
      el('div', { class: 'rbx-toolbar' },
        el('div', { class: 'rbx-compare__pick' },
          el('span', { class: 'rbx-compare__tag' }, 'A'),
          savedA, manualA),
        el('div', { class: 'rbx-compare__pick' },
          el('span', { class: 'rbx-compare__tag' }, 'B'),
          savedB, manualB),
        runBtn)),
    resultSlot);

  async function resolveSide(savedSel, manualInput) {
    const manual = manualInput.value.trim();
    if (manual) {
      if (/^\d+$/.test(manual)) {
        const p = await users.getById(manual);
        return { id: p.id, name: p.name, displayName: p.displayName || p.name, profile: p };
      }
      const res = await users.byUsernames([manual]);
      const hit = res?.data?.[0];
      if (!hit) throw { status: 404, message: `No user named "${manual}".`, hint: 'Check spelling.' };
      const p = await users.getById(hit.id).catch(() => null);
      return { id: hit.id, name: hit.name, displayName: hit.displayName || hit.name, profile: p };
    }
    if (savedSel.value) {
      const u = JSON.parse(savedSel.value);
      const p = await users.getById(u.id).catch(() => null);
      return { id: u.id, name: u.name, displayName: u.displayName || u.name, profile: p };
    }
    throw { status: 400, message: tr('roblox.compare.sideMissing', 'Pick or type a user for both sides.', '兩邊都要揀定或者輸入用户。'), hint: '' };
  }

  async function run() {
    resultSlot.textContent = '';
    resultSlot.appendChild(emptyState('⏳', tr('roblox.common.loading', 'Loading…', '載入中……'),
      tr('roblox.compare.loadingBody', 'Resolving both profiles, friend lists and group memberships.', '正在解析兩邊嘅檔案、朋友清單同群組成員身分。'), null));
    try {
      state.a = await resolveSide(savedA, manualA);
      state.b = await resolveSide(savedB, manualB);
    } catch (err) {
      resultSlot.textContent = '';
      resultSlot.appendChild(errorState(err, {}));
      announce(tr('roblox.compare.resolveFail', 'Could not resolve one of the two users', '其中一個用户解析唔到'));
      return;
    }

    resultSlot.textContent = '';
    resultSlot.appendChild(await comparison());
    announce(tr('roblox.compare.readyAnnounce', 'Comparison ready', '比較已準備好'));
  }

  async function comparison() {
    const wrap = el('div', {});

    /* side-by-side cards */
    const duo = el('div', { class: 'rbx-compare__duo' });
    for (const side of [state.a, state.b]) {
      const card = el('article', { class: 'rbx-card rbx-hero rbx-compare__side' });
      const img = el('div', { class: 'rbx-hero__img' });
      img.appendChild(thumbImg(null, { size: 120, alt: side.name, letter: side.name }));
      card.appendChild(img);
      const info = el('div', { class: 'rbx-hero__info' },
        el('h3', {}, side.displayName || side.name),
        el('p', { class: 'rbx-muted' }, `@${side.name} · ${side.id}`),
        el('p', {}, `${tr('roblox.users.joined', 'Joined', '加入')} ${formatDate(side.profile?.created)}`));
      card.appendChild(info);
      duo.appendChild(card);
    }
    // Headshots
    (async () => {
      const thumbs = await batchThumbnails([
        { type: 'AvatarHeadShot', targetId: state.a.id, size: '150x150' },
        { type: 'AvatarHeadShot', targetId: state.b.id, size: '150x150' },
      ]).catch(() => new Map());
      [[state.a], [state.b]].forEach(([side]) => {
        const v = thumbs.get(String(side.id));
        if (/^https?:/.test(v || '')) {
          const idx = side === state.a ? 0 : 1;
          const slotEl = duo.children[idx]?.querySelector('.rbx-hero__img');
          if (slotEl) {
            slotEl.textContent = '';
            slotEl.appendChild(thumbImg(v, { size: 120, alt: side.name, letter: side.name }));
          }
        }
      });
    })();

    wrap.appendChild(duo);

    /* overlaps */
    const overlaps = el('section', { class: 'rbx-card rbx-home__card' });
    overlaps.appendChild(el('h3', {}, tr('roblox.compare.overlapsTitle', 'Overlaps', '重疊')));

    const mutualBox = el('div', {});
    const groupBox = el('div', {});
    overlaps.append(mutualBox, groupBox);
    overlaps.appendChild(el('p', { class: 'rbx-muted', role: 'note' }, '🏅 ' +
      tr('roblox.compare.badgeNote',
        'Badge overlap is not computed here — it requires scanning every game each account plays. This surface sticks to data the public APIs grant directly.',
        '呢度唔會計徽章重疊 — 呢個需要掃描每個帳戶玩嘅所有遊戲。本頁面只用公開 API 直接提供嘅數據。')));

    loadMutuals(mutualBox);
    loadSharedGroups(groupBox);

    /* export */
    let rows = [];
    const exportBtn = await exportButton({
      name: `roblox-compare-${state.a.id}-${state.b.id}`,
      label: tr('roblox.compare.exportMd', 'Export comparison (Markdown)', '匯出比較（Markdown）'),
      formats: ['md', 'json'],
      rows: () => rows,
    });
    if (exportBtn) overlaps.appendChild(exportBtn);

    async function loadMutuals(box) {
      box.textContent = '';
      box.appendChild(el('h4', {}, tr('roblox.compare.mutualTitle', 'Mutual friends', '共同朋友')));
      box.appendChild(el('p', { class: 'rbx-muted' }, '…'));
      try {
        const [fa, fb] = await Promise.all([friends.list(state.a.id), friends.list(state.b.id)]);
        const bIds = new Set((fb?.data || []).map((u) => u.id));
        const mutual = (fa?.data || []).filter((u) => bIds.has(u.id));
        box.textContent = '';
        const countLine = el('p', {},
          el('strong', {}, formatNumber(mutual.length)), ' ',
          tr('roblox.compare.mutualCount', 'mutual friends', '個共同朋友'));
        box.appendChild(countLine);
        rows.push({ metric: 'Mutual friends count', value: mutual.length });
        if (mutual.length) {
          const sample = mutual.slice(0, 20);
          const chips = el('ul', { class: 'rbx-chip-row' });
          for (const m of sample) {
            chips.appendChild(el('li', { class: 'rbx-chip rbx-chip--neutral', title: `@${m.name}` },
              m.displayName || m.name));
          }
          box.appendChild(chips);
          if (mutual.length > sample.length) {
            box.appendChild(el('p', { class: 'rbx-muted' },
              tr('roblox.compare.mutualSampled', `(showing ${sample.length} of ${mutual.length})`, `（顯示 ${sample.length} / ${mutual.length}）`)));
          }
          rows.push(...sample.map((m) => ({ metric: 'Mutual friend', value: `${m.displayName || m.name} (@${m.name})` })));
        }
      } catch (err) {
        box.textContent = '';
        box.appendChild(errorState(err, {}));
      }
    }

    async function loadSharedGroups(box) {
      box.textContent = '';
      box.appendChild(el('h4', {}, tr('roblox.compare.sharedGroupsTitle', 'Shared group memberships', '共同群組')));
      box.appendChild(el('p', { class: 'rbx-muted' }, '…'));
      try {
        const [ga, gb] = await Promise.all([groups.userGroups(state.a.id), groups.userGroups(state.b.id)]);
        const mapB = new Map((gb?.data || []).map((r) => [r.group?.id, r]));
        const shared = (ga?.data || []).filter((r) => mapB.has(r.group?.id));
        box.textContent = '';
        box.appendChild(el('p', {},
          el('strong', {}, formatNumber(shared.length)), ' ',
          tr('roblox.compare.sharedCount', 'shared groups', '個共同群組')));
        rows.push({ metric: 'Shared groups count', value: shared.length });
        if (shared.length) {
          const ul = el('ul', { class: 'rbx-plainlist' });
          for (const r of shared.slice(0, 50)) {
            ul.appendChild(el('li', {},
              el('button', {
                type: 'button', class: 'rbx-linklike',
                onclick: () => router.navigate('roblox-groups'),
              }, r.group?.name || `#${r.group?.id}`),
              el('span', { class: 'rbx-muted' },
                ` · A: ${r.role?.name || '—'} · B: ${mapB.get(r.group?.id)?.role?.name || '—'}`)));
            rows.push({
              metric: 'Shared group',
              value: `${r.group?.name || r.group?.id}`,
              roles: `${r.role?.name || '—'} / ${mapB.get(r.group?.id)?.role?.name || '—'}`,
            });
          }
          box.appendChild(ul);
        }
      } catch (err) {
        box.textContent = '';
        box.appendChild(errorState(err, {}));
      }
    }

    return wrap;
  }
}
