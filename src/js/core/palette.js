/**
 * Material Roblox — command palette, Ctrl+Shift+F (Lane C).
 *
 * One discoverable global shortcut (Ctrl+Shift+F, the contract's fixed
 * binding) plus the `mrb-open-palette` DOM event for programmatic opens.
 * Every command, destination, settings group, individual setting and router
 * tab is a row; rows with a `control(fn)` render the LIVE control inline —
 * the exact same settings.get/set code path as the Settings surface, so a
 * switch flipped here behaves identically to one flipped there (same
 * validation, same persistence, same history entry).
 *
 * Selecting a result TELEPORTS: navigate → reveal → focus → brief highlight,
 * never "land somewhere nearby and make the user hunt". Filtering is plain
 * fuzzy-substring scoring by default with an explicit regex opt-in through
 * this lane's own attachSearch wiring; the list follows the ARIA combobox +
 * listbox pattern, announces result counts politely, pins the five most
 * recent commands atop the unfiltered list, offers a persisted compact/full
 * view, and states an honest "No commands match" empty state.
 *
 * Built-ins are seeded against optional peers (settings, router, updater,
 * notify, history, locks, authenticator) with dynamic-import-null guards:
 * a missing peer removes its rows instead of shipping dead entries.
 */

import { store } from './store.js';
import { i18n } from './i18n.js';
import { ui } from './ui.js';

/* ── Registry ───────────────────────────────────────────────────────────── */

/** @type {Map<string, {id:string,title:string,keywords?:string[],group?:string,
 *                  action?:Function,control?:Function,teleport?:Function}>} */
const registry = new Map();

/**
 * Register a palette entry. Re-registering an id REPLACES it (last wins), so
 * lanes can refresh their own rows without duplicating them.
 */
