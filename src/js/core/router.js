/**
 * Browser-style tabbed navigation with a left-docked strip by default.
 *
 * Owns: tab registration/lifecycle, docking (left/right/top/bottom, persisted,
 * orientation-aware keyboard), pinning, groups (create/rename/color/collapse),
 * the "Move… into group…" picker, an overflow surface, per-tab context menus
 * with real working shortcuts, Shift+right-click direct appearance editing,
 * FOUR discovery searches (current strip / inside groups / group names / all
 * tabs) each with its own regex-wired field, bulk close with preview/veto/
 * honesty, roving-tabindex accessibility, and persistence across restarts.
 *
 * The Settings tab is registered BY the settings module; this module only
 * hosts it. A minimal Home placeholder appears ONLY if no other lane
 * registered id "home" by the end of the boot turn.
 */

import { store } from './store.js';
import { ui } from './ui.js';
import { i18n } from './i18n.js';

const LAYOUT_KEY = 'tabs.layout';

const STRIP_ID = 'mrb-tabstrip';
const SURFACE_ID = 'mrb-surface';
const APP_ID = 'mrb-app';

const GROUP_COLORS = [
  '#8c1d18',
  '#b3591f',
  '#7a6a12',
  '#2f6b3a',
  '#1f5f7a',
  '#4a4a8f',
  '#7a2f6b',
];

/* --------------------------------- State ---------------------------------- */

/** @type {Map<string, object>} normalized tab definitions */
const tabs = new Map();
/** @type {Map<string, {pinned: boolean, groupId: string|null}>} */
const tabState = new Map();
/** @type {Map<string, {id: string, name: string, color: string, collapsed: boolean}>} */
const groups = new Map();
let order = [];
let currentId = null;
let dockEdge = 'left';
let mounted = false;
let lockProbe = null;
const lastQueryByTab = new Map();
let panelElement = null;

/** @type {Map<string, {combo: string, desc: string, id: string, fn: Function}>} */
const shortcuts = new Map();

/* ------------------------------- Utilities -------------------------------- */

function titleOf(def) {
  try {
    return String(typeof def.title === 'function' ? def.title() : def.title || def.id);
  } catch {
    return def.id;
  }
}

function normalizeCombo(combo) {
  const parts = String(combo)
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  const mods = [];
  let key = '';
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl') mods.push('Ctrl');
    else if (lower === 'alt') mods.push('Alt');
    else if (lower === 'shift') mods.push('Shift');
    else if (lower === 'meta' || lower === 'cmd') mods.push('Meta');
    else key = part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
  }
  return [...mods, key].filter(Boolean).join('+');
}

function comboFromEvent(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');
  const key = event.key;
  if (!key) return '';
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return '';
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join('+');
}

/**
 * Global shortcut table. Context menus read the same table so a displayed
 * shortcut is always one that actually works here.
 */
export function registerShortcut(combo, fn, descOrOptions = {}) {
  const options =
    typeof descOrOptions === 'string' ? { desc: descOrOptions } : descOrOptions || {};
  const canonical = normalizeCombo(combo);
  shortcuts.set(canonical, {
    combo: canonical,
    desc: String(options.desc || ''),
    id: String(options.id || ''),
    fn: typeof fn === 'function' ? fn : () => {},
  });
  return function unregister() {
    shortcuts.delete(canonical);
  };
}

function shortcutForAction(actionId) {
  for (const entry of shortcuts.values()) {
    if (entry.id === actionId) return entry.combo;
  }
  return null;
}

/* ------------------------------ Ordering view ----------------------------- */

/** Order entries whose tab definitions still exist (saved layout may name ghosts). */
function knownOrder() {
  return order.filter((id) => tabs.has(id));
}

function orderedUngroupedIds() {
  return knownOrder().filter((id) => {
    const state = tabState.get(id);
    return !state || (!state.pinned && !state.groupId);
  });
}

