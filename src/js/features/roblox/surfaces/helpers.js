/**
 * Shared surface helpers for the Roblox lane: guarded export buttons and the
 * native selection model used by list surfaces.
 *
 * Export buttons are only rendered when Lane C's exporter module is present —
 * a missing peer means the control is hidden entirely, never dead. Selection
 * is implemented natively (checkboxes + shift-range + select-all states) so
 * bulk actions work regardless of whether any optional peer has landed;
 * destructive batches still route through ui.superConfirm per the contract.
 */

import { ui } from '../../../core/ui.js';
import { loadExporter } from '../peers.js';
import { announce, tr } from '../cards.js';

const el = (...args) => ui.el(...args);

/**
 * Build an "Export" button that offers every format the exporter supports for
 * this data shape. Returns null when the exporter peer is unavailable, so
 * callers can hide it entirely (`if (!btn) …`).
 *
 * @param {{name:string, rows:()=>Array<Record<string,any>>,
 *          formats?:string[], label?:string}} spec
 * @returns {Promise<HTMLButtonElement|null>}
 */
export async function exportButton(spec) {
  let exporter = null;
  try {
    exporter = await loadExporter();
  } catch { /* stay hidden */ }
  if (!exporter || typeof exporter.exportData !== 'function') return null;

  const btn = el('button', {
    type: 'button',
    class: 'mrb-btn tonal',
    title: tr('roblox.export.title', 'Export what is currently visible', '匯出目前顯示嘅內容'),
    onclick: async () => {
      try {
        const rows = spec.rows() || [];
        if (!rows.length) {
          ui.toast({
            title: tr('roblox.export.emptyTitle', 'Nothing to export', '冇嘢可以匯出'),
            body: tr('roblox.export.emptyBody', 'Load some results first.', '先載入啲結果先啦。'),
            tone: 'warn',
          });
          return;
        }
        await exporter.exportData({
          name: spec.name,
          rows,
          formats: spec.formats || ['json', 'csv', 'md'],
        });
      } catch (err) {
        ui.toast({
          title: tr('roblox.export.failTitle', 'Export failed', '匯出失敗'),
          body: String((err && err.message) || err),
          tone: 'error',
        });
      }
    },
  }, spec.label || tr('roblox.export.button', 'Export', '匯出'));
  return btn;
}

/**
 * Native multi-select model for a list of row elements.
 *
 * Rows opt in by carrying `data-row-id`; the helper wires each row's
 * checkbox, shift-click range selection over DOM order, and exposes counts
 * plus the two explicit select-all scopes required by the contract
 * ("THIS PAGE" vs "ALL LOADED").
 *
 * @param {(id:string, on:boolean)=>void} [onToggle] extra hook per row change
 * @returns {{
 *   makeCheckbox:(rowId:string, ariaLabel:string)=>HTMLInputElement,
 *   registerRow:(rowEl:HTMLElement, rowId:string)=>void,
 *   ids: ()=>string[],
 *   allLoadedIds: ()=>string[],
 *   setAllLoaded:(ids:string[])=>void,
 *   scopeAllLoaded:()=>boolean,
 *   setScopeAllLoaded:(v:boolean)=>void,
 *   clear:()=>void,
 *   count:()=>number,
 *   onChange:(fn:Function)=>void,
 * }}
 */
export function createSelection(onToggle) {
  const state = {
    /** @type {Set<string>} */ selected: new Set(),
    /** @type {HTMLElement[]} */ rows: [],
    /** @type {string[]} */ loaded: [],
    allLoadedScope: false,
    lastCheckedIndex: -1,
    listeners: [],
  };

  const emit = () => state.listeners.forEach((fn) => fn(state.selected.size));

  function rowIndexOf(id) {
    return state.loaded.indexOf(String(id));
  }

  /**
   * Checkbox factory bound to one row id; handles click + shift-range.
   * @param {string} rowId
   * @param {string} ariaLabel
   */
  function makeCheckbox(rowId, ariaLabel) {
    const id = String(rowId);
    const cb = el('input', { type: 'checkbox' });
    cb.checked = state.selected.has(id);
    cb.setAttribute('aria-label', ariaLabel);
    cb.dataset.rowId = id;
    cb.addEventListener('click', (ev) => {
      ev.stopPropagation(); // don't trigger row-level open handlers
      const idx = rowIndexOf(id);
      if (ev.shiftKey && state.lastCheckedIndex >= 0 && idx >= 0) {
        const [a, b] = [Math.min(idx, state.lastCheckedIndex), Math.max(idx, state.lastCheckedIndex)];
        const turnOn = !state.selected.has(id);
        for (let i = a; i <= b; i += 1) {
          const rid = state.loaded[i];
          if (!rid) continue;
          if (turnOn) state.selected.add(rid); else state.selected.delete(rid);
        }
      } else if (cb.checked) {
        state.selected.add(id);
        state.lastCheckedIndex = idx;
      } else {
        state.selected.delete(id);
        state.lastCheckedIndex = idx;
      }
      syncCheckboxes();
      emit();
      if (onToggle) onToggle(id, state.selected.has(id));
    });
    return cb;
  }

  function syncCheckboxes() {
    for (const row of state.rows) {
      const cb = row.querySelector?.('input[type="checkbox"][data-row-id]');
      if (cb) cb.checked = state.selected.has(cb.dataset.rowId);
    }
  }

  return {
    makeCheckbox,
    /** Register a rendered row so its checkbox stays in sync. */
    registerRow(rowEl, rowId) {
      state.rows.push(rowEl);
      rowEl.dataset.rowId = String(rowId);
    },
    resetRows() { state.rows = []; },
    ids() { return [...state.selected]; },
    /** Ids of everything loaded so far (for the ALL LOADED scope). */
    allLoadedIds() { return [...state.loaded]; },
    setAllLoaded(ids) {
      state.loaded = (ids || []).map(String);
      // Drop selections that scrolled out of the loaded set.
      const live = new Set(state.loaded);
      for (const id of [...state.selected]) if (!live.has(id)) state.selected.delete(id);
    },
    scopeAllLoaded() { return state.allLoadedScope; },
    setScopeAllLoaded(v) {
      state.allLoadedScope = Boolean(v);
      if (!v) { /* THIS PAGE keeps whatever is checked */ }
      else {
        for (const id of state.loaded) state.selected.add(id);
        syncCheckboxes();
        emit();
      }
    },
    selectPageOnly(pageIds) {
      state.selected.clear();
      for (const id of pageIds || []) state.selected.add(String(id));
      syncCheckboxes();
      emit();
    },
    invert(pageIds) {
      const scope = state.allLoadedScope ? state.loaded : (pageIds || []);
      for (const id of scope.map(String)) {
        if (state.selected.has(id)) state.selected.delete(id);
        else state.selected.add(id);
      }
      syncCheckboxes();
      emit();
    },
    clear() {
      state.selected.clear();
      syncCheckboxes();
      emit();
    },
    count() { return state.selected.size; },
    onChange(fn) { state.listeners.push(fn); },
    /** Announce the current selection politely. */
    announceSelection() {
      const n = state.selected.size;
      announce(n === 0
        ? tr('roblox.select.none', 'No rows selected', '未揀任何一行')
        : tr('roblox.select.count', `${n} rows selected`, `揀咗 ${n} 行`));
    },
  };
}

