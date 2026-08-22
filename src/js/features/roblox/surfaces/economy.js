/**
 * Roblox lane — Economy surface (session-gated).
 *
 * Without a session: a connect-promo explaining exactly what connecting
 * unlocks (Robux balance, monthly summary) — never fake numbers. With a
 * session: the Robux balance as a big number and a generic, honest rendering
 * of whatever fields the transactions-summary endpoint grants; Premium-gated
 * parts render as locked-with-reason rows instead of blanks. Refresh honours
 * the shared throttle.
 */

import { ui } from '../../../core/ui.js';
import { router } from '../../../core/router.js';
import {
  economy, getSelf, hasSession,
} from '../api.js';
import { tr, voice } from '../peers.js';
import { announce, errorState } from '../cards.js';

const el = (...args) => ui.el(...args);

const TAB_ID = 'roblox-economy';

export async function init() {
  const list = typeof router.list === 'function' ? router.list() : [];
  if (list.some((t) => t && t.id === TAB_ID)) return;
  router.registerTab({
    id: TAB_ID,
    title: tr('roblox.tabs.economy', 'Economy', '經濟'),
    icon: '💰',
    group: 'Roblox',
    render: (rootEl) => render(rootEl),
  });
}

async function render(rootEl) {
  rootEl.textContent = '';
  rootEl.className = 'rbx-surface';
  rootEl.appendChild(el('h1', {}, tr('roblox.economy.title', 'Economy', '經濟')));

  const body = el('div', {});
  rootEl.appendChild(body);

  if (!hasSession()) {
    body.appendChild(connectPromo());
    announce(tr('roblox.economy.noSessionAnnounce', 'Economy needs a connected session', '經濟頁需要連接 session'));
    return;
  }
  await paintConnected(body);
}

function connectPromo() {
  return el('section', { class: 'rbx-card rbx-home__card rbx-connectpromo' },
    el('h2', {}, '🔌 ', tr('roblox.economy.connectTitle', 'Connect your session to see economy data', '連接你嘅 session 就會見到經濟數據')),
    el('p', {}, tr('roblox.economy.promoBody1',
      'Connecting unlocks exactly two things here:',
      '連接之後呢度解鎖兩樣嘢：')),
    el('ul', { class: 'rbx-plainlist' },
      el('li', {}, tr('roblox.economy.unlockBalance', 'Your current Robux balance', '你而家嘅 Robux 餘額')),
      el('li', {}, tr('roblox.economy.unlockSummary',
        'A summary of your recent transaction totals (parts are Roblox-Premium-only)',
        '近期交易總覽（部分係 Roblox Premium 專屬）'))),
    el('p', { class: 'rbx-muted' }, tr('roblox.economy.promoNote',
      'Nothing is fetched or shown without it — no placeholders, no estimates.',
      '未連接之前乜都唔會抓取或顯示 — 冇假數據，冇估計值。')),
    el('div', { class: 'rbx-actions' },
      el('button', {
        type: 'button', class: 'mrb-btn filled',
        onclick: () => router.navigate('roblox-session'),
      }, tr('roblox.economy.openSession', 'Open Session tab', '開啟 Session 分頁'))));
}