function visibleOrderedIds() {
  const clean = knownOrder();
  const pinned = clean.filter((id) => {
    const state = tabState.get(id);
    return state && state.pinned;
  });
  const result = [...pinned];
  for (const id of orderedUngroupedIds()) result.push(id);
  for (const group of groups.values()) {
    if (group.collapsed) continue;
    for (const id of clean) {
      const state = tabState.get(id);
      if (state && state.groupId === group.id && !state.pinned) result.push(id);
    }
  }
  // Any tab whose group vanished falls back into the main flow.
  for (const id of clean) {
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

/* ------------------------------ Persistence ------------------------------- */

const persistLayout = ui.debounce(() => {
  const pins = {};
  for (const [id, state] of tabState.entries()) {
    pins[id] = { pinned: state.pinned, groupId: state.groupId };
  }
  store.set(LAYOUT_KEY, {
    order: [...order],
    pins,
    groups: [...groups.values()],
    dock: dockEdge,
    currentId,
  });
}, 300);

function restoreLayout() {
  const saved = store.get(LAYOUT_KEY, null);
  if (!saved || typeof saved !== 'object') return;
  if (Array.isArray(saved.order)) {
    order = saved.order.filter((id) => typeof id === 'string');
  }
  if (typeof saved.dock === 'string' && ['left', 'right', 'top', 'bottom'].includes(saved.dock)) {
    dockEdge = saved.dock;
  }
  if (Array.isArray(saved.groups)) {
    for (const group of saved.groups) {
      if (
        group &&
        typeof group.id === 'string' &&
        typeof group.name === 'string'
      ) {
        groups.set(group.id, {
          id: group.id,
          name: group.name,
          color: typeof group.color === 'string' ? group.color : GROUP_COLORS[0],
          collapsed: group.collapsed === true,
        });
      }
    }
  }
  if (saved.pins && typeof saved.pins === 'object') {
    for (const [id, value] of Object.entries(saved.pins)) {
      tabState.set(id, {
        pinned: Boolean(value && value.pinned),
        groupId: value && typeof value.groupId === 'string' ? value.groupId : null,
      });
    }
  }
  if (typeof saved.currentId === 'string') currentId = saved.currentId;
}

/* ------------------------------ Registration ------------------------------ */

function normalizeTabDef(raw) {
  if (!raw || typeof raw.id !== 'string' || !raw.id) {
    console.warn('[router] Rejected tab without id.');
    return null;
  }
  if (typeof raw.render !== 'function') {
    console.warn('[router] Rejected tab without render():', raw.id);
    return null;
  }
  return {
    id: raw.id,
    title: raw.title !== undefined ? raw.title : raw.id,
    // Contract spelling is "icon"; "iconSvg" accepted as the internal alias.
    iconSvg: typeof raw.iconSvg === 'string' ? raw.iconSvg : typeof raw.icon === 'string' ? raw.icon : '',
    closable: raw.closable !== false,
    render: raw.render,
    ctxMenuItems: Array.isArray(raw.ctxMenuItems) ? raw.ctxMenuItems : [],
  };
}

function registerTab(rawDef) {
  const def = normalizeTabDef(rawDef);
  if (!def) return null;

  const isNew = !tabs.has(def.id);
  tabs.set(def.id, def);

  if (isNew) {
    if (!tabState.has(def.id)) {
      tabState.set(def.id, { pinned: false, groupId: null });
    }
    // Prefer a restored position; otherwise append.
    if (!order.includes(def.id)) {
      order.push(def.id);
    }
    if (mounted && !currentId) navigate(def.id);
    if (mounted) renderStrip();
  } else if (mounted && currentId === def.id) {
    renderSurface(def.id);
  }
  return def;
}

/* -------------------------------- Rendering ------------------------------- */

function stripElement() {
  return document.getElementById(STRIP_ID);
}

function surfaceElement() {
  return document.getElementById(SURFACE_ID);
}

function appElement() {
  return document.getElementById(APP_ID);
}

function isVertical() {
  return dockEdge === 'left' || dockEdge === 'right';
}

function buildTabButton(id) {
  const def = tabs.get(id);
  const state = tabState.get(id) || { pinned: false, groupId: null };
  const button = ui.el('button', {
    type: 'button',
    class: ['mrb-tab'],
    role: 'tab',
    id: 'mrb-tab-btn-' + id,
    'aria-selected': currentId === id ? 'true' : 'false',
    'aria-controls': 'mrb-panel-' + id,
    tabindex: currentId === id ? '0' : '-1',
    title: titleOf(def),
  });

  if (def.iconSvg) {
    button.appendChild(
      ui.el('span', { class: 'mrb-tab-icon', 'aria-hidden': 'true', html: def.iconSvg })
    );
  }
  button.appendChild(ui.el('span', { class: 'mrb-tab-label', text: titleOf(def) }));
  if (state.pinned) {
    button.appendChild(
      ui.el('span', { class: 'mrb-badge', text: i18n.t('common.pin'), 'aria-hidden': 'true' })
    );
  }

  button.addEventListener('click', () => navigate(id));
  button.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (event.shiftKey) {
      requestAppearanceEditor(button, 'tab', id);
      return;
    }
    openTabMenu(id, button);
  });
  button.addEventListener('keydown', (event) => {
    handleStripKeydown(event, id);
  });
  return button;
}

function axisNext(event) {
  const vertical = isVertical();
  const forward = vertical ? event.key === 'ArrowDown' : event.key === 'ArrowRight';
  const backward = vertical ? event.key === 'ArrowUp' : event.key === 'ArrowLeft';
  // Accept both axes regardless of orientation rather than dead-ending.
  const forwardAny = forward || (vertical ? event.key === 'ArrowRight' : event.key === 'ArrowDown');
  const backwardAny = backward || (vertical ? event.key === 'ArrowLeft' : event.key === 'ArrowUp');
  return { forwardAny, backwardAny };
}

function handleStripKeydown(event, sourceId) {
  const visible = visibleOrderedIds().filter((id) => {
    const group = tabState.get(id) && tabState.get(id).groupId;
    if (group) {
      const g = groups.get(group);
      if (g && g.collapsed) return false;
    }
    return true;
  });
  const index = visible.indexOf(sourceId);
  const { forwardAny, backwardAny } = axisNext(event);

  if (forwardAny || backwardAny) {
    event.preventDefault();
    if (visible.length === 0) return;
    let nextIndex = index;
    if (forwardAny) nextIndex = (index + 1) % visible.length;
    else nextIndex = (index - 1 + visible.length) % visible.length;
    const nextId = visible[nextIndex];
    const button = document.getElementById('mrb-tab-btn-' + nextId);
    if (button instanceof HTMLElement) {
      button.focus();
      navigate(nextId);
    }
    return;
  }

  if (event.key === 'Home') {
    event.preventDefault();
    const first = visible[0];
    if (first) {
      const button = document.getElementById('mrb-tab-btn-' + first);
      if (button instanceof HTMLElement) {
        button.focus();
        navigate(first);
      }
    }
    return;
  }
  if (event.key === 'End') {
    event.preventDefault();
    const last = visible[visible.length - 1];
    if (last) {
      const button = document.getElementById('mrb-tab-btn-' + last);
      if (button instanceof HTMLElement) {
        button.focus();
        navigate(last);
      }
    }
    return;
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    navigate(sourceId);
    return;
  }
  if (event.key === 'Delete') {
    const def = tabs.get(sourceId);
    if (def && def.closable) {
      event.preventDefault();
      void closeTabWithGuard(sourceId);
    }
  }
}

function buildGroupBlock(group) {
  const members = knownOrder().filter((id) => {
    const state = tabState.get(id);
    return state && state.groupId === group.id && !state.pinned;
  });

  const block = ui.el('div', {
    class: ['mrb-tab-group', group.collapsed ? 'is-collapsed' : ''],
    'data-group-id': group.id,
  });

  const header = ui.el('button', {
    type: 'button',
    class: 'mrb-tab-group-header',
    'aria-expanded': group.collapsed ? 'false' : 'true',
    title: group.name,
  });
  header.appendChild(ui.el('span', { class: 'mrb-tab-group-dot', style: { background: group.color }, 'aria-hidden': 'true' }));
  header.appendChild(ui.el('span', { text: group.name }));
  header.appendChild(ui.el('span', { class: 'mrb-result-count', text: '(' + members.length + ')' }));
  header.addEventListener('click', () => {
    toggleGroup(group.id, !groups.get(group.id).collapsed);
  });
  header.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openGroupMenu(group.id, header);
  });
  block.appendChild(header);

  const membersWrap = ui.el('div', { class: 'mrb-tab-group-members', role: 'presentation' });
  for (const id of members) membersWrap.appendChild(buildTabButton(id));
  block.appendChild(membersWrap);

  return block;
}

