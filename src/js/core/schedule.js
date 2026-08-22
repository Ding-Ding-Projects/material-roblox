/**
 * schedule.js — scheduled settings (Lane E).
 *
 * Time-windowed overrides for any writable setting: language mode, theme,
 * density, fonts and friends flip themselves on a schedule and return to base
 * afterwards. This pass ships LOCAL value sources only; validated remote APIs
 * and Home-Assistant boolean entities are documented roadmap items in the
 * source contract below (ROADMAP carries the same note).
 *
 * Schema (versioned):
 *   { v:1, rules:[{ id, label, enabled:true, value:{path,value},
 *                   timeStart:'HH:MM', timeEnd:'HH:MM',
 *                   days:'every'|[0..6], dateStart?:'YYYY-MM-DD', dateEnd? }]}
 *
 * Semantics (documented here AND in the editor UI):
 *  - Times are the user's configured LOCAL timezone; the zone name is shown in
 *    the editor. DST shifts move wall-clock windows with the clock (windows are
 *    wall-clock expressions, so a 22:00–06:00 window stays 22:00–06:00 across a
 *    DST boundary even though its length changes by an hour that night).
 *  - start > end spans midnight (e.g. 22:00→06:00 wraps correctly).
 *  - start === end is a ZERO-LENGTH window and never activates — documented,
 *    not a bug, and stated in the editor beside the inputs.
 *  - "Every day" is one flag meaning all days within the time window; it is
 *    never stored as seven duplicated weekday entries.
 *  - Precedence: deterministic — rules sort stably by creation time and the
 *    LATEST-created matching enabled rule wins per setting path. When no rule
 *    matches, base settings stand again.
 */

import { store } from './store.js';
import { ui } from './ui.js';
import { i18n } from './i18n.js';
import { ensureToolsStyles } from './colorpicker.js';

/* ------------------------------------------------------------------ */
/* Peers                                                               */
/* ------------------------------------------------------------------ */

const peerCache = new Map();
function peer(name) {
  if (!peerCache.has(name)) peerCache.set(name, import(name).then((m) => m).catch(() => null));
  return peerCache.get(name);
}

let P = { settings: null, router: null, palette: null };

function tt(en, yue) {
  try {
    if (i18n.schoolActive()) return en;
    const mode = i18n.lang();
    if (mode === 'yue' && yue) return yue;
    if (mode === 'bi' && yue) return `${en} · ${yue}`;
  } catch (_) { /* English always correct */ }
  return en;
}

function recordChange(label, snapshot) {
  peer('./history.js').then((m) => {
    if (m && m.history && typeof m.history.record === 'function') {
      m.history.record({ kind: 'settings', label, snapshot });
    }
  }).catch(() => { /* history is evidence, never a gate */ });
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

const RULES_KEY = 'scheduleRules';

/** @returns {{v:number, rules:Array}} */
export function loadSchema() {
  const raw = store.get(RULES_KEY, null);
  if (!raw || raw.v !== 1 || !Array.isArray(raw.rules)) return { v: 1, rules: [] };
  /* migration hook: bump v here and transform old shapes when v becomes 2 */
  return raw;
}

function saveSchema(schema, label) {
  schema.v = 1;
  store.set(RULES_KEY, schema);
  recordChange(label || 'Schedule changed', { ruleCount: schema.rules.length });
}

export function listRules() {
  return loadSchema().rules;
}

const uid = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

const hhmmToMinutes = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
};

/**
 * Does `rule` match at `now`?
 * Equal start/end is zero-length and inactive; start>end wraps midnight.
 */
