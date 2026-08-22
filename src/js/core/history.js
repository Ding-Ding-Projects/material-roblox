/**
 * Material Roblox — local version history facade + panel (Lane C).
 *
 * Renderer half of the `hist:*` channels (main-process twin: app/ipc/hist.js).
 * The history repository itself lives at userData/history and is Git-backed;
 * this module never touches Git — it speaks IPC and renders.
 *
 * Surfaces provided here:
 *  • `record({kind,label,snapshot})` — the one-call API every other lane uses
 *    (fire-and-forget safe: a history failure is logged, never thrown into a
 *    caller's flow).
 *  • The History PANEL as a router tab: advanced date-range picker (calendar
 *    with month/year jump + typed entry in either locale or ISO order,
 *    neither side ever clobbering the other), action-kind filter derived from
 *    the data WITH live counts, regex-capable text search, expandable line
 *    diffs, confirm-guarded restore, inline relabeling, retention pruning
 *    behind super confirmation with a dry-run preview, and redacted export.
 *  • `show()` — navigates to the History tab, falling back to a modal when
 *    the router peer is unavailable.
 *
 * Honesty rules baked in: unchanged states record NOTHING (server-side digest
 * dedupe), restores APPEND rather than rewrite, prune HIDES rather than
 * deletes, exports carry snapshots OMITTED statement lines, and every IPC
 * failure surfaces as actionable copy instead of a blank panel.
 */

import { store } from './store.js';
import { i18n } from './i18n.js';
import { ui } from './ui.js';
import { saveText } from './exporter.js';

/* ── Bridge helpers ─────────────────────────────────────────────────────── */

function bridge() {
  return typeof window !== 'undefined' && window.mrb ? window.mrb : null;
}

async function invoke(channel, payload) {
  const b = bridge();
  if (!b || typeof b.invoke !== 'function') {
    throw new Error(tr('hist.noBridge',
      'The desktop bridge is unavailable, so history cannot be read or written right now.',
      '目前攞唔到桌面橋接，歷史紀錄暫時讀寫唔到。'));
  }
  return b.invoke(channel, payload);
}

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

/* ── Public API ─────────────────────────────────────────────────────────── */

/**
 * Append a history event. Fire-and-forget SAFE: callers must never have their
 * flow broken by journaling, so failures are logged (visible) and returned.
 * Unchanged states record NOTHING — the main process dedupes on digests.
 *
 * @param {{kind:string,label:string,snapshot?:{files:Object<string,string>,
 *          domain?:string}}} ev
 */