function renderStrip() {
  const strip = stripElement();
  if (!strip) return;
  strip.replaceChildren();

  const pinnedIds = knownOrder().filter((id) => {
    const state = tabState.get(id);
    return state && state.pinned;
  });
  if (pinnedIds.length > 0) {
    const pinnedRegion = ui.el('div', { class: 'mrb-tab-pinned-region', 'aria-label': i18n.t('common.pin') });
    for (const id of pinnedIds) pinnedRegion.appendChild(buildTabButton(id));
    strip.appendChild(pinnedRegion);
  }

  for (const id of orderedUngroupedIds()) strip.appendChild(buildTabButton(id));

  for (const group of groups.values()) strip.appendChild(buildGroupBlock(group));

  const overflowButton = ui.el('button', {
    type: 'button',
    class: 'mrb-tab-overflow',
    'aria-label': 'More tabs',
    title: 'More tabs',
    text: '…',
  });
  overflowButton.addEventListener('click', () => openOverflowMenu(overflowButton));
  strip.appendChild(overflowButton);

  const toolbar = ui.el('div', { style: { display: 'flex', flexDirection: isVertical() ? 'column' : 'row', gap: '6px', marginTop: 'auto', paddingTop: '8px' } });

  const searchButton = ui.el('button', {
    type: 'button',
    class: ['mrb-chip'],
    text: i18n.t('common.search'),
    title: i18n.t('common.search'),
  });
  searchButton.addEventListener('click', () => openSearchHub(searchButton));
  toolbar.appendChild(searchButton);

  const shortcutHelp = ui.el('button', {
    type: 'button',
    class: ['mrb-chip'],
    text: '?',
    'aria-label': i18n.t('shortcuts.title'),
    title: i18n.t('shortcuts.title'),
  });
  shortcutHelp.addEventListener('click', () => openShortcutsPanel(shortcutHelp));
  toolbar.appendChild(shortcutHelp);

  strip.appendChild(toolbar);

  strip.setAttribute('aria-orientation', isVertical() ? 'vertical' : 'horizontal');

  // Overflow: reveal the chevron only when content actually exceeds the strip.
  overflowButton.hidden = true;
  requestAnimationFrame(() => {
    const overflowing = isVertical()
      ? strip.scrollHeight > strip.clientHeight + 4
      : strip.scrollWidth > strip.clientWidth + 4;
    overflowButton.hidden = !overflowing;
  });
}

function renderSurface(id) {
  const surface = surfaceElement();
  const def = tabs.get(id);
  if (!surface || !def) return;
  surface.replaceChildren();

  panelElement = ui.el('div', {
    id: 'mrb-panel-' + id,
    role: 'tabpanel',
    'aria-labelledby': 'mrb-tab-btn-' + id,
    tabindex: '-1',
    'data-tab-id': id,
  });
  surface.appendChild(panelElement);

  try {
    def.render(panelElement, {
      tabId: id,
      query: lastQueryByTab.get(id) || '',
    });
  } catch (err) {
    console.error('[router] Tab render failed:', id, err);
    panelElement.replaceChildren(
      ui.el('div', { class: 'mrb-empty-state' }, [
        ui.el('h3', { text: 'This tab could not load.' }),
        ui.el('p', { text: err instanceof Error ? err.message : String(err) }),
        ui.el(
          'button',
          {
            type: 'button',
            class: ['mrb-btn', 'tonal'],
            text: i18n.t('common.retry'),
            onclick: () => renderSurface(id),
          }
        ),
      ])
    );
  }

  const heading = panelElement.querySelector('h1, h2, h3');
  if (heading instanceof HTMLElement) {
    panelElement.setAttribute('aria-label', heading.textContent || titleOf(def));
  }
}

/* ------------------------------- Navigation ------------------------------- */

function navigate(id) {
  if (!tabs.has(id)) return;
  currentId = id;
  for (const otherId of tabs.keys()) {
    const button = document.getElementById('mrb-tab-btn-' + otherId);
    if (button) {
      button.setAttribute('aria-selected', otherId === id ? 'true' : 'false');
      button.setAttribute('tabindex', otherId === id ? '0' : '-1');
    }
  }
  renderSurface(id);
  persistLayout();
}

function current() {
  return currentId;
}

function list() {
  return visibleOrderedIds().map((id) => {
    const def = tabs.get(id);
    const state = tabState.get(id) || {};
    return {
      id,
      title: titleOf(def),
      pinned: Boolean(state.pinned),
      groupId: state.groupId || null,
      closable: def.closable !== false,
    };
  });
}

/* ---------------------------- Pins / Groups/Dock --------------------------- */

function pin(id, on) {
  const state = tabState.get(id);
  if (!state) return;
  state.pinned = Boolean(on);
  renderStrip();
  persistLayout();
}

function createGroup(name, color) {
  const trimmedName = String(name || '').trim().slice(0, 60) || 'Group';
  const id = 'grp-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
  const usedColors = new Set([...groups.values()].map((group) => group.color));
  const chosenColor =
    typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)
      ? color
      : GROUP_COLORS.find((candidate) => !usedColors.has(candidate)) || GROUP_COLORS[groups.size % GROUP_COLORS.length];
  groups.set(id, { id, name: trimmedName, color: chosenColor, collapsed: false });
  renderStrip();
  persistLayout();
  return id;
}

function renameGroup(groupId, name, color) {
  const group = groups.get(groupId);
  if (!group) return false;
  if (typeof name === 'string' && name.trim()) group.name = name.trim().slice(0, 60);
  if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) group.color = color;
  renderStrip();
  persistLayout();
  return true;
}

function removeGroupKeepTabs(groupId) {
  const group = groups.get(groupId);
  if (!group) return;
  for (const state of tabState.values()) {
    if (state.groupId === groupId) state.groupId = null;
  }
  groups.delete(groupId);
  renderStrip();
  persistLayout();
}