export function register(entry) {
  if (!entry || typeof entry.id !== 'string' || !entry.id) {
    throw new Error('palette.register needs an entry with a non-empty id.');
  }
  if (typeof entry.title !== 'string' || !entry.title) {
    throw new Error(`palette.register('${entry.id}') needs a title.`);
  }
  registry.set(entry.id, {
    keywords: [],
    group: '',
    ...entry,
  });
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

/* ── Peers (optional; null-safe) ────────────────────────────────────────── */

async function peer(path, guard) {
  try {
    const mod = await import(path);
    if (guard && !guard(mod)) return null;
    return mod;
  } catch {
    return null;
  }
}

/* ── Teleport default implementation ────────────────────────────────────── */

function reducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function cssEscapeValue(s) {
  return (window.CSS && typeof CSS.escape === 'function') ? CSS.escape(s) : String(s).replace(/"/g, '\\"');
}

function findByText(root, text) {
  if (!text) return null;
  const needle = text.toLowerCase();
  const candidates = root.querySelectorAll('h1,h2,h3,h4,legend,label,[role="heading"],summary');
  for (const el of candidates) {
    if ((el.textContent || '').toLowerCase().includes(needle)) return el;
  }
  return null;
}

function flash(el) {
  if (!el) return;
  el.classList.add('mrb-flash-highlight');
  setTimeout(() => el.classList.remove('mrb-flash-highlight'), 1200);
}

/**
 * Default teleport: navigate to the tab, then reveal + focus + briefly
 * highlight the target element (selector first, heading-text fallback).
 * Double rAF waits one paint so freshly-rendered tabs exist in the DOM.
 */
export async function teleportToTab(tabId, opts = {}) {
  const mod = await peer('./router.js', (m) => m && typeof m.router?.navigate === 'function');
  if (mod) {
    try { mod.router.navigate(tabId); } catch { /* unknown tab id: reveal step still runs below */ }
  }
  requestAnimationFrame(() => requestAnimationFrame(() => {
    let target = opts.selector ? document.querySelector(opts.selector) : null;
    if (!target && opts.textHint) target = findByText(document, opts.textHint);
    if (!target) return; // navigation alone is still a valid teleport result
    target.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    flash(target);
    if (typeof target.focus === 'function') {
      try { target.focus({ preventScroll: true }); } catch { target.focus(); }
    }
  }));
}

/* ── Settings-backed rich rows ──────────────────────────────────────────── */

/**
 * Mount a live control for a SettingDef, bound through settings.get/set —
 * the same code path the Settings surface uses, so behaviour (validation,
 * persistence, history recording) cannot drift between the two.
 */
function mountSettingControl(mount, def, settings) {
  const inputId = `mrb-pal-ctl-${Math.random().toString(36).slice(2, 9)}`;
  const stop = (e) => e.stopPropagation();

  if (def.type === 'toggle') {
    const cb = ui.el('input', { type: 'checkbox', class: 'mrb-cx-mini-toggle', id: inputId });
    cb.checked = !!settings.get(def.key, def.def);
    cb.addEventListener('click', stop);
    cb.addEventListener('change', () => settings.set(def.key, cb.checked));
    mount.appendChild(cb);
    return;
  }
  if (def.type === 'select' && Array.isArray(def.options)) {
    const sel = ui.el('select', { class: 'mrb-select mrb-cx-mini-select', id: inputId, 'aria-label': def.title || def.key });
    for (const o of def.options) {
      const opt = ui.el('option', { value: String(o.value) }, (o.label && o.label.en) || String(o.value));
      sel.appendChild(opt);
    }
    sel.value = String(settings.get(def.key, def.def));
    sel.addEventListener('click', stop);
    sel.addEventListener('change', () => settings.set(def.key, sel.value));
    mount.appendChild(sel);
    return;
  }
  if (def.type === 'slider') {
    const range = ui.el('input', {
      type: 'range', class: 'mrb-cx-mini-range', id: inputId,
      min: String(def.min ?? 0), max: String(def.max ?? 100), step: String(def.step ?? 1),
      'aria-label': def.key,
    });
    range.value = String(settings.get(def.key, def.def));
    range.addEventListener('pointerdown', stop);
    range.addEventListener('input', stop);
    range.addEventListener('change', () => settings.set(def.key, Number(range.value)));
    mount.appendChild(range);
    return;
  }
  // text / color / font / path / hotkey: an inline text field covers the
  // value honestly; the teleport lands on the full editor for the rest.
  const input = ui.el('input', { type: 'text', class: 'mrb-cx-mini-text', id: inputId, 'aria-label': def.key });
  input.value = String(settings.get(def.key, def.def) ?? '');
  input.addEventListener('click', stop);
  input.addEventListener('keydown', stop);
  input.addEventListener('change', () => settings.set(def.key, input.value));
  mount.appendChild(input);
}

/* ── Built-in seeding ───────────────────────────────────────────────────── */

async function seedBuiltins() {
  const settingsMod = await peer('./settings.js', (m) => m && m.settings && typeof m.settings.defs === 'function');
  const settings = settingsMod ? settingsMod.settings : null;
  const settingsGroup = tr('palette.group.settings', 'Settings', '設定');

  if (settings) {
    // One row per settings GROUP (teleports + scrolls + flashes) …
    const groups = new Set();
    for (const def of settings.defs()) {
      const g = (def && def.group) || 'General';
      if (!groups.has(g)) {
        groups.add(g);
        register({
          id: `settings-group:${g}`,
          title: tr('palette.settingsGroup', `Open settings: ${g}`, `打開設定：${g}`),
          group: settingsGroup,
          teleport: () => teleportToTab('settings', {
            selector: `[data-mrb-settings-group="${cssEscapeValue(g)}"]`,
            textHint: g,
          }),
        });
      }
    }
    // … and one RICH row per individual setting (live control + teleport).
    for (const def of settings.defs()) {
      if (!def || !def.key) continue;
      const g = def.group || 'General';
      const label = (def.label && def.label.en) || def.key;
      register({
        id: `setting:${def.key}`,
        title: label,
        keywords: [def.key, g],
        group: `${settingsGroup} · ${g}`,
        control: (mount) => {
          try { mountSettingControl(mount, def, settings); } catch { /* row stays label-only */ }
        },
        teleport: () => teleportToTab('settings', {
          selector: `[data-mrb-settings-key="${cssEscapeValue(def.key)}"]`,
          textHint: label,
        }),
      });
    }

    register({
      id: 'theme:toggle',
      title: tr('palette.toggleTheme', 'Toggle theme (light / dark)', '切換主題（淺色／深色）'),
      group: settingsGroup,
      action: () => {
        try {
          const cur = settings.get('appearance.theme', 'system');
          const dark = cur === 'dark' ||
            (cur === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
          settings.set('appearance.theme', dark ? 'light' : 'dark');
        } catch (err) {
          ui.toast({
            title: tr('palette.themeFail', 'Could not switch the theme', '切換唔到主題'),
            body: String((err && err.message) || err),
            tone: 'error',
          });
        }
      },
    });
  }

  const updaterMod = await peer('./updater.js', (m) =>
    m && ['checkNow', 'checkForUpdates', 'check'].some((k) => typeof m[k] === 'function'));
  if (updaterMod) {
    const fn = updaterMod.checkNow || updaterMod.checkForUpdates || updaterMod.check;
    register({
      id: 'update:check',
      title: tr('palette.checkUpdates', 'Check for updates', '檢查更新'),
      group: tr('palette.group.app', 'Application', '應用程式'),
      action: () => { try { fn.call(updaterMod); } catch (err) { console.warn('[mrb/palette] update check failed:', err); } },
    });
  }

  const notifyMod = await peer('./notify.js', (m) => m && typeof m.center === 'function');
  if (notifyMod) {
    register({
      id: 'notify:center',
      title: tr('palette.notifCenter', 'Notification centre', '通知中心'),
      group: tr('palette.group.app', 'Application', '應用程式'),
      action: () => notifyMod.center(),
    });
    register({
      id: 'notify:search',
      title: tr('palette.notifSearch', 'Search notifications', '搜尋通知'),
      group: tr('palette.group.app', 'Application', '應用程式'),
      action: () => notifyMod.search(''),
    });
  }

  const historyMod = await peer('./history.js', (m) => m && typeof m.show === 'function');
  if (historyMod) {
    register({
      id: 'history:panel',
      title: tr('palette.history', 'History panel', '歷史紀錄面板'),
      group: tr('palette.group.app', 'Application', '應用程式'),
      action: () => historyMod.show(),
    });
  }

  const locksMod = await peer('./locks.js', (m) =>
    m && (typeof m.show === 'function' || typeof m.openManager === 'function' ||
      (m.locks && typeof m.locks.openManager === 'function')));
  if (locksMod) {
    const fn = locksMod.openManager || locksMod.show || (locksMod.locks && locksMod.locks.openManager);
    register({
      id: 'locks:manager',
      title: tr('palette.locks', 'Locks manager', '鎖定管理員'),
      group: tr('palette.group.app', 'Application', '應用程式'),
      action: () => fn.call(locksMod.locks || locksMod),
    });
  }

  const authMod = await peer('./authenticator.js', (m) =>
    m && (typeof m.show === 'function' || typeof m.open === 'function'));
  if (authMod) {
    const fn = authMod.open || authMod.show;
    register({
      id: 'authenticator:open',
      title: tr('palette.auth', 'Authenticator', '驗證器'),
      group: tr('palette.group.app', 'Application', '應用程式'),
      action: () => fn.call(authMod),
    });
  }
}

/* ── Entries snapshot & scoring ─────────────────────────────────────────── */

/* Snapshot is taken fresh on EVERY open — later-booting lanes (history,
 * converter, …) register tabs after this module initialises, and a cached
 * list would hide them forever. */
async function routerTabEntries() {
  const mod = await peer('./router.js', (m) => m && typeof m.router?.list === 'function');
  if (!mod) return [];
  return mod.router.list().map((t) => ({
    id: `tab:${t.id}`,
    title: tr('palette.goto', `Go to ${t.title || t.id}`, `去 ${t.title || t.id}`),
    group: tr('palette.group.navigate', 'Navigate', '導覽'),
    teleport: () => teleportToTab(t.id),
  }));
}

function scoreEntry(entry, q) {
  const title = entry.title.toLowerCase();
  const hay = `${entry.title} ${(entry.keywords || []).join(' ')} ${entry.group || ''}`.toLowerCase();
  if (title.startsWith(q)) return 120;
  if (title.split(/\W+/).some((w) => w.startsWith(q))) return 100;
  if (title.includes(q)) return 90;
  if (hay.includes(q)) return 70;
  let i = 0; // subsequence fuzzy: "stngs" finds "Settings"
  for (const ch of title) {
    if (ch === q[i]) i += 1;
    if (i >= q.length) return 50;
  }
  return 0;
}

/* ── Overlay ────────────────────────────────────────────────────────────── */

let installed = false;
let openState = null; // {backdrop, card, listEl, statusEl, input, controller, opener, entries, activeIndex, close}
let seedPromise = null;

function mruIds() {
  const v = store.get('paletteMru', []);
  return Array.isArray(v) ? v.slice(0, 5) : [];
}

function pushMru(id) {
  const next = [id, ...mruIds().filter((x) => x !== id)].slice(0, 5);
  store.set('paletteMru', next);
}

function viewMode() {
  return store.get('paletteView', 'card') === 'full' ? 'full' : 'card';
}

function computeResults(entries, queryState) {
  const q = (queryState.q || '').trim();
  if (!q) return entries.map((entry) => ({ entry, score: 0 }));
  if (queryState.mode === 'regex') {
    if (!queryState.valid) return [];
    let re;
    try { re = new RegExp(q, queryState.flags); } catch { return []; }
    return entries
      .filter((e) => re.test(`${e.title}\n${(e.keywords || []).join(' ')}\n${e.group || ''}`))
      .map((entry) => ({ entry, score: 0 }));
  }
  const ql = q.toLowerCase();
  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry, ql) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

export function open() {
  if (openState) {
    openState.input.focus();
    return openState.close;
  }

  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const backdrop = ui.el('div', { class: 'mrb-cx-pal-overlay' });
  const card = ui.el('div', {
    class: `mrb-cx-pal ${viewMode() === 'full' ? 'is-full' : ''}`,
    role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('palette.title', 'Command palette', '指令面板'),
  });
  backdrop.appendChild(card);

  const listId = 'mrb-cx-pal-list';
  const filterWrap = ui.el('div', { class: 'mrb-cx-pal-filter' });
  card.appendChild(filterWrap);

  const listEl = ui.el('div', { class: 'mrb-cx-pal-list', role: 'listbox', id: listId, 'aria-label': tr('palette.results', 'Commands', '指令') });
  const statusEl = ui.el('p', { class: 'mrb-visually-hidden', 'aria-live': 'polite' });
  const emptyEl = ui.el('p', { class: 'mrb-cx-pal-empty', hidden: 'true' }, tr('palette.empty', 'No commands match', '冇符合嘅指令'));
  // Invalid regex feedback lives under the filter field itself (attachSearch
  // renders it inline); the palette adds no second error surface.

  const viewBtn = ui.el('button', { class: 'mrb-btn mrb-btn--text', type: 'button' },
    viewMode() === 'full' ? tr('palette.compact', 'Compact view', '緊湊檢視') : tr('palette.full', 'Full window', '全視窗'));
  viewBtn.addEventListener('click', () => {
    const next = viewMode() === 'full' ? 'card' : 'full';
    store.set('paletteView', next);
    card.classList.toggle('is-full', next === 'full');
    viewBtn.textContent = next === 'full' ? tr('palette.compact', 'Compact view', '緊湊檢視') : tr('palette.full', 'Full window', '全視窗');
  });

  const foot = ui.el('footer', { class: 'mrb-cx-pal-foot' },
    ui.el('span', { class: 'mrb-cx-pal-hints' },
      tr('palette.hints', '↑↓ navigate · Enter run · Tab inspect · Esc close', '↑↓ 揀 · Enter 行 · Tab 睇 · Esc 閂')),
    statusEl, viewBtn);

  card.append(listEl, emptyEl, foot);

  const state = {
    backdrop, card, listEl, statusEl, emptyEl, viewBtn,
    input: null, controller: null,
    opener,
    entries: [],
    rows: [],
    activeIndex: -1,
    query: { q: '', mode: 'plain', flags: '', valid: true },
    close: null,
  };
  openState = state;

  function close() {
    if (!openState) return;
    document.removeEventListener('keydown', onDocKeydown);
    backdrop.remove();
    openState = null;
    if (opener && typeof opener.focus === 'function') {
      try { opener.focus(); } catch { /* element went away mid-session */ }
    }
  }
  state.close = close;

  function setActive(i, { focusControl = false } = {}) {
    const rows = state.rows;
    if (!rows.length) { state.activeIndex = -1; return; }
    state.activeIndex = ((i % rows.length) + rows.length) % rows.length;
    rows.forEach((r, idx) => {
      const on = idx === state.activeIndex;
      r.el.classList.toggle('is-active', on);
      r.el.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const active = rows[state.activeIndex];
    state.input.setAttribute('aria-activedescendant', active.el.id);
    active.el.scrollIntoView({ block: 'nearest' });
    if (focusControl) {
      const ctl = active.el.querySelector('input,select,button.mrb-cx-ctl');
      if (ctl) ctl.focus();
    }
  }

  function runActive() {
    const row = state.rows[state.activeIndex];
    if (!row) return;
    const entry = row.entry;
    pushMru(entry.id);
    close();
    // Run after close so an action opening its own surface never fights the
    // palette overlay for focus.
    setTimeout(() => {
      try {
        if (typeof entry.teleport === 'function') entry.teleport();
        else if (typeof entry.action === 'function') entry.action();
        else if (typeof entry.control === 'function') {
          // Control-only row: nothing to run — say so instead of pretending.
          ui.toast({
            title: tr('palette.controlOnly', 'Adjust it right here', '喺呢度直接調整'),
            body: tr('palette.controlOnlyBody', 'That row carries a live control in the list — reopen the palette and change it inline.', '嗰行喺清單入面已經有即時控制——重開面板直接改就得。'),
            tone: 'info', timeoutMs: 5000,
          });
        }
      } catch (err) {
        console.warn('[mrb/palette] command failed:', err);
      }
    }, 0);
  }

  function previewActive() {
    // Tab = hover-equivalent inspection: focus the row's inline control when
    // it has one, otherwise flash the row itself. Nothing is executed.
    const row = state.rows[state.activeIndex];
    if (!row) return;
    const ctl = row.el.querySelector('input,select');
    if (ctl) { ctl.focus(); return; }
    flash(row.el);
  }

  function render() {
    const results = computeResults(state.entries, state.query);
    const qEmpty = !state.query.q.trim();
    let ordered = results;
    if (qEmpty) {
      // MRU pinned atop the unfiltered list, then everything else in
      // registration order (Map preserves insertion order).
      const ids = new Set(mruIds());
      const recent = mruIds()
        .map((id) => state.entries.find((e) => e.id === id))
        .filter(Boolean);
      const rest = results.map((r) => r.entry).filter((e) => !ids.has(e.id));
      ordered = [...recent.map((entry) => ({ entry, score: 0, recent: true })), ...rest.map((entry) => ({ entry, score: 0 }))];
    }
    const RENDER_CAP = 200;
    const shown = ordered.slice(0, RENDER_CAP);

    state.listEl.textContent = '';
    state.rows = [];
    shown.forEach((r, idx) => {
      const el = ui.el('div', {
        class: 'mrb-cx-prow' + (r.recent ? ' is-recent' : ''),
        role: 'option', id: `mrb-cx-prow-${idx}`, 'aria-selected': 'false',
      });
      const left = ui.el('div', { class: 'mrb-cx-prow-main' },
        ui.el('span', { class: 'mrb-cx-prow-title' }, (r.recent ? '↻ ' : '') + r.entry.title));
      const ctx = [r.entry.group, r.recent ? tr('palette.recent', 'Recent', '最近') : null]
        .filter(Boolean).join(' · ');
      if (ctx) left.appendChild(ui.el('span', { class: 'mrb-cx-prow-ctx' }, ctx));
      el.appendChild(left);

      const right = ui.el('div', { class: 'mrb-cx-prow-side' });
      if (typeof r.entry.control === 'function') {
        const mount = ui.el('div', { class: 'mrb-cx-prow-ctl' });
        try { r.entry.control(mount); } catch { /* label-only row on control failure */ }
        right.appendChild(mount);
      } else {
        right.appendChild(ui.el('span', { class: 'mrb-cx-prow-hint', 'aria-hidden': 'true' }, '↵'));
      }
      el.appendChild(right);

      el.addEventListener('click', () => {
        setActive(state.rows.findIndex((x) => x.el === el));
        runActive();
      });
      el.addEventListener('mousemove', () => {
        const i = state.rows.findIndex((x) => x.el === el);
        if (i !== state.activeIndex) setActive(i);
      });

      state.listEl.appendChild(el);
      state.rows.push({ el, entry: r.entry });
    });

    state.emptyEl.hidden = shown.length !== 0;
    if (ordered.length > RENDER_CAP) {
      state.emptyEl.hidden = false;
      state.emptyEl.textContent = tr('palette.capped',
        `Showing the first ${RENDER_CAP} of ${ordered.length} matches — keep typing to narrow.`,
        `只顯示 ${ordered.length} 個符合之中嘅頭 ${RENDER_CAP} 個——繼續輸入收窄。`);
    } else {
      state.emptyEl.textContent = tr('palette.empty', 'No commands match', '冇符合嘅指令');
    }
    state.statusEl.textContent = tr('palette.count', `${shown.length} commands match`, `${shown.length} 個符合指令`);
    setActive(0);
  }

  function onDocKeydown(e) {
    if (!openState) return;
    if (e.key === 'Escape') {
      // Bubble phase ON PURPOSE: the filter field's own Escape handler runs
      // first (clear text, then collapse the builder) and stops propagation;
      // only an already-empty field reaches here and closes the palette.
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
  document.addEventListener('keydown', onDocKeydown);

  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });

  /* Filter input — this palette's OWN attachSearch wiring (regex toggle and
   * builder included), never a shared field with another surface. */
  import('./regexbuilder.js').then((rb) => {
    if (!rb || typeof rb.attachSearch !== 'function' || !openState) return;
    const input = ui.el('input', {
      type: 'search', id: 'mrb-cx-pal-filter',
      placeholder: tr('palette.ph', 'Type a command…', '輸入指令…'),
      role: 'combobox', 'aria-expanded': 'true', 'aria-controls': listId,
      'aria-autocomplete': 'list',
    });
    filterWrap.appendChild(input);
    state.input = input;
    state.controller = rb.attachSearch(input, {
      debounceMs: 120,
      onQuery: (q, meta) => {
        state.query = { q, ...meta };
        render();
      },
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setActive(state.activeIndex + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setActive(state.activeIndex - 1); }
      else if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); setActive(0); }
      else if (e.key === 'End') { e.preventDefault(); e.stopPropagation(); setActive(state.rows.length - 1); }
      else if (e.key === 'PageDown') { e.preventDefault(); e.stopPropagation(); setActive(state.activeIndex + 8); }
      else if (e.key === 'PageUp') { e.preventDefault(); e.stopPropagation(); setActive(state.activeIndex - 8); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); runActive(); }
      else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); previewActive(); }
      // Escape is handled by attachSearch (clear-then-collapse) and the
      // document capture above (close when the field is already empty).
    });
    requestAnimationFrame(() => input.focus());
    render();
  }).catch(() => {
    // Builder peer failed — the palette still opens with a bare input so
    // commands remain reachable; only regex filtering is degraded.
    const input = ui.el('input', {
      type: 'search', id: 'mrb-cx-pal-filter', placeholder: tr('palette.ph', 'Type a command…', '輸入指令…'),
    });
    filterWrap.appendChild(input);
    state.input = input;
    input.addEventListener('input', () => { state.query = { q: input.value, mode: 'plain', flags: '', valid: true }; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(state.activeIndex + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(state.activeIndex - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); runActive(); }
    });
    requestAnimationFrame(() => input.focus());
    render();
  });

  document.body.appendChild(backdrop);

  // Snapshot dynamic entries (router tabs) at open time, then first paint.
  (async () => {
    const tabs = await routerTabEntries();
    if (!openState || openState !== state) return; // closed while loading
    state.entries = [...registry.values(), ...tabs.filter((t) => !registry.has(t.id))];
    if (state.input) render();
  })();

  return close;
}

export function closePalette() {
  if (openState) openState.close();
}

export function isOpen() {
  return !!openState;
}

/* ── Module init ────────────────────────────────────────────────────────── */

export async function init() {
  if (installed) return;
  installed = true;
  try {
    ui.injectCss(new URL('../../styles/features/coreux.css', import.meta.url).href);
  } catch (err) {
    console.warn('[mrb/palette] stylesheet injection failed:', err && err.message);
  }

  window.addEventListener('keydown', (e) => {
    // Ctrl+Shift+F is the contract's fixed palette shortcut. Capture phase so
    // a focused surface cannot swallow it.
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
      e.preventDefault();
      e.stopPropagation();
      if (openState) openState.close();
      else open();
    }
  }, true);

  window.addEventListener('mrb-open-palette', () => { if (!openState) open(); });

  seedPromise = seedBuiltins().catch((err) => {
    console.warn('[mrb/palette] builtin seeding failed:', err && err.message);
  });
  await seedPromise;
}
