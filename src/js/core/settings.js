/**
 * Settings registry: typed definitions, user values, temporary overrides,
 * provenance reporting, and the Settings tab surface itself.
 *
 * Lanes call settings.register(defs) during their own init(); definitions are
 * merged by key with last-wins and a console warning on duplicates. Values
 * resolve override -> user -> definition default. The schedule lane drives
 * setOverride()/clearOverrides(). Every user change records a history entry
 * (kind "settings") through the optional history lane, guarded so a missing
 * history module never blocks changing a setting.
 */

import { store } from './store.js';
import { i18n } from './i18n.js';
import { ui } from './ui.js';

const STORE_KEY = 'settings';
const VALID_TYPES = ['toggle', 'slider', 'select', 'text', 'color', 'font', 'path', 'hotkey', 'custom'];

/** @type {Map<string, object>} */
const defsByKey = new Map();
/** Insertion-ordered group names. */
const groupOrder = [];
/** @type {Map<string, {value: any, sourceId: string}>} */
const overrides = new Map();
let userValues = {};
/** @type {Set<(detail: object) => void>} */
const listeners = new Set();

/* ------------------------------- Registry --------------------------------- */

function normalizeDef(raw) {
  if (!raw || typeof raw.key !== 'string' || !raw.key.includes('.')) {
    console.warn('[settings] Rejected a definition without a dotted key:', raw && raw.key);
    return null;
  }
  if (!VALID_TYPES.includes(raw.type)) {
    console.warn('[settings] Rejected definition with unknown type:', raw.key, raw.type);
    return null;
  }
  const label = raw.label && typeof raw.label === 'object' ? raw.label : { en: raw.key };
  const explain =
    raw.explain && typeof raw.explain === 'object' ? raw.explain : { en: '', yue: '' };
  return {
    key: raw.key,
    type: raw.type,
    def: raw.def !== undefined ? raw.def : defaultValueForType(raw.type),
    group: typeof raw.group === 'string' ? raw.group : 'advanced',
    label,
    explain,
    options: Array.isArray(raw.options) ? raw.options : undefined,
    min: typeof raw.min === 'number' ? raw.min : undefined,
    max: typeof raw.max === 'number' ? raw.max : undefined,
    step: typeof raw.step === 'number' ? raw.step : undefined,
    unit: typeof raw.unit === 'string' ? raw.unit : undefined,
    render: typeof raw.render === 'function' ? raw.render : undefined,
  };
}

function defaultValueForType(type) {
  switch (type) {
    case 'toggle':
      return false;
    case 'slider':
      return 0;
    case 'select':
      return '';
    case 'color':
      return '#000000';
    case 'font':
      return '';
    case 'path':
      return '';
    case 'hotkey':
      return '';
    default:
      return '';
  }
}

function ensureGroup(group) {
  if (!groupOrder.includes(group)) groupOrder.push(group);
}