function moveTab(tabId, groupIdOrNull) {
  const state = tabState.get(tabId);
  if (!state) return false;
  if (groupIdOrNull === null || groupIdOrNull === undefined) {
    state.groupId = null;
  } else {
    if (!groups.has(groupIdOrNull)) return false;
    state.groupId = groupIdOrNull;
    // Moving into a collapsed group leaves that group collapsed.
  }
  renderStrip();
  persistLayout();
  return true;
}

function toggleGroup(groupId, collapsed) {
  const group = groups.get(groupId);
  if (!group) return;
  group.collapsed = Boolean(collapsed);
  renderStrip();
  persistLayout();
}

function groupsList() {
  return [...groups.values()].map((group) => ({
    ...group,
    count: knownOrder().filter((id) => {
      const state = tabState.get(id);
      return state && state.groupId === group.id && !state.pinned;
    }).length,
  }));
}

function setDock(edge) {
  if (!['left', 'right', 'top', 'bottom'].includes(edge)) return;
  dockEdge = edge;
  const app = appElement();
  const strip = stripElement();
  if (app) app.dataset.dock = edge;
  if (strip) strip.setAttribute('aria-orientation', isVertical() ? 'vertical' : 'horizontal');
  renderStrip();
  persistLayout();
}

function dock() {
  return dockEdge;
}

/* -------------------------------- Searching -------------------------------- */

function compileMatcher(query, mode, flags) {
  if (mode === 'regex') {
    let expression;
    try {
      expression = new RegExp(query, flags || '');
    } catch (err) {
      throw new Error('Invalid regular expression: ' + (err instanceof Error ? err.message : ''));
    }
    return (text) => expression.test(text);
  }
  const needle = String(query).toLowerCase();
  return (text) => text.toLowerCase().includes(needle);
}

function search(query, options = {}) {
  const mode = options.mode === 'regex' ? 'regex' : 'plain';
  const flags = typeof options.flags === 'string' ? options.flags.replace(/[^gimsuy]/g, '') : '';
  const scope = ['strip', 'groups', 'groupNames', 'all'].includes(options.scope)
    ? options.scope
    : 'all';
  if (!query || !query.trim()) return [];
  const matcher = compileMatcher(query, mode, flags);

  if (scope === 'groupNames') {
    return groupsList()
      .filter((group) => matcher(group.name))
      .map((group) => ({ groupId: group.id, name: group.name, color: group.color, count: group.count }));
  }

  const pool =
    scope === 'strip'
      ? visibleOrderedIds()
      : scope === 'groups'
        ? knownOrder().filter((id) => {
            const state = tabState.get(id);
            return state && state.groupId;
          })
        : knownOrder();

  const results = [];
  for (const id of pool) {
    const def = tabs.get(id);
    if (!def) continue;
    const state = tabState.get(id) || {};
    const groupName = state.groupId && groups.get(state.groupId) ? groups.get(state.groupId).name : '';
    if (matcher(titleOf(def))) {
      results.push({ id, title: titleOf(def), groupName, pinned: Boolean(state.pinned) });
    }
  }
  return results;
}

/* ------------------------------- Bulk close ------------------------------- */

function unsavedGuardFor(tabId) {
  return new Promise((resolve) => {
    const detail = { tabId, promises: [] };
    window.dispatchEvent(new CustomEvent('mrb-unsaved-guard', { detail }));
    if (!Array.isArray(detail.promises) || detail.promises.length === 0) {
      resolve(true);
      return;
    }
    Promise.all(detail.promises)
      .then((verdicts) => resolve(verdicts.every((v) => v !== false)))
      .catch(() => resolve(false));
  });
}

function destroyTab(id) {
  const def = tabs.get(id);
  if (!def || def.closable === false) return false;
  const wasCurrent = currentId === id;
  tabs.delete(id);
  tabState.delete(id);
  order = order.filter((entry) => entry !== id);

  // Drop now-empty groups created ad hoc? Only explicit user action removes
  // groups deliberately; empty groups persist until removed from their menu.

  if (wasCurrent) {
    const visible = visibleOrderedIds();
    const fallback = visible[0];
    if (fallback) {
      currentId = null;
      navigate(fallback);
    } else {
      currentId = null;
      const surface = surfaceElement();
      if (surface) surface.replaceChildren();
      renderStrip();
    }
  } else {
    renderStrip();
  }
  persistLayout();
  return true;
}

async function closeTabWithGuard(id) {
  const ok = await unsavedGuardFor(id);
  if (!ok) {
    ui.toast({
      title: 'Not closed',
      body: 'This tab has unsaved work.',
      tone: 'warn',
    });
    return false;
  }
  return destroyTab(id) === true;
}

function bulkClose(matchText, options = {}) {
  const negate = options.negate === true;
  const includePinned = options.includePinned === true;
  const mode = options.mode === 'regex' ? 'regex' : 'plain';
  const flags = typeof options.flags === 'string' ? options.flags.replace(/[^gimsuy]/g, '') : '';

  function classify() {
    const matcher = compileMatcher(matchText, mode, flags);
    const matched = [];
    const excluded = [];
    for (const id of knownOrder()) {
      const def = tabs.get(id);
      if (!def) continue;
      const state = tabState.get(id) || {};
      const hit = matcher(titleOf(def)) !== negate;
      if (!hit) continue;
      let reason = null;
      if (def.closable === false) reason = 'not closable';
      else if (state.pinned && !includePinned) reason = 'pinned';
      else if (lockProbe && lockProbe(id)) reason = 'locked';
      if (reason) excluded.push({ id, title: titleOf(def), reason });
      else matched.push({ id, title: titleOf(def) });
    }
    return { matched, excluded };
  }

  return {
    preview() {
      return classify();
    },
    async apply() {
      const { matched, excluded } = classify();
      const closedIds = [];
      /** @type {{id: string, title: string, reason: string}[]} */
      const failed = [];
      for (const item of matched) {
        const allowed = await unsavedGuardFor(item.id);
        if (!allowed) {
          failed.push({ ...item, reason: 'unsaved work' });
          continue;
        }
        if (destroyTab(item.id)) closedIds.push(item.id);
        else failed.push({ ...item, reason: 'could not close' });
      }
      return {
        closed: closedIds,
        excluded: excluded.map((entry) => ({ ...entry })),
        failed,
      };
    },
  };
}

