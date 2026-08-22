// Site bootstrap: rail tabs, router, context menus, per-element appearance
// editing, command palette, keyboard shortcuts. Each feature module initializes
// inside its own try/catch so one failure degrades alone.

import { el, attachSearch, openContextMenu, toast, anchored, flashHighlight } from './ui.mjs';
import { store } from './store.mjs';
import { i18n, initI18n } from './i18n.mjs';
import { applyAppearance, initSchedule } from './theme.mjs';
import { renderHome, renderFeatures, renderDocs, renderChangelog, renderDownload, renderStatus, renderAbout } from './pages.mjs';

const TABS = [
  ['home', 'nav.home', icon('home'), renderHome],
  ['features', 'nav.features', icon('grid'), renderFeatures],
  ['docs', 'nav.docs', icon('book'), (r) => renderDocs(r)],
  ['changelog', 'nav.changelog', icon('clock'), renderChangelog],
  ['download', 'nav.download', icon('down'), renderDownload],
  ['status', 'nav.status', icon('pulse'), renderStatus],
  ['settings', 'nav.settings', icon('gear'), (r) => import('./settings.mjs').then((m) => m.renderSettings(r))],
  ['about', 'nav.about', icon('info'), renderAbout],
];

function icon(name) {
  const paths = {
    home: 'M12 3 2 12h3v8h6v-6h2v6h6v-8h3L12 3z',
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    book: 'M4 4h9a4 4 0 014 4v12a3 3 0 00-3-3H4zm11 0h5v13h-5z',
    clock: 'M12 3a9 9 0 109 9 9 9 0 00-9-9zm1 5v5l4 2-.8 1.6L11 14V8z',
    down: 'M12 3v10m0 0 4-4m-4 4-4-4M4 19h16',
    pulse: 'M3 12h4l3-8 4 16 3-8h4',
    gear: 'M12 8a4 4 0 104 4 4 4 0 00-4-4zm8.4 4a8.4 8.4 0 01-.1 1.4l2 1.6-2 3.4-2.4-1a8.6 8.6 0 01-2.4 1.4l-.4 2.6h-4l-.4-2.6a8.6 8.6 0 01-2.4-1.4l-2.4 1-2-3.4 2-1.6A8.4 8.4 0 013.6 12a8.4 8.4 0 01.1-1.4l-2-1.6 2-3.4 2.4 1a8.6 8.6 0 012.4-1.4L9 2.6h4l.4 2.6a8.6 8.6 0 012.4 1.4l2.4-1 2 3.4-2 1.6z',
    info: 'M12 2a10 10 0 1010 10A10 10 0 0012 2zm1 15h-2v-6h2zm0-8h-2V7h2z',
  };
  return el('svg', { viewBox: '0 0 24 24', fill: name === 'grid' ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': name === 'grid' ? '0' : '1.8', 'aria-hidden': 'true' },
    el('path', { d: paths[name] }));
}

/* ---------------- boot ---------------- */

async function boot() {
  // Toast region exists before anything can toast.
  document.body.append(el('div', { class: 'toast-region', role: 'log', 'aria-label': 'Notifications' }));

  try { initI18n(); } catch (e) { console.error(e); }
  try { applyAppearance(store.get('appearance', {})); } catch (e) { console.error(e); }
  buildFrame();
  try {
    const { initSecurity } = await import('./security.mjs');
    initSecurity();
  } catch (e) { console.error(e); }
  try {
    const { initAdhd, maybeDimSum } = await import('./delight.mjs');
    initAdhd();
    maybeDimSum();
  } catch (e) { console.error(e); }
  try { initSchedule(); } catch (e) { console.error(e); }
  wireEvents();

  const initial = location.hash.replace('#', '') || store.get('activeTab', 'home');
  navigate(TABS.some(([id]) => id === initial) ? initial : 'home');
}

function buildFrame() {
  const header = document.querySelector('.mrb-header');
  header.append(
    el('span', { class: 'brand' },
      el('img', { src: './favicon.svg', alt: '', width: '30', height: '30' }),
      el('a', { href: '#home', style: 'color:inherit;text-decoration:none' }, i18n.node('app.name'))),
    el('span', { class: 'header-spacer' }),
  );
  if (store.get('adhd.time', false)) window.dispatchEvent(new CustomEvent('mrb-adhd'));

  const rail = document.querySelector('.rail');
  rail.setAttribute('role', 'navigation');
  rail.setAttribute('aria-label', 'Site sections');
  const list = el('ul', { class: 'rail-list', role: 'tablist', 'aria-orientation': 'vertical' });
  for (const [id, key, ic] of TABS) {
    const tab = el('button', { class: 'rail-tab', role: 'tab', id: `tab-${id}`, 'aria-controls': `panel-${id}`, 'aria-selected': 'false', tabindex: '-1' }, ic, el('span', { class: 'tab-label' }, i18n.node(key)));
    tab.addEventListener('click', () => navigate(id));
    list.append(el('li', {}, tab));
  }
  rail.append(list);
  applyDock(store.get('ui.dock', 'left'));

  // Arrow-key roving focus on the tablist.
  list.addEventListener('keydown', (e) => {
    const tabs = [...list.querySelectorAll('.rail-tab')];
    const idx = tabs.indexOf(document.activeElement);
    if (idx < 0) return;
    let next = null;
    if (e.key === 'ArrowDown') next = idx + 1;
    else if (e.key === 'ArrowUp') next = idx - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    const t = tabs[(next + tabs.length) % tabs.length];
    t.focus(); t.click();
  });
}

function applyDock(edge) {
  const app = document.querySelector('.app');
  const rail = document.querySelector('.rail');
  const list = document.querySelector('.rail-list');
  rail.classList.toggle('dock-top', edge === 'top');
  list.setAttribute('aria-orientation', edge === 'top' ? 'horizontal' : 'vertical');
  app.style.gridTemplateColumns = edge === 'right' ? '1fr auto' : 'auto 1fr';
  app.style.gridTemplateAreas = edge === 'top'
    ? '"header" "rail" "main"'
    : edge === 'right' ? '"header header" "main rail"' : '"rail header" "rail main"';
  rail.style.order = '';
  if (edge === 'top') { app.style.gridTemplateRows = 'auto auto 1fr'; }
}

/* ---------------- router ---------------- */

const panels = new Map();

function navigate(id) {
  for (const [pid] of TABS) {
    const panel = ensurePanel(pid);
    const active = pid === id;
    panel.hidden = !active;
    document.querySelector(`#tab-${pid}`)?.setAttribute('aria-selected', String(active));
    document.querySelector(`#tab-${pid}`)?.setAttribute('tabindex', active ? '0' : '-1');
  }
  const [, renderer] = TABS.find(([tid]) => tid === id);
  const panel = ensurePanel(id);
  panel.replaceChildren(el('p', { class: 'applied-note' }, 'Loading…'));
  Promise.resolve(renderer(panel)).catch((err) => {
    console.error(err);
    panel.replaceChildren(el('div', { class: 'status-empty' }, `This section failed to load: ${err.message}`));
  });
  store.set('activeTab', id);
  location.hash = id;
  document.getElementById(`panel-${id}`)?.setAttribute('aria-busy', 'true');
  setTimeout(() => document.getElementById(`panel-${id}`)?.removeAttribute('aria-busy'), 400);
}

function ensurePanel(id) {
  if (!panels.has(id)) {
    const p = el('section', { class: 'panel', role: 'tabpanel', id: `panel-${id}`, 'aria-labelledby': `tab-${id}`, hidden: true });
    document.querySelector('.main').append(p);
    panels.set(id, p);
  }
  return panels.get(id);
}

window.addEventListener('hashchange', () => {
  const id = location.hash.replace('#', '');
  if (TABS.some(([tid]) => tid === id) && store.get('activeTab') !== id) navigate(id);
});

/* ---------------- events & integrations ---------------- */

function wireEvents() {
  // Dock changes from Settings.
  store.onChange('ui.dock', (edge) => edge && applyDock(edge));
  store.onChange('lang', () => {
    // Re-render nav labels and current page copy in the new mode.
    // The label spans carry their own data-i18n nodes, so refilling — not
    // clearing — is what keeps them intact.
    i18n.applyToDom(document);
    const active = store.get('activeTab', 'home');
    navigate(active);
  });
  window.addEventListener('mrb-schedule-lang', (e) => { i18n.setLang(e.detail); i18n.applyToDom(); });
  window.addEventListener('mrb-open-doc', (e) => {
    navigate('docs');
    setTimeout(() => renderDocs(ensurePanel('docs'), normalizeDocPath(e.detail)), 50);
  });
  window.addEventListener('mrb-open-converter', () => import('./converter.mjs').then((m) => m.openConverter()));
  window.addEventListener('mrb-open-auth', () => import('./authenticator.mjs').then((m) => m.openAuthenticator()));
  window.addEventListener('mrb-goto-settings-reset', () => navigate('settings'));
  window.addEventListener('mrb-adhd', () => {
    // Re-render the time chip when toggled.
    const has = !!document.querySelector('.timechip');
    const want = store.get('adhd.time', false);
    if (want && !has) { /* delight module re-renders on its own event */ }
  });

  // Global context menu: Edit appearance… / Lock this element… / Reset element…
  document.addEventListener('contextmenu', (e) => {
    const target = e.target.closest('main .card, main h1, main h2, main h3, main p, main table, main ul, main section, .rail-tab, .hero, .one-thing-banner');
    if (!target || target.closest('.popover')) return;
    e.preventDefault();
    const items = {
      filterable: true,
      list: [
        { label: 'Edit appearance…', shortcut: 'Shift+R-click', action: () => openElementEditor(target) },
        { label: 'Lock this element…', action: async () => {
          const sec = await import('./security.mjs');
          sec.lockElementPrompt(target, target);
        } },
        '-', { label: 'Reset this element’s appearance', action: () => resetElementAppearance(target) },
      ],
    };
    openContextMenu(e.clientX, e.clientY, items);
  });

  // Shift+right-click opens the appearance editor directly.
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 2 || !e.shiftKey) return;
    const target = e.target.closest('main *');
    if (!target) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    openElementEditor(target);
  }, true);

  // Command palette.
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
      e.preventDefault();
      openPalette();
    }
  });
}