export const settings = {
  /** Merge definitions; duplicate keys warn and last one wins. */
  register(defs) {
    if (!Array.isArray(defs)) return;
    for (const raw of defs) {
      const def = normalizeDef(raw);
      if (!def) continue;
      if (defsByKey.has(def.key)) {
        console.warn('[settings] Duplicate definition replaced:', def.key);
      }
      defsByKey.set(def.key, def);
      ensureGroup(def.group);
    }
  },

  /** All registered definitions, sorted stably by group order then key. */
  defs() {
    return [...defsByKey.values()].sort((a, b) => {
      const groupDelta = groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group);
      if (groupDelta !== 0) return groupDelta;
      return a.key.localeCompare(b.key);
    });
  },

  /** Resolve a dot-path value: override, then user value, then default. */
  get(path, fallback) {
    const override = overrides.get(path);
    if (override) return override.value;
    if (Object.prototype.hasOwnProperty.call(userValues, path)) {
      const value = userValues[path];
      return value === undefined || value === null ? fallback : value;
    }
    const def = defsByKey.get(path);
    if (def) {
      return def.def === undefined ? fallback : def.def;
    }
    return fallback;
  },

  /** Persist a user value and record it in history (when history exists). */
  set(path, value) {
    userValues[path] = value;
    store.set(STORE_KEY, userValues);
    notify({ path, value, origin: 'user' });
    void recordChange(path);
    return value;
  },

  /**
   * Reset user values. Pass "*" for everything or a group/prefix such as
   * "appearance" (matches the exact key and every child path).
   */
  reset(prefixOrAll) {
    const changed = [];
    if (prefixOrAll === '*') {
      changed.push(...Object.keys(userValues));
      userValues = {};
    } else {
      const prefix = String(prefixOrAll);
      for (const key of Object.keys(userValues)) {
        if (key === prefix || key.startsWith(prefix + '.')) {
          delete userValues[key];
          changed.push(key);
        }
      }
    }
    if (changed.length > 0) store.set(STORE_KEY, userValues);
    for (const path of changed) {
      notify({ path, value: settings.get(path), origin: 'reset' });
    }
    return changed.length;
  },

  provenance(path) {
    const def = defsByKey.get(path);
    const isUser =
      overrides.has(path) || Object.prototype.hasOwnProperty.call(userValues, path);
    const base = {
      source: isUser ? 'user' : 'default',
      default: def ? def.def : undefined,
    };
    if (overrides.has(path)) {
      base.override = { ...overrides.get(path) };
    }
    return base;
  },

  onChange(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return function unsubscribe() {
      listeners.delete(fn);
    };
  },

  /** Temporary value layer used by the scheduled-settings lane. */
  setOverride(path, value, sourceId) {
    overrides.set(path, { value, sourceId: String(sourceId || 'external') });
    notify({ path, value, origin: 'override' });
  },

  clearOverrides(sourceId) {
    const cleared = [];
    for (const [path, entry] of [...overrides.entries()]) {
      if (sourceId === undefined || entry.sourceId === sourceId) {
        overrides.delete(path);
        cleared.push(path);
        notify({ path, value: settings.get(path), origin: 'override-cleared' });
      }
    }
    return cleared;
  },
};

function notify(detail) {
  for (const fn of listeners) {
    try {
      fn(detail);
    } catch (err) {
      console.error('[settings] listener failed:', err);
    }
  }
}

async function recordChange(path) {
  try {
    const mod = await import('./history.js');
    const def = defsByKey.get(path);
    const labelBase = def && def.label && def.label.en ? def.label.en : path;
    if (mod && mod.history && typeof mod.history.record === 'function') {
      await mod.history.record({ kind: 'settings', label: 'Changed: ' + labelBase });
    }
  } catch {
    /* history lane absent - the setting still applies */
  }
}

/* --------------------------- Settings tab surface -------------------------- */

const GEAR_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06A1.7 1.7 0 0015 19.4a1.7 1.7 0 00-1 1.56V21a2 2 0 11-4 0v-.09A1.7 1.7 0 009 19.4a1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.7 1.7 0 004.6 15a1.7 1.7 0 00-1.56-1H3a2 2 0 110-4h.09A1.7 1.7 0 004.6 9a1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06A1.7 1.7 0 009 4.6a1.7 1.7 0 001-1.56V3a2 2 0 114 0v.09a1.7 1.7 0 001 1.51 1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06A1.7 1.7 0 0019.4 9c.14.35.4.63.72.81.28.16.6.24.93.24H21a2 2 0 110 4h-.09a1.7 1.7 0 00-1.51 1z"/></svg>';

function defLabelText(def) {
  const primary = def.label && def.label.en ? def.label.en : def.key;
  const secondary = def.label && def.label.yue ? def.label.yue : null;
  return { primary: i18n.applyVocabulary(primary), secondary };
}