async function paintConnected(body) {
  const self = getSelf();
  const card = el('section', { class: 'rbx-card rbx-home__card' });

  card.appendChild(el('div', { class: 'rbx-toolbar' },
    el('h2', {}, tr('roblox.economy.balanceTitle', 'Robux balance', 'Robux 餘額')),
    el('button', {
      type: 'button', class: 'mrb-btn tonal',
      onclick: () => refreshAll(),
    }, tr('roblox.common.refresh', 'Refresh', '刷新'))));

  const balanceWrap = el('div', { class: 'rbx-econ__balance' });
  card.appendChild(balanceWrap);
  card.appendChild(el('h3', {},
    `${tr('roblox.economy.summaryTitle', 'Monthly summary', '月結摘要')} — ${self?.displayName || self?.name || ''}`));
  const summarySlot = el('div', {});
  card.appendChild(summarySlot);
  body.appendChild(card);

  async function refreshAll() {
    balanceWrap.textContent = '';
    balanceWrap.appendChild(el('span', { class: 'mrb-skeleton rbx-econ__balance-skel' }));
    summarySlot.textContent = '';
    summarySlot.appendChild(el('p', { class: 'rbx-muted' }, tr('roblox.common.loading', 'Loading…', '載入中……')));

    /* balance */
    try {
      const cur = await economy.currency(self.id);
      balanceWrap.textContent = '';
      balanceWrap.appendChild(el('strong', { class: 'rbx-econ__balance-num' }, formatRobux(cur?.robux)));
      balanceWrap.appendChild(el('span', { class: 'rbx-muted' }, ' R$'));
      announce(tr('roblox.economy.balanceAnnounce', `Balance loaded`, `餘額已載入`));
    } catch (err) {
      balanceWrap.textContent = '';
      balanceWrap.appendChild(errorState(err, { retry: refreshAll }));
    }

    /* summary — rendered generically from whatever the API grants */
    try {
      const sum = await economy.summary(self.id, { timeFrame: 'Month' });
      summarySlot.textContent = '';
      if (!sum || typeof sum !== 'object') {
        summarySlot.appendChild(emptyish(tr('roblox.economy.summaryEmpty',
          'The summary endpoint returned nothing for this account.', '摘要 API 對呢個帳戶冇回傳任何嘢。')));
        return;
      }
      const table = el('table', { class: 'mrb-table rbx-table' },
        el('caption', { class: 'rbx-visually-hidden' },
          tr('roblox.economy.summaryCaption', 'Monthly transaction summary granted by the API', 'API 有俾嘅月結交易摘要')),
        el('tbody', {}));
      /** @type {string[]} names of nodes the API marked as locked */
      const lockedNames = [];
      walk(sum, '', table.querySelector('tbody'), lockedNames);
      summarySlot.appendChild(table);
      if (lockedNames.length) {
        summarySlot.appendChild(el('p', { class: 'rbx-muted', role: 'note' },
          voice('warn', tr('roblox.economy.lockedNote',
            `Locked rows (Premium-only): ${lockedNames.join(', ')}`,
            `上鎖項目（只限 Premium）：${lockedNames.join(', ')}`))));
      }
    } catch (err) {
      summarySlot.textContent = '';
      if (err && err.status === 403) {
        summarySlot.appendChild(lockedCard(err));
      } else {
        summarySlot.appendChild(errorState(err, { retry: refreshAll }));
      }
    }
  }

  /**
   * Render every scalar field the response actually contains. Field names
   * come straight from the payload — this surface invents no schema. Nodes
   * the API marks `{ isLocked: true }` render as locked rows with a reason,
   * never as blank values.
   */
  function walk(value, path, tbody, lockedNames) {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`, tbody, lockedNames));
      return;
    }
    if (typeof value === 'object') {
      const name = path || '(root)';
      if (value.isLocked === true) {
        lockedNames.push(name);
        const reason = typeof value.reason === 'string' && value.reason ? value.reason : '';
        tbody.appendChild(el('tr', { class: 'rbx-econ__row-locked' },
          el('th', { scope: 'row' }, name),
          el('td', { colspan: '2' },
            '🔒 ',
            reason || tr('roblox.economy.lockedGeneric',
              'Requires Roblox Premium to view.', '需要 Roblox Premium 先可以睇。'))));
        return; // do not descend into a locked node's children
      }
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, tbody, lockedNames);
      return;
    }
    tbody.appendChild(el('tr', {},
      el('th', { scope: 'row' }, path || '(value)'),
      el('td', {}, String(value))));
  }

  /** Locked-with-reason state for a refused summary (403). */
  function lockedCard(err) {
    return el('div', { class: 'rbx-card rbx-home__card rbx-inv__privacy', role: 'alert' },
      el('h2', {}, '🔒 ', tr('roblox.economy.lockedTitle', 'Summary not available for this account', '呢個帳戶攞唔到摘要')),
      el('p', {}, err.message || ''),
      el('p', {}, tr('roblox.economy.lockedBody',
        'Transaction summaries are restricted to Roblox Premium accounts. Without Premium this stays locked; the balance above still works.',
        '交易摘要只限 Roblox Premium 帳戶。冇 Premium 呢部分會保持上鎖；上面嘅餘額仍然正常。')));
  }

  function emptyish(text) {
    return el('p', { class: 'rbx-muted', role: 'status' }, text);
  }

  function formatRobux(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    try { return v.toLocaleString(); } catch { return String(v); }
  }

  await refreshAll();
}