function normalizeDocPath(href) {
  const clean = href.split('#')[0];
  if (/^\.\/docs\//.test(clean)) return clean;
  return `./docs/features/${clean}`;
}

/* ---------------- per-element appearance editor ---------------- */

const elemStyles = store.get('elem.styles', {});

function styleKey(target) {
  // Same signature logic as locks so reset/lock/edit agree on identity.
  const parts = [];
  let n = target;
  let depth = 0;
  while (n && n !== document.body && depth < 5) {
    const parent = n.parentElement;
    const idx = parent ? [...parent.children].indexOf(n) + 1 : 0;
    parts.unshift(`${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ''}:nth-child(${idx})`);
    n = parent; depth++;
  }
  return parts.join('>');
}

function applyElementStyle(key) {
  const s = elemStyles[key];
  const target = queryByKey(key);
  if (!target || !s) return;
  Object.assign(target.style, s);
}
function queryByKey(key) {
  try { return document.querySelector(key); } catch { return null; }
}
export function restoreElementStyles() {
  for (const key of Object.keys(elemStyles)) applyElementStyle(key);
}
restoreElementStyles();

function openElementEditor(target) {
  const key = styleKey(target);
  const cur = elemStyles[key] || {};
  const fields = {};
  const mkField = (label, prop, kind = 'text', extra = {}) => {
    const input = kind === 'select'
      ? el('select', { 'aria-label': label }, extra.options.map(([v, l]) => el('option', { value: v, selected: (cur[prop] ?? '') === v ? true : null }, l)))
      : el('input', { type: kind === 'number' ? 'number' : kind, value: cur[prop] ?? '', 'aria-label': label, ...extra.attrs });
    fields[prop] = input;
    return el('div', { class: 'field' }, el('label', {}, label), input);
  };

  const panel = el('div', {},
    el('h3', {}, 'Edit appearance'),
    el('p', { class: 'applied-note' }, el('code', {}, key)),
    el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px' },
      mkField('Font size (px)', 'fontSize', 'number', { attrs: { min: 8, max: 96 } }),
      mkField('Weight', 'fontWeight', 'select', { options: [['', 'inherit'], ['300', 'Light'], ['400', 'Regular'], ['500', 'Medium'], ['700', 'Bold']] }),
      mkField('Style', 'fontStyle', 'select', { options: [['', 'Inherit'], ['italic', 'Italic'], ['oblique', 'Oblique']] }),
      mkField('Transform', 'textTransform', 'select', { options: [['', 'Inherit'], ['none', 'None'], ['uppercase', 'Uppercase'], ['lowercase', 'Lowercase'], ['capitalize', 'Capitalize'], ['small-caps', 'Small caps*']] }),
      mkField('Letter spacing', 'letterSpacing', 'text', { attrs: { placeholder: 'e.g. 0.02em' } }),
      mkField('Line height', 'lineHeight', 'text', { attrs: { placeholder: 'e.g. 1.4' } }),
      mkField('Text colour', 'color', 'text', { attrs: { placeholder: '#hex or css()' } }),
      mkField('Background', 'backgroundColor', 'text', { attrs: { placeholder: 'transparent or #hex' } }),
      mkField('Underline', 'textDecorationLine', 'select', { options: [['', 'Inherit'], ['underline', 'Underline'], ['line-through', 'Strikethrough'], ['underline line-through', 'Both'], ['none', 'None']] }),
      mkField('Border radius', 'borderRadius', 'text', { attrs: { placeholder: 'e.g. 12px' } }),
      mkField('Padding', 'padding', 'text', { attrs: { placeholder: 'CSS padding' } }),
      mkField('Alignment', 'textAlign', 'select', { options: [['', 'Inherit'], ['start', 'Start'], ['center', 'Center'], ['end', 'End']] }),
    ),
    el('p', { class: 'applied-note' }, '* Small caps renders as transform where the platform lacks real synthesis.'),
    el('div', { class: 'dialog-actions' },
      el('button', { class: 'mrb-btn text', onclick: () => { delete elemStyles[key]; store.set('elem.styles', elemStyles); const t = queryByKey(key); if (t) t.removeAttribute('style'); closePanel(); } }, 'Reset this element'),
      el('button', { class: 'mrb-btn tonal', onclick: () => closePanel() }, 'Cancel'),
      el('button', { class: 'mrb-btn filled', onclick: () => {
        const styles = {};
        for (const [prop, input] of Object.entries(fields)) if (input.value !== '') styles[prop] = input.value;
        if ('textTransform' in styles && styles.textTransform === 'small-caps') { styles.fontVariant = 'small-caps'; delete styles.textTransform; }
        elemStyles[key] = styles;
        store.set('elem.styles', elemStyles);
        const t = queryByKey(key);
        if (t) { t.removeAttribute('style'); Object.assign(t.style, styles); }
        closePanel();
        toast({ title: 'Appearance applied to this element', body: 'Persisted per-element; Reset this element or global reset undo it.', tone: 'ok' });
      } }, 'Apply'),
    ),
  );
  const closePanel = anchored(target, panel, { width: 480 });
}