function buildControl(def, onChangeValue) {
  const current = settings.get(def.key, def.def);

  if (def.type === 'custom') {
    const host = ui.el('div');
    if (typeof def.render === 'function') {
      try {
        def.render(host);
      } catch (err) {
        console.error('[settings] custom renderer failed:', def.key, err);
        host.textContent = 'This setting failed to render.';
      }
    }
    return host;
  }

  if (def.type === 'toggle') {
    const wrap = ui.el('label', { class: 'mrb-switch' });
    const input = ui.el('input', { type: 'checkbox', role: 'switch' });
    input.checked = Boolean(current);
    input.addEventListener('change', () => onChangeValue(input.checked));
    wrap.append(input, ui.el('span', { class: 'mrb-switch-track' }), ui.el('span', { class: 'mrb-switch-thumb' }));
    return wrap;
  }

  if (def.type === 'slider') {
    const wrap = ui.el('div', { class: 'mrb-slider' });
    const input = ui.el('input', {
      type: 'range',
      min: String(def.min ?? 0),
      max: String(def.max ?? 100),
      step: String(def.step ?? 1),
      'aria-label': defLabelText(def).primary,
    });
    input.value = String(Number.isFinite(Number(current)) ? Number(current) : def.min ?? 0);
    const bubble = ui.el('output', { class: 'mrb-slider-bubble' });
    const paint = () => {
      const value = Number(input.value);
      const span = Number(def.max ?? 100) - Number(def.min ?? 0) || 1;
      input.style.setProperty('--mrb-slider-fill', ((value - Number(def.min ?? 0)) / span) * 100 + '%');
      bubble.textContent = String(value) + (def.unit ? ' ' + def.unit : '');
    };
    input.addEventListener('input', () => {
      paint();
      onChangeValue(Number(input.value));
    });
    paint();
    wrap.append(input, bubble);
    return wrap;
  }

  if (def.type === 'select') {
    const wrap = ui.el('div', { class: 'mrb-select' });
    const select = ui.el('select', { 'aria-label': defLabelText(def).primary });
    for (const option of def.options || []) {
      const optionEl = ui.el('option', { value: String(option.value) });
      optionEl.textContent = option.label && option.label.en ? option.label.en : String(option.value);
      if (String(option.value) === String(current)) optionEl.selected = true;
      select.appendChild(optionEl);
    }
    select.addEventListener('change', () => onChangeValue(select.value));
    wrap.appendChild(select);
    return wrap;
  }

  if (def.type === 'color') {
    const wrap = ui.el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } });
    const swatch = ui.el('input', { type: 'color', 'aria-label': defLabelText(def).primary, style: { width: '44px', height: '44px', border: 'none', background: 'transparent' } });
    const text = ui.el('input', { type: 'text', spellcheck: 'false', 'aria-label': 'Hex color' });
    const initial = /^#[0-9a-fA-F]{6}$/.test(String(current)) ? String(current) : '#000000';
    swatch.value = initial;
    text.value = initial;
    swatch.addEventListener('input', () => {
      text.value = swatch.value;
      onChangeValue(swatch.value);
    });
    text.addEventListener('change', () => {
      if (/^#[0-9a-fA-F]{6}$/.test(text.value)) {
        swatch.value = text.value;
        onChangeValue(text.value);
      }
    });
    wrap.append(swatch, text);
    return wrap;
  }

  if (def.type === 'font') {
    const wrap = ui.el('div', { class: 'mrb-select' });
    const select = ui.el('select', { 'aria-label': defLabelText(def).primary });
    const stacks = [
      { value: '', label: { en: 'System default' } },
      { value: '"Segoe UI", system-ui, sans-serif', label: { en: 'Segoe UI' } },
      { value: 'Arial, sans-serif', label: { en: 'Arial' } },
      { value: '"Cascadia Code", Consolas, monospace', label: { en: 'Cascadia Code' } },
      { value: '"Microsoft JhengHei", sans-serif', label: { en: 'Microsoft JhengHei' } },
      { value: 'serif', label: { en: 'Serif' } },
    ];
    for (const stack of stacks) {
      const optionEl = ui.el('option', { value: stack.value });
      optionEl.textContent = stack.label.en;
      if (stack.value === String(current)) optionEl.selected = true;
      select.appendChild(optionEl);
    }
    select.addEventListener('change', () => onChangeValue(select.value));
    wrap.appendChild(select);
    return wrap;
  }

  if (def.type === 'path') {
    const wrap = ui.el('div', { class: 'mrb-searchbar' });
    const input = ui.el('input', { type: 'text', spellcheck: 'false', placeholder: 'Choose a folder…' });
    input.value = String(current ?? '');
    const browse = ui.el('button', { type: 'button', class: ['mrb-btn', 'outlined'], text: 'Browse…' });
    browse.addEventListener('click', async () => {
      try {
        const picked = await window.mrb.invoke('dialog:open', { dir: true });
        if (Array.isArray(picked) && picked[0]) {
          input.value = picked[0];
          onChangeValue(picked[0]);
        }
      } catch (err) {
        ui.toast({ title: err && err.message ? String(err.message) : 'Could not open the folder picker.', tone: 'warn' });
      }
    });
    input.addEventListener('change', () => onChangeValue(input.value));
    wrap.append(input, browse);
    return wrap;
  }

  if (def.type === 'hotkey') {
    const wrap = ui.el('div', { class: 'mrb-searchbar' });
    const display = ui.el('span', { class: 'mrb-kbd', text: String(current || 'Not set') });
    const record = ui.el('button', { type: 'button', class: ['mrb-btn', 'outlined'], text: 'Record' });
    let recording = false;
    record.addEventListener('click', () => {
      if (recording) return;
      recording = true;
      record.disabled = true;
      display.textContent = 'Press keys…';
      const onKey = (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') {
          window.removeEventListener('keydown', onKey, true);
          recording = false;
          record.disabled = false;
          display.textContent = String(current || 'Not set');
          return;
        }
        const parts = [];
        if (event.ctrlKey) parts.push('Ctrl');
        if (event.altKey) parts.push('Alt');
        if (event.shiftKey) parts.push('Shift');
        if (event.metaKey) parts.push('Meta');
        const main = event.key.length === 1 ? event.key.toUpperCase() : event.key;
        if (main !== 'Control' && main !== 'Alt' && main !== 'Shift' && main !== 'Meta') {
          parts.push(main);
          const combo = parts.join('+');
          display.textContent = combo;
          window.removeEventListener('keydown', onKey, true);
          recording = false;
          record.disabled = false;
          onChangeValue(combo);
        }
      };
      window.addEventListener('keydown', onKey, true);
    });
    wrap.append(display, record);
    return wrap;
  }

  // text
  const input = ui.el('input', { type: 'text', spellcheck: 'false', 'aria-label': defLabelText(def).primary });
  input.value = String(current ?? '');
  input.addEventListener('change', () => onChangeValue(input.value));
  return input;
}

