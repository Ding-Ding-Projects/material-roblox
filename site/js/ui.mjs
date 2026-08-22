// UI toolkit: element helper, toasts + notification centre, anchored popovers,
// modal dialogs, super confirmation, the anchored regex builder, and
// filterable menus. Everything paints its own surface and stays viewport-bounded.

import { i18n } from './i18n.mjs';
import { store } from './store.mjs';

/* ---------------- tiny helpers ---------------- */

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'html') n.innerHTML = v; // trusted internal markup only
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(9)) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

export const debounce = (fn, ms = 200) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast({ title: 'Copied', body: '', tone: 'ok', quiet: true }); }
  catch { toast({ title: 'Copy failed', body: 'Clipboard permission refused.', tone: 'warn' }); }
}

export const fmtBytes = (n) => {
  if (!Number.isFinite(n)) return '—';
  const u = ['B', 'KiB', 'MiB', 'GiB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};

export function flashHighlight(elm) {
  if (!elm) return;
  elm.classList.add('flash');
  setTimeout(() => elm.classList.remove('flash'), 1200);
}

/* ---------------- notifications (toasts + centre) ---------------- */

const log = store.get('notif.log', []);
const listeners = new Set();
let seq = 0;

function record(entry) {
  log.unshift({ ...entry, id: entry.id || `n${++seq}` });
  if (log.length > 200) log.length = 200;
  store.set('notif.log', log);
  listeners.forEach((fn) => fn());
}

export function onLog(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export const getLog = () => [...log];

export function toast({ title, body = '', tone = 'info', timeoutMs = 5000, actions = [], sticky = false }) {
  const region = document.querySelector('.toast-region');
  if (!region) return;
  const t = el('div', { class: `toast ${tone === 'error' ? 'warn' : tone}`, role: 'status' },
    el('div', { class: 't-title' }, i18n.voice(tone, title)),
    body ? el('div', { class: 't-body' }, body) : null,
    el('div', { class: 't-actions' },
      actions.map((a) => el('button', { class: 'mrb-btn text', onclick: () => { a.action?.(); close(); } }, a.label)),
      sticky || tone === 'error' || tone === 'warn'
        ? el('button', { class: 'mrb-btn text', onclick: close, 'aria-label': i18n.t('toast.dismiss') }, '✕')
        : null,
    ),
  );
  function close() { t.remove(); }
  region.append(t);
  if (!sticky && tone !== 'error' && tone !== 'warn') setTimeout(close, timeoutMs);
  record({ at: Date.now(), title, body, tone });
}

/* ---------------- anchored popover ---------------- */

export function anchored(anchorEl, panelEl, { width } = {}) {
  panelEl.classList.add('popover');
  document.body.append(panelEl);
  const place = () => {
    const r = anchorEl.getBoundingClientRect();
    const pw = Math.min(panelEl.offsetWidth, window.innerWidth - 16);
    const ph = panelEl.offsetHeight;
    let x = Math.min(Math.max(8, r.left), window.innerWidth - pw - 8);
    let y = r.bottom + 6;
    if (y + ph > window.innerHeight - 8) y = Math.max(8, r.top - ph - 6);
    panelEl.style.left = `${x}px`;
    panelEl.style.top = `${y}px`;
    if (width) panelEl.style.width = `${Math.min(width, window.innerWidth - 16)}px`;
  };
  place();
  const onDoc = (e) => { if (!panelEl.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); anchorEl.focus(); } };
  setTimeout(() => document.addEventListener('pointerdown', onDoc));
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', close);
  const prevFocus = document.activeElement;
  const focusables = panelEl.querySelectorAll('input, button, select, textarea, [tabindex]');
  if (focusables[0]) focusables[0].focus();

  function close() {
    document.removeEventListener('pointerdown', onDoc);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', close);
    panelEl.remove();
    if (prevFocus && prevFocus.isConnected) prevFocus.focus?.();
  }
  return close;
}

/* ---------------- modal + super confirm ---------------- */

export function modal({ title, build, actions = [], emergencyExit = false }) {
  const overlay = el('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const dlg = el('div', { class: 'dialog' });
  const closeAll = () => overlay.remove();

  const bodyEl = el('div');
  dlg.append(el('h2', {}, title));
  if (emergencyExit) dlg.append(el('button', { class: 'mrb-btn tonal emergency-exit', onclick: closeAll }, '🚪 Exit'));
  build(bodyEl, closeAll);
  dlg.append(bodyEl);
  if (actions.length) {
    dlg.append(el('div', { class: 'dialog-actions' },
      actions.map((a) => el('button', {
        class: `mrb-btn ${a.kind || 'text'}`,
        onclick: () => { if (a.keepOpen !== true) closeAll(); a.action?.(closeAll); },
      }, a.label)),
    ));
  }
  overlay.append(dlg);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) closeAll(); });
  const onKey = (e) => { if (e.key === 'Escape') { closeAll(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  const first = dlg.querySelector('input, button:not(.emergency-exit), select, textarea, [tabindex]');
  first?.focus();
  return closeAll;
}

/** Two independent key controls + full-range slider gate. */
export function superConfirm({ title, detailHtml, confirmLabel = 'Yes, do it', onConfirm }) {
  modal({
    title,
    build(body, close) {
      body.innerHTML = `<div>${detailHtml}</div>
        <div class="callout warn"><strong>This is irreversible.</strong> Two independent keys must both be set before the slider unlocks.</div>`;
      const k1 = el('input', { type: 'checkbox', id: 'gk1' });
      const k2 = el('input', { type: 'checkbox', id: 'gk2' });
      body.append(el('div', { class: 'gate-keys' },
        el('label', { for: 'gk1', style: 'display:flex;gap:8px;align-items:center;min-height:44px' }, k1, 'Key one: I understand what this deletes'),
        el('label', { for: 'gk2', style: 'display:flex;gap:8px;align-items:center;min-height:44px' }, k2, 'Key two: nothing here needs saving'),
      ));
      const ringFill = el('i');
      body.append(ringWrap());
      function ringWrap() { return el('div', { class: 'progress-ring' }, ringFill); }
      const slider = el('input', { type: 'range', class: 'slider gate-slider', min: 0, max: 100, value: 0, disabled: true, 'aria-label': 'Confirmation slider — drag fully right to confirm' });
      body.append(slider);
      const done = el('div', { hidden: true, style: 'font-weight:700;margin-top:8px' }, '✓ Authorized');
      body.append(done);

      const check = () => { slider.disabled = !(k1.checked && k2.checked); };
      k1.addEventListener('change', check);
      k2.addEventListener('change', check);
      slider.addEventListener('input', () => { ringFill.style.width = `${slider.value}%`; done.hidden = slider.value < 100; });
      slider.addEventListener('change', () => {
        if (slider.value >= 100) { onConfirm?.(); close(); }
      });
      body.append(el('div', { class: 'dialog-actions' },
        el('button', { class: 'mrb-btn tonal', onclick: close }, 'Emergency exit'),
      ));
    },
  });
}

/* ---------------- anchored regex builder ---------------- */

const builderState = new WeakMap(); // input -> controller

export function attachSearch(inputEl, { onQuery, placeholder = 'Search…', withRegexToggle = true } = {}) {
  inputEl.placeholder = placeholder;
  const state = { mode: 'plain', flags: '', pattern: '' };
  inputEl.addEventListener('input', () => emit());
  function emit() {
    const q = inputEl.value;
    if (state.mode === 'regex' && state.pattern) {
      try {
        const re = new RegExp(state.pattern, state.flags.replace('g', ''));
        onQuery?.(q, { mode: 'regex', re });
        return;
      } catch (e) {
        onQuery?.(q, { mode: 'regex', error: e.message });
        return;
      }
    }
    onQuery?.(q, { mode: 'plain' });
  }
  // Builder affordance button anchored beside the field.
  const btn = el('button', { class: 'builder-btn', title: 'Open regex builder', 'aria-label': 'Open regex builder', 'aria-expanded': 'false' }, '.*');
  inputEl.insertAdjacentElement('afterend', btn);
  btn.addEventListener('click', () => openBuilder(inputEl, state, emit));

  const ctrl = {
    state, emit,
    setMode(mode) { state.mode = mode; emit(); },
  };
  builderState.set(inputEl, ctrl);
  if (withRegexToggle) wireModeToggle(inputEl, state, emit);
  return ctrl;
}

function wireModeToggle(inputEl, state, emit) {
  // A small plain/regex toggle rendered after the field by callers that want it.
  inputEl.dispatchEvent(new CustomEvent('mrb-search-ready', { bubbles: true }));
  inputEl._mrbEmit = emit;
  inputEl._mrbState = state;
}

export function makeModeToggle(inputEl) {
  const wrap = el('div', { class: 'mode-toggle', role: 'group', 'aria-label': 'Match mode' });
  const mkBtn = (mode, label) => {
    const b = el('button', { type: 'button', 'aria-pressed': String(mode === (inputEl._mrbState?.mode || 'plain')) }, label);
    b.addEventListener('click', () => {
      if (!inputEl._mrbState) return;
      inputEl._mrbState.mode = mode;
      wrap.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      inputEl._mrbEmit?.();
    });
    return b;
  };
  wrap.append(mkBtn('plain', 'Aa'), mkBtn('regex', '.*'));
  return wrap;
}

export function openBuilder(inputEl, state, emit) {
  const panel = el('div', { class: 'builder' }, el('h3', {}, 'Regex builder'), el('p', { class: 'applied-note' }, 'Engine: JavaScript RegExp (V8). Plain text stays the default.'));
  const snippets = [
    ['Any char', '.'], ['Digit', '\\d'], ['Word', '\\w'], ['Space', '\\s'],
    ['Class [..]', '[abc]'], ['Not digit', '\\D'], ['Start ^', '^'], ['End $', '$'],
    ['Group (…)', '(…)'], ['Either |', 'a|b'], ['One+', '+'], ['Zero+', '*'],
    ['Optional ?', '?'], ['{n,m}', '{2,4}'], ['Escape \\', '\\.'],
  ];
  const raw = el('input', { type: 'text', placeholder: 'pattern', value: state.pattern, 'aria-label': 'Regex pattern' });
  const sample = el('textarea', { placeholder: 'Sample text to test against', 'aria-label': 'Sample text', rows: 3 });
  const flagsWrap = el('div', { class: 'flag-row' });
  for (const f of ['g', 'i', 'm', 's', 'u', 'y']) {
    const id = `flag-${f}`;
    const c = el('input', { type: 'checkbox', id, checked: state.flags.includes(f) ? true : null });
    c.addEventListener('change', () => {
      state.flags = ['g', 'i', 'm', 's', 'u', 'y'].filter((x) => panel.querySelector(`#flag-${x}`).checked).join('');
      run();
    });
    flagsWrap.append(el('label', { for: id, style: 'display:inline-flex;gap:6px;align-items:center;font-family:var(--mrb-font-mono)' }, c, f));
  }
  const matches = el('ul', { class: 'matchlist', role: 'list' });

  function run() {
    state.pattern = raw.value;
    try {
      const re = new RegExp(state.pattern, state.flags.replace('g', ''));
      matches.textContent = '';
      const s = sample.value;
      if (!re.test(s)) { matches.append(el('li', {}, '(no match in sample)')); }
      else {
        let m;
        let count = 0;
        const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
        while ((m = globalRe.exec(s)) && count < 12) {
          matches.append(el('li', {},
            `#${count + 1} “`, el('mark', {}, m[0]), '”',
            m.slice(1).length ? ` groups: ${m.slice(1).map((x) => x ?? '∅').join(', ')}` : '',
          ));
          if (m.index === globalRe.lastIndex) globalRe.lastIndex++;
          count++;
        }
      }
      if (inputEl._mrbState === state || state === inputEl?._mrbState) { /* same field */ }
      emit?.();
    } catch (e) {
      matches.textContent = '';
      matches.append(el('li', {}, `invalid pattern: ${e.message}`));
    }
  }
  raw.addEventListener('input', debounce(run, 150));
  sample.addEventListener('input', debounce(run, 150));

  const grid = el('div', { class: 'builder-grid' },
    snippets.map(([label, snip]) => el('button', {
      class: 'snippet',
      onclick: () => {
        const ins = snip === '(…)' ? '()' : snip === '{2,4}' ? '{2,4}' : snip;
        raw.value += ins;
        raw.focus();
        run();
      },
    }, label)),
  );
  panel.append(
    el('div', { class: 'field' }, el('label', {}, 'Insert building block'), grid),
    el('div', { class: 'field' }, el('label', {}, 'Raw pattern'), raw),
    el('div', { class: 'field' }, el('label', {}, 'Flags'), flagsWrap),
    el('div', { class: 'field' }, el('label', {}, 'Sample text'), sample),
    el('div', { class: 'field' }, el('label', {}, 'Live matches & capture groups'), matches),
    el('div', { class: 'dialog-actions' },
      el('button', { class: 'mrb-btn text', onclick: () => copyText(state.pattern) }, 'Copy pattern'),
    ),
  );
  const close = anchored(inputEl, panel, { width: 520 });
  raw.value = state.pattern || '';
  return close;
}

/* ---------------- context menu ---------------- */

export function openContextMenu(x, y, items) {
  document.querySelectorAll('.ctx-menu').forEach((n) => n.remove());
  const menu = el('div', { class: 'popover ctx-menu', role: 'menu' });
  const filterWrap = items.filterable ? buildMenuFilter(menu, items) : null;
  if (filterWrap) menu.append(filterWrap);
  const renderList = (list) => {
    menu.querySelectorAll('.menu-item').forEach((n) => n.remove());
    for (const it of list) {
      if (it === '-') { menu.append(el('hr')); continue; }
      menu.append(el('button', {
        class: 'menu-item', role: 'menuitem',
        onclick: () => { cleanup(); it.action?.(); },
      },
      it.icon ? el('span', { 'aria-hidden': 'true' }, it.icon) : null,
      it.label,
      it.shortcut ? el('kbd', {}, it.shortcut) : null,
      ));
    }
  };
  renderList(items.list);
  document.body.append(menu);
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  menu.style.left = `${Math.min(x, window.innerWidth - mw - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - mh - 8)}px`;
  const onDoc = (e) => { if (!menu.contains(e.target)) cleanup(); };
  const onKey = (e) => { if (e.key === 'Escape') cleanup(); };
  function cleanup() {
    document.removeEventListener('pointerdown', onDoc);
    document.removeEventListener('keydown', onKey);
    menu.remove();
  }
  setTimeout(() => document.addEventListener('pointerdown', onDoc));
  document.addEventListener('keydown', onKey);
  const fi = menu.querySelector('input, .menu-item');
  fi?.focus?.();
  return cleanup;
}

function buildMenuFilter(menu, items) {
  const inp = el('input', { type: 'search', placeholder: 'Filter…', 'aria-label': 'Filter menu items' });
  const row = el('div', { class: 'search-row', style: 'margin-bottom:8px' }, inp);
  attachSearch(inp, {
    onQuery: (q, meta) => {
      const base = items.list.filter((it) => it !== '-');
      const out = !q ? items.list : base.filter((it) => {
        if (meta.mode === 'regex' && meta.re) return meta.re.test(it.label);
        return it.label.toLowerCase().includes(q.toLowerCase());
      });
      // Filtering changes visibility, never semantics: shortcuts stay live.
      menu.querySelectorAll('.menu-item').forEach((n) => n.remove());
      for (const it of out) {
        menu.append(el('button', { class: 'menu-item', onclick: () => { menu.remove(); it.action?.(); } }, it.label));
      }
      if (!out.length) menu.append(el('div', { class: 'menu-item', style: 'opacity:.7' }, '(no matching items)'));
    },
  });
  return row;
}
