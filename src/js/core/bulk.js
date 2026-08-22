/**
 * Material Roblox — universal bulk-actions engine (Lane C).
 *
 * `enable(listEl, opts)` turns ANY list markup into a multi-select surface:
 * leading checkbox column, tri-state select-all with an explicit scope choice
 * ("This page" vs "All matches (N)"), inverse selection, shift-click ranges,
 * Ctrl/Cmd+A scoped to the component, Escape to clear, a floating elevated
 * action bar while anything is selected, destructive batches routed through
 * the two-key super confirmation with a scrollable affected-items preview,
 * chunked cancellable progress for long runs, an enumerated skipped-items
 * report (never silent), and optional snapshot-based undo through local
 * history.
 *
 * No framework assumptions: rows are found by `rowSelector`, the checkbox
 * cell is a `<td>` for table rows and a `<span>` otherwise, and a debounced
 * MutationObserver keeps new rows selectable without any re-render contract.
 */

import { ui } from './ui.js';
import { i18n } from './i18n.js';

/* ── Localized copy helpers (CONTRACT §8 fallback pattern) ──────────────── */

function tr(key, en, yue) {
  let translated = null;
  let mode = 'en';
  try {
    const v = i18n.t(key);
    if (v && v !== key) translated = v;
    if (typeof i18n.lang === 'function') mode = i18n.lang();
  } catch { /* catalogs unavailable — local copy stands */ }
  const primary = translated || en;
  if (mode === 'bi' && yue && yue !== primary) return `${primary} · ${yue}`;
  return primary;
}

function voice(category, text) {
  try {
    const v = i18n.voice(category, text);
    if (typeof v === 'string' && v) return v;
  } catch { /* facts stay exact */ }
  return text;
}

/* ── Module state ───────────────────────────────────────────────────────── */

const instances = new WeakMap();
let historyPeerPromise = null;

function loadHistoryPeer() {
  if (!historyPeerPromise) {
    historyPeerPromise = import('./history.js').then((m) => (m && typeof m.record === 'function' ? m : null)).catch(() => null);
  }
  return historyPeerPromise;
}

/* ── Chunked runner ─────────────────────────────────────────────────────── */

/**
 * Run `fn` over `items`, yielding to the UI every 50 completions so long
 * batches never freeze the interface. `token.cancelled` stops between items —
 * partial progress stays partial and is reported honestly by the caller.
 */
export async function runChunked(items, fn, onTick, token = { cancelled: false }) {
  let done = 0;
  for (const item of items) {
    if (token.cancelled) break;
    await fn(item);
    done += 1;
    if (done % 50 === 0) {
      if (onTick) onTick(done, items.length);
      // Microtask yield: paints get a slot without timer-based delays.
      await Promise.resolve();
    }
  }
  if (onTick) onTick(done, items.length);
  return done;
}

/* ── enable() ───────────────────────────────────────────────────────────── */

/**
 * @param {HTMLElement} listEl container whose rows are matched by rowSelector
 * @param {object} opts
 *   rowSelector     required selector matching selectable rows inside listEl
 *   getItemId|idOf  row -> stable id (both spellings accepted)
 *   getLabel        row -> human label (checkbox aria-label, previews)
 *   actions         [{ id,label,danger?,run(ids,ctx),excludes?(id)->reason|null,
 *                      snapshotter?(ids)->{files:{path:content}}|null }]
 *   totalProvider?  () -> number of ALL matches (for the scope select count)
 *   allIdsProvider? () -> iterable of ALL ids; without it the "All matches"
 *                        option stays disabled with an explanatory tooltip —
 *                        the app never pretends it can act on ids it cannot see.
 *   scopeLabel?     accessible name for the whole component
 */