function buildDefRow(def) {
  const row = ui.el('div', { class: 'mrb-card', 'data-setting-key': def.key });
  const labels = defLabelText(def);
  const titleRow = ui.el('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } });
  titleRow.appendChild(ui.el('strong', { text: labels.primary }));
  if (labels.secondary) {
    titleRow.appendChild(
      ui.el('span', { class: 'mrb-field-support', lang: 'zh-Hant', text: labels.secondary })
    );
  }
  if (overrides.has(def.key)) {
    titleRow.appendChild(ui.el('span', { class: 'mrb-badge error', text: i18n.t('settings.overrideBadge') }));
  }
  row.appendChild(titleRow);

  const controlHost = ui.el('div');
  controlHost.appendChild(
    buildControl(def, (value) => {
      settings.set(def.key, value);
      refreshProvenance();
    })
  );
  row.appendChild(controlHost);

  if (def.explain && (def.explain.en || def.explain.yue)) {
    const details = ui.el('details');
    details.appendChild(ui.el('summary', { text: 'What this does', style: { cursor: 'pointer' } }));
    if (def.explain.en) details.appendChild(ui.el('p', { text: def.explain.en }));
    if (def.explain.yue) {
      const p = ui.el('p', { lang: 'zh-Hant', text: def.explain.yue });
      p.style.color = 'var(--mrb-on-surface-variant)';
      details.appendChild(p);
    }
    row.appendChild(details);
  }

  const provenanceLine = ui.el('p', { class: 'mrb-field-support' });
  row.appendChild(provenanceLine);

  const provenanceButton = ui.el('button', {
    type: 'button',
    class: ['mrb-chip'],
    text: i18n.t('settings.resetOne'),
  });
  provenanceButton.addEventListener('click', () => {
    // A leaf key is its own prefix, so reset() clears exactly this setting.
    settings.reset(def.key);
    refreshProvenance();
    const control = buildControl(def, (value) => {
      settings.set(def.key, value);
      refreshProvenance();
    });
    controlHost.replaceChildren(control);
  });

  const footer = ui.el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } });
  footer.append(provenanceLine, provenanceButton);
  row.appendChild(footer);

  function refreshProvenance() {
    const prov = settings.provenance(def.key);
    if (prov.source === 'user') {
      provenanceLine.textContent = i18n.t('settings.provenance.user');
    } else {
      provenanceLine.textContent = i18n.t('settings.provenance.default', {
        value: JSON.stringify(prov.default),
      });
    }
  }
  refreshProvenance();

  return row;
}