/* ------------------------------- Menus/pickers ----------------------------- */

function buildMenu(items, anchorElement) {
  const menu = ui.el('div', { class: 'mrb-menu', role: 'menu' });
  for (const item of items) {
    if (!item) continue;
    if (item.separator) {
      menu.appendChild(ui.el('hr', { class: 'mrb-menu-separator' }));
      continue;
    }
    const shortcutCombo = item.shortcutId ? shortcutForAction(item.shortcutId) : item.shortcut || null;
    const button = ui.el('button', {
      type: 'button',
      class: 'mrb-menu-item',
      role: 'menuitem',
      disabled: item.disabled === true ? '' : null,
    });
    button.appendChild(ui.el('span', { text: item.label }));
    if (shortcutCombo) {
      button.appendChild(ui.el('kbd', { class: 'mrb-kbd', text: shortcutCombo }));
    } else {
      button.appendChild(ui.el('span'));
    }
    button.addEventListener('click', () => {
      closeMenu();
      if (typeof item.fn === 'function') item.fn();
    });
    menu.appendChild(button);
  }
  return ui.anchored(anchorElement, menu);
}

let closeCurrentMenu = null;
function openMenu(items, anchor) {
  if (closeCurrentMenu) closeCurrentMenu();
  closeCurrentMenu = buildMenu(items, anchor);
}

function closeMenu() {
  if (closeCurrentMenu) {
    closeCurrentMenu();
    closeCurrentMenu = null;
  }
}

function openTabMenu(id, anchor) {
  const def = tabs.get(id);
  const state = tabState.get(id);
  if (!def || !state) return;
  const items = [
    {
      label: state.pinned ? i18n.t('common.unpin') : i18n.t('common.pin'),
      fn: () => pin(id, !state.pinned),
    },
    { label: i18n.t('common.moveToGroup'), fn: () => openMovePicker(id, anchor) },
    { label: i18n.t('common.duplicate'), fn: () => duplicateTab(id) },
    { separator: true },
    {
      label: i18n.t('common.close'),
      shortcutId: 'tab.close',
      disabled: def.closable === false,
      fn: () => void closeTabWithGuard(id),
    },
    {
      label: 'Close other tabs',
      fn: () => void closeOthers(id),
    },
    {
      label: 'Close tabs to the right',
      fn: () => void closeToRight(id),
    },
    { separator: true },
    {
      label: i18n.t('common.editAppearance'),
      fn: () => requestAppearanceEditor(document.getElementById('mrb-tab-btn-' + id) || anchor, 'tab', id),
    },
    {
      label: i18n.t('common.lock') + ' this tab…',
      fn: () =>
        window.dispatchEvent(
          new CustomEvent('mrb-lock-target', { detail: { kind: 'tab', tabId: id } })
        ),
    },
    { separator: true },
    {
      label: i18n.t('shortcuts.title'),
      fn: () => openShortcutsPanel(anchor),
    },
  ];
  // Feature lanes may extend the tab menu with their own entries.
  for (const extra of def.ctxMenuItems || []) {
    items.splice(items.length - 1, 0, extra);
  }
  openMenu(items, anchor);
}

/** Clone a tab definition under a fresh id and open the clone. */
function duplicateTab(id) {
  const def = tabs.get(id);
  if (!def) return;
  let copyId = id + '-copy';
  let counter = 2;
  while (tabs.has(copyId)) {
    copyId = id + '-copy-' + counter;
    counter += 1;
  }
  registerTab({
    id: copyId,
    title: () => titleOf(def) + ' (copy)',
    iconSvg: def.iconSvg,
    closable: true,
    render: def.render,
    ctxMenuItems: def.ctxMenuItems,
  });
  navigate(copyId);
}

async function closeOthers(keepId) {
  for (const id of knownOrder()) {
    if (id === keepId) continue;
    const state = tabState.get(id) || {};
    const def = tabs.get(id);
    if (!def || def.closable === false || state.pinned) continue;
    if (lockProbe && lockProbe(id)) continue;
    const allowed = await unsavedGuardFor(id);
    if (allowed) destroyTab(id);
  }
}

async function closeToRight(fromId) {
  const visible = visibleOrderedIds();
  const startIndex = visible.indexOf(fromId);
  if (startIndex < 0) return;
  for (const id of visible.slice(startIndex + 1).filter((candidate) => tabs.has(candidate))) {
    const state = tabState.get(id) || {};
    const def = tabs.get(id);
    if (!def || def.closable === false || state.pinned) continue;
    if (lockProbe && lockProbe(id)) continue;
    const allowed = await unsavedGuardFor(id);
    if (allowed) destroyTab(id);
  }
}

function openGroupMenu(groupId, anchor) {
  const group = groups.get(groupId);
  if (!group) return;
  openMenu(
    [
      {
        label: i18n.t('common.renameGroup'),
        fn: () => {
          const form = ui.el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '220px' } });
          const nameInput = ui.el('input', { type: 'text', value: group.name, 'aria-label': i18n.t('common.renameGroup') });
          const colorInput = ui.el('input', { type: 'color', value: group.color, 'aria-label': 'Colour' });
          const apply = ui.el('button', { type: 'button', class: ['mrb-btn', 'filled'], text: i18n.t('common.apply') });
          apply.addEventListener('click', () => {
            renameGroup(groupId, nameInput.value, colorInput.value);
            closeMenu();
          });
          form.append(nameInput, colorInput, apply);
          closeCurrentMenu = ui.anchored(anchor, form);
          nameInput.focus();
        },
      },
      {
        label: group.collapsed ? i18n.t('common.prev') + ' (expand)' : 'Collapse',
        fn: () => toggleGroup(groupId, !group.collapsed),
      },
      {
        label: 'Remove group (keep tabs)',
        fn: () => removeGroupKeepTabs(groupId),
      },
    ],
    anchor
  );
}