export async function record(ev) {
  try {
    const res = await invoke('hist:append', ev);
    if (res && res.ok === false) {
      console.warn('[mrb/history] append rejected:', res.error);
      return res;
    }
    return res || { ok: true };
  } catch (err) {
    console.warn('[mrb/history] append failed:', err && err.message);
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/** Query events. Filters compose with AND; see app/ipc/hist.js. */
export async function query(filters = {}) {
  return invoke('hist:query', filters);
}

export async function getEvent(id) {
  return invoke('hist:get', { id });
}

export async function diff(idA, idB) {
  return invoke('hist:diff', idB ? { idA, idB } : { idA });
}

export async function restore(id) {
  return invoke('hist:restore', { id });
}

export async function label(id, text) {
  return invoke('hist:label', { id, text });
}

export async function prune(policy) {
  return invoke('hist:prune', policy);
}

/**
 * Redacted export — metadata only, snapshots omitted (stated inside the file).
 * @param {{format?:('json'|'md')}&Record<string,any>} opts
 */
export async function exportRedacted(opts = {}) {
  const format = opts.format === 'md' ? 'md' : 'json';
  const res = await invoke('hist:export', { ...opts, format });
  if (!res || res.ok === false) {
    return { ok: false, error: (res && res.error) || tr('hist.exportFail', 'Export failed.', '匯出失敗。') };
  }
  return saveText(res.filename, res.content, format === 'md' ? 'Markdown' : 'JSON');
}

/* ── Typed/locale date parsing ──────────────────────────────────────────── */

let dateOrder = null; // e.g. 'month-day-year' | 'day-month-year' | 'year-month-day'

function getOrder() {
  if (dateOrder) return dateOrder;
  try {
    const parts = new Intl.DateTimeFormat(undefined)
      .formatToParts(new Date(2020, 10, 30))
      .filter((p) => ['year', 'month', 'day'].includes(p.type))
      .map((p) => p.type);
    dateOrder = parts.join('-');
  } catch {
    dateOrder = 'month-day-year';
  }
  return dateOrder;
}

/**
 * Parse a typed date: plain ISO first, then the detected locale order.
 * Returns {ms}|null — null means "not valid YET"; partial input is preserved
 * by the caller and never discarded.
 */
export function parseTypedDate(text) {
  const s = String(text || '').trim();
  if (!s) return { ms: null, empty: true };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return mk(+m[1], +m[2], +m[3]);
  m = s.split(/[^\d]+/).filter(Boolean).map(Number);
  if (m.length !== 3 || m.some((n) => !Number.isFinite(n))) return null;
  const [a, b, c] = m;
  const order = getOrder();
  if (order.startsWith('day-')) return mk(c, b, a);        // d/m/yyyy
  if (order.startsWith('year-')) return mk(a, b, c);        // yyyy/m/d
  return mk(c, a, b);                                        // m/d/yyyy
  function mk(y, mo, d) {
    if (y < 100) y += 2000;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    // Range bounds are inclusive through the END of the chosen day for `to`.
    return { ms: dt.getTime(), y, mo, d };
  }
}

function formatTyped(ms) {
  const d = new Date(ms);
  const order = getOrder();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear());
  if (order.startsWith('day-')) return `${dd}/${mm}/${yy}`;
  if (order.startsWith('year-')) return `${yy}-${mm}-${dd}`;
  return `${mm}/${dd}/${yy}`;
}

/* ── Advanced date-range picker ─────────────────────────────────────────── */

/**
 * Calendar popover + typed fields + presets. Typed entry accepts ISO or the
 * locale order; invalid or PARTIAL input stays in the box with an inline
 * message (never discarded), and the calendar selection writes back through
 * the same formatter so neither surface ever clobbers the other's text.
 */
function buildDateRange(initial, onChange) {
  const state = {
    from: initial.from || null,
    to: initial.to || null,
    viewY: new Date().getFullYear(),
    viewM: new Date().getMonth(),
  };

  const root = ui.el('div', { class: 'mrb-cx-daterange' });
  const presets = ui.el('div', { class: 'mrb-cx-dr-presets', role: 'group', 'aria-label': tr('hist.presets', 'Date presets', '日期捷徑') });
  const fromInput = ui.el('input', { type: 'text', class: 'mrb-field mrb-cx-dr-typed', placeholder: formatTyped(Date.now()), 'aria-label': tr('hist.from', 'From date', '開始日期'), spellcheck: 'false' });
  const toInput = ui.el('input', { type: 'text', class: 'mrb-field mrb-cx-dr-typed', placeholder: formatTyped(Date.now()), 'aria-label': tr('hist.to', 'To date', '結束日期'), spellcheck: 'false' });
  const msg = ui.el('p', { class: 'mrb-cx-dr-msg', 'aria-live': 'polite' });
  const calBtn = ui.el('button', { class: 'mrb-btn mrb-btn--outlined mrb-cx-dr-calbtn', type: 'button' }, tr('hist.calendar', 'Calendar…', '日曆…'));

  function setMsg(text, bad) {
    msg.textContent = text || '';
    msg.classList.toggle('is-bad', !!bad);
  }

  function emit() {
    onChange({ from: state.from, to: state.to });
  }

  function syncInputs() {
    fromInput.value = state.from != null ? formatTyped(state.from) : fromInput.value;
    toInput.value = state.to != null ? formatTyped(endOfDay(state.to)) : toInput.value;
  }

  function endOfDay(ms) {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
  }
  function startOfDay(ms) {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  function applyBound(which, parsed) {
    if (!parsed) return;             // invalid partial: keep text, wait
    if (parsed.empty) {
      if (which === 'from') state.from = null;
      else state.to = null;
      setMsg('');
      emit();
      return;
    }
    const ms = which === 'from' ? startOfDay(parsed.ms) : endOfDay(parsed.ms);
    if (which === 'from') state.from = ms;
    else state.to = ms;
    if (state.from != null && state.to != null && state.from > state.to) {
      const t = state.from; state.from = state.to; state.to = t;   // swap, never drop
      syncInputs();
    }
    setMsg('');
    state.viewY = new Date(state.from ?? state.to ?? Date.now()).getFullYear();
    state.viewM = new Date(state.from ?? state.to ?? Date.now()).getMonth();
    emit();
  }

  fromInput.addEventListener('change', () => {
    const parsed = parseTypedDate(fromInput.value);
    if (parsed === null) {
      setMsg(tr('hist.badDate',
        `That does not look like a complete date yet — use ${getOrder().startsWith('day-') ? 'DD/MM/YYYY' : getOrder().startsWith('year-') ? 'YYYY-MM-DD' : 'MM/DD/YYYY'} or YYYY-MM-DD.`,
        `呢個似係未打完嘅日期——用 ${getOrder().startsWith('day-') ? 'DD/MM/YYYY' : getOrder().startsWith('year-') ? 'YYYY-MM-DD' : 'MM/DD/YYYY'} 或者 YYYY-MM-DD。`), true);
      return;                       // typed text preserved, nothing cleared
    }
    applyBound('from', parsed);
  });
  toInput.addEventListener('change', () => {
    const parsed = parseTypedDate(toInput.value);
    if (parsed === null) {
      setMsg(tr('hist.badDate', 'Incomplete date.', '日期未打完。'), true);
      return;
    }
    applyBound('to', parsed);
  });

  const PRESETS = [
    { id: 'today', en: 'Today', yue: '今日', days: 0 },
    { id: '7d', en: '7 days', yue: '7 日', days: 7 },
    { id: '30d', en: '30 days', yue: '30 日', days: 30 },
    { id: '90d', en: '90 days', yue: '90 日', days: 90 },
    { id: 'all', en: 'All time', yue: '全部', days: -1 },
  ];
  for (const p of PRESETS) {
    const b = ui.el('button', { class: 'mrb-chip mrb-rb-chip', type: 'button' }, tr(`hist.preset.${p.id}`, p.en, p.yue));
    b.addEventListener('click', () => {
      if (p.days < 0) {
        state.from = null;
        state.to = null;
      } else {
        const now = Date.now();
        state.from = p.days === 0 ? startOfDay(now) : startOfDay(now - (p.days - 1) * 86400000);
        state.to = endOfDay(now);
      }
      syncInputs();
      setMsg('');
      emit();
    });
    presets.appendChild(b);
  }

  calBtn.addEventListener('click', () => {
    openCalendar(calBtn);
  });

  function openCalendar(anchor) {
    const cal = ui.el('div', { class: 'mrb-cx-calendar', role: 'group', 'aria-label': tr('hist.calendar', 'Calendar', '日曆') });
    const headRow = ui.el('div', { class: 'mrb-cx-cal-head' });
    const prevB = ui.el('button', { class: 'mrb-btn mrb-btn--text', type: 'button', 'aria-label': tr('hist.prevMonth', 'Previous month', '上個月') }, '‹');
    const nextB = ui.el('button', { class: 'mrb-btn mrb-btn--text', type: 'button', 'aria-label': tr('hist.nextMonth', 'Next month', '下個月') }, '›');
    const monthSel = ui.el('select', { class: 'mrb-select mrb-cx-cal-month', 'aria-label': tr('hist.month', 'Month', '月份') });
    const yearSel = ui.el('select', { class: 'mrb-select mrb-cx-cal-year', 'aria-label': tr('hist.year', 'Year', '年份') });
    headRow.append(prevB, monthSel, yearSel, nextB);

    const MONTHS = [...Array(12)].map((_, i) =>
      new Date(2020, i, 1).toLocaleDateString(undefined, { month: 'long' }));
    MONTHS.forEach((name, i) => monthSel.appendChild(ui.el('option', { value: String(i) }, name)));
    const nowY = new Date().getFullYear();
    for (let y = nowY - 15; y <= nowY + 1; y++) yearSel.appendChild(ui.el('option', { value: String(y) }, String(y)));

    const grid = ui.el('div', { class: 'mrb-cx-cal-grid', role: 'grid' });

    function paintCal() {
      monthSel.value = String(state.viewM);
      yearSel.value = String(state.viewY);
      grid.textContent = '';
      const firstDow = (new Date(state.viewY, state.viewM, 1).getDay() + 6) % 7; // Monday-start
      const daysInMonth = new Date(state.viewY, state.viewM + 1, 0).getDate();
      for (const lbl of ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']) {
        grid.appendChild(ui.el('span', { class: 'mrb-cx-cal-dow', 'aria-hidden': 'true' }, lbl));
      }
      for (let i = 0; i < firstDow; i++) grid.appendChild(ui.el('span', { class: 'mrb-cx-cal-blank' }));
      const todayMs = startOfDay(Date.now());
      for (let d = 1; d <= daysInMonth; d++) {
        const ms = new Date(state.viewY, state.viewM, d).getTime();
        const cls = ['mrb-cx-cal-day'];
        if (ms === todayMs) cls.push('is-today');
        if (state.from != null && ms === startOfDay(state.from)) cls.push('is-edge');
        if (state.to != null && ms === startOfDay(state.to)) cls.push('is-edge');
        if (state.from != null && state.to != null && ms > startOfDay(state.from) && ms < endOfDay(state.to)) cls.push('is-inrange');
        const b = ui.el('button', { class: cls.join(' '), type: 'button', 'aria-label': formatTyped(ms) }, String(d));
        b.addEventListener('click', () => {
          // First pick sets the START; the second pick completes the range
          // (an earlier second pick becomes the start instead — a range is
          // never dropped); the next pick after a complete range starts fresh.
          const pick = startOfDay(ms);
          if (state.from == null || (state.from != null && state.to != null)) {
            state.from = pick;
            state.to = null;
            setMsg(tr('hist.pickEnd', 'Now pick the end date.', '而家揀結束日期。'));
          } else {
            const a = startOfDay(state.from);
            if (pick < a) {
              state.from = pick;
              state.to = endOfDay(a);
            } else {
              state.to = endOfDay(pick); // same-day pick yields a 1-day range
            }
            setMsg('');
            closeCal();
          }
          syncInputs();
          paintCal();
          emit();
        });
        grid.appendChild(b);
      }
    }
    prevB.addEventListener('click', () => {
      state.viewM -= 1;
      if (state.viewM < 0) { state.viewM = 11; state.viewY -= 1; }
      paintCal();
    });
    nextB.addEventListener('click', () => {
      state.viewM += 1;
      if (state.viewM > 11) { state.viewM = 0; state.viewY += 1; }
      paintCal();
    });
    monthSel.addEventListener('change', () => { state.viewM = Number(monthSel.value); paintCal(); });
    yearSel.addEventListener('change', () => { state.viewY = Number(yearSel.value); paintCal(); });

    paintCal();
    cal.appendChild(headRow);
    cal.appendChild(grid);
    let closeCalFn = null;
    function closeCal() { if (closeCalFn) closeCalFn(); }
    // ui.anchored paints its own surface, viewport-bounds, scrolls internally
    // and never covers its anchor.
    closeCalFn = ui.anchored(anchor, cal, {}) || null;
  }

  root.append(presets, ui.el('div', { class: 'mrb-cx-dr-inputs' }, fromInput, ui.el('span', { class: 'mrb-cx-dr-sep' }, '–'), toInput, calBtn), msg);
  return { root, syncInputs, setMsg };
}

/* ── Panel ──────────────────────────────────────────────────────────────── */

const PAGE_SIZE = 100;

function toneIcon(kind) {
  if (kind === 'deleted') return '−';
  if (kind === 'created') return '+';
  if (kind === 'restored') return '⟲';
  if (kind === 'undone') return '⤺';
  return '·';
}

function renderPanel(root) {
  const filters = {
    from: null,
    to: null,
    actions: new Set(),
    text: { q: '', mode: 'plain', flags: '', valid: true },
  };
  let offset = 0;
  let total = 0;
  let kindsSeen = {};
  let loading = false;

  root.textContent = '';
  root.className = 'mrb-cx-history';

  const head = ui.el('header', { class: 'mrb-cx-hist-head' },
    ui.el('h2', {}, tr('hist.title', 'History', '歷史紀錄')));
  const refreshBtn = ui.el('button', { class: 'mrb-btn mrb-btn--outlined', type: 'button' }, tr('hist.refresh', 'Refresh', '重新整理'));
  const expJson = ui.el('button', { class: 'mrb-btn mrb-btn--text', type: 'button' }, tr('hist.expJson', 'Export JSON', '匯出 JSON'));
  const expMd = ui.el('button', { class: 'mrb-btn mrb-btn--text', type: 'button' }, tr('hist.expMd', 'Export Markdown', '匯出 Markdown'));
  head.append(ui.el('div', { class: 'mrb-cx-hist-headbtns' }, refreshBtn, expJson, expMd));

  /* Filters */
  const searchWrap = ui.el('div', { class: 'mrb-cx-hist-search' });
  const kindChips = ui.el('div', { class: 'mrb-cx-kindchips', role: 'group', 'aria-label': tr('hist.actions', 'Filter by action', '按操作篩選') });
  const dr = buildDateRange({}, (r) => { filters.from = r.from; filters.to = r.to; offset = 0; load(); });

  const filterCard = ui.el('section', { class: 'mrb-card mrb-cx-hist-filters', 'aria-label': tr('hist.filters', 'Filters', '篩選') });
  filterCard.append(dr.root, searchWrap, kindChips);

  /* Results */
  const tableWrap = ui.el('div', { class: 'mrb-cx-hist-results' });
  const statusLine = ui.el('p', { class: 'mrb-cx-hist-status', 'aria-live': 'polite' });
  const pager = ui.el('div', { class: 'mrb-cx-hist-pager' });
  const prevBtn = ui.el('button', { class: 'mrb-btn mrb-btn--text', type: 'button' }, tr('hist.prev', '‹ Newer', '‹ 較新'));
  const nextBtn = ui.el('button', { class: 'mrb-btn mrb-btn--text', type: 'button' }, tr('hist.next', 'Older ›', '較舊 ›'));
  pager.append(prevBtn, nextBtn);
  prevBtn.addEventListener('click', () => { offset = Math.max(0, offset - PAGE_SIZE); load(); });
  nextBtn.addEventListener('click', () => { if (offset + PAGE_SIZE < total) { offset += PAGE_SIZE; load(); } });

  /* Prune card */
  const savedPrune = store.get('historyPrune', {});
  const keepDaysIn = ui.el('input', { type: 'number', min: '0', step: '1', class: 'mrb-field mrb-cx-prune-in', 'aria-label': tr('hist.keepDays', 'Keep days', '保留日數') });
  keepDaysIn.value = String(Number.isFinite(savedPrune.keepDays) ? savedPrune.keepDays : 90);
  const keepCountIn = ui.el('input', { type: 'number', min: '0', step: '1', class: 'mrb-field mrb-cx-prune-in', 'aria-label': tr('hist.keepCount', 'Keep newest events', '保留最新事件數') });
  keepCountIn.value = String(Number.isFinite(savedPrune.keepCount) ? savedPrune.keepCount : 500);
  const dryBtn = ui.el('button', { class: 'mrb-btn mrb-btn--outlined', type: 'button' }, tr('hist.dryRun', 'Dry run', '預演'));
  const applyBtn = ui.el('button', { class: 'mrb-btn mrb-btn--danger', type: 'button' }, tr('hist.applyPrune', 'Apply prune…', '執行封存…'));
  const pruneMsg = ui.el('p', { class: 'mrb-cx-prune-msg', 'aria-live': 'polite' });
  const pruneCard = ui.el('details', { class: 'mrb-card mrb-cx-prune' });
  pruneCard.appendChild(ui.el('summary', {}, tr('hist.pruneTitle', 'Retention & pruning', '保留與封存')));
  pruneCard.appendChild(ui.el('div', { class: 'mrb-cx-prune-body' },
    ui.el('p', { class: 'mrb-cx-note' }, tr('hist.pruneNote',
      'Pruning HIDES older events (tombstones); the underlying history stays append-only and is never rewritten.',
      '封存只會「收埋」較舊事件；底層歷史永遠只加不改。')),
    ui.el('div', { class: 'mrb-cx-prune-row' },
      ui.el('label', {}, tr('hist.keepDays', 'Keep days', '保留日數'), keepDaysIn),
      ui.el('label', {}, tr('hist.keepCount', 'Keep newest events', '保留最新事件數'), keepCountIn)),
    ui.el('div', { class: 'mrb-cx-prune-row' }, dryBtn, applyBtn),
    pruneMsg));

  root.append(head, filterCard, tableWrap, statusLine, pager, pruneCard);

  refreshBtn.addEventListener('click', () => { offset = 0; load(); });

  expJson.addEventListener('click', () => doExport('json'));
  expMd.addEventListener('click', () => doExport('md'));

  async function doExport(format) {
    try {
      const res = await exportRedacted({
        format,
        from: filters.from, to: filters.to,
        actions: [...filters.actions],
        text: filters.text.q, textMode: filters.text.mode, textFlags: filters.text.flags,
      });
      if (res && res.ok === false && !res.cancelled) {
        ui.toast({ title: tr('hist.expFail', 'Export failed', '匯出失敗'), body: res.error || '', tone: 'error', sticky: true });
      }
    } catch (err) {
      ui.toast({ title: tr('hist.expFail', 'Export failed', '匯出失敗'), body: String((err && err.message) || err), tone: 'error', sticky: true });
    }
  }

  import('./regexbuilder.js').then((rb) => {
    if (!rb || typeof rb.attachSearchableFactory !== 'function') return;
    const s = rb.attachSearchableFactory({
      label: tr('hist.searchLabel', 'Search history', '搜尋歷史'),
      placeholder: tr('hist.searchPh', 'Label, kind or file path', '標籤、種類或檔案路徑'),
      onQuery: (q, meta) => { filters.text = { q, ...meta }; offset = 0; load(); },
    });
    searchWrap.appendChild(s.root);
  }).catch(() => { /* search degrades to none; list still works */ });

  function buildKindChips() {
    kindChips.textContent = '';
    const entries = Object.entries(kindsSeen).sort((a, b) => b[1] - a[1]);
    if (!entries.length) {
      kindChips.appendChild(ui.el('span', { class: 'mrb-cx-note' }, tr('hist.noKinds', 'Actions appear here as they are recorded.', '有紀錄之後，操作類別會喺呢度出現。')));
      return;
    }
    for (const [kind, count] of entries) {
      const b = ui.el('button', {
        class: `mrb-chip mrb-rb-chip${filters.actions.has(kind) ? ' is-on' : ''}`,
        type: 'button', 'aria-pressed': filters.actions.has(kind) ? 'true' : 'false',
      }, `${toneIcon(kind)} ${kind} (${count})`);
      b.addEventListener('click', () => {
        if (filters.actions.has(kind)) filters.actions.delete(kind);
        else filters.actions.add(kind);
        offset = 0;
        buildKindChips();
        load();
      });
      kindChips.appendChild(b);
    }
  }

  function diffLineEl(line) {
    const div = ui.el('div', { class: `mrb-cx-diffline is-${line.t === '+' ? 'add' : line.t === '-' ? 'del' : 'ctx'}` });
    div.textContent = `${line.t} ${line.s}`;
    return div;
  }

  function buildRow(ev) {
    const frag = document.createDocumentFragment();
    const tr1 = ui.el('div', { class: 'mrb-cx-hist-row' });
    const when = new Date(ev.ts);
    const mainKids = [
      ui.el('span', { class: `mrb-cx-hist-kind is-${ev.kind}` , title: ev.kind }, `${toneIcon(ev.kind)} ${ev.kind}`),
      ui.el('span', { class: 'mrb-cx-hist-label' }, ev.label),
    ];
    tr1.appendChild(ui.el('span', { class: 'mrb-cx-hist-when', title: when.toISOString() },
      when.toLocaleString()));
    tr1.appendChild(ui.el('span', { class: 'mrb-cx-hist-main' }, ...mainKids));
    tr1.appendChild(ui.el('span', { class: 'mrb-cx-hist-files' },
      tr('hist.filesN', `${ev.files.length} file(s)`, `${ev.files.length} 個檔案`)));

    const acts = ui.el('span', { class: 'mrb-cx-hist-actions' });
    const restoreB = ui.el('button', { class: 'mrb-btn mrb-btn--text', type: 'button' }, tr('hist.restore', 'Restore…', '還原…'));
    restoreB.addEventListener('click', () => confirmRestore(ev));
    const labelB = ui.el('button', { class: 'mrb-btn mrb-btn--text', type: 'button', 'aria-label': tr('hist.relabel', 'Relabel this event', '改這項的標籤') }, '✎');
    labelB.addEventListener('click', () => editLabelInline(tr1, ev));
    acts.append(labelB, restoreB);
    tr1.appendChild(acts);
    frag.appendChild(tr1);

    const det = ui.el('details', { class: 'mrb-cx-hist-diffbox' });
    const sum = ui.el('summary', {}, tr('hist.showDiff', 'Diff vs previous event', '與上一事件嘅差異'));
    const body = ui.el('div', { class: 'mrb-cx-diff monospace' });
    body.textContent = tr('hist.diffLoading', 'Loading…', '載入中…');
    det.append(sum, body);
    let loaded = false;
    det.addEventListener('toggle', async () => {
      if (!det.open || loaded) return;
      loaded = true;
      try {
        const res = await diff(ev.id);
        if (!res || res.ok === false) throw new Error((res && res.error) || 'diff failed');
        body.textContent = '';
        if (!res.a) {
          body.appendChild(ui.el('p', { class: 'mrb-cx-note' }, tr('hist.firstEvent', 'First event touching these files — nothing earlier to diff against.', '呢批檔案嘅第一個事件——冇更早版本可比較。')));
        }
        if (!res.diffs.length) {
          body.appendChild(ui.el('p', { class: 'mrb-cx-note' }, tr('hist.noChanges', 'No textual changes against the comparison event.', '同比較事件冇文字差異。')));
        }
        for (const d of res.diffs) {
          body.appendChild(ui.el('p', { class: 'mrb-cx-difffile' }, d.path));
          const cap = 400;
          d.lines.slice(0, cap).forEach((line) => body.appendChild(diffLineEl(line)));
          if (d.lines.length > cap) {
            body.appendChild(ui.el('p', { class: 'mrb-cx-note' },
              tr('hist.diffCap', `… ${d.lines.length - cap} more diff lines hidden.`, `…另外 ${d.lines.length - cap} 行差異已收起。`)));
          }
        }
      } catch (err) {
        loaded = false; // allow retrying a transient failure by re-opening
        body.textContent = voiceError(String((err && err.message) || err));
      }
    });
    frag.appendChild(det);
    return frag;

    function voiceError(text) {
      try { const v = i18n.voice('error', text); if (v) return v; } catch { /* exact */ }
      return text;
    }
  }

  function confirmRestore(ev) {
    ui.superConfirm({
      title: tr('hist.restoreTitle', 'Restore this snapshot?', '還原這個快照？'),
      detailHtml:
        `<p>${ui.escapeHtml(tr('hist.restoreDetail',
          `This rewrites ${ev.files.length} file(s) to their state at “${ev.label}” and records a NEW restored event. Nothing is deleted from history.`,
          `會將 ${ev.files.length} 個檔案寫返「${ev.label}」嗰陣嘅狀態，並新增一筆 restored 紀錄。歷史唔會刪走任何嘢。`))}</p>` +
        `<ul class="mrb-cx-previewlist">${ev.files.map((f) => `<li>${ui.escapeHtml(f.path)}</li>`).join('')}</ul>`,
      confirmLabel: tr('hist.restore', 'Restore', '還原'),
      onConfirm: async () => {
        try {
          const res = await restore(ev.id);
          if (!res || res.ok === false) throw new Error((res && res.error) || 'restore failed');
          ui.toast({
            title: tr('hist.restored', 'Restored', '已還原'),
            body: tr('hist.restoredBody', `${res.files.length} file(s) written back; a restored event was recorded.`, `已寫回 ${res.files.length} 個檔案，並記錄一筆 restored 紀錄。`),
            tone: 'ok', timeoutMs: 6000,
          });
          load();
        } catch (err) {
          ui.toast({ title: tr('hist.restoreFail', 'Restore failed', '還原失敗'), body: String((err && err.message) || err), tone: 'error', sticky: true });
        }
      },
    });
  }

  function editLabelInline(rowEl, ev) {
    const holder = rowEl.querySelector('.mrb-cx-hist-main');
    if (!holder || holder.querySelector('input')) return;
    const original = ev.label;
    const input = ui.el('input', { type: 'text', class: 'mrb-field mrb-cx-relabel', 'aria-label': tr('hist.newLabel', 'New label', '新標籤') });
    input.value = original;
    const saveB = ui.el('button', { class: 'mrb-btn mrb-btn--tonal', type: 'button' }, tr('common.save', 'Save', '儲存'));
    const cancelB = ui.el('button', { class: 'mrb-btn mrb-btn--text', type: 'button' }, tr('common.cancel', 'Cancel', '取消'));
    const wrap = ui.el('span', { class: 'mrb-cx-relabelwrap' }, input, saveB, cancelB);
    holder.textContent = '';
    holder.appendChild(wrap);
    input.focus();
    input.select();

    const finish = () => load();
    cancelB.addEventListener('click', finish);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(); }
      if (e.key === 'Enter') { e.preventDefault(); saveB.click(); }
    });
    saveB.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text || text === original) { finish(); return; }
      try {
        const res = await label(ev.id, text);
        if (!res || res.ok === false) throw new Error((res && res.error) || 'label failed');
        finish();
      } catch (err) {
        ui.toast({ title: tr('hist.labelFail', 'Could not relabel', '改標籤失敗'), body: String((err && err.message) || err), tone: 'error', sticky: true });
      }
    });
  }

  async function load() {
    if (loading) return;
    loading = true;
    statusLine.textContent = tr('hist.loading', 'Loading history…', '載入歷史中…');
    try {
      const res = await query({
        from: filters.from, to: filters.to,
        actions: [...filters.actions],
        text: filters.text.q, textMode: filters.text.mode, textFlags: filters.text.flags,
        limit: PAGE_SIZE, offset,
      });
      if (!res || res.ok === false) throw new Error((res && res.error) || 'query failed');
      total = res.total;
      kindsSeen = res.kinds || {};
      buildKindChips();

      tableWrap.textContent = '';
      if (!res.events.length) {
        const anyAtAll = total === 0 && offset === 0 && !filters.text.q && !filters.actions.size && filters.from == null && filters.to == null;
        tableWrap.appendChild(ui.el('p', { class: 'mrb-cx-empty' },
          anyAtAll
            ? tr('hist.emptyAll', 'Nothing recorded yet. Changes you make around the app will appear here.', '仲未有紀錄。你喺程式入面嘅變更之後會喺呢度出現。')
            : tr('hist.emptyFiltered', 'No events match the current filters.', '冇事件符合目前篩選條件。')));
      }
      for (const ev of res.events) tableWrap.appendChild(buildRow(ev));

      const from = offset + 1;
      const to = offset + res.events.length;
      statusLine.textContent = total > 0
        ? tr('hist.range', `Showing ${from}–${to} of ${total}`, `顯示 ${total} 項之中嘅第 ${from}–${to} 項`)
        : tr('hist.none', 'No events', '沒有事件');
      prevBtn.disabled = offset <= 0;
      nextBtn.disabled = offset + PAGE_SIZE >= total;
    } catch (err) {
      const message = String((err && err.message) || err);
      tableWrap.textContent = '';
      tableWrap.appendChild(ui.el('p', { class: 'mrb-cx-empty is-bad' },
        tr('hist.unavailable', message.includes('bridge')
          ? message
          : `History is unavailable right now: ${message}`,
          message.includes('橋接') ? message : `暫時讀取唔到歷史：${message}`)));
      statusLine.textContent = '';
    } finally {
      loading = false;
    }
  }

  dryBtn.addEventListener('click', async () => {
    try {
      const res = await prune({
        keepDays: Number(keepDaysIn.value) || 0,
        keepCount: Number(keepCountIn.value) || 0,
        dryRun: true,
      });
      if (!res || res.ok === false) throw new Error((res && res.error) || 'dry run failed');
      pruneMsg.textContent = tr('hist.dryResult',
        `Would hide ${res.wouldHide} of ${res.total} events. Nothing has changed.`,
        `將會收起 ${res.total} 項之中嘅 ${res.wouldHide} 項。而家咩都冇變。`);
    } catch (err) {
      pruneMsg.textContent = String((err && err.message) || err);
    }
  });

  applyBtn.addEventListener('click', () => {
    const keepDays = Number(keepDaysIn.value) || 0;
    const keepCount = Number(keepCountIn.value) || 0;
    store.set('historyPrune', { keepDays, keepCount });
    ui.superConfirm({
      title: tr('hist.pruneConfirmTitle', 'Prune old history?', '封存舊歷史？'),
      detailHtml: `<p>${ui.escapeHtml(tr('hist.pruneConfirm',
        `Events older than ${keepDays} days beyond the newest ${keepCount} will be HIDDEN. History stays append-only; hidden events are excluded from queries and restores but nothing is deleted from disk.`,
        `超過 ${keepDays} 日、而且唔喺最新 ${keepCount} 項之內嘅事件會被「收埋」。歷史仍然只加不改；被收起嘅事件唔會再出現，但磁碟上乜都唔會剷走。`))}</p>`,
      confirmLabel: tr('hist.applyPrune', 'Apply prune', '執行封存'),
      onConfirm: async () => {
        try {
          const res = await prune({ keepDays, keepCount, compact: true });
          if (!res || res.ok === false) throw new Error((res && res.error) || 'prune failed');
          const gcBit = res.gc && res.gc.ran
            ? tr('hist.gcDone', ` Compaction reclaimed ${(res.gc.reclaimedBytes / 1048576).toFixed(1)} MiB.`, `壓縮騰出 ${(res.gc.reclaimedBytes / 1048576).toFixed(1)} MiB。`)
            : (res.gc && res.gc.note ? ` ${res.gc.note}` : '');
          pruneMsg.textContent = tr('hist.pruneResult', `Hidden ${res.hidden} of ${res.total}.`, `已收起 ${res.total} 項之中嘅 ${res.hidden} 項。`) + gcBit;
          load();
        } catch (err) {
          pruneMsg.textContent = String((err && err.message) || err);
        }
      },
    });
  });

  load();
}