/**
 * Select-all scope dropdown: explicitly states whether the action covers
 * THIS PAGE or ALL LOADED rows (contract wording), as an accessible <select>.
 *
 * @param {{scope:()=>boolean, setScope:(v:boolean)=>void, applyPage?:()=>void}} sel
 */
export function selectAllControl(sel) {
  const select = el('select', {
    class: 'mrb-select rbx-bulk__scope',
    'aria-label': tr('roblox.bulk.selectAllScope', 'Select-all scope', '全選範圍'),
    onchange: () => {
      const allLoaded = select.value === 'loaded';
      sel.setScope(allLoaded);
      if (!allLoaded && typeof sel.applyPage === 'function') sel.applyPage();
      announce(select.value === 'loaded'
        ? tr('roblox.bulk.scopeLoaded', 'Select-all now covers all loaded rows', '全選而家包括所有已載入行')
        : tr('roblox.bulk.scopePage', 'Select-all now covers this page only', '全選而家只限本頁'));
    },
  },
  el('option', { value: 'page' }, tr('roblox.bulk.pageOption', 'THIS PAGE', '本頁')),
  el('option', { value: 'loaded' }, tr('roblox.bulk.loadedOption', 'ALL LOADED', '所有已載入')));
  return select;
}

/**
 * Bulk toolbar shell: hosts scope dropdown, count readout and action buttons.
 * @returns {{root:HTMLElement, count:HTMLElement, actions:HTMLElement}}
 */
export function bulkBarShell() {
  const count = el('span', { class: 'rbx-bulk__count', 'aria-live': 'polite' },
    tr('roblox.bulk.zeroSelected', '0 selected', '已選 0 項'));
  const actions = el('div', { class: 'rbx-bulk__actions' });
  const root = el('div', { class: 'rbx-toolbar rbx-bulk', role: 'group',
    'aria-label': tr('roblox.bulk.label', 'Bulk actions', '批次操作') },
    count, actions);
  return { root, count, actions };
}

/** Update a bulk-bar count readout. */
export function updateBulkCount(countEl, sel, totalLoaded) {
  const n = sel.count();
  countEl.textContent = `${tr('roblox.bulk.selectedPrefix', 'selected:', '已選：')} ${n}` +
    ` / ${totalLoaded ?? '?'}`;
}

/**
 * Run a destructive batch strictly through ui.superConfirm's two-key +
 * full-range-slider gate. If the gate is unavailable the action is REFUSED
 * (with a visible toast) rather than performed unconfirmed.
 *
 * @param {{detailHtml:string, confirmLabel?:string,
 *          action:()=>void|Promise<void>, done?:(ok:boolean)=>void}} spec
 */
export function runDestructiveBatch(spec) {
  const finish = (ok) => { if (typeof spec.done === 'function') spec.done(ok); };
  if (typeof ui.superConfirm !== 'function') {
    ui.toast({
      title: tr('roblox.bulk.gateMissingTitle', 'Confirmation unavailable', '無法確認'),
      body: tr('roblox.bulk.gateMissingBody',
        'The confirmation gate is not available right now, so this destructive action was refused.',
        '確認閘門暫時用唔到，所以呢個破壞性操作被拒絕咗。'),
      tone: 'error',
    });
    finish(false);
    return;
  }
  try {
    ui.superConfirm({
      title: tr('roblox.bulk.confirmTitle', 'Confirm destructive action', '確認破壞性操作'),
      detailHtml: spec.detailHtml,
      confirmLabel: spec.confirmLabel || tr('roblox.bulk.confirmGo', 'Yes, do it', '係，照做'),
      onConfirm: () => {
        Promise.resolve(spec.action()).then(
          () => finish(true),
          () => finish(false),
        );
      },
    });
  } catch {
    finish(false);
  }
}