function renderSettingsPanel(container) {
  container.replaceChildren();

  const heading = ui.el('h1', {
    text: i18n.t('tabs.settings'),
    style: { fontSize: 'var(--mrb-type-headline-md-size)', marginBottom: '12px' },
  });
  container.appendChild(heading);

  // Search bar with anchored regex-builder access (guarded when absent).
  const searchBar = ui.el('div', { class: 'mrb-searchbar', style: { maxWidth: '520px' } });
  const searchInput = ui.el('input', {
    type: 'search',
    placeholder: i18n.t('settings.searchPlaceholder'),
    'aria-label': i18n.t('settings.searchPlaceholder'),
  });
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
      if (mod && typeof mod.openBuilder === 'function') mod.openBuilder(searchInput);
    } catch {
      ui.toast({ title: 'The regex builder is not installed in this build.', tone: 'warn' });
    }
  });
  searchInput.addEventListener('input', () => applyFilter(searchInput.value));
  searchBar.append(searchInput, builderButton);
  container.appendChild(searchBar);

  const body = ui.el('div', { style: { marginTop: '16px' } });
  container.appendChild(body);

  let browseMode = null;

  function renderBrowse() {
    body.replaceChildren();
    const groups = [];
    for (const def of settings.defs()) {
      if (!groups.some((entry) => entry.name === def.group)) {
        groups.push({
          name: def.group,
          defs: settings.defs().filter((candidate) => candidate.group === def.group),
        });
      }
    }

    const nav = ui.el('div', { class: 'mrb-seg', role: 'tablist', 'aria-label': i18n.t('settings.groupsNav'), style: { flexWrap: 'wrap' } });
    const panelHost = ui.el('div', { style: { marginTop: '12px' }, role: 'tabpanel' });
    let selectedGroup = browseMode || (groups[0] && groups[0].name) || '';

    function showGroup(name) {
      selectedGroup = name;
      browseMode = name;
      panelHost.replaceChildren();
      const group = groups.find((entry) => entry.name === name);
      if (!group) return;

      const groupTitle = ui.el('h2', {
        text: name.charAt(0).toUpperCase() + name.slice(1),
        style: { fontSize: 'var(--mrb-type-title-lg-size)', margin: '8px 0' },
      });
      panelHost.appendChild(groupTitle);

      for (const def of group.defs) {
        panelHost.appendChild(buildDefRow(def));
      }

      const resetGroup = ui.el('button', {
        type: 'button',
        class: ['mrb-chip'],
        text: i18n.t('settings.resetGroup') + ': ' + name,
        style: { marginTop: '12px' },
      });
      resetGroup.addEventListener('click', () => {
        settings.reset(name);
        renderBrowse();
      });
      panelHost.appendChild(resetGroup);

      for (const button of nav.querySelectorAll('button')) {
        button.setAttribute('aria-pressed', button.dataset.group === name ? 'true' : 'false');
      }
    }

    for (const group of groups) {
      nav.appendChild(
        ui.el('button', {
          type: 'button',
          role: 'tab',
          'data-group': group.name,
          text: group.name,
          onclick: () => showGroup(group.name),
        })
      );
    }
    body.append(nav, panelHost);
    if (selectedGroup) showGroup(selectedGroup);

    const resetAll = ui.el('button', {
      type: 'button',
      class: ['mrb-btn', 'danger'],
      text: i18n.t('settings.resetAll'),
      style: { marginTop: '20px' },
    });
    resetAll.addEventListener('click', () => {
      ui.superConfirm({
        title: i18n.t('settings.resetAll'),
        detailHtml:
          '<p>Every setting returns to its shipped default. Your data files are not touched.</p>',
        confirmLabel: i18n.t('settings.resetAll'),
        onConfirm: () => {
          settings.reset('*');
          renderBrowse();
          ui.toast({ title: i18n.t('settings.resetAll'), tone: 'ok' });
        },
      });
    });
    body.appendChild(resetAll);
  }

  function renderResults(query) {
    body.replaceChildren();
    const needle = query.trim().toLowerCase();
    const matches = settings
      .defs()
      .filter((def) => {
        const haystack = [
          def.key,
          def.label && def.label.en,
          def.label && def.label.yue,
          def.explain && def.explain.en,
          def.group,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(needle);
      });
    if (matches.length === 0) {
      body.appendChild(
        ui.el('div', { class: 'mrb-empty-state' }, [
          ui.el('h3', { text: i18n.t('common.noResults') }),
          ui.el('p', { text: 'Nothing in settings matches "' + query + '".' }),
        ])
      );
      return;
    }
    body.appendChild(ui.el('p', { class: 'mrb-result-count', text: String(matches.length) }));
    for (const def of matches) body.appendChild(buildDefRow(def));
  }

  function applyFilter(query) {
    if (!query || !query.trim()) {
      renderBrowse();
      return;
    }
    renderResults(query);
  }

  // Plain-text filtering works even without the regex-builder lane; when it
  // IS present its attachSearch wires pattern/flag support onto this input.
  import('./regexbuilder.js')
    .then((mod) => {
      if (mod && typeof mod.attachSearch === 'function') {
        mod.attachSearch(searchInput, { onQuery: (q) => applyFilter(q) });
      }
    })
    .catch(() => {
      /* regex builder lane absent - plain filtering above remains */
    });

  renderBrowse();
}

/* ---------------------------------- init ----------------------------------- */

export async function init() {
  const persisted = store.get(STORE_KEY, {});
  if (persisted && typeof persisted === 'object' && !Array.isArray(persisted)) {
    userValues = { ...persisted };
  }

  // Register the Settings tab LAST among core modules' own registrations but
  // BEFORE the router mounts: the router queues definitions given pre-mount.
  try {
    const mod = await import('./router.js');
    mod.router.registerTab({
      id: 'settings',
      title: () => i18n.t('tabs.settings'),
      iconSvg: GEAR_ICON,
      closable: false,
      render(panelEl) {
        renderSettingsPanel(panelEl);
      },
    });
  } catch (err) {
    console.error('[settings] Could not register the settings tab:', err);
  }
}