export function ruleMatches(rule, now = new Date()) {
  if (!rule || !rule.enabled || !rule.value || !rule.value.path) return false;
  const ts = hhmmToMinutes(rule.timeStart);
  const te = hhmmToMinutes(rule.timeEnd);
  if (ts == null || te == null) return false;

  if (rule.dateStart || rule.dateEnd) {
    const ymd = localYmd(now);
    if (rule.dateStart && ymd < rule.dateStart) return false;
    if (rule.dateEnd && ymd > rule.dateEnd) return false;
  }

  if (rule.days !== 'every') {
    if (!Array.isArray(rule.days) || !rule.days.includes(now.getDay())) return false;
  }

  const cur = now.getHours() * 60 + now.getMinutes();
  if (ts === te) return false;          // zero-length window, inactive by design
  if (ts < te) return cur >= ts && cur < te;
  return cur >= ts || cur < te;         // cross-midnight wrap
}

function localYmd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Deterministic precedence: latest createdAt wins per path. */
export function activeOverrides(now = new Date()) {
  const rules = [...listRules()].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  /** @type {Map<string, any>} */
  const out = new Map();
  for (const r of rules) {
    if (!ruleMatches(r, now)) continue;
    out.set(r.value.path, r.value.value); // later (newer) matching rule overwrites
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Override application                                                */
/* ------------------------------------------------------------------ */

/**
 * The override layer. When the settings module exposes setOverride/releaseOverride
 * (documented extension point it owns) we drive that; otherwise this module keeps
 * its own shadow layer. The shadow captures the PRE-WINDOW value before writing
 * and restores exactly that on release — so a schedule never degrades a user's
 * chosen base setting to the factory default, and a user edit made DURING the
 * window is preserved (we only ever put back what we displaced).
 */
let shadowApplied = new Map(); // path -> { value, prev }
let usingNativeLayer = false;

function nativeAvailable() {
  const s = P.settings;
  return !!(s && typeof s.setOverride === 'function');
}

function applyValue(path, value) {
  if (usingNativeLayer) {
    P.settings.setOverride(path, value, 'schedule');
  } else {
    if (!shadowApplied.has(path)) {
      shadowApplied.set(path, { value, prev: currentBase(path) });
    }
    const s = P.settings;
    if (s && typeof s.set === 'function') s.set(path, value);
    else store.set(path, value);
  }
}

function releaseAll() {
  if (usingNativeLayer) {
    if (typeof P.settings.releaseOverride === 'function') P.settings.releaseOverride('schedule');
    else if (typeof P.settings.clearOverride === 'function') P.settings.clearOverride('schedule');
    return;
  }
  const entries = [...shadowApplied.entries()];
  shadowApplied = new Map();
  for (const [path, rec] of entries.reverse()) {
    try {
      if (rec.prev === undefined) {
        /* there was no base value: remove our write entirely */
        if (P.settings && typeof P.settings.reset === 'function') P.settings.reset(path);
        else store.remove(path);
      } else if (P.settings && typeof P.settings.set === 'function') {
        P.settings.set(path, rec.prev);
      } else {
        store.set(path, rec.prev);
      }
    } catch (_) { /* leave the last known-good value in place */ }
  }
}

let lastMinuteKey = '';

function evaluate() {
  try {
    const now = new Date();
    const key = `${now.getHours()}:${now.getMinutes()}`;
    if (key === lastMinuteKey) return;
    lastMinuteKey = key;

    usingNativeLayer = nativeAvailable();

    const wanted = activeOverrides(now);
    const wantedPaths = new Set(wanted.keys());
    let dirty = false;

    for (const path of [...shadowApplied.keys()]) {
      if (!wantedPaths.has(path)) {
        shadowApplied.delete(path);
        dirty = true;
      }
    }
    if (dirty) releaseAll();

    for (const [path, value] of wanted.entries()) {
      const cur = currentBase(path);
      if (JSON.stringify(cur) !== JSON.stringify(value) || !shadowApplied.has(path)) {
        applyValue(path, value);
      }
    }
    updateNextPreview();
  } catch (err) {
    console.warn('[schedule] evaluation failed', err);
  }
}

function currentBase(path) {
  if (P.settings && typeof P.settings.get === 'function') return P.settings.get(path, undefined);
  const v = store.get(path, undefined);
  return v === undefined ? undefined : v;
}

/* ------------------------------------------------------------------ */
/* Next-change preview                                                 */
/* ------------------------------------------------------------------ */

let nextPreviewNode = null;

function updateNextPreview() {
  if (!nextPreviewNode) return;
  const next = nextChange(new Date());
  if (!next) {
    nextPreviewNode.textContent = tt('No upcoming change.', '暫時冇即將到嚟嘅變更。');
    return;
  }
  const when = next.at.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  nextPreviewNode.textContent = tt('Next:', '下一個：') + ` ${when} → ${next.path} = ${fmtValue(next.value)} (${next.rule.label || next.rule.id})`;
}

function fmtValue(v) {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * Soonest future moment any enabled rule starts OR stops applying.
 * Walks minute-by-minute up to 8 days ahead (bounded, cheap: pure arithmetic).
 */
export function nextChange(from = new Date()) {
  const rules = listRules().filter((r) => r.enabled);
  if (!rules.length) return null;
  let best = null;
  const probe = new Date(from.getTime());
  probe.setSeconds(0, 0);
  const wasActive = new Map(rules.map((r) => [r.id, ruleMatches(r, probe)]));
  for (let i = 0; i < 60 * 24 * 8; i++) {
    probe.setMinutes(probe.getMinutes() + 1);
    for (const r of rules) {
      const nowActive = ruleMatches(r, probe);
      if (nowActive !== wasActive.get(r.id)) {
        if (!best || probe < best.at) {
          best = { at: new Date(probe.getTime()), rule: r, path: r.value.path, value: r.value.value, starting: nowActive };
        }
        wasActive.set(r.id, nowActive);
      }
    }
    if (best) break; // earliest boundary found at this resolution
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const WRITABLE_TYPES = new Set(['toggle', 'select', 'slider', 'text', 'color', 'font', 'path', 'hotkey']);

function writableDefs() {
  if (!P.settings || typeof P.settings.defs !== 'function') return [];
  try {
    return P.settings.defs().filter((d) => WRITABLE_TYPES.has(d.type));
  } catch (_) {
    return [];
  }
}

function openRuleEditor(existing) {
  const isNew = !existing;
  const rule = existing || {
    id: uid(), label: '', enabled: true,
    value: { path: '', value: '' },
    timeStart: '08:00', timeEnd: '18:00',
    days: 'every', createdAt: new Date().toISOString(),
  };

  const errLine = ui.el('p', { class: 'mrb-schedule-error', role: 'alert' });
  const labelIn = ui.el('input', {
    class: 'mrb-field-input', type: 'text', maxlength: '60',
    placeholder: tt('e.g. Work hours — dark theme', '例如：返工時間—深色主題'),
    value: rule.label, 'aria-label': tt('Rule label', '規則名稱'),
  });

  const defs = writableDefs();
  const targetSel = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Target setting', '目標設定') });
  targetSel.append(ui.el('option', { value: '', text: tt('Choose a setting…', '揀一個設定…') }));
  for (const d of defs) {
    targetSel.append(ui.el('option', { value: d.key, text: `${groupOf(d)} › ${labelOf(d)}` }));
  }
  targetSel.value = rule.value.path || '';
  if (targetSel.value && !defs.some((d) => d.key === targetSel.value)) {
    targetSel.append(ui.el('option', { value: targetSel.value, text: targetSel.value }));
  }

  /* rich value control rebuilt when the target changes */
  let valueHost = ui.el('div', { class: 'mrb-schedule-valuehost' });
  let currentValue = rule.value.value;
  function rebuildValueControl() {
    valueHost.textContent = '';
    const def = defs.find((d) => d.key === targetSel.value);
    currentValue = rule.value.path === targetSel.value ? rule.value.value : (def ? def.def : '');
    if (!def) {
      valueHost.append(ui.el('span', { class: 'mrb-cpk-empty', text: tt('Pick a target setting first.', '先揀目標設定。') }));
      return;
    }
    switch (def.type) {
      case 'toggle': {
        const cb = ui.el('input', { type: 'checkbox', class: 'mrb-switch-input' });
        cb.checked = !!currentValue;
        cb.addEventListener('change', () => { currentValue = cb.checked; });
        valueHost.append(ui.el('label', { class: 'mrb-field-check' }, cb, ui.el('span', { text: tt('On while scheduled', '排程期間開啟') })));
        break;
      }
      case 'select': {
        const sel = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Scheduled value', '排程數值') });
        for (const o of def.options || []) {
          sel.append(ui.el('option', { value: o.value, text: `${o.label.en}${o.label.yue ? ' · ' + o.label.yue : ''}` }));
        }
        sel.value = String(currentValue ?? (def.options && def.options[0] && def.options[0].value) ?? '');
        sel.addEventListener('change', () => { currentValue = coerceLike(def, sel.value); });
        valueHost.append(sel);
        break;
      }
      case 'slider': {
        const rng = ui.el('input', {
          type: 'range', class: 'mrb-slider', min: String(def.min ?? 0), max: String(def.max ?? 100),
          step: String(def.step ?? 1), value: String(Number(currentValue ?? def.def ?? 0)),
          'aria-label': tt('Scheduled value', '排程數值'),
        });
        const out = ui.el('output', { text: rng.value });
        rng.addEventListener('input', () => { out.textContent = rng.value; });
        rng.addEventListener('change', () => { currentValue = Number(rng.value); });
        valueHost.append(rng, out);
        break;
      }
      case 'color': {
        import('./colorpicker.js').then(({ mountColorPicker, RAINBOW }) => {
          valueHost.textContent = '';
          mountColorPicker(valueHost, {
            value: typeof currentValue === 'string' && currentValue ? currentValue : (def.def || '#B3261E'),
            allowSentinel: true,
            onChange: (v) => { currentValue = v === RAINBOW ? RAINBOW : v; },
          });
        });
        break;
      }
      default: {
        const inp = ui.el('input', {
          class: 'mrb-field-input', type: 'text', value: String(currentValue ?? ''),
          'aria-label': tt('Scheduled value', '排程數值'),
        });
        inp.addEventListener('change', () => { currentValue = inp.value; });
        valueHost.append(inp);
      }
    }
  }
  function coerceLike(def, raw) {
    const match = (def.options || []).find((o) => String(o.value) === raw);
    return match ? match.value : raw;
  }
  targetSel.addEventListener('change', () => { rule.value.path = targetSel.value; rebuildValueControl(); });

  const tsIn = ui.el('input', { type: 'time', class: 'mrb-field-input', value: rule.timeStart, 'aria-label': tt('Start time', '開始時間') });
  const teIn = ui.el('input', { type: 'time', class: 'mrb-field-input', value: rule.timeEnd, 'aria-label': tt('End time', '結束時間') });

  /* weekday chips: 'every' is ONE flag, not seven duplicated rules */
  let days = rule.days === 'every' ? 'every' : [...(rule.days || [])];
  const dayRow = ui.el('div', { class: 'mrb-schedule-days', role: 'group', 'aria-label': tt('Days', '星期') });
  const everyChip = ui.el('button', {
    class: 'mrb-chip mrb-schedule-daychip', type: 'button',
    'aria-pressed': String(days === 'every'), text: tt('Every day', '每日'),
  });
  const dayChips = [];
  for (let d = 0; d < 7; d++) {
    const b = ui.el('button', {
      class: 'mrb-chip mrb-schedule-daychip', type: 'button',
      'aria-pressed': String(days !== 'every' && days.includes(d)),
      text: DAY_LABELS[d],
    });
    b.addEventListener('click', () => {
      if (days === 'every') days = [0, 1, 2, 3, 4, 5, 6];
      const i = days.indexOf(d);
      if (i >= 0) days.splice(i, 1); else days.push(d);
      if (days.length === 7) days = 'every';
      syncChips();
    });
    dayChips.push([d, b]);
    dayRow.append(b);
  }
  everyChip.addEventListener('click', () => { days = 'every'; syncChips(); });
  function syncChips() {
    everyChip.setAttribute('aria-pressed', String(days === 'every'));
    for (const [d, b] of dayChips) {
      b.setAttribute('aria-pressed', String(days !== 'every' && days.includes(d)));
    }
  }
  dayRow.prepend(everyChip);
  dayRow.append(ui.el('span', {
    class: 'mrb-explain',
    text: tt('"Every day" means all days within the time window — one flag, never seven duplicated rules.', '「每日」代表時間窗內所有日子 — 一個旗標，唔係七條重複規則。'),
  }));

  const dsIn = ui.el('input', { type: 'date', class: 'mrb-field-input', value: rule.dateStart || '', 'aria-label': tt('First date (optional)', '開始日期（可選）') });
  const deIn = ui.el('input', { type: 'date', class: 'mrb-field-input', value: rule.dateEnd || '', 'aria-label': tt('Last date (optional)', '完結日期（可選）') });

  let tzName = 'local timezone';
  let dstNote = '';
  try {
    tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || tzName;
    dstNote = tt(
      'Windows are wall-clock times, so they follow daylight-saving shifts automatically.',
      '時間以牆上鐘計算，會自動跟夏令時間偏移。',
    );
  } catch (_) { /* extremely old engines: plain local time stands */ }

  const body = ui.el('div', { class: 'mrb-schedule-editor' },
    ui.el('label', { class: 'mrb-field' }, ui.el('span', { text: tt('Label', '名稱') }), labelIn),
    ui.el('label', { class: 'mrb-field' }, ui.el('span', { text: tt('Setting', '設定') }), targetSel),
    ui.el('div', { class: 'mrb-field' }, ui.el('span', { text: tt('Value while active', '生效時數值') }), valueHost),
    ui.el('div', { class: 'mrb-field mrb-schedule-times' },
      ui.el('span', { text: tt('Window', '時間窗') }), tsIn, ui.el('span', { text: '→' }), teIn,
      ui.el('span', { class: 'mrb-explain', text: tt('Equal start and end is a zero-length window and never fires; start after end wraps past midnight.', '起訖相同即零長度，永不觸發；開始大過結束會跨午夜。') })),
    dayRow,
    ui.el('div', { class: 'mrb-field mrb-schedule-times' },
      ui.el('span', { text: tt('Dates (optional)', '日期（可選）') }), dsIn, ui.el('span', { text: '→' }), deIn),
    ui.el('p', { class: 'mrb-explain', text: `${tt('Timezone', '時區')}: ${tzName}. ${dstNote} ${tt('If two rules match, the newer rule wins; base settings return when no rule matches.', '兩條同時命中時，較新新嘅優先；冇規則命中就還原基本設定。')}` }),
    errLine,
  );

  const closeM = ui.modal ? ui.modal({
    title: isNew ? tt('New schedule rule', '新增排程規則') : tt('Edit schedule rule', '編輯排程規則'),
    build: (b) => { b.append(body); rebuildValueControl(); },
    actions: [
      { label: tt('Cancel', '取消'), onClick: () => closeM() },
      {
        label: isNew ? tt('Add rule', '加入規則') : tt('Save rule', '儲存規則'),
        onClick: () => {
          /* fail closed on invalid/partial input — nothing half-written */
          const problems = [];
          if (!labelIn.value.trim()) problems.push(tt('Give the rule a name.', '要有名稱。'));
          if (!targetSel.value) problems.push(tt('Pick a target setting.', '要揀目標設定。'));
          const ts = hhmmToMinutes(tsIn.value);
          const te = hhmmToMinutes(teIn.value);
          if (ts == null) problems.push(tt('Start time is incomplete.', '開始時間未填好。'));
          if (te == null) problems.push(tt('End time is incomplete.', '完結時間未填好。'));
          if (days !== 'every' && Array.isArray(days) && days.length === 0) problems.push(tt('Pick at least one day (or “Every day”).', '至少揀一日（或「每日」）。'));
          if (problems.length) {
            errLine.textContent = problems.join(' ');
            return;
          }
          const schema = loadSchema();
          const rec = {
            id: rule.id,
            label: labelIn.value.trim(),
            enabled: true,
            value: { path: targetSel.value, value: currentValue },
            timeStart: tsIn.value,
            timeEnd: teIn.value,
            days,
            dateStart: dsIn.value || undefined,
            dateEnd: deIn.value || undefined,
            createdAt: rule.createdAt,
          };
          const idx = schema.rules.findIndex((r) => r.id === rule.id);
          if (idx >= 0) schema.rules[idx] = rec; else schema.rules.push(rec);
          saveSchema(schema, isNew ? 'Added schedule rule' : 'Updated schedule rule');
          renderTable();
          evaluateNow();
          closeM();
        },
      },
    ],
  }) : null;
}

/* ------------------------------------------------------------------ */
/* Tab surface                                                         */
/* ------------------------------------------------------------------ */

let tableWrap = null;

function registerTab() {
  if (!P.router || typeof P.router.registerTab !== 'function') return;
  P.router.registerTab({
    id: 'schedule',
    title: tt('Schedule', '排程'),
    icon: '⏰',
    closable: true,
    group: 'settings',
    render(el) {
      el.append(buildScheduleTab());
    },
  });
}

function buildScheduleTab() {
  const wrap = ui.el('div', { class: 'mrb-schedule-tab' });
  const card = ui.el('section', { class: 'mrb-card' }, ui.el('h2', { text: tt('Scheduled settings', '排程設定') }));
  card.append(ui.el('p', {
    class: 'mrb-explain',
    text: tt(
      'Rules flip any writable setting on a local time window and put it back afterwards. Remote API and Home-Assistant sources are planned, not shipped.',
      '規則會喺本地時間窗內切換任何可寫設定，完咗自動還原。遠端 API 同 Home Assistant 來源屬規劃中，尚未推出。',
    ),
  }));

  nextPreviewNode = ui.el('p', { class: 'mrb-schedule-next', 'aria-live': 'polite' });
  card.append(nextPreviewNode);

  const addBtn = ui.el('button', { class: 'mrb-btn mrb-btn-filled', type: 'button', text: tt('Add rule…', '新增規則…') });
  addBtn.addEventListener('click', () => openRuleEditor(null));
  card.append(addBtn);

  tableWrap = ui.el('div', { class: 'mrb-schedule-tablewrap' });
  card.append(tableWrap);
  wrap.append(card);
  renderTable();
  updateNextPreview();
  return wrap;
}

function renderTable() {
  if (!tableWrap) return;
  tableWrap.textContent = '';
  const rules = listRules();
  if (!rules.length) {
    tableWrap.append(ui.el('p', {
      class: 'mrb-cpk-empty',
      text: tt('No rules yet — add one and your settings can look after themselves.', '仲未有規則 — 加一條，設定就識自己照顧自己。'),
    }));
    return;
  }
  const tbl = ui.el('table', { class: 'mrb-table' });
  const thead = ui.el('thead', {}, ui.el('tr', {},
    ...['', tt('Label', '名稱'), tt('Setting', '設定'), tt('Window', '時間窗'), tt('Days', '日子'), ''].map((h) => ui.el('th', { text: h }))));
  const tbody = ui.el('tbody');
  for (const r of rules.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
    const en = ui.el('input', { type: 'checkbox', class: 'mrb-switch-input', 'aria-label': tt('Enabled', '啟用') });
    en.checked = !!r.enabled;
    en.addEventListener('change', () => {
      const schema = loadSchema();
      const rec = schema.rules.find((x) => x.id === r.id);
      if (rec) { rec.enabled = en.checked; saveSchema(schema, en.checked ? 'Enabled schedule rule' : 'Disabled schedule rule'); }
      evaluateNow();
    });
    const delBtn = ui.el('button', { class: 'mrb-btn mrb-btn-text mrb-btn-sm', type: 'button', text: '🗑', 'aria-label': tt('Delete rule', '刪除規則') });
    delBtn.addEventListener('click', () => {
      const doDelete = () => {
        const schema = loadSchema();
        schema.rules = schema.rules.filter((x) => x.id !== r.id);
        saveSchema(schema, 'Deleted schedule rule');
        renderTable();
        evaluateNow();
      };
      if (ui.superConfirm) {
        ui.superConfirm({
          title: tt('Delete this rule?', '刪除呢條規則？'),
          detailHtml: `${escapeHtmlLocal(r.label || r.id)}<br><small>${escapeHtmlLocal(r.value.path)}</small>`,
          confirmLabel: tt('Delete rule', '刪除規則'),
          onConfirm: doDelete,
        });
      } else doDelete();
    });
    const editBtn = ui.el('button', { class: 'mrb-btn mrb-btn-tonal mrb-btn-sm', type: 'button', text: '✎', 'aria-label': tt('Edit rule', '編輯規則') });
    editBtn.addEventListener('click', () => openRuleEditor(r));

    tbody.append(ui.el('tr', {},
      ui.el('td', {}, en),
      ui.el('td', { text: r.label || r.id }),
      ui.el('td', { text: `${r.value.path} = ${fmtValue(r.value.value)}` }),
      ui.el('td', { text: `${r.timeStart}–${r.timeEnd}` }),
      ui.el('td', { text: r.days === 'every' ? tt('Every day', '每日') : (r.days || []).map((d) => DAY_LABELS[d]).join(' ') }),
      ui.el('td', {}, editBtn, delBtn)));
  }
  tbl.append(thead, tbody);
  tableWrap.append(tbl);
}

function escapeHtmlLocal(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------------ */
/* Settings defs + init                                                */
/* ------------------------------------------------------------------ */

function registerSettingDefs() {
  if (!P.settings || typeof P.settings.register !== 'function') return;
  P.settings.register([
    {
      key: 'schedule.enabled', type: 'toggle', def: true, group: 'Scheduled',
      label: { en: 'Run schedules', yue: '執行排程' },
      explain: {
        en: 'Master switch for every schedule rule. Manage the rules themselves on the Schedule tab.',
        yue: '全部排程規則嘅總掣；規則本身喺「排程」分頁管理。',
      },
    },
  ]);
}

let tickTimer = null;

function startEvaluator() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    if (getMasterEnabled()) evaluate();
  }, 15000);
}

function getMasterEnabled() {
  const v = P.settings && typeof P.settings.get === 'function'
    ? P.settings.get('schedule.enabled', true)
    : store.get('schedule.enabled', true);
  return v !== false;
}

/** Force re-evaluation (used by the editor after mutations). */
export function evaluateNow() {
  lastMinuteKey = '';
  evaluate();
}

/** @returns {Promise<void>} */
export async function init() {
  ensureToolsStyles();
  P.settings = ((await peer('./settings.js')) || {}).settings || null;
  P.router = ((await peer('./router.js')) || {}).router || null;

  try { registerSettingDefs(); } catch (_) { /* Settings surface optional this boot */ }
  try { registerTab(); } catch (_) { /* router optional this boot */ }
  try {
    const paletteM = await peer('./palette.js');
    if (paletteM && paletteM.palette && typeof paletteM.palette.register === 'function') {
      paletteM.palette.register({
        id: 'schedule.open', title: tt('Open Schedule', '開啟排程'), group: tt('Scheduled', '排程'),
        action: () => { if (P.router) P.router.navigate('schedule'); },
      });
    }
  } catch (_) { /* palette optional */ }

  if (!getMasterEnabled()) return;
  usingNativeLayer = nativeAvailable();
  evaluate();
  startEvaluator();
  try { document.addEventListener('visibilitychange', () => { if (!document.hidden) { lastMinuteKey = ''; evaluate(); } }); } catch (_) {}
}
