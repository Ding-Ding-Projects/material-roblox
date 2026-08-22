/**
 * Material Roblox — anchored full regex builder + search-bar wiring (Lane C).
 *
 * Two surfaces live here:
 *
 *  1. `attachSearch(inputEl, opts)` upgrades any `<input type="search">` into
 *     a fully wired search field: trailing builder button, clear button, a
 *     clickable Plain/Regex mode chip, per-field owned state
 *     `{q, mode, flags, valid}`, debounced `onQuery` callbacks, an inline
 *     validation message that NEVER discards what the user typed, and a
 *     bidirectional `controller.setQuery()` that updates the field without
 *     re-triggering callbacks.
 *
 *  2. `openBuilder(inputEl)` opens THE anchored builder popover beside that
 *     specific field: guided construction chips (literals, classes, anchors,
 *     groups, alternation, quantifiers with a lazy toggle, escapes), a raw
 *     pattern textarea that is the single source of truth, the gimsuy flag
 *     row, a bounded sample-text area, live matches with safe highlighting,
 *     a capture-group table, ReDoS heuristics, copy/export actions and the
 *     engine footer. Plain text is always the default; regex is opt-in.
 *
 * Engine statement (also rendered literally in every builder footer):
 * the engine is JavaScript RegExp running on V8. There is deliberately one
 * engine across the app so a pattern built here behaves identically in every
 * search bar it is applied to.
 *
 * Safety notes baked into the implementation:
 *  - Sample highlighting rebuilds text nodes and `<mark>` elements; user text
 *    is never assigned through innerHTML.
 *  - Match iteration uses a manual exec loop with a zero-width lastIndex
 *    advance (a zero-length match otherwise never advances and loops forever),
 *    a hard iteration cap, and a 50 ms evaluation budget — pathological input
 *    degrades to a "too complex to evaluate safely" state instead of hanging.
 */

import { store } from './store.js';
import { i18n } from './i18n.js';
import { ui } from './ui.js';

/* ── Constants ──────────────────────────────────────────────────────────── */

const SAMPLE_CAP = 100_000;          // hard cap; evaluation SKIPS past it
const SAMPLE_DISPLAY_CAP = 20_000;   // highlight box renders at most this much
const EVAL_BUDGET_MS = 50;           // per-evaluation time budget
const MAX_DISPLAY_MATCHES = 500;     // highlighted/tabled match ceiling
const MAX_ITERATIONS = 100_000;      // belt-and-braces loop guard

/** Rendered literally in every builder footer. Keep the exact wording. */
export const ENGINE_FOOTER =
  'Engine: JavaScript RegExp (V8). Flags above. No lookbehind in older browsers — this app targets Chromium.';

/* ── Small shared helpers ───────────────────────────────────────────────── */

/**
 * Localized-copy helper mirroring the documented CONTRACT §8 pattern (the
 * same approach Lane B ships in its peers.js): try the shared catalog first;
 * when the catalog does not carry the key yet, fall back to this lane's local
 * English + Cantonese copy. Catalog additions win automatically later.
 */
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

function bridge() {
  return typeof window !== 'undefined' && window.mrb ? window.mrb : null;
}

let idSeq = 0;

/* ── Search-field defaults from Settings ────────────────────────────────── */

let settingsPeer = null;
let searchDefaults = { mode: 'plain', caseSensitive: false };

async function loadSettingsPeer() {
  try {
    const mod = await import('./settings.js');
    if (mod && mod.settings) settingsPeer = mod.settings;
  } catch { /* optional peer — degrade to shipped defaults */ }
  if (!settingsPeer) return;
  try {
    settingsPeer.register([
      {
        key: 'search.defaultMode',
        type: 'select',
        def: 'plain',
        group: 'Search',
        label: { en: 'Default search mode', yue: '預設搜尋模式' },
        explain: {
          en: 'New search fields start in this mode. Plain text is the safe default; Regular expression enables JavaScript regex matching.',
          yue: '新嘅搜尋欄由呢個模式開始。純文字係穩陣預設；揀正規表達式就會啟用 JavaScript 正則匹配。',
        },
        options: [
          { value: 'plain', label: { en: 'Plain text', yue: '純文字' } },
          { value: 'regex', label: { en: 'Regular expression', yue: '正規表達式' } },
        ],
      },
      {
        key: 'search.caseSensitive',
        type: 'toggle',
        def: false,
        group: 'Search',
        label: { en: 'Case-sensitive search by default', yue: '預設區分大小寫' },
        explain: {
          en: 'When off, new searches ignore letter case (Regex mode starts with the i flag). Turning it on removes that flag.',
          yue: '關閉時，新搜尋唔理大小寫（正則模式自動帶 i 旗標）；開啟就會移除。',
        },
      },
    ]);
    const read = () => {
      searchDefaults = {
        mode: settingsPeer.get('search.defaultMode', 'plain') === 'regex' ? 'regex' : 'plain',
        caseSensitive: !!settingsPeer.get('search.caseSensitive', false),
      };
    };
    read();
    settingsPeer.onChange(read);
  } catch (err) {
    console.warn('[mrb/regexbuilder] Settings registration failed:', err && err.message);
  }
}

function defaultFlagsFor() {
  return searchDefaults.caseSensitive ? '' : 'i';
}

/* ── Validation & evaluation core ───────────────────────────────────────── */