export function enable(listEl, opts = {}) {
  if (!listEl || !(listEl instanceof HTMLElement)) throw new Error('bulk.enable expects a container element.');
  if (instances.has(listEl)) return instances.get(listEl);

  const idOf = opts.getItemId || opts.idOf || ((row) => row.dataset.mrbBulkId || '');
  const getLabel = opts.getLabel || (() => '');
  const rowSelector = opts.rowSelector || '';
  const actions = Array.isArray(opts.actions) ? opts.actions.slice() : [];
  const compName = opts.scopeLabel || tr('bulk.component', 'List', '清單');

  const selected = new Set();          // ids ticked on THIS page
  let lastCheckedIndex = -1;
  let scope = 'page';                  // 'page' | 'all'
  let destroyed = false;

  const rows = () => Array.from(listEl.querySelectorAll(rowSelector));
  const pageIds = () => rows().map(idOf).filter((v) => v != null && v !== '');

  /* Toolbar (select-all + scope + inverse) sits directly above the list. */
  const toolbar = ui.el('div', { class: 'mrb-cx-bulk-toolbar', role: 'group', 'aria-label': tr('bulk.selection', `Selection for ${compName}`, `${compName}嘅選擇`) });

  const selAllId = `mrb-cx-selall-${Math.random().toString(36).slice(2, 8)}`;
  const selectAll = ui.el('input', { type: 'checkbox', id: selAllId });
  const selAllLab = ui.el('label', { class: 'mrb-cx-selall-label', for: selAllId },
    ui.el('span', { class: 'mrb-visually-hidden' }, tr('bulk.selectAll', 'Select all', '全選')));
  // The visible tick-box chrome comes from CSS so the hit target stays 48px
  // regardless of localized label length.

  const scopeSelect = ui.el('select', {
    class: 'mrb-select mrb-cx-scope',
    'aria-label': tr('bulk.scope', 'Selection scope', '選擇範圍'),
  });

  const inverseBtn = ui.el('button', { class: 'mrb-btn mrb-btn--text mrb-cx-inverse', type: 'button' },
    tr('bulk.inverse', 'Inverse', '反選'));
  inverseBtn.addEventListener('click', () => {
    for (const id of pageIds()) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
    }
    paint();
  });

  toolbar.append(selectAll, selAllLab, scopeSelect, inverseBtn);
  listEl.parentNode.insertBefore(toolbar, listEl);

  function rebuildScopeOptions() {
    const pageN = pageIds().length;
    const total = typeof opts.totalProvider === 'function' ? Number(opts.totalProvider()) : pageN;
    const canAll = typeof opts.allIdsProvider === 'function';
    scopeSelect.textContent = '';
    const optPage = ui.el('option', { value: 'page' },
      tr('bulk.scopePage', `This page (${pageN})`, `本頁 (${pageN})`));
    scopeSelect.appendChild(optPage);
    const optAll = ui.el('option', { value: 'all' },
      tr('bulk.scopeAll', `All matches (${Number.isFinite(total) ? total : '?'})`, `所有符合 (${Number.isFinite(total) ? total : '?'}）`));
    if (!canAll) {
      optAll.disabled = true;
      optAll.title = tr('bulk.scopeAllNeedsSource',
        'An item source for every match is not available here, so only this page can be selected.',
        '呢度攞唔到所有符合項目嘅來源，所以只能揀本頁。');
    }
    scopeSelect.appendChild(optAll);
    scopeSelect.value = scope === 'all' && canAll ? 'all' : 'page';
  }

  scopeSelect.addEventListener('change', () => {
    scope = scopeSelect.value === 'all' ? 'all' : 'page';
    paint();
  });

  /* Per-row checkbox column. */
  function ensureCell(row, id, label) {
    let cell = row.querySelector(':scope > .mrb-cx-bulkcell');
    if (!cell) {
      cell = document.createElement(row.tagName === 'TR' ? 'td' : 'span');
      cell.className = 'mrb-cx-bulkcell';
      row.insertBefore(cell, row.firstChild);
    }
    let cb = cell.querySelector('input[type="checkbox"]');
    if (!cb) {
      cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'mrb-cx-bulkcheck';
      cell.appendChild(cb);
      cb.addEventListener('click', (e) => {
        if (e.shiftKey) {
          e.preventDefault();
          const rs = rows();
          const thisIdx = rs.indexOf(row);
          const anchor = lastCheckedIndex >= 0 && lastCheckedIndex < rs.length ? lastCheckedIndex : thisIdx;
          const [a, b] = anchor <= thisIdx ? [anchor, thisIdx] : [thisIdx, anchor];
          const turnOn = !selected.has(id);
          for (let k = a; k <= b; k++) {
            const rid = idOf(rs[k]);
            if (rid == null || rid === '') continue;
            if (turnOn) selected.add(rid);
            else selected.delete(rid);
          }
          lastCheckedIndex = thisIdx;
          paint();
          return;
        }
        lastCheckedIndex = rows().indexOf(row);
        if (cb.checked) selected.add(id);
        else selected.delete(id);
        paint();
      });
    }
    cb.dataset.mrbBulkFor = id;
    cb.setAttribute('aria-label', tr('bulk.selectOne', `Select ${label}`, `揀 ${label}`));
    return cb;
  }

  function syncRows() {
    if (destroyed) return;
    quiet(() => {
      for (const row of rows()) {
        const id = String(idOf(row) ?? '');
        if (!id) continue;
        const cb = ensureCell(row, id, getLabel(row));
        cb.checked = selected.has(id);
      }
    });
    rebuildScopeOptions();
    paintTriState();
    paintBar();
  }

  /* Keep fresh rows selectable without any framework hook. Our own checkbox
   * injections also trip this observer, so self-writes are flagged and
   * ignored to stop the sync → mutate → sync feedback loop. */
  let observer = null;
  let obsTimer = 0;
  let selfMutation = false;
  try {
    observer = new MutationObserver(() => {
      if (selfMutation) { selfMutation = false; return; }
      clearTimeout(obsTimer);
      obsTimer = setTimeout(syncRows, 50);
    });
    observer.observe(listEl, { childList: true, subtree: true });
  } catch { /* ancient engines: callers can call refresh() manually */ }

  function quiet(mutate) {
    selfMutation = true;
    try { mutate(); } finally {
      // The observer callback fires as a microtask after the mutation; the
      // flag is consumed there. Clearing it on the next macrotask covers the
      // case where no callback fires at all.
      setTimeout(() => { selfMutation = false; }, 0);
    }
  }

  /* Floating action bar. */
  const bar = ui.el('div', { class: 'mrb-cx-bulkbar', role: 'toolbar', 'aria-label': tr('bulk.actions', 'Bulk actions', '批次操作'), hidden: 'true' });
  const liveLine = ui.el('p', { class: 'mrb-cx-bulkbar-live', 'aria-live': 'polite' });
  const btnRow = ui.el('div', { class: 'mrb-cx-bulkbar-buttons' });
  const cancelBtn = ui.el('button', { class: 'mrb-btn mrb-btn--text', type: 'button', hidden: 'true' }, tr('bulk.cancel', 'Cancel', '取消'));
  bar.append(liveLine, btnRow, cancelBtn);
  document.body.appendChild(bar);

  function effectiveIds() {
    if (scope === 'all' && typeof opts.allIdsProvider === 'function') {
      return new Set(Array.from(opts.allIdsProvider()).map(String));
    }
    const page = new Set(pageIds());
    return new Set([...selected].filter((id) => page.has(id)));
  }

  /** Split ids into {affected, excluded:{reason:count}} using an action's excludes(). */
  function partition(action, ids) {
    const affected = [];
    const excluded = {};
    if (typeof action.excludes !== 'function') return { affected: [...ids], excluded };
    for (const id of ids) {
      let reason = null;
      try { reason = action.excludes(id); } catch { reason = null; }
      if (reason) excluded[reason] = (excluded[reason] || 0) + 1;
      else affected.push(id);
    }
    return { affected, excluded };
  }

  function summarizeExcluded(excluded) {
    const parts = Object.entries(excluded).map(([reason, n]) => `${reason}×${n}`);
    return parts.join(', ');
  }

  async function runAction(action) {
    const all = [...effectiveIds()];
    const { affected, excluded } = partition(action, new Set(all));
    const go = async () => {
      cancelBtn.hidden = false;
      const token = { cancelled: false };
      onCancel = () => { token.cancelled = true; };
      // Snapshot BEFORE the first mutation, so the undo record describes the
      // state that existed when the batch started — never the wreck after it.
      let snapshot = null;
      if (action.danger && typeof action.snapshotter === 'function') {
        try { snapshot = action.snapshotter(affected) || null; } catch { snapshot = null; }
      }
      try {
        // Per-item failures are COUNTED, never allowed to abort the batch
        // silently — partial results are reported honestly below.
        let failed = 0;
        const done = await runChunked(affected, async (id) => {
          try {
            await action.run([id], { signal: token });
          } catch (err) {
            failed += 1;
            console.warn('[mrb/bulk] item failed during', action.id || action.label, err);
          }
        }, (d, total) => {
          liveLine.textContent = voice('info', tr('bulk.progress', `Working… ${d} / ${total}`, `做緊… ${d} / ${total}`));
        }, token);
        const failedBit = failed > 0
          ? tr('bulk.failedN', ` · ${failed} failed — see the console for details`, ` · ${failed} 個失敗——詳情睇 console`)
          : '';
        // Record the history entry BEFORE the toast that offers "Restore",
        // so the link can never point at an entry that does not exist yet.
        if (snapshot) {
          try {
            const hp = await loadHistoryPeer();
            if (hp) {
              await hp.record({
                kind: action.danger ? 'deleted' : 'updated',
                label: `${action.label} — ${affected.length} item(s)`,
                snapshot: { files: (snapshot && snapshot.files) || {} },
              });
            }
          } catch { /* history unavailability never blocks the batch result */ }
        }
        const skippedBit = Object.keys(excluded).length
          ? tr('bulk.skipped', ` · Skipped ${all.length - affected.length}: ${summarizeExcluded(excluded)}`,
                              ` · 跳過 ${all.length - affected.length} 個：${summarizeExcluded(excluded)}`)
          : '';
        const undoActions = snapshot
          ? [{ label: tr('bulk.undoHint', 'Restore from history', '從歷史還原'), run: openHistory }]
          : undefined;
        if (token.cancelled) {
          ui.toast({
            title: tr('bulk.cancelled', 'Batch cancelled', '已取消批次'),
            body: voice('warn', tr('bulk.partial', `${done} of ${affected.length} items were processed; the rest were left untouched.`, `已處理 ${affected.length} 個之中嘅 ${done} 個；其餘原封不動。`)) + skippedBit + failedBit,
            tone: 'warn',
            sticky: true,
            actions: undoActions,
          });
        } else {
          ui.toast({
            title: tr('bulk.done', 'Done', '搞掂'),
            body: voice(action.danger ? 'warn' : 'ok', `${action.label}: ${done}`) + skippedBit + failedBit +
              (!action.danger || snapshot ? '' : ' ' + tr('bulk.notUndoable', 'This batch cannot be undone — this list provides no snapshot.', '呢個批次冇得復原——個清單冇提供快照。')),
            tone: action.danger || failed > 0 ? 'warn' : 'ok',
            timeoutMs: 6000,
            actions: undoActions,
          });
        }
      } finally {
        onCancel = null;
        cancelBtn.hidden = true;
      }
      selected.clear();
      paint();
    };

    if (action.danger) {
      const labels = affected.map((id) => {
        const row = rows().find((r) => String(idOf(r)) === String(id));
        return row ? getLabel(row) : String(id);
      }).filter(Boolean);
      const preview = labels.slice(0, 50).map((l) => `<li>${ui.escapeHtml(String(l))}</li>`).join('');
      const more = labels.length > 50
        ? `<li>… ${tr('bulk.moreN', `and ${labels.length - 50} more`, `仲有另外 ${labels.length - 50} 項`)}</li>`
        : '';
      const skipBit = Object.keys(excluded).length
        ? `<p>${ui.escapeHtml(tr('bulk.willSkip', `Will be skipped: ${summarizeExcluded(excluded)}`, `將會跳過：${summarizeExcluded(excluded)}`))}</p>`
        : '';
      ui.superConfirm({
        title: `${action.label} — ${affected.length}`,
        detailHtml:
          `<p>${ui.escapeHtml(tr('bulk.affects', 'This affects:', '會影響：'))} <strong>${affected.length}</strong></p>` +
          `<ul class="mrb-cx-previewlist">${preview}${more}</ul>` + skipBit,
        confirmLabel: action.label,
        onConfirm: go,
      });
    } else {
      await go();
    }
  }

  let onCancel = null;
  cancelBtn.addEventListener('click', () => { if (onCancel) onCancel(); });

  function openHistory() {
    import('./history.js').then((m) => { if (m && typeof m.show === 'function') m.show(); }).catch(() => { });
  }

  function rebuildButtons() {
    btnRow.textContent = '';
    for (const action of actions) {
      const b = ui.el('button', {
        class: `mrb-btn ${action.danger ? 'mrb-btn--danger' : 'mrb-btn--tonal'} mrb-cx-bulkbtn`,
        type: 'button',
      }, action.label);
      b.addEventListener('click', () => runAction(action));
      btnRow.appendChild(b);
    }
  }

  function paintTriState() {
    const ids = pageIds();
    const n = ids.filter((id) => selected.has(id)).length;
    selectAll.checked = ids.length > 0 && n === ids.length;
    selectAll.indeterminate = n > 0 && n < ids.length;
    selectAll.setAttribute('aria-checked', selectAll.checked ? 'true' : (selectAll.indeterminate ? 'mixed' : 'false'));
  }

  function paintBar() {
    const n = effectiveIds().size;
    if (n <= 0) {
      bar.hidden = true;
      return;
    }
    // M previews the post-exclusion count using the first action that defines
    // exclusions; each confirm dialog always states its own exact numbers.
    const withExcl = actions.find((a) => typeof a.excludes === 'function');
    let m = n;
    if (withExcl) m = partition(withExcl, effectiveIds()).affected.length;
    liveLine.textContent = voice('neutral',
      tr('bulk.countline', `${n} selected · ${m} will change`, `${n} 個已選 · 將會影響 ${m} 個`));
    bar.hidden = false;
  }

  function paint() {
    for (const row of rows()) {
      const id = String(idOf(row) ?? '');
      if (!id) continue;
      const cb = row.querySelector('.mrb-cx-bulkcell input[type="checkbox"]');
      if (cb) cb.checked = selected.has(id);
    }
    paintTriState();
    paintBar();
  }

  selectAll.addEventListener('change', () => {
    const ids = pageIds();
    if (selectAll.checked || selectAll.indeterminate) ids.forEach((id) => selected.add(id));
    else selected.clear();
    paint();
  });

  const onKeydown = (e) => {
    const within = listEl.contains(e.target) || toolbar.contains(e.target) || bar.contains(e.target);
    if (!within) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      if (scope === 'all' && typeof opts.allIdsProvider === 'function') {
        for (const id of opts.allIdsProvider()) selected.add(String(id));
      } else {
        pageIds().forEach((id) => selected.add(id));
      }
      paint();
    } else if (e.key === 'Escape' && !e.altKey) {
      if (selected.size) {
        e.preventDefault();
        selected.clear();
        paint();
      }
    }
  };
  document.addEventListener('keydown', onKeydown);

  const controller = {
    getSelected: () => new Set(effectiveIds()),
    setSelected(ids) {
      selected.clear();
      for (const id of ids || []) selected.add(String(id));
      paint();
    },
    clear: () => { selected.clear(); paint(); },
    refresh: syncRows,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(obsTimer);
      if (observer) observer.disconnect();
      document.removeEventListener('keydown', onKeydown);
      for (const cell of listEl.querySelectorAll('.mrb-cx-bulkcell')) cell.remove();
      toolbar.remove();
      bar.remove();
      instances.delete(listEl);
    },
  };

  rebuildButtons();
  syncRows();
  instances.set(listEl, controller);
  return controller;
}

/** Detach everything enable() attached. Safe to call twice. */
export function teardown(listEl) {
  const c = instances.get(listEl);
  if (c) c.destroy();
}

/** Namespaced facade per CONTRACT §6 (`bulk.enable(...)`). */
export const bulk = { enable, teardown, runChunked };

export async function init() {
  try {
    ui.injectCss(new URL('../../styles/features/coreux.css', import.meta.url).href);
  } catch (err) {
    console.warn('[mrb/bulk] stylesheet injection failed:', err && err.message);
  }
}