function openOverflowMenu(anchor) {
  const visible = visibleOrderedIds();
  const items = visible.map((id) => ({
    label: titleOf(tabs.get(id)),
    fn: () => navigate(id),
  }));
  if (items.length === 0) {
    items.push({ label: i18n.t('common.noResults'), disabled: true, fn: () => {} });
  }
  openMenu(items, anchor);
}

/** "Move… into group…" anchored picker with search, create-new, keyboard nav. */
function openMovePicker(tabId, anchor) {
  const panel = ui.el('div', { class: 'mrb-anchor-panel', style: { padding: '12px', gap: '10px', display: 'flex', flexDirection: 'column' } });
  panel.style.minWidth = '260px';

  const searchInput = ui.el('input', {
    type: 'search',
    placeholder: i18n.t('common.search'),
    'aria-label': i18n.t('common.search'),
  });
  panel.appendChild(searchInput);

  const listWrap = ui.el('div', { role: 'listbox', 'aria-label': i18n.t('common.moveToGroup'), style: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '40vh', overflow: 'auto' } });
  panel.appendChild(listWrap);

  const newRow = ui.el('div', { class: 'mrb-searchbar' });
  const newName = ui.el('input', { type: 'text', placeholder: i18n.t('common.newGroup'), 'aria-label': i18n.t('common.newGroup') });
  const createButton = ui.el('button', { type: 'button', class: ['mrb-chip'], text: i18n.t('common.newGroup') });
  newRow.append(newName, createButton);
  panel.appendChild(newRow);

  function renderList(filterText) {
    listWrap.replaceChildren();
    const needle = String(filterText || '').toLowerCase();
    const available = groupsList().filter((group) => group.name.toLowerCase().includes(needle));

    const noGroupOption = ui.el('button', {
      type: 'button',
      role: 'option',
      class: 'mrb-menu-item',
      text: 'No group',
    });
    noGroupOption.addEventListener('click', () => finish(null));
    listWrap.appendChild(noGroupOption);

    for (const group of available) {
      const row = ui.el('button', {
        type: 'button',
        role: 'option',
        class: 'mrb-menu-item',
      });
      row.appendChild(ui.el('span', { class: 'mrb-tab-group-dot', style: { background: group.color }, 'aria-hidden': 'true' }));
      row.appendChild(ui.el('span', { text: group.name }));
      row.appendChild(ui.el('kbd', { class: 'mrb-kbd', text: String(group.count) }));
      row.addEventListener('click', () => finish(group.id));
      listWrap.appendChild(row);
    }

    if (available.length === 0) {
      listWrap.appendChild(
        ui.el('p', { class: 'mrb-field-support', text: 'No groups yet. Create one below or choose No group.' })
      );
    }
  }

  function finish(groupId) {
    moveTab(tabId, groupId);
    closePicker();
  }

  createButton.addEventListener('click', () => {
    const groupId = createGroup(newName.value);
    moveTab(tabId, groupId);
    closePicker();
  });
  newName.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') createButton.click();
  });

  let closePicker = null;
  searchInput.addEventListener('input', () => renderList(searchInput.value));
  renderList('');
  closePicker = ui.anchored(anchor, panel, {
    onClose: () => {
      closePicker = null;
    },
  });
  searchInput.focus();
}

/* --------------------------- Four discovery searches ------------------------ */

const SEARCH_SCOPES = [
  { key: 'strip', label: 'Current strip' },
  { key: 'groups', label: 'Inside groups' },
  { key: 'groupNames', label: 'Group names' },
  { key: 'all', label: 'All tabs' },
];