function resetElementAppearance(target) {
  const key = styleKey(target);
  delete elemStyles[key];
  store.set('elem.styles', elemStyles);
  const t = queryByKey(key);
  if (t) t.removeAttribute('style');
  toast({ title: 'Element appearance reset', tone: 'info' });
}

/* ---------------- command palette ---------------- */

let paletteOpen = false;

async function openPalette() {
  if (paletteOpen) return;
  paletteOpen = true;
  const { modal, superConfirm: sc } = await import('./ui.mjs');
  void sc;

  const rows = [];
  rows.push(...TABS.map(([id, key]) => ({ title: i18n.t(key), kind: 'destination', go: () => navigate(id) })));
  // Every setting as a rich row.
  const { DEFS, readPref, writePref, applyAll } = await import('./settings.mjs');
  for (const def of DEFS) {
    rows.push({
      title: `${def.label.en} — ${def.group}`,
      kind: def.type,
      keywords: `${def.label.yue || ''} ${def.explain.en}`,
      controlFor: (rowEl) => {
        const c = paletteControl(def, readPref(def.key), (v) => { writePref(def.key, v); applyAll(); });
        rowEl.append(c);
      },
      go: () => { navigate('settings'); setTimeout(() => flashHighlight(ensurePanel('settings')), 60); },
    });
  }

  const overlay = el('div', { class: 'overlay palette-overlay' });
  const box = el('div', { class: 'dialog palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' });
  const input = el('input', { type: 'search', class: 'palette-input', placeholder: 'Type a command, setting, or destination…', 'aria-label': 'Palette search' });
  attachSearch(input, { withRegexToggle: false, onQuery: () => render() });
  const listEl = el('div', { class: 'palette-list', role: 'listbox' });
  box.append(input, listEl);
  overlay.append(box);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
  document.body.append(overlay);
  input.focus();

  function close() { paletteOpen = false; overlay.remove(); }
  let activeIdx = 0;
  let visible = [];

  function render() {
    const q = input.value.trim().toLowerCase();
    visible = rows.filter((r) => !q || r.title.toLowerCase().includes(q) || (r.keywords || '').toLowerCase().includes(q)).slice(0, 30);
    activeIdx = Math.min(activeIdx, Math.max(0, visible.length - 1));
    listEl.replaceChildren(...visible.map((r, idx) => {
      const rowEl = el('div', {
        class: `pal-row${idx === activeIdx ? ' active' : ''}`, role: 'option', 'aria-selected': String(idx === activeIdx),
        onclick: () => { r.go?.(); close(); },
      },
      el('span', {}, r.title),
      r.controlFor ? (() => { const c = el('span', { class: 'inline-ctl' }); r.controlFor(c); c.addEventListener('click', (ev) => ev.stopPropagation()); return c; })() : null,
      el('span', { class: 'pal-kind' }, r.kind));
      return rowEl;
    }));
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { activeIdx = Math.min(visible.length - 1, activeIdx + 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { activeIdx = Math.max(0, activeIdx - 1); render(); e.preventDefault(); }
    else if (e.key === 'Enter') { visible[activeIdx]?.go(); close(); }
    else if (e.key === 'Escape') close();
  });
  render();
}

function paletteControl(def, value, set) {
  switch (def.type) {
    case 'toggle': {
      const c = el('input', { type: 'checkbox', checked: value ? true : null, 'aria-label': def.label.en });
      c.addEventListener('change', () => set(c.checked));
      return c;
    }
    case 'slider': {
      const s = el('input', { type: 'range', class: 'slider', min: def.min, max: def.max, step: def.step, value: String(value ?? def.min), style: 'width:120px', 'aria-label': def.label.en });
      s.addEventListener('change', () => set(Number(s.value)));
      return s;
    }
    case 'select': case 'font': case 'lang': {
      const sel = el('select', { 'aria-label': def.label.en, style: 'max-width:160px' },
        (def.type === 'lang'
          ? [['en', 'English'], ['yue', '廣東話'], ['bi', 'Bilingual']]
          : def.type === 'font'
            ? [['system-ui', 'System UI'], ['segoe', 'Segoe UI'], ['georgia', 'Georgia']]
            : def.options).map(([v, l]) => el('option', { value: v, selected: String(value) === String(v) ? true : null }, l)));
      sel.addEventListener('change', () => set(sel.value));
      return sel;
    }
    default:
      return el('button', { class: 'chip clickable', onclick: () => set(value) }, 'open');
  }
}

boot();