/* ── Tab registration & show() ──────────────────────────────────────────── */

let tabRegistered = false;

async function registerTabIfPossible() {
  if (tabRegistered) return;
  const mod = await import('./router.js').catch(() => null);
  if (!mod || !mod.router || typeof mod.router.registerTab !== 'function') return;
  tabRegistered = true;
  mod.router.registerTab({
    id: 'history',
    title: tr('hist.tab', 'History', '歷史'),
    closable: false,
    render(el) { renderPanel(el); },
  });
}

/** Open the History surface (router tab when available, modal otherwise). */
export async function show() {
  const mod = await import('./router.js').catch(() => null);
  if (mod && mod.router && typeof mod.router.navigate === 'function') {
    try {
      mod.router.navigate('history');
      return;
    } catch { /* fall through to the modal */ }
  }
  ui.modal({
    title: tr('hist.title', 'History', '歷史紀錄'),
    build(bodyEl) { renderPanel(bodyEl); },
    actions: [],
  });
}

/** Namespaced facade per CONTRACT §6 (`history.record(...)`). */
export const history = {
  record, query, getEvent, diff, restore, label, prune, exportRedacted, show,
};

export async function init() {
  try {
    ui.injectCss(new URL('../../styles/features/coreux.css', import.meta.url).href);
  } catch (err) {
    console.warn('[mrb/history] stylesheet injection failed:', err && err.message);
  }
  await registerTabIfPossible();
}