function openSearchHub(anchor) {
  const hub = ui.el('div', { class: 'mrb-anchor-panel', style: { width: '420px', maxWidth: 'calc(100vw - 24px)', padding: '12px', gap: '10px', display: 'flex', flexDirection: 'column' } });

  const scopeSeg = ui.el('div', { class: 'mrb-seg', role: 'tablist', 'aria-label': i18n.t('common.search') });
  const scopeRows = new Map();
  let activeScope = 'strip';

  function runQuery(scopeKey) {
    const row = scopeRows.get(scopeKey);
    if (!row) return;
    const input = row.input;
    const resultsHost = row.results;
    resultsHost.replaceChildren();
    let results;
    try {
      results = search(input.value, {
        mode: row.mode,
        flags: row.flags,
        scope: scopeKey,
      });
    } catch (err) {
      resultsHost.appendChild(
        ui.el('p', { class: 'mrb-field-support', role: 'alert', text: err.message })
      );
      return;
    }
    if (!input.value.trim()) {
      resultsHost.appendChild(
        ui.el('p', { class: 'mrb-field-support', text: i18n.t('palette.placeholder') })
      );
      return;
    }
    if (results.length === 0) {
      resultsHost.appendChild(
        ui.el('p', { class: 'mrb-result-count', text: i18n.t('common.noResults') })
      );
      return;
    }
    resultsHost.appendChild(
      ui.el('p', { class: 'mrb-result-count', text: i18n.t('common.selectedCount', { count: results.length }) })
    );

    for (const result of results) {
      const isGroup = Boolean(result.groupId);
      const rowButton = ui.el('button', {
        type: 'button',
        class: 'mrb-list-row',
        style: { minHeight: '44px' },
      });
      rowButton.appendChild(
        ui.el('div', { class: 'mrb-list-body' }, [
          ui.el('span', { class: 'mrb-list-title', text: isGroup ? result.name : result.title }),
          ui.el(
            'span',
            {
              class: 'mrb-list-sub',
              text: isGroup
                ? 'Group · ' + result.count + ' tab(s)'
                : [result.groupName || 'No group', result.pinned ? '· pinned' : ''].join(' ').trim(),
            }
          ),
        ])
      );
      rowButton.addEventListener('click', () => {
        const queryText = row.input.value;
        if (isGroup) {
          activateGroupResult(result.groupId, queryText);
        } else {
          activateTabResult(result.id, queryText);
        }
      });
      resultsHost.appendChild(rowButton);
    }
  }

  function revealTab(id, queryText) {
    if (typeof queryText === 'string' && queryText.trim()) {
      lastQueryByTab.set(id, queryText.trim());
    }
    const state = tabState.get(id);
    let restoreCollapse = null;
    if (state && state.groupId) {
      const group = groups.get(state.groupId);
      if (group && group.collapsed) {
        restoreCollapse = group.id;
        group.collapsed = false;
      }
    }
    renderStrip();
    navigate(id);
    const button = document.getElementById('mrb-tab-btn-' + id);
    if (button instanceof HTMLElement) {
      button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      button.classList.add('is-revealed');
      window.setTimeout(() => button.classList.remove('is-revealed'), 1600);
    }
    // Restore the collapsed preference without destroying it.
    if (restoreCollapse) {
      window.setTimeout(() => {
        const group = groups.get(restoreCollapse);
        if (group) {
          group.collapsed = true;
          renderStrip();
          persistLayout();
        }
      }, 1800);
    }
  }

  function activateTabResult(id, queryText) {
    revealTab(id, queryText);
    closeHub();
  }
  function activateGroupResult(groupId, queryText) {
    const group = groups.get(groupId);
    if (group && group.collapsed) {
      group.collapsed = false;
      renderStrip();
      window.setTimeout(() => {
        const fresh = groups.get(groupId);
        if (fresh) {
          fresh.collapsed = true;
          renderStrip();
          persistLayout();
        }
      }, 1800);
    }
    const firstMember = knownOrder().find((id) => {
      const state = tabState.get(id);
      return state && state.groupId === groupId && !state.pinned;
    });
    if (firstMember) revealTab(firstMember, queryText);
    closeHub();
  }

  for (const scope of SEARCH_SCOPES) {
    scopeSeg.appendChild(
      ui.el('button', {
        type: 'button',
        role: 'tab',
        text: scope.label,
        'data-scope': scope.key,
        onclick: () => setActiveScope(scope.key),
      })
    );
  }
  hub.appendChild(scopeSeg);

  for (const scope of SEARCH_SCOPES) {
    const input = ui.el('input', {
      type: 'search',
      placeholder: scope.label + ' — ' + i18n.t('palette.placeholder'),
      'aria-label': scope.label,
      'data-search-scope': scope.key,
    });
    input.addEventListener('input', () => runQuery(scope.key));
    const builderButton = ui.el('button', {
      type: 'button',
      class: 'mrb-searchbar-builder',
      'aria-label': i18n.t('palette.open'),
      title: i18n.t('palette.open'),
      text: '.*',
    });
    builderButton.addEventListener('click', async () => {
      try {
        const mod = await import('./regexbuilder.js');
        if (mod && typeof mod.openBuilder === 'function') mod.openBuilder(input);
      } catch {
        ui.toast({ title: 'The regex builder is not installed in this build.', tone: 'warn' });
      }
    });
    const bar = ui.el('div', { class: 'mrb-searchbar' }, input, builderButton);
    const results = ui.el('div', { style: { marginTop: '8px' } });
    const wrapper = ui.el('div', {}, bar, results);
    hub.appendChild(wrapper);
    scopeRows.set(scope.key, {
      input,
      results,
      wrapper,
      mode: 'plain',
      flags: '',
    });

    import('./regexbuilder.js')
      .then((mod) => {
        if (mod && typeof mod.attachSearch === 'function') {
          mod.attachSearch(input, {
            onQuery: (query, meta) => {
              const record = scopeRows.get(scope.key);
              if (record) {
                record.mode = meta && meta.mode === 'regex' ? 'regex' : 'plain';
                record.flags = (meta && meta.flags) || '';
              }
              runQuery(scope.key);
            },
          });
        }
      })
      .catch(() => {
        /* regex-builder lane absent - plain search above still works */
      });
  }

  function setActiveScope(scopeKey) {
    activeScope = scopeKey;
    for (const [key, record] of scopeRows.entries()) {
      record.wrapper.hidden = key !== scopeKey;
    }
    for (const button of scopeSeg.querySelectorAll('button')) {
      button.setAttribute('aria-selected', button.dataset.scope === scopeKey ? 'true' : 'false');
    }
    const record = scopeRows.get(scopeKey);
    if (record instanceof Object) record.input.focus();
  }

  hub.hidden = false;
  let closeHubRef = null;
  function closeHub() {
    if (closeHubRef) closeHubRef();
  }
  closeHubRef = ui.anchored(anchor, hub, {
    onClose: () => {
      closeHubRef = null;
      anchor.focus({ preventScroll: true });
    },
  });

  // Bulk close flows live beside the searches: containing / NOT containing.
  const bulkSection = ui.el('details', { style: { marginTop: '8px' } });
  bulkSection.appendChild(ui.el('summary', { text: i18n.t('common.bulkClose'), style: { cursor: 'pointer' } }));

  const bulkBar = ui.el('div', { class: 'mrb-searchbar', style: { marginTop: '8px' } });
  const bulkInput = ui.el('input', { type: 'search', placeholder: 'Text to match against tab titles', 'aria-label': 'Bulk close match text' });
  const negateToggle = ui.el('label', { class: 'mrb-checkbox' });
  const negateCheck = ui.el('input', { type: 'checkbox' });
  negateToggle.append(negateCheck, ui.el('span', { text: 'NOT containing' }));
  const pinnedToggle = ui.el('label', { class: 'mrb-checkbox' });
  const pinnedCheck = ui.el('input', { type: 'checkbox' });
  pinnedToggle.append(pinnedCheck, ui.el('span', { text: 'Include pinned' }));
  const bulkPreviewLine = ui.el('p', { class: 'mrb-field-support', role: 'status' });
  const bulkGo = ui.el('button', { type: 'button', class: ['mrb-btn', 'danger'], text: 'Close matched tabs' });

  function currentBulkController() {
    return bulkClose(bulkInput.value, {
      negate: negateCheck.checked,
      includePinned: pinnedCheck.checked,
      mode: 'plain',
    });
  }

  function refreshBulkPreview() {
    if (!bulkInput.value.trim()) {
      bulkPreviewLine.textContent = 'Type text to preview which tabs would close.';
      bulkGo.disabled = true;
      return;
    }
    try {
      const { matched, excluded } = currentBulkController().preview();
      bulkPreviewLine.textContent =
        matched.length + ' will close; ' + excluded.length + ' excluded (pinned/locked/not closable).';
      bulkGo.disabled = matched.length === 0;
    } catch {
      bulkPreviewLine.textContent = 'Invalid pattern.';
      bulkGo.disabled = true;
    }
  }

  bulkGo.disabled = true;
  bulkInput.addEventListener('input', refreshBulkPreview);
  negateCheck.addEventListener('change', refreshBulkPreview);
  pinnedCheck.addEventListener('change', refreshBulkPreview);
  bulkGo.addEventListener('click', () => {
    if (!bulkInput.value.trim()) return;
    ui.superConfirm({
      title: 'Close ' + currentBulkController().preview().matched.length + ' tab(s)',
      detailHtml:
        '<p>Closing matched tabs. Pinned tabs are skipped unless you ticked include-pinned. Tabs with unsaved work are kept.</p>',
      confirmLabel: i18n.t('common.bulkClose'),
      onConfirm: async () => {
        const outcome = await currentBulkController().apply();
        ui.toast({
          title: 'Closed ' + outcome.closed.length + ', kept ' + (outcome.excluded.length + outcome.failed.length) + '.',
          body: outcome.failed.map((entry) => entry.title + ': ' + entry.reason).join('; ') || '',
          tone: 'ok',
        });
      },
    });
  });

  bulkSection.append(bulkBar, negateToggle, pinnedToggle, bulkPreviewLine, bulkGo);
  hub.appendChild(bulkSection);

  setActiveScope(activeScope);
}