/** Compile check. Returns {valid, message}. Never throws. */
export function validatePattern(q, flags) {
  if (!q) return { valid: true, message: null };
  try {
    // Evaluated purely to prove compilability; discarded immediately.
    new RegExp(q, flags);
    return { valid: true, message: null };
  } catch (err) {
    return { valid: false, message: (err && err.message) ? String(err.message) : 'Invalid regular expression.' };
  }
}

/**
 * Heuristic ReDoS warning — NOT a proof. Nested unbounded quantifiers such as
 * (a+)+ or (.*)* are the classic exponential-backtracking shape. Escapes are
 * neutralised first so \( or \+ cannot fool the test.
 */
export function looksCatastrophic(source) {
  const s = String(source).replace(/\\./g, '?');
  return /\([^()]*[*+][^()]*\)[*+{]/.test(s) ||
         /\([^()]*\{[\d,]+\}[^()]*\)[*+{]/.test(s) ||
         /[*+]\)[*+]/.test(s);
}

/**
 * Timeboxed match evaluation.
 *
 * Uses a manual exec loop rather than String.matchAll because matchAll gives
 * no opportunity to (a) bail out mid-scan when the time budget expires and
 * (b) advance lastIndex past zero-width matches — a zero-length match leaves
 * lastIndex untouched, which would spin forever. Both safeguards live here;
 * the iteration cap below is a second line of defence.
 */
export function evaluatePattern(pattern, flagsStr, sample) {
  const result = { error: null, timedOut: false, skipped: false, matches: [], elapsedMs: 0, catastrophic: false };
  if (!pattern) return result;
  if (sample.length > SAMPLE_CAP) { result.skipped = true; return result; }
  result.catastrophic = looksCatastrophic(pattern);
  const t0 = performance.now();
  let re;
  try {
    re = new RegExp(pattern, flagsStr);
  } catch (err) {
    result.error = (err && err.message) ? String(err.message) : 'Invalid regular expression.';
    return result;
  }
  let iterations = 0;
  for (;;) {
    if (++iterations > MAX_ITERATIONS) { result.timedOut = true; break; }
    if (performance.now() - t0 > EVAL_BUDGET_MS) { result.timedOut = true; break; }
    const m = re.exec(sample);
    if (!m) break;
    if (m.index === re.lastIndex) {
      // Zero-width safeguard: advance manually or the loop never ends.
      re.lastIndex += 1;
    }
    result.matches.push(m);
    if (!re.global && !re.sticky) break; // non-looping engines stop at #1
    if (result.matches.length >= MAX_DISPLAY_MATCHES) break;
  }
  result.elapsedMs = Math.round((performance.now() - t0) * 100) / 100;
  return result;
}

/* ── Per-input controllers ──────────────────────────────────────────────── */

const controllers = new WeakMap();

/**
 * Upgrade a search input with builder button, clear button, mode chip and
 * per-field owned state. Idempotent: attaching twice hands back the same
 * controller instead of double-wrapping the DOM.
 *
 * @param {HTMLInputElement} inputEl
 * @param {{onQuery?:Function, placeholder?:string, debounceMs?:number,
 *          mode?:('plain'|'regex'), ariaLabel?:string}} [opts]
 * @returns {{input:HTMLInputElement, getState:Function, setQuery:Function,
 *            setMode:Function, setFlags:Function, openBuilder:Function,
 *            focus:Function, destroy:Function}}
 */
export function attachSearch(inputEl, opts = {}) {
  if (!(inputEl instanceof HTMLInputElement)) {
    throw new Error('attachSearch expects an <input> element.');
  }
  const existing = controllers.get(inputEl);
  if (existing) return existing;

  const debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : 250;
  const ownerSeq = ++idSeq;

  const state = {
    q: '',
    mode: opts.mode === 'regex' ? 'regex' : (searchDefaults.mode === 'regex' ? 'regex' : 'plain'),
    flags: defaultFlagsFor(),
    valid: true,
  };

  /* Wrap the input so the adornments belong to THIS field only. State is
   * per-input by construction: nothing below reads or writes module-level
   * query state, and two fields never share a controller object. */
  const wrap = ui.el('div', { class: 'mrb-rb-field' });
  inputEl.parentNode.insertBefore(wrap, inputEl);
  wrap.appendChild(inputEl);
  inputEl.classList.add('mrb-rb-input');

  const errId = `mrb-rb-err-${ownerSeq}`;
  const prevDescribed = inputEl.getAttribute('aria-describedby');
  inputEl.setAttribute('aria-describedby', prevDescribed ? `${prevDescribed} ${errId}` : errId);

  const errLine = ui.el('p', { class: 'mrb-rb-error', id: errId, 'aria-live': 'polite' });

  const clearBtn = ui.el('button', {
    class: 'mrb-rb-clear', type: 'button', title: tr('search.clear', 'Clear search', '清空搜尋'),
    'aria-label': tr('search.clear', 'Clear search', '清空搜尋'), tabindex: '-1',
  }, '✕');

  const modeChip = ui.el('button', {
    class: 'mrb-rb-mode', type: 'button',
    title: tr('search.modeTip', 'Toggle between plain text and regular expression matching', '切換純文字同正規表達式匹配'),
  }, 'Plain');

  const builderBtn = ui.el('button', {
    class: 'mrb-rb-open', type: 'button',
    'aria-label': tr('search.openBuilder', 'Open regex builder', '打開正則產生器'),
    title: tr('search.openBuilder', 'Open regex builder', '打開正則產生器'),
  }, '.*');

  const adorn = ui.el('span', { class: 'mrb-rb-adorn' }, modeChip, builderBtn, clearBtn);
  wrap.appendChild(adorn);
  wrap.appendChild(errLine);

  if (opts.placeholder) inputEl.placeholder = opts.placeholder;
  if (opts.ariaLabel) inputEl.setAttribute('aria-label', opts.ariaLabel);

  let suppressEmit = false;
  let builderClose = null;

  const emit = ui.debounce(() => {
    if (suppressEmit) return;
    if (typeof opts.onQuery === 'function') {
      opts.onQuery(state.q, { mode: state.mode, flags: state.flags, valid: state.valid });
    }
  }, debounceMs);

  function refreshUi() {
    clearBtn.style.visibility = state.q ? 'visible' : 'hidden';
    modeChip.textContent = state.mode === 'regex'
      ? tr('search.mode.regex', 'Regex', '正則')
      : tr('search.mode.plain', 'Plain', '純文字');
    modeChip.classList.toggle('is-regex', state.mode === 'regex');
    modeChip.setAttribute('aria-pressed', state.mode === 'regex' ? 'true' : 'false');
    if (state.mode === 'regex' && state.q) {
      const v = validatePattern(state.q, state.flags);
      state.valid = v.valid;
      errLine.textContent = v.valid ? '' : voice('error', v.message);
      wrap.classList.toggle('has-error', !v.valid);
      inputEl.setAttribute('aria-invalid', v.valid ? 'false' : 'true');
    } else {
      state.valid = true;
      errLine.textContent = '';
      wrap.classList.remove('has-error');
      inputEl.setAttribute('aria-invalid', 'false');
    }
  }

  const onInput = () => {
    state.q = inputEl.value;
    refreshUi();
    emit();
  };

  const onKeydown = (e) => {
    if (e.key === 'Escape') {
      if (builderClose) {           // first Escape collapses the builder…
        e.preventDefault();
        e.stopPropagation();
        builderClose();
        return;
      }
      if (inputEl.value) {          // …then Escape clears the query…
        e.preventDefault();
        e.stopPropagation();        // …consuming the event so an overlay under
        setQuery('', { silent: false }); // the field does not close prematurely
      }
      // Empty field + no builder: let Escape bubble (closes host overlay).
      return;
    }
    if (e.key === 'Enter') {
      // Enter fires the query immediately instead of waiting out the debounce.
      e.preventDefault();
      state.q = inputEl.value;
      refreshUi();
      if (!suppressEmit && typeof opts.onQuery === 'function') {
        opts.onQuery(state.q, { mode: state.mode, flags: state.flags, valid: state.valid });
      }
    }
  };

  inputEl.addEventListener('input', onInput);
  inputEl.addEventListener('keydown', onKeydown);

  clearBtn.addEventListener('click', () => setQuery('', { silent: false }));

  modeChip.addEventListener('click', () => {
    setMode(state.mode === 'regex' ? 'plain' : 'regex', { silent: false });
    inputEl.focus();
  });

  builderBtn.addEventListener('click', () => {
    if (builderClose) { builderClose(); return; }
    builderClose = openBuilder(inputEl, { onClose: () => { builderClose = null; inputEl.focus(); } });
  });

  function setQuery(q, { mode, flags, silent = true } = {}) {
    suppressEmit = true;
    try {
      state.q = String(q == null ? '' : q);
      inputEl.value = state.q;             // programmatic path — no input event fires
      if (mode) state.mode = mode === 'regex' ? 'regex' : 'plain';
      if (typeof flags === 'string') state.flags = flags;
      refreshUi();
      if (!silent && typeof opts.onQuery === 'function') {
        opts.onQuery(state.q, { mode: state.mode, flags: state.flags, valid: state.valid });
      }
    } finally {
      suppressEmit = false;
    }
  }

  function setMode(mode, { silent = true } = {}) {
    setQuery(state.q, { mode, silent });
  }

  function destroy() {
    if (builderClose) { try { builderClose(); } catch { /* already gone */ } builderClose = null; }
    inputEl.removeEventListener('input', onInput);
    inputEl.removeEventListener('keydown', onKeydown);
    wrap.parentNode.insertBefore(inputEl, wrap);
    wrap.remove();
    inputEl.classList.remove('mrb-rb-input');
    if (prevDescribed) inputEl.setAttribute('aria-describedby', prevDescribed);
    else inputEl.removeAttribute('aria-describedby');
    controllers.delete(inputEl);
  }

  const controller = {
    input: inputEl,
    getState: () => ({ ...state }),
    setQuery,
    setMode,
    setFlags: (flags, o = {}) => setQuery(state.q, { flags, silent: o.silent !== false }),
    openBuilder: () => {
      if (!builderClose) builderClose = openBuilder(inputEl, { onClose: () => { builderClose = null; inputEl.focus(); } });
      return builderClose;
    },
    focus: () => inputEl.focus(),
    destroy,
  };
  controllers.set(inputEl, controller);
  refreshUi();
  return controller;
}

/**
 * Create a complete, labelled, pre-wired search field from scratch — used by
 * the notification centre, history panel and command palette so every search
 * surface shares one implementation.
 */
export function attachSearchableFactory(factoryOpts = {}) {
  const id = `mrb-cx-search-${++idSeq}`;
  const root = ui.el('div', { class: 'mrb-cx-searchable' });
  const label = ui.el('label', { class: 'mrb-cx-searchable-label', for: id },
    factoryOpts.label || tr('search.label', 'Search', '搜尋'));
  const input = ui.el('input', {
    type: 'search', id,
    placeholder: factoryOpts.placeholder || tr('search.placeholder', 'Type to search', '輸入以搜尋'),
  });
  root.appendChild(label);
  root.appendChild(input);
  const controller = attachSearch(input, {
    onQuery: factoryOpts.onQuery,
    debounceMs: factoryOpts.debounceMs,
    ariaLabel: factoryOpts.label,
  });
  return { root, input, controller, label };
}

/* ── The anchored builder popover ───────────────────────────────────────── */

const FLAG_DEFS = [
  { f: 'g', en: 'Global — find all matches, not just the first.', yue: '全域——搵晒所有匹配，唔止第一個。' },
  { f: 'i', en: 'Ignore case.', yue: '唔分大小寫。' },
  { f: 'm', en: 'Multiline — ^ and $ match line boundaries.', yue: '多行——^ 同 $ 會對齊行界。' },
  { f: 's', en: 'Dotall — dot also matches newlines.', yue: 'dotAll——點號都會食埋換行。' },
  { f: 'u', en: 'Unicode — match by full code points.', yue: 'Unicode——成個碼位咁匹配。' },
  { f: 'y', en: 'Sticky — match only at lastIndex. Advanced; most searches do not want this.', yue: '黏性——只會在 lastIndex 匹配。進階用法，一般搜尋用唔着。' },
];

function escapeLiteral(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Insert text into a textarea AT THE CARET while preserving the browser's
 * native undo stack. `execCommand('insertText')` is deprecated but remains
 * the only DOM API that integrates with native Ctrl+Z; where it refuses, the
 * setRangeText fallback still writes correctly (with coarser undo steps — an
 * honest, documented degradation, never a lost edit).
 */
function insertAtCaret(ta, text) {
  ta.focus();
  const s = ta.selectionStart ?? ta.value.length;
  const e = ta.selectionEnd ?? s;
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
  if (!ok) {
    ta.setRangeText(text, s, e, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function selectionOf(ta) {
  const s = ta.selectionStart ?? ta.value.length;
  const e = ta.selectionEnd ?? s;
  return { start: s, end: e, text: ta.value.slice(s, e) };
}

/**
 * Open the anchored builder beside `inputEl`.
 * @param {HTMLInputElement} inputEl the OWNING search field
 * @param {{onClose?:Function}} [opts]
 * @returns {Function} close()
 */
export function openBuilder(inputEl, opts = {}) {
  const controller = controllers.get(inputEl) || null;
  const initial = controller ? controller.getState() : { q: '', mode: 'plain', flags: '' };

  const session = {
    pattern: initial.mode === 'regex' ? initial.q : '',
    flags: new Set((initial.mode === 'regex' && initial.flags) ? initial.flags.split('') : (initial.q ? initial.flags.split('') : [])),
    sample: '',
  };
  // Seed the default case-sensitivity only when it is a real flag character —
  // an empty defaultFlagsFor() must never add '' to the set.
  if (!session.flags.size) {
    for (const f of defaultFlagsFor()) session.flags.add(f);
  }

  const panel = ui.el('div', { class: 'mrb-rb-pop', role: 'dialog', 'aria-label': 'Regex builder' });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });

  /* Header */
  const headTitle = ui.el('h2', { class: 'mrb-rb-pop-title' }, tr('rb.title', 'Regex builder', '正則產生器'));
  const headSub = ui.el('p', { class: 'mrb-rb-pop-sub' },
    tr('rb.forField', 'Building a pattern for the search field beside this popover.', '為旁邊嘅搜尋欄建立正則表達式。'));
  const closeBtn = ui.el('button', {
    class: 'mrb-btn mrb-btn--text mrb-rb-pop-close', type: 'button',
    'aria-label': tr('common.close', 'Close', '關閉'),
  }, '✕');

  /* Guided section */
  const guidedHead = ui.el('h3', { class: 'mrb-rb-sect-title', id: `mrb-rb-guided-${++idSeq}` },
    tr('rb.guided', 'Build', '建立'));
  const chipGrid = ui.el('div', { class: 'mrb-rb-chipgrid', role: 'group', 'aria-labelledby': guidedHead.id });

  function chip(labelText, tip, onClick) {
    const b = ui.el('button', { class: 'mrb-chip mrb-rb-chip', type: 'button', title: tip }, labelText);
    b.addEventListener('click', onClick);
    chipGrid.appendChild(b);
    return b;
  }

  /* Raw textarea is the SINGLE SOURCE of truth; guided chips write into it. */
  const patId = `mrb-rb-pattern-${++idSeq}`;
  const patLabel = ui.el('label', { class: 'mrb-rb-lab', for: patId }, tr('rb.pattern', 'Pattern', '表達式'));
  const patTa = ui.el('textarea', {
    class: 'mrb-rb-pattern', rows: '3', spellcheck: 'false', id: patId,
    'aria-label': tr('rb.pattern', 'Pattern', '表達式'),
    placeholder: 'e.g. \\d{4}-\\d{2}-\\d{2}',
  });

  const lazyWrap = ui.el('label', { class: 'mrb-rb-inline-check' });
  const lazyChk = ui.el('input', { type: 'checkbox' });
  lazyWrap.appendChild(lazyChk);
  lazyWrap.appendChild(document.createTextNode(
    tr('rb.lazy', 'Lazy variants (append ? — matches as little as possible)', '懶人版（加 ? 盡量少配）')));

  const quantChips = ui.el('div', { class: 'mrb-rb-chiprow' });
  function quantChip(tok, tip) {
    const b = ui.el('button', { class: 'mrb-chip mrb-rb-chip', type: 'button', title: tip }, tok);
    b.addEventListener('click', () => {
      // A quantifier must follow an atom: wrapping an existing selection in a
      // non-capturing group keeps the result valid instead of producing "*x".
      const sel = selectionOf(patTa);
      const suffix = lazyChk.checked ? `${tok}?` : tok;
      if (sel.text) insertAtCaret(patTa, `(?:${sel.text})${suffix}`);
      else insertAtCaret(patTa, suffix);
      syncFromTextarea();
    });
    quantChips.appendChild(b);
  }

  const customClass = ui.el('details', { class: 'mrb-rb-mini' });
  const ccSummary = ui.el('summary', {}, tr('rb.customClass', 'Custom character class…', '自訂字元類別…'));
  const ccNegWrap = ui.el('label', { class: 'mrb-rb-inline-check' });
  const ccNeg = ui.el('input', { type: 'checkbox' });
  ccNegWrap.appendChild(ccNeg);
  ccNegWrap.appendChild(document.createTextNode(tr('rb.negate', 'Negate (^)', '相反 (^)')));
  const ccInput = ui.el('input', { type: 'text', class: 'mrb-rb-mini-in', spellcheck: 'false', placeholder: 'a-z0-9_' });
  const ccPreview = ui.el('code', { class: 'mrb-rb-mini-preview' }, '[a-z0-9_]');
  const ccInsert = ui.el('button', { class: 'mrb-btn mrb-btn--tonal mrb-rb-mini-insert', type: 'button' },
    tr('rb.insert', 'Insert', '插入'));
  const ccNote = ui.el('p', { class: 'mrb-rb-note' },
    tr('rb.ccVerbatim', 'Contents are inserted exactly as typed — include ranges like a-z yourself.',
      '內容會照你打咗嘅原樣插入——記得自己寫 a-z 呢啲範圍。'));

  const namedGroup = ui.el('details', { class: 'mrb-rb-mini' });
  const ngSummary = ui.el('summary', {}, tr('rb.namedGroup', 'Named group…', '具名群組…'));
  const ngInput = ui.el('input', { type: 'text', class: 'mrb-rb-mini-in', spellcheck: 'false', placeholder: 'myName' });
  const ngErr = ui.el('p', { class: 'mrb-rb-note mrb-rb-note--warn', hidden: 'true' });
  const ngInsert = ui.el('button', { class: 'mrb-btn mrb-btn--tonal mrb-rb-mini-insert', type: 'button' },
    tr('rb.insert', 'Insert', '插入'));

  const escSelect = ui.el('select', { class: 'mrb-select mrb-rb-escapes', 'aria-label': tr('rb.escapes', 'Common escapes', '常用跳脫字元') });
  escSelect.appendChild(ui.el('option', { value: '' }, tr('rb.escapes', 'Common escapes…', '常用跳脫字元…')));
  for (const t of ['\\d', '\\D', '\\w', '\\W', '\\s', '\\S', '\\b', '\\\\', '\\.', '\\n', '\\t']) {
    escSelect.appendChild(ui.el('option', { value: t }, t));
  }

  /* Flags */
  const flagsHead = ui.el('h3', { class: 'mrb-rb-sect-title' }, tr('rb.flags', 'Flags', '旗標'));
  const flagRow = ui.el('div', { class: 'mrb-rb-flagrow', role: 'group', 'aria-label': 'Flags' });
  const yCaution = ui.el('p', { class: 'mrb-rb-note mrb-rb-note--warn', hidden: 'true' },
    tr('rb.yWarn', 'Caution: sticky (y) matching starts at lastIndex and can quietly match nothing. Most searches should leave it off.',
      '注意：黏性 (y) 由 lastIndex 開始配，好易靜靜地咩都配唔到。一般搜尋最好咪開。'));

  /* Sample + matches */
  const sampleLabel = ui.el('label', { class: 'mrb-rb-lab' }, tr('rb.sample', 'Sample text', '示範文字'));
  const sampleCounter = ui.el('span', { class: 'mrb-rb-counter', 'aria-live': 'off' }, '0');
  const sampleTa = ui.el('textarea', {
    class: 'mrb-rb-sample', rows: '5', spellcheck: 'false',
    'aria-label': tr('rb.sample', 'Sample text', '示範文字'),
    placeholder: tr('rb.samplePh', 'Paste text to test the pattern against…', '貼啲文字嚟試下條表達式…'),
  });
  const capWarn = ui.el('p', { class: 'mrb-rb-note mrb-rb-note--warn', hidden: 'true' },
    tr('rb.capWarn', `Evaluation skipped: the sample exceeds ${SAMPLE_CAP.toLocaleString()} characters.`,
      `已跳過評估：示範文字超過 ${SAMPLE_CAP.toLocaleString()} 字元。`));

  const matchStatus = ui.el('p', { class: 'mrb-rb-status', 'aria-live': 'polite' });
  const highlightBox = ui.el('div', { class: 'mrb-rb-highlight', 'aria-hidden': 'true' });
  const capNote = ui.el('p', { class: 'mrb-rb-note', hidden: 'true' });
  const capTableWrap = ui.el('div', { class: 'mrb-rb-capwrap' });
  const redosNote = ui.el('p', { class: 'mrb-rb-note mrb-rb-note--warn', hidden: 'true' },
    tr('rb.redos', 'Possible catastrophic backtracking (nested quantifiers like (a+)+). The app still caps evaluation at 50 ms.',
      '可能有災難性回溯（類似 (a+)+ 嘅巢狀量化）。應用程式仍會將評估上限定喺 50 毫秒。'));

  /* Actions */
  const actRow = ui.el('div', { class: 'mrb-rb-actions' });
  function actionBtn(labelText, onClick, cls = 'mrb-btn--tonal') {
    const b = ui.el('button', { class: `mrb-btn ${cls} mrb-rb-action`, type: 'button' }, labelText);
    b.addEventListener('click', onClick);
    actRow.appendChild(b);
    return b;
  }

  const foot = ui.el('footer', { class: 'mrb-rb-engine' }, ENGINE_FOOTER);

  /* ── Behaviour ── */

  function syncFromTextarea() {
    session.pattern = patTa.value;
    renderMatches();
  }
  patTa.addEventListener('input', syncFromTextarea);

  function refreshFlagButtons() {
    for (const btn of flagRow.querySelectorAll('button')) {
      const f = btn.dataset.flag;
      const on = session.flags.has(f);
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    yCaution.hidden = !session.flags.has('y');
    renderMatches();
  }

  for (const def of FLAG_DEFS) {
    const b = ui.el('button', {
      class: 'mrb-chip mrb-rb-flag', type: 'button', 'data-flag': def.f,
      title: tr(`rb.flag.${def.f}`, def.en, def.yue),
      'aria-pressed': 'false',
    }, def.f);
    b.addEventListener('click', () => {
      if (session.flags.has(def.f)) session.flags.delete(def.f);
      else session.flags.add(def.f);
      refreshFlagButtons();
    });
    flagRow.appendChild(b);
  }

  function currentFlags() {
    return [...FLAG_DEFS.map((d) => d.f)].filter((f) => session.flags.has(f)).join('');
  }

  function renderHighlighted(sample, matches) {
    highlightBox.textContent = '';
    if (!sample) return;
    const shown = sample.length > SAMPLE_DISPLAY_CAP ? sample.slice(0, SAMPLE_DISPLAY_CAP) : sample;
    capNote.hidden = sample.length <= SAMPLE_DISPLAY_CAP;
    if (capNote.hidden === false) {
      capNote.textContent = tr('rb.dispCap',
        `Showing the first ${SAMPLE_DISPLAY_CAP.toLocaleString()} characters of the sample; the match count below covers the whole sample.`,
        `只顯示示範文字頭 ${SAMPLE_DISPLAY_CAP.toLocaleString()} 字元；下面嘅匹配數仍統計全文。`);
    }
    // Safe rendering: text nodes + <mark>, never innerHTML with user content.
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const m of matches) {
      if (m.index >= shown.length) break;
      const hitEnd = Math.min(m.index + m[0].length, shown.length);
      if (m.index > pos) frag.appendChild(document.createTextNode(shown.slice(pos, m.index)));
      const mark = document.createElement('mark');
      mark.className = 'mrb-rb-hit';
      mark.textContent = m[0].length === 0 ? '∅' : shown.slice(m.index, hitEnd);
      if (m[0].length === 0) mark.title = 'zero-width match';
      frag.appendChild(mark);
      pos = hitEnd;
      if (pos >= shown.length) break;
    }
    if (pos < shown.length) frag.appendChild(document.createTextNode(shown.slice(pos)));
    highlightBox.appendChild(frag);
  }

  function renderCaptureTable(firstMatch) {
    capTableWrap.textContent = '';
    if (!firstMatch) return;
    const groups = [];
    firstMatch.slice(1).forEach((val, i) => groups.push({ name: `$${i + 1}`, value: val }));
    if (firstMatch.groups) {
      for (const [name, val] of Object.entries(firstMatch.groups)) groups.push({ name: `$<${name}>`, value: val });
    }
    if (!groups.length) return;
    const table = ui.el('table', { class: 'mrb-table mrb-rb-caps' });
    const caption = ui.el('caption', {}, tr('rb.captures', 'Capture groups (first match)', '擷取群組（第一次匹配）'));
    table.appendChild(caption);
    const thead = ui.el('thead', {}, ui.el('tr', {},
      ui.el('th', { scope: 'col' }, tr('rb.groupCol', 'Group', '群組')),
      ui.el('th', { scope: 'col' }, tr('rb.valueCol', 'Value', '值'))));
    const tbody = ui.el('tbody');
    for (const g of groups) {
      tbody.appendChild(ui.el('tr', {},
        ui.el('td', { class: 'mrb-rb-capname' }, g.name),
        ui.el('td', { class: 'mrb-rb-capval' }, g.value == null ? tr('rb.noValue', '(not matched)', '(冇匹配)') : String(g.value))));
    }
    table.appendChild(thead);
    table.appendChild(tbody);
    capTableWrap.appendChild(table);
  }

  function renderMatches() {
    const sample = sampleTa.value;
    const len = sample.length;
    sampleCounter.textContent = `${len.toLocaleString()} / ${SAMPLE_CAP.toLocaleString()}`;
    sampleCounter.classList.toggle('is-over', len > SAMPLE_CAP);
    capWarn.hidden = !(len > SAMPLE_CAP);

    redosNote.hidden = true;
    if (!session.pattern) {
      matchStatus.textContent = tr('rb.statusEmpty', 'Type a pattern or pick a chip above.', '打個表達式，或者撳上面嘅選項。');
      highlightBox.textContent = '';
      capTableWrap.textContent = '';
      return;
    }

    const r = evaluatePattern(session.pattern, currentFlags(), sample);
    redosNote.hidden = !r.catastrophic;

    if (r.error) {
      matchStatus.textContent = voice('error', r.error);
      matchStatus.classList.add('is-bad');
      highlightBox.textContent = '';
      capTableWrap.textContent = '';
      return;
    }
    matchStatus.classList.remove('is-bad');

    if (r.skipped) {
      matchStatus.textContent = voice('warn', capWarn.textContent);
      highlightBox.textContent = '';
      capTableWrap.textContent = '';
      return;
    }

    if (r.timedOut) {
      matchStatus.textContent = voice('warn',
        tr('rb.tooComplex', 'Too complex to evaluate safely — evaluation stopped after 50 ms.',
          '太複雜，唔敢繼續計——50 毫秒後已經收手。'));
      highlightBox.textContent = '';
      capTableWrap.textContent = '';
      return;
    }

    const capped = r.matches.length >= MAX_DISPLAY_MATCHES;
    matchStatus.textContent = r.matches.length === 1
      ? tr('rb.oneMatch', `1 match · ${r.elapsedMs} ms`, `1 個匹配 · ${r.elapsedMs} 毫秒`)
      : tr('rb.nMatches', `${r.matches.length.toLocaleString()} matches · ${r.elapsedMs} ms`, `${r.matches.length.toLocaleString()} 個匹配 · ${r.elapsedMs} 毫秒`);
    if (capped) {
      matchStatus.textContent += tr('rb.shownCap', ` (first ${MAX_DISPLAY_MATCHES} shown)`, `（只顯示頭 ${MAX_DISPLAY_MATCHES} 個）`);
    }
    renderHighlighted(sample, r.matches);
    renderCaptureTable(r.matches[0]);
  }

  sampleTa.addEventListener('input', () => {
    session.sample = sampleTa.value;
    renderMatches();
  });

  function applyChip(insertFn) {
    insertFn(patTa);
    syncFromTextarea();
  }

  /* Guided chips */
  chip(tr('rb.chip.literal', 'Literal "abc"', '字面 "abc"'),
    tr('rb.chip.literalTip', 'Inserts your selected text with regex characters escaped (or "abc").',
      '將揀選文字入面嘅正則符號跳脫後插入（冇揀就插入 abc）。'),
    (ta) => applyChip((t) => {
      const sel = selectionOf(t);
      insertAtCaret(t, sel.text ? escapeLiteral(sel.text) : 'abc');
    }));
  chip('.', tr('rb.chip.anyTip', 'Any character except line breaks.', '任何字元（換行除外）。'),
    () => applyChip((t) => insertAtCaret(t, '.')));

  chip('[a-zA-Z]', tr('rb.chip.lettersTip', 'Any ASCII letter.', '任何英文字母。'),
    () => applyChip((t) => insertAtCaret(t, '[a-zA-Z]')));
  chip('\\w', tr('rb.chip.wordTip', 'Word character: letter, digit or underscore.', '文字字元：字母、數字或底線。'),
    () => applyChip((t) => insertAtCaret(t, '\\w')));
  chip('\\d', tr('rb.chip.digitTip', 'Digit 0-9.', '數字 0-9。'),
    () => applyChip((t) => insertAtCaret(t, '\\d')));
  chip('\\s', tr('rb.chip.wsTip', 'Whitespace (spaces, tabs, newlines).', '空白（空格、Tab、換行）。'),
    () => applyChip((t) => insertAtCaret(t, '\\s')));

  chip('^', tr('rb.chip.startTip', 'Start of string (or line with the m flag).', '字串開頭（開 m 旗標就係行首）。'),
    () => applyChip((t) => insertAtCaret(t, '^')));
  chip('$', tr('rb.chip.endTip', 'End of string (or line with the m flag).', '字串結尾（開 m 旗標就係行尾）。'),
    () => applyChip((t) => insertAtCaret(t, '$')));
  chip('\\b', tr('rb.chip.boundaryTip', 'Word boundary.', '詞邊界。'),
    () => applyChip((t) => insertAtCaret(t, '\\b')));

  chip('( )', tr('rb.chip.capTip', 'Capturing group around the selection.', '包住揀選範圍嘅擷取群組。'),
    () => applyChip((t) => {
      const sel = selectionOf(t);
      insertAtCaret(t, `(${sel.text})`);
    }));
  chip('(?: )', tr('rb.chip.nonCapTip', 'Non-capturing group around the selection.', '包住揀選範圍、唔擷取嘅群組。'),
    () => applyChip((t) => {
      const sel = selectionOf(t);
      insertAtCaret(t, `(?:${sel.text})`);
    }));
  chip('|', tr('rb.chip.altTip', 'Alternation — either side can match.', '或然——左右兩邊都得。'),
    () => applyChip((t) => {
      const sel = selectionOf(t);
      insertAtCaret(t, sel.text ? `${sel.text}|` : 'a|b');
    }));

  quantChip('*', tr('rb.quant.star', 'Zero or more.', '零個或以上。'));
  quantChip('+', tr('rb.quant.plus', 'One or more.', '一個或以上。'));
  quantChip('?', tr('rb.quant.opt', 'Optional (zero or one).', '可以有可以冇。'));
  quantChip('{n}', tr('rb.quant.n', 'Exactly n — edit n after inserting.', '正好 n 次——插入後自己改 n。'));
  quantChip('{n,}', tr('rb.quant.nmin', 'n or more.', '至少 n 次。'));
  quantChip('{n,m}', tr('rb.quant.nm', 'Between n and m.', 'n 至 m 次。'));

  /* Mini-editors */
  function refreshCcPreview() {
    ccPreview.textContent = `[${ccNeg.checked ? '^' : ''}${ccInput.value}]`;
  }
  ccNeg.addEventListener('change', refreshCcPreview);
  ccInput.addEventListener('input', refreshCcPreview);
  ccInsert.addEventListener('click', () => {
    applyChip((t) => insertAtCaret(t, `[${ccNeg.checked ? '^' : ''}${ccInput.value}]`));
  });

  function ngNameValid(name) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
  }
  ngInput.addEventListener('input', () => {
    const ok = ngNameValid(ngInput.value);
    ngErr.hidden = ok || !ngInput.value;
    if (!ok && ngInput.value) {
      ngErr.textContent = tr('rb.ngBad', 'Use letters, digits or underscores, starting with a letter or underscore.',
        '要用字母、數字或底線，而且要以字母或底線開頭。');
    }
    ngInsert.disabled = !ok;
  });
  ngInsert.disabled = true;
  ngInsert.addEventListener('click', () => {
    if (!ngNameValid(ngInput.value)) return;
    applyChip((t) => {
      const sel = selectionOf(t);
      insertAtCaret(t, `(?<${ngInput.value}>${sel.text})`);
    });
  });

  escSelect.addEventListener('change', () => {
    if (!escSelect.value) return;
    applyChip((t) => insertAtCaret(t, escSelect.value));
    escSelect.value = '';
  });

  /* Actions */
  actionBtn(tr('rb.copyPattern', 'Copy pattern', '複製表達式'), async () => {
    try { await ui.copyText(session.pattern || ''); } catch { /* clipboard refused; nothing claimed */ }
  });
  actionBtn(tr('rb.copyEscaped', 'Copy escaped for string', '複製跳脫後字串'), async () => {
    try { await ui.copyText(JSON.stringify(session.pattern || '').slice(1, -1)); } catch { /* as above */ }
  }, 'mrb-btn--outlined');
  actionBtn(tr('rb.copySnippet', 'Copy JS snippet', '複製 JS 片段'), async () => {
    const snippet = `const re = new RegExp(${JSON.stringify(session.pattern || '')}, ${JSON.stringify(currentFlags())});`;
    try { await ui.copyText(snippet); } catch { /* as above */ }
  }, 'mrb-btn--outlined');
  const insertBtn = actionBtn(tr('rb.useInSearch', 'Insert into search', '套用至搜尋欄'), () => {
    if (controller) controller.setQuery(session.pattern, { mode: 'regex', flags: currentFlags(), silent: false });
    close();
    if (inputEl) inputEl.focus();
  }, 'mrb-btn--filled');

  /* Assemble */
  customClass.appendChild(ccSummary);
  customClass.appendChild(ui.el('div', { class: 'mrb-rb-mini-body' }, ccNegWrap, ccInput, ccPreview, ccInsert, ccNote));
  namedGroup.appendChild(ngSummary);
  namedGroup.appendChild(ui.el('div', { class: 'mrb-rb-mini-body' }, ngInput, ngErr, ngInsert));

  const quantBlock = ui.el('div', { class: 'mrb-rb-block' }, lazyWrap, quantChips);

  panel.appendChild(ui.el('header', { class: 'mrb-rb-pop-head' },
    ui.el('div', {}, headTitle, headSub), closeBtn));
  panel.appendChild(ui.el('section', { class: 'mrb-rb-sect', role: 'group', 'aria-labelledby': guidedHead.id },
    guidedHead,
    ui.el('div', { class: 'mrb-rb-block' },
      patLabel, patTa, chipGrid, quantBlock, customClass, namedGroup, escSelect)));
  panel.appendChild(ui.el('section', { class: 'mrb-rb-sect' }, flagsHead, flagRow, yCaution));
  panel.appendChild(ui.el('section', { class: 'mrb-rb-sect' },
    ui.el('div', { class: 'mrb-rb-labline' }, sampleLabel, sampleCounter), sampleTa, capWarn));
  panel.appendChild(ui.el('section', { class: 'mrb-rb-sect', 'aria-label': 'Live matches' },
    matchStatus, highlightBox, capNote, redosNote, capTableWrap));
  panel.appendChild(ui.el('section', { class: 'mrb-rb-sect' }, actRow));
  panel.appendChild(foot);

  /* Seed state from the owning field, then paint once. */
  patTa.value = session.pattern;
  sampleTa.value = session.sample;
  refreshFlagButtons();
  renderMatches();
  requestAnimationFrame(() => patTa.focus());

  let closed = false;
  let anchoredClose = null;
  function close() {
    if (closed) return;
    closed = true;
    try { if (anchoredClose) anchoredClose(); } catch { /* host already removed it */ }
    if (typeof opts.onClose === 'function') opts.onClose();
  }
  closeBtn.addEventListener('click', () => close());

  // ui.anchored paints the popover's own surface/border/elevation, bounds it
  // to the viewport (scrolling internally), flips away from screen edges,
  // never covers the anchor field, closes on outside Escape and restores
  // focus to the anchor. CSS additionally caps the body at 70vh with its own
  // scrollbar for very long content.
  anchoredClose = ui.anchored(inputEl, panel, { maxHeight: '70vh' }) || (() => {});
  return close;
}

/* ── Module init ────────────────────────────────────────────────────────── */

export async function init() {
  try {
    ui.injectCss(new URL('../../styles/features/coreux.css', import.meta.url).href);
  } catch (err) {
    console.warn('[mrb/regexbuilder] stylesheet injection failed:', err && err.message);
  }
  await loadSettingsPeer();
}