function openShortcutsPanel(anchor) {
  const panel = ui.el('div', { class: 'mrb-anchor-panel', style: { padding: '12px', gap: '6px' } });
  panel.appendChild(ui.el('strong', { text: i18n.t('shortcuts.title') }));
  const entries = [...shortcuts.values()];
  if (entries.length === 0) {
    panel.appendChild(ui.el('p', { class: 'mrb-field-support', text: i18n.t('common.noResults') }));
  }
  for (const entry of entries) {
    const row = ui.el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center' } });
    row.appendChild(ui.el('span', { text: entry.desc || entry.id || 'Command' }));
    row.appendChild(ui.el('kbd', { class: 'mrb-kbd', text: entry.combo }));
    panel.appendChild(row);
  }
  ui.anchored(anchor, panel);
}

/* --------------------------- Appearance / locks hooks ---------------------- */

function requestAppearanceEditor(element, kind, tabId) {
  window.dispatchEvent(
    new CustomEvent('mrb-edit-element-appearance', {
      detail: { el: element, kind, tabId },
    })
  );
  // Honest fallback when the appearance lane is absent.
  window.setTimeout(() => {
    if (!window.__mrbAppearanceEditorReady) {
      ui.toast({
        title: 'The appearance editor is not installed in this build.',
        tone: 'warn',
      });
    }
  }, 400);
}

function editAppearance(target) {
  if (target instanceof HTMLElement) {
    requestAppearanceEditor(target, 'element', null);
    return;
  }
  const id = target && typeof target === 'object' ? target.tabId : null;
  const element = id ? document.getElementById('mrb-tab-btn-' + id) : null;
  requestAppearanceEditor(element, (target && target.kind) || 'element', id);
}

/** Locks lane registers a probe so locked tabs stay out of destructive flows. */
function setLockProbe(fn) {
  lockProbe = typeof fn === 'function' ? fn : null;
}

/* -------------------------------- Home stub -------------------------------- */

function registerHomePlaceholder() {
  registerTab({
    id: 'home',
    title: () => i18n.t('tabs.home'),
    iconSvg:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>',
    closable: false,
    render(panelEl) {
      panelEl.appendChild(
        ui.el('div', { class: 'mrb-empty-state' }, [
          ui.el('img', { src: '../assets/logo.svg', alt: '', width: '96', height: '96' }),
          ui.el('h1', { text: i18n.t('home.placeholderTitle') }),
          ui.el('p', { text: i18n.t('home.placeholderBody') }),
          ui.el('button', {
            type: 'button',
            class: ['mrb-btn', 'tonal'],
            text: i18n.t('home.openSettings'),
            onclick: () => navigate('settings'),
          }),
        ])
      );
    },
  });
}

/** Runs once at the very end of the boot turn: only fills a genuinely empty slot. */
function ensureHomePlaceholder() {
  window.setTimeout(() => {
    if (!tabs.has('home')) registerHomePlaceholder();
  }, 0);
}

/* --------------------------------- Exports --------------------------------- */

export const router = {
  registerTab,
  navigate,
  current,
  list,
  setDock,
  dock,
  pin,
  createGroup,
  renameGroup,
  moveTab,
  toggleGroup,
  groups: groupsList,
  search,
  bulkClose,
  editAppearance,
  setLockProbe,
  ensureHomePlaceholder,

  /** Additive helper for lanes that need the shortcut table directly. */
  shortcuts: () => [...shortcuts.values()],
};

export async function init() {
  restoreLayout();

  const strip = stripElement();
  const app = appElement();
  if (strip) {
    strip.setAttribute('role', 'tablist');
    strip.setAttribute('aria-orientation', isVertical() ? 'vertical' : 'horizontal');
  }
  if (app) app.dataset.dock = dockEdge;

  registerShortcut('Ctrl+W', () => {
    const id = currentId;
    if (id) void closeTabWithGuard(id);
  }, { id: 'tab.close', desc: 'Close current tab' });

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    const combo = comboFromEvent(event);
    if (!combo) return;
    const entry = shortcuts.get(combo);
    if (entry) {
      event.preventDefault();
      event.stopPropagation();
      try {
        entry.fn(event);
      } catch (err) {
        console.error('[router] shortcut failed:', combo, err);
      }
    }
  });

  window.addEventListener('mrb-lang-changed', () => {
    if (mounted) renderStrip();
  });

  mounted = true;
  renderStrip();

  const initial = currentId && tabs.has(currentId) ? currentId : visibleOrderedIds()[0];
  if (initial) navigate(initial);

  ensureHomePlaceholder();
}
