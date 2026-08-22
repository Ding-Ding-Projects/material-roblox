/**
 * appearance.js — M3 appearance engine (Lane E).
 *
 * Owns everything visual the user can tune:
 *  - Settings group "Appearance": theme system/light/dark (default dark),
 *    accent SEED colour driving a generated tonal palette, density,
 *    font family (installed enumeration where the platform grants it,
 *    bundled fallback stack otherwise), font-size scale 85..130%,
 *    base weight, rainbow speed level.
 *  - Tonal palette: OKLab-space approximation of Material You tonal roles.
 *    This is deliberately documented as an APPROXIMATION — the reference
 *    algorithm is Google's HCT; we reproduce the role structure and contrast
 *    guarantees (every on-* colour is picked by measured WCAG contrast against
 *    its container) without shipping HCT itself.
 *  - Per-element appearance editor ("Edit appearance…", Shift+right-click):
 *    Word-depth typography, colour/shape/elevation sections, state targets
 *    (default/hover/active/disabled), anchored non-modal panel that tracks its
 *    anchor, per-property/per-element/global reset, locks integration.
 *  - Named theme presets + user presets + export/import (.json token dump).
 *  - App-logo customisation with shipped presets + validated local upload,
 *    crop/fit/focal/background controls, derived display sizes, honest notes
 *    about what conversion loses, reset to shipped mark.
 *
 * Persistence lives under `mrb:appearance*` store keys; every mutation is
 * recorded through the history peer as kind 'settings'.
 */

import { store } from './store.js';
import { ui } from './ui.js';
import { i18n } from './i18n.js';
import {
  RAINBOW, RAINBOW_SPEED_MAP, applyRainbowGlobals, ensureToolsStyles,
  mountColorPicker, parse as cpParse, toHex, contrastReport, WHITE, BLACK,
} from './colorpicker.js';

/* ------------------------------------------------------------------ */
/* Peers (optional-degrade)                                            */
/* ------------------------------------------------------------------ */

const peerCache = new Map();
function peer(name) {
  if (!peerCache.has(name)) {
    peerCache.set(name, import(name).then((m) => m).catch(() => null));
  }
  return peerCache.get(name);
}
async function getPeers() {
  const [settingsM, routerM, paletteM, exporterM, historyM, locksM] = await Promise.all([
    peer('./settings.js'), peer('./router.js'), peer('./palette.js'),
    peer('./exporter.js'), peer('./history.js'), peer('./locks.js'),
  ]);
  return {
    settings: settingsM && settingsM.settings,
    router: routerM && routerM.router,
    palette: paletteM && paletteM.palette ? paletteM.palette : (paletteM && paletteM.register ? paletteM : null),
    exporter: exporterM && exporterM.exporter,
    history: historyM && historyM.history,
    locks: locksM && (locksM.locks || locksM.default || null),
  };
}

let P = { settings: null, router: null, palette: null, exporter: null, history: null, locks: null };

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function tt(en, yue) {
  try {
    if (i18n.schoolActive()) return en;
    const mode = i18n.lang();
    if (mode === 'yue' && yue) return yue;
    if (mode === 'bi' && yue) return `${en} · ${yue}`;
  } catch (_) { /* English always correct */ }
  return en;
}

/** History recording that degrades silently when the peer is absent. */
function recordChange(label, snapshot) {
  try {
    if (P.history && typeof P.history.record === 'function') {
      P.history.record({ kind: 'settings', label, snapshot });
    }
  } catch (_) { /* history is evidence, never a gate */ }
}

function setSetting(path, value, label) {
  if (P.settings && typeof P.settings.set === 'function') {
    P.settings.set(path, value);
  } else {
    store.set(path, value); // settings peer absent this boot: persist directly
  }
  recordChange(label || `Changed ${path}`, { path, value });
}

function getSetting(path, fallback) {
  if (P.settings && typeof P.settings.get === 'function') {
    return P.settings.get(path, fallback);
  }
  const v = store.get(path, undefined);
  return v === undefined ? fallback : v;
}

/* ------------------------------------------------------------------ */
/* Tonal palette (documented approximation)                            */
/* ------------------------------------------------------------------ */

/**
 * Build `oklch(L C H)` -> parsed sRGB via the shared colour math. Returns
 * null when the coordinates fall outside anything representable.
 */
function oklch(L, C, H) {
  const p = cpParse(`oklch(${round2(L)} ${round3(Math.max(0, C))} ${round1(((H % 360) + 360) % 360)})`);
  return p.ok ? p : null;
}
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;

/** Pick readable ink for a container colour (WCAG AA body-text threshold). */
function inkFor(bgColor) {
  const onWhite = contrastReport(bgColor, WHITE);
  return onWhite.aaBody ? '#FFFFFF' : '#1B1B1F';
}

/**
 * Generate the full M3 role set from a seed colour.
 * Approximation note: roles follow Material You's structure (primary /
 * secondary / tertiary containers, five surface container steps, inverse
 * roles) computed in OKLab rather than HCT. Contrast pairs are verified with
 * the WCAG report rather than trusted from the tone ladder.
 */
export function buildTonalTokens(seedStr, { dark, highContrast }) {
  const seed = cpParse(seedStr);
  let L0 = 0.56, C0 = 0.13, H0 = 25;
  if (seed.ok) {
    // Extract OKLCH from the parsed seed through the shared translator.
    const lin = [seed.r, seed.g, seed.b];
    const lab = oklabOf(lin);
    if (lab) { L0 = lab[0]; C0 = Math.max(lab[1], 0.04); H0 = lab[2]; }
  }

  const capC = (c, max) => Math.min(Math.max(c, 0.02), max);
  const roles = {};
  const put = (k, col) => { if (col) roles[k] = toHex(col, { forceAlpha: true }); };

  if (!dark) {
    const prim = oklch(0.50, capC(C0 * 1.35, 0.17), H0);
    const primC = oklch(0.90, capC(C0 * 0.60, 0.10), H0);
    const sec = oklch(0.52, capC(C0 * 0.45, 0.10), H0 + 14);
    const secC = oklch(0.89, capC(C0 * 0.32, 0.07), H0 + 14);
    const ter = oklch(0.53, capC(C0 * 0.44, 0.11), H0 - 42);
    const terC = oklch(0.90, capC(C0 * 0.30, 0.08), H0 - 42);
    put('--mrb-primary', prim);
    put('--mrb-on-primary', prim ? inkFor(prim) : null);
    put('--mrb-primary-container', primC);
    put('--mrb-on-primary-container', primC ? inkFor(oklch(0.34, capC(C0 * 0.9, 0.13), H0)) : null);
    roles['--mrb-on-primary-container'] = toHex(oklch(0.30, capC(C0 * 0.95, 0.13), H0));
    put('--mrb-secondary', sec);
    put('--mrb-on-secondary', sec ? inkFor(sec) : null);
    put('--mrb-secondary-container', secC);
    roles['--mrb-on-secondary-container'] = toHex(oklch(0.30, capC(C0 * 0.5, 0.08), H0 + 14));
    put('--mrb-tertiary', ter);
    put('--mrb-on-tertiary', ter ? inkFor(ter) : null);
    put('--mrb-tertiary-container', terC);
    roles['--mrb-on-tertiary-container'] = toHex(oklch(0.30, capC(C0 * 0.5, 0.09), H0 - 42));
    roles['--mrb-surface'] = toHex(neutralTone(H0, 0.985));
    roles['--mrb-surface-dim'] = toHex(neutralTone(H0, 0.88));
    roles['--mrb-surface-bright'] = toHex(neutralTone(H0, 0.995));
    roles['--mrb-surface-container-lowest'] = toHex(neutralTone(H0, 1.0));
    roles['--mrb-surface-container-low'] = toHex(neutralTone(H0, 0.962));
    roles['--mrb-surface-container'] = toHex(neutralTone(H0, 0.94));
    roles['--mrb-surface-container-high'] = toHex(neutralTone(H0, 0.918));
    roles['--mrb-surface-container-highest'] = toHex(neutralTone(H0, 0.897));
    roles['--mrb-on-surface'] = toHex(neutralTone(H0, highContrast ? 0.10 : 0.19));
    roles['--mrb-on-surface-variant'] = toHex(neutralTone(H0, highContrast ? 0.30 : 0.41, 0.014));
    roles['--mrb-outline'] = toHex(neutralTone(H0, highContrast ? 0.42 : 0.57, 0.014));
    roles['--mrb-outline-variant'] = toHex(neutralTone(H0, highContrast ? 0.68 : 0.85, 0.010));
    roles['--mrb-inverse-surface'] = toHex(neutralTone(H0, 0.20));
    roles['--mrb-inverse-on-surface'] = toHex(neutralTone(H0, 0.965));
    roles['--mrb-inverse-primary'] = toHex(oklch(0.81, capC(C0 * 0.75, 0.13), H0));
  } else {
    const prim = oklch(0.82, capC(C0 * 0.85, 0.15), H0);
    const primC = oklch(0.38, capC(C0 * 0.75, 0.12), H0);
    const sec = oklch(0.80, capC(C0 * 0.34, 0.09), H0 + 14);
    const secC = oklch(0.40, capC(C0 * 0.28, 0.06), H0 + 14);
    const ter = oklch(0.81, capC(C0 * 0.33, 0.10), H0 - 42);
    const terC = oklch(0.40, capC(C0 * 0.26, 0.07), H0 - 42);
    put('--mrb-primary', prim);
    roles['--mrb-on-primary'] = toHex(oklch(0.24, capC(C0 * 0.9, 0.12), H0));
    put('--mrb-primary-container', primC);
    roles['--mrb-on-primary-container'] = toHex(oklch(0.90, capC(C0 * 0.6, 0.10), H0));
    put('--mrb-secondary', sec);
    roles['--mrb-on-secondary'] = toHex(oklch(0.24, capC(C0 * 0.4, 0.06), H0 + 14));
    put('--mrb-secondary-container', secC);
    roles['--mrb-on-secondary-container'] = toHex(oklch(0.90, capC(C0 * 0.3, 0.05), H0 + 14));
    put('--mrb-tertiary', ter);
    roles['--mrb-on-tertiary'] = toHex(oklch(0.24, capC(C0 * 0.4, 0.07), H0 - 42));
    put('--mrb-tertiary-container', terC);
    roles['--mrb-on-tertiary-container'] = toHex(oklch(0.90, capC(C0 * 0.28, 0.06), H0 - 42));
    roles['--mrb-surface'] = toHex(neutralTone(H0, highContrast ? 0.06 : 0.105));
    roles['--mrb-surface-dim'] = toHex(neutralTone(H0, 0.06));
    roles['--mrb-surface-bright'] = toHex(neutralTone(H0, 0.16));
    roles['--mrb-surface-container-lowest'] = toHex(neutralTone(H0, highContrast ? 0.0 : 0.085));
    roles['--mrb-surface-container-low'] = toHex(neutralTone(H0, 0.135));
    roles['--mrb-surface-container'] = toHex(neutralTone(H0, 0.17));
    roles['--mrb-surface-container-high'] = toHex(neutralTone(H0, 0.215));
    roles['--mrb-surface-container-highest'] = toHex(neutralTone(H0, 0.26));
    roles['--mrb-on-surface'] = toHex(neutralTone(H0, highContrast ? 0.98 : 0.92));
    roles['--mrb-on-surface-variant'] = toHex(neutralTone(H0, highContrast ? 0.88 : 0.77, 0.014));
    roles['--mrb-outline'] = toHex(neutralTone(H0, highContrast ? 0.80 : 0.61, 0.014));
    roles['--mrb-outline-variant'] = toHex(neutralTone(H0, highContrast ? 0.55 : 0.32, 0.010));
    roles['--mrb-inverse-surface'] = toHex(neutralTone(H0, 0.91));
    roles['--mrb-inverse-on-surface'] = toHex(neutralTone(H0, 0.20));
    roles['--mrb-inverse-primary'] = toHex(oklch(0.50, capC(C0 * 1.2, 0.15), H0));
  }

  /* Error family stays the shipped M3 baseline in both themes. */
  Object.assign(roles, {
    '--mrb-error': '#B3261E',
    '--mrb-on-error': '#FFFFFF',
    '--mrb-error-container': dark ? '#F9DEDC' : '#F9DEDC',
    '--mrb-on-error-container': '#410E0B',
  });
  return roles;

  function neutralTone(hue, Ltone, cmax = 0.008) {
    return oklch(Ltone, cmax, hue);
  }
}

/** OKLab of linear sRGB triple (reuses the shared matrices indirectly). */
function oklabOf(linSrgb) {
  const probe = cpParse(toHex({ r: linSrgb[0], g: linSrgb[1], b: linSrgb[2], a: 1 }));
  void probe;
  /* Direct matrix math (same constants as colorpicker.js OKLab path). */
  const [r, g, b] = linSrgb.map(linearise);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(Math.max(l, 0));
  const m_ = Math.cbrt(Math.max(m, 0));
  const s_ = Math.cbrt(Math.max(s, 0));
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  let h = (Math.atan2(B, A) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [L, Math.sqrt(A * A + B * B), h];
}
function linearise(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/* ------------------------------------------------------------------ */
/* Theme + base application                                            */
/* ------------------------------------------------------------------ */

const FONT_FALLBACKS = ['Segoe UI Variable', 'Segoe UI', 'Roboto', 'Microsoft JhengHei', 'Noto Sans HK', 'system-ui'];

let systemDarkWatcher = null;

function resolveDark(theme) {
  if (theme === 'light') return false;
  if (theme === 'system') {
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (_) { return true; }
  }
  return true; // shipped default: dark
}

/** Apply every appearance setting to the live document. Idempotent. */
export function applyAppearance() {
  const root = document.documentElement;
  const theme = getSetting('appearance.theme', 'dark');
  const dark = resolveDark(theme);
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  root.setAttribute('data-theme-mode', theme);

  const seed = getSetting('appearance.accentSeed', '#B3261E');
  const hc = !!getSetting('appearance.highContrast', false);
  root.toggleAttribute('data-mrb-hc', hc);
  const roles = buildTonalTokens(seed === RAINBOW ? '#B3261E' : seed, { dark, highContrast: hc });
  for (const [k, v] of Object.entries(roles)) root.style.setProperty(k, v);

  const density = getSetting('appearance.density', 'comfortable');
  root.setAttribute('data-density', density);
  root.style.setProperty('--mrb-density', density === 'compact' ? '0.72' : '1');

  const scale = Number(getSetting('appearance.fontScale', 1)) || 1;
  const pct = Math.round(Math.min(Math.max(scale, 0.85), 1.3) * 100);
  root.style.fontSize = pct + '%';

  const weight = String(getSetting('appearance.baseWeight', 400));
  document.body.style.setProperty('--mrb-weight-base', weight);
  document.body.style.fontWeight = weight;

  const family = getSetting('appearance.fontFamily', '');
  const stack = family && family !== '__default__'
    ? `"${String(family).replace(/["\\]/g, '')}", ${FONT_FALLBACKS.join(', ')}`
    : FONT_FALLBACKS.join(', ');
  document.body.style.setProperty('--mrb-font-family-user', stack);
  document.body.style.fontFamily = stack;

  applyRainbowGlobals();
}

/* ------------------------------------------------------------------ */
/* Installed font enumeration                                          */
/* ------------------------------------------------------------------ */

let installedFontsCache = null;

/** Enumerate installed fonts when the platform grants permission; else null. */
export async function listInstalledFonts() {
  if (installedFontsCache) return installedFontsCache;
  try {
    if (typeof window.queryLocalFonts !== 'function') return null;
    const fonts = await window.queryLocalFonts();
    const names = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
    installedFontsCache = names;
    return names;
  } catch (_) {
    return null; // permission refused or API absent — fallback stack stands
  }
}

/* ------------------------------------------------------------------ */
/* Element signature + overrides                                       */
/* ------------------------------------------------------------------ */

/**
 * Stable CSS path for an element (tag + id + first classes + nth-of-type),
 * rooted at body. Deliberately deterministic across reloads for static UI.
 */
export function elementSignature(el) {
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.body) {
    let seg = node.tagName.toLowerCase();
    if (node.id) {
      seg += '#' + node.id;
    } else {
      const cls = [...node.classList].filter((c) => /^[a-zA-Z][\w-]*$/.test(c)).slice(0, 2);
      if (cls.length) seg += '.' + cls.join('.');
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((n) => n.tagName === node.tagName);
        if (same.length > 1) seg += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
    }
    parts.unshift(seg);
    node = node.parentElement;
  }
  return 'body > ' + parts.join(' > ');
}

export function hashSignature(sig) {
  let h = 5381;
  for (let i = 0; i < sig.length; i++) h = ((h << 5) + h + sig.charCodeAt(i)) >>> 0;
  return 'e' + h.toString(36);
}

const OVERRIDES_KEY = 'elementOverrides';

function loadOverrides() {
  return store.get(OVERRIDES_KEY, {});
}
function saveOverrides(map, label) {
  store.set(OVERRIDES_KEY, map);
  recordChange(label || 'Appearance overrides changed', { overrides: Object.keys(map) });
}

let overrideStyleTag = null;
let restampObserver = null;
let restampTimer = null;

/** Regenerate the injected override stylesheet from the stored map. */
export function refreshOverrideStylesheet() {
  if (!overrideStyleTag) {
    overrideStyleTag = document.createElement('style');
    overrideStyleTag.id = 'mrb-appearance-overrides';
    document.head.append(overrideStyleTag);
  }
  const map = loadOverrides();
  const chunks = [];
  const STATE_PSEUDO = { base: '', hover: ':hover', active: ':active', disabled: ':disabled' };
  for (const rec of Object.values(map)) {
    if (!rec || !rec.selector || !rec.states) continue;
    for (const [stateName, props] of Object.entries(rec.states)) {
      const decls = Object.entries(props || {})
        .map(([p, v]) => `  ${p}: ${v} !important;`)
        .join('\n');
      if (!decls) continue;
      chunks.push(`${rec.selector}${STATE_PSEUDO[stateName] || ''} {\n${decls}\n}`);
    }
  }
  overrideStyleTag.textContent = chunks.join('\n\n');
  stampAll();
}

/** Stamp matching elements with their data attribute so the rules bind. */
function stampAll() {
  const map = loadOverrides();
  for (const [hash, rec] of Object.entries(map)) {
    if (!rec.selector) continue;
    let nodes = [];
    try { nodes = [...document.querySelectorAll(rec.selector)]; } catch (_) { continue; }
    for (const n of nodes) n.setAttribute('data-mrb-e', hash);
  }
}

function startRestampObserver() {
  if (restampObserver || typeof MutationObserver === 'undefined') return;
  restampObserver = new MutationObserver(() => {
    clearTimeout(restampTimer);
    restampTimer = setTimeout(stampAll, 250);
  });
  restampObserver.observe(document.body, { childList: true, subtree: true });
}

/** Ask the locks peer whether this property on this element may change. */
async function vetoed(hash, prop) {
  try {
    if (P.locks && typeof P.locks.vetoPropertyChange === 'function') {
      return await P.locks.vetoPropertyChange(hash, prop);
    }
  } catch (_) { /* locks degraded: fail open, appearance is presentation-only */ }
  return false;
}

/* ------------------------------------------------------------------ */
/* Per-element editor                                                  */
/* ------------------------------------------------------------------ */

const EDITABLE_PROPS = [
  ['color', 'Text colour'],
  ['background-color', 'Highlight'],
  ['font-family', 'Font family'],
  ['font-size', 'Font size'],
  ['font-weight', 'Weight'],
  ['font-style', 'Italic / oblique'],
  ['text-decoration-line', 'Underline / strike'],
  ['text-decoration-style', 'Decoration style'],
  ['text-decoration-color', 'Decoration colour'],
  ['font-variant-caps', 'Caps'],
  ['vertical-align', 'Sup/sub/baseline'],
  ['letter-spacing', 'Letter spacing'],
  ['word-spacing', 'Word spacing'],
  ['line-height', 'Line height'],
  ['text-align', 'Alignment'],
  ['direction', 'Direction'],
  ['outline-color', 'Outline colour'],
  ['outline-width', 'Outline width'],
  ['box-shadow', 'Shadow / glow'],
  ['border-radius', 'Corner radius'],
];

function propSupported(prop, sampleValue) {
  try {
    if (prop === 'box-shadow') return CSS.supports('box-shadow', '0 0 0 #000');
    if (prop === 'text-decoration-style') return CSS.supports('text-decoration-style', 'wavy');
    return CSS.supports(prop, sampleValue);
  } catch (_) { return true; }
}

let activeEditorClose = null;

/**
 * Open the anchored per-element appearance editor for `el`.
 * @param {HTMLElement} el
 * @param {{direct?:boolean}} opts direct=true means Shift+right-click route.
 */
export async function editElement(el, opts = {}) {
  if (!el || el === document.body || el === document.documentElement) {
    ui.toast?.({
      title: tt('Nothing editable there', '嗰度冇嘢可以改'),
      body: tt('Pick a concrete control, card or text node inside the page.', '揀個具體控件、卡或者文字。'),
      tone: 'info', timeoutMs: 4000,
    });
    return;
  }
  if (activeEditorClose) { try { activeEditorClose(); } catch (_) {} activeEditorClose = null; }

  const sig = elementSignature(el);
  const hash = hashSignature(sig);
  const originFocus = document.activeElement;

  const panel = ui.el('div', { class: 'mrb-app-editor', role: 'dialog', 'aria-label': tt('Edit appearance', '編輯外觀') });
  panel.append(ui.el('h3', { class: 'mrb-app-editor-title', text: tt('Edit appearance', '編輯外觀') }));
  const sigLine = ui.el('code', { class: 'mrb-app-editor-sig', text: sig });
  sigLine.title = sig;
  panel.append(sigLine);

  const map = loadOverrides();
  const rec = map[hash] || (map[hash] = { selector: sig, states: {} });

  /* state target tabs */
  const STATES = ['base', 'hover', 'active', 'disabled'];
  let curState = 'base';
  const stateTabs = ui.el('div', { class: 'mrb-app-editor-states', role: 'tablist', 'aria-label': tt('State target', '狀態目標') });
  const stateBtns = {};
  for (const st of STATES) {
    const b = ui.el('button', {
      class: 'mrb-chip mrb-app-state-chip',
      type: 'button',
      role: 'tab',
      'aria-selected': String(st === curState),
      text: st,
    });
    b.addEventListener('click', () => {
      curState = st;
      for (const [k, btn] of Object.entries(stateBtns)) btn.setAttribute('aria-selected', String(k === st));
    });
    stateBtns[st] = b;
    stateTabs.append(b);
  }
  panel.append(stateTabs);

  const propsFor = () => (rec.states[curState] = rec.states[curState] || {});
  const currentVal = (prop) => (rec.states[curState] || {})[prop]
    || (curState === 'base' ? getComputedStyle(el).getPropertyValue(prop).trim() : '');

  const bodyWrap = ui.el('div', { class: 'mrb-app-editor-body' });
  panel.append(bodyWrap);

  const commit = async (prop, value) => {
    if (await vetoed(hash, prop)) {
      ui.toast?.({
        title: tt('That element is locked', '呢個元素已鎖上'),
        body: tt('A lock protects this property. Unlock the element to edit it.', '有鎖保護緊呢個屬性；解鎖先可以改。'),
        tone: 'warn', timeoutMs: 5000,
      });
      return;
    }
    const props = propsFor();
    if (value === '' || value == null) delete props[prop];
    else props[prop] = value;
    saveOverrides(loadOverridesMapWith(map, hash, rec), `Edited ${prop} (${curState})`);
    refreshOverrideStylesheet();
  };
  function loadOverridesMapWith(base, h, r) { base[h] = r; return base; }

  buildTypographySection(bodyWrap, el, currentVal, commit);
  buildColourShapeSection(bodyWrap, el, currentVal, commit);

  /* resets */
  const resetRow = ui.el('div', { class: 'mrb-app-editor-resets' });
  const perPropSel = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Property to reset', '重設邊個屬性') });
  const fillProps = () => {
    perPropSel.textContent = '';
    const edited = new Set(Object.keys(propsFor()));
    if (!edited.size) perPropSel.append(ui.el('option', { value: '', text: tt('(nothing edited in this state)', '(呢個狀態未有改動)') }));
    for (const k of edited) perPropSel.append(ui.el('option', { value: k, text: k }));
  };
  fillProps();
  const resetPropBtn = ui.el('button', { class: 'mrb-btn mrb-btn-tonal mrb-btn-sm', type: 'button', text: tt('Reset property', '重設屬性') });
  resetPropBtn.addEventListener('click', () => {
    const p = perPropSel.value;
    if (!p) return;
    delete propsFor()[p];
    saveOverrides(map, `Reset ${p}`);
    refreshOverrideStylesheet();
    fillProps();
  });
  const resetElBtn = ui.el('button', { class: 'mrb-btn mrb-btn-outlined mrb-btn-sm', type: 'button', text: tt('Reset element', '重設元素') });
  resetElBtn.addEventListener('click', () => {
    const fresh = loadOverrides();
    delete fresh[hash];
    el.removeAttribute('data-mrb-e');
    store.set(OVERRIDES_KEY, fresh);
    recordChange('Reset element appearance', { element: hash });
    refreshOverrideStylesheet();
    try { close(); } catch (_) {}
  });
  resetRow.append(perPropSel, resetPropBtn, resetElBtn);
  panel.append(resetRow);

  /* anchor + open */
  let close;
  if (typeof ui.anchored === 'function') {
    close = ui.anchored(el, panel, { onclose: onClosed });
  } else {
    close = fallbackAnchor(el, panel, onClosed);
  }
  activeEditorClose = close;
  function onClosed() {
    activeEditorClose = null;
    try { if (originFocus && document.contains(originFocus)) originFocus.focus(); } catch (_) {}
  }

  /* ---------------- section builders ------------------------------ */
  function buildTypographySection(wrap, target, val, doCommit) {
    const sec = ui.el('details', { class: 'mrb-app-section', open: true },
      ui.el('summary', { text: tt('Typography', '字體排印') }));
    const grid = ui.el('div', { class: 'mrb-app-grid' });

    /* font family: searchable list, each option previewed in its own face */
    const famRow = ui.el('label', { class: 'mrb-app-row mrb-app-row-wide' },
      ui.el('span', { text: tt('Family', '字族') }));
    const famSearch = ui.el('input', {
      class: 'mrb-field-input', type: 'search',
      placeholder: tt('Filter families…', '篩選字族…'),
      'aria-label': tt('Filter font families', '篩選字族'),
    });
    const famList = ui.el('div', { class: 'mrb-app-fontlist', role: 'listbox', 'aria-label': tt('Fonts', '字體'), tabindex: '0' });
    famRow.append(famSearch, famList);
    grid.append(famRow);
    const renderFamList = async () => {
      famList.textContent = '';
      const q = famSearch.value.trim().toLowerCase();
      const addOption = (name, labelExtra) => {
        if (q && !name.toLowerCase().includes(q)) return;
        const opt = ui.el('div', {
          class: 'mrb-app-fontopt', role: 'option', tabindex: '-1',
          style: `font-family:"${name.replace(/"/g, '')}", monospace`,
          text: name + (labelExtra || ''),
        });
        opt.addEventListener('click', () => doCommit('font-family', `"${name.replace(/"/g, '')}"`));
        opt.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') opt.click(); });
        famList.append(opt);
      };
      addOption(FONT_FALLBACKS[0] + ' / system stack', tt('  (shipped default)', '（出廠預設）'));
      const installed = await listInstalledFonts();
      if (installed && installed.length) for (const f of installed.slice(0, 400)) addOption(f);
      else famList.append(ui.el('div', {
        class: 'mrb-cpk-empty',
        text: tt('Installed font list unavailable — the shipped stack still applies. Use “Browse installed fonts…” in Settings to grant access.', '攞唔到已安裝字體清單 — 仍會用內置字族。可去設定㩒「瀏覽已安裝字體…」授權。'),
      }));
    };
    famSearch.addEventListener('input', ui.debounce ? ui.debounce(renderFamList, 150) : renderFamList);
    renderFamList();

    grid.append(numRow(tt('Size (px)', '大小（px）'), 'font-size', () => parseFloat(val('font-size')) || 14,
      (v) => doCommit('font-size', `${v}px`), { min: 8, max: 96, step: 1 }));

    const weightSel = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Weight', '字重') });
    for (const w of ['inherit', '300', '400', '500', '600', '700', '800']) {
      weightSel.append(ui.el('option', { value: w, text: w }));
    }
    weightSel.value = val('font-weight') || 'inherit';
    weightSel.addEventListener('change', () => doCommit('font-weight', weightSel.value === 'inherit' ? '' : weightSel.value));
    grid.append(fieldRow(tt('Weight', '字重'), weightSel));

    const styleSel = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Style', '樣式') });
    for (const [v, lbl] of [['', 'normal'], ['italic', 'italic'], ['oblique 8deg', 'oblique']]) {
      styleSel.append(ui.el('option', { value: v, text: lbl }));
    }
    styleSel.value = val('font-style') || '';
    if (styleSel.value.startsWith('oblique')) styleSel.value = 'oblique 8deg';
    styleSel.addEventListener('change', () => doCommit('font-style', styleSel.value));
    grid.append(fieldRow(tt('Style', '樣式'), styleSel));

    const decSel = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Decoration line', '裝飾線') });
    for (const [v, lbl] of [['', 'none'], ['underline', 'underline'], ['line-through', 'strikethrough'], ['underline line-through', 'underline + strike'], ['overline', 'overline']]) {
      decSel.append(ui.el('option', { value: v, text: lbl }));
    }
    decSel.value = val('text-decoration-line') || '';
    decSel.addEventListener('change', () => doCommit('text-decoration-line', decSel.value));
    grid.append(fieldRow(tt('Lines', '線'), decSel));

    const decStyleSel = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Decoration style', '裝飾線款式') });
    for (const v of ['', 'solid', 'double', 'dotted', 'dashed', 'wavy']) {
      decStyleSel.append(ui.el('option', { value: v, text: v || 'default' }));
    }
    decStyleSel.value = val('text-decoration-style') || '';
    if (!propSupported('text-decoration-style', 'wavy')) {
      decStyleSel.disabled = true;
      decStyleSel.title = tt('Not supported on this platform.', '呢個平台唔支援。');
    }
    decStyleSel.addEventListener('change', () => doCommit('text-decoration-style', decStyleSel.value));
    grid.append(fieldRow(tt('Line style', '線款式'), decStyleSel));

    grid.append(colourRow(tt('Line colour', '線顏色'), 'text-decoration-color', val, doCommit));

    const capsSel = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Capitalisation', '大細楷') });
    for (const [v, lbl] of [['', 'normal'], ['small-caps', 'small caps'], ['all-small-caps', 'all small caps']]) {
      capsSel.append(ui.el('option', { value: v, text: lbl }));
    }
    capsSel.value = val('font-variant-caps') || '';
    capsSel.addEventListener('change', () => doCommit('font-variant-caps', capsSel.value));
    grid.append(fieldRow(tt('Caps', '大細楷'), capsSel));

    const vaSel = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Vertical align', '垂直對齊') });
    for (const [v, lbl] of [['', 'baseline'], ['super', 'superscript'], ['sub', 'subscript']]) {
      vaSel.append(ui.el('option', { value: v, text: lbl }));
    }
    vaSel.value = ['super', 'sub'].includes(val('vertical-align')) ? val('vertical-align') : '';
    vaSel.addEventListener('change', () => doCommit('vertical-align', vaSel.value));
    grid.append(fieldRow(tt('Sup / sub', '上標下標'), vaSel));

    grid.append(numRow(tt('Baseline offset (px)', '基線偏移（px）'), 'vertical-align', () => parseFloat(val('vertical-align')) || 0,
      (v) => doCommit('vertical-align', v === 0 ? '' : `${v}px`), { min: -24, max: 24, step: 1 }));

    grid.append(numRow(tt('Letter spacing (px)', '字距（px）'), 'letter-spacing', () => parseFloat(val('letter-spacing')) || 0,
      (v) => doCommit('letter-spacing', v === 0 ? '' : `${v}px`), { min: -4, max: 16, step: 0.25 }));
    grid.append(numRow(tt('Word spacing (px)', '詞距（px）'), 'word-spacing', () => parseFloat(val('word-spacing')) || 0,
      (v) => doCommit('word-spacing', v === 0 ? '' : `${v}px`), { min: -8, max: 32, step: 0.5 }));
    grid.append(numRow(tt('Line height', '行高'), 'line-height', () => parseFloat(val('line-height')) || 0,
      (v) => doCommit('line-height', v === 0 ? '' : String(v)), { min: 0.8, max: 3, step: 0.05 }));

    const alignSel = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Alignment', '對齊') });
    for (const v of ['', 'left', 'center', 'right', 'justify']) alignSel.append(ui.el('option', { value: v, text: v || 'inherit' }));
    alignSel.value = val('text-align') || '';
    alignSel.addEventListener('change', () => doCommit('text-align', alignSel.value));
    grid.append(fieldRow(tt('Align', '對齊'), alignSel));

    const dirSel = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Direction', '書寫方向') });
    for (const v of ['', 'ltr', 'rtl']) dirSel.append(ui.el('option', { value: v, text: v || 'inherit' }));
    dirSel.value = val('direction') || '';
    dirSel.addEventListener('change', () => doCommit('direction', dirSel.value));
    grid.append(fieldRow(tt('Direction', '方向'), dirSel));

    wrap.append(sec);
    sec.append(grid);

    function fieldRow(lblTxt, ctrl) {
      return ui.el('label', { class: 'mrb-app-row' }, ui.el('span', { text: lblTxt }), ctrl);
    }
    function numRow(lblTxt, prop, getV, setV, bounds) {
      const stepper = ui.el('input', {
        class: 'mrb-field-input', type: 'number',
        min: String(bounds.min), max: String(bounds.max), step: String(bounds.step),
        value: String(getV()), 'aria-label': lblTxt,
      });
      stepper.addEventListener('change', () => {
        let n = parseFloat(stepper.value);
        if (Number.isNaN(n)) n = getV();
        n = Math.min(bounds.max, Math.max(bounds.min, n));
        stepper.value = String(n);
        setV(n);
      });
      return fieldRow(lblTxt, stepper);
    }
    function colourRow(lblTxt, prop, getVal, doIt) {
      const host = ui.el('span', { class: 'mrb-app-colour-host' });
      const trigger = ui.el('button', {
        class: 'mrb-btn mrb-btn-tonal mrb-btn-sm', type: 'button',
        text: tt('Pick…', '揀色…'),
        'aria-label': lblTxt,
      });
      trigger.addEventListener('click', () => openInlinePicker(host, trigger, getVal(prop), (v) => doIt(prop, v)));
      const row = fieldRow(lblTxt, trigger);
      row.append(host);
      return row;
    }
  }

  function openInlinePicker(host, trigger, initial, onChange) {
    host.textContent = '';
    const inst = mountColorPicker(host, {
      value: initial && initial.startsWith('#') ? initial : '#B3261E',
      onChange: (v) => { if (v !== RAINBOW) onChange(v); },
      allowSentinel: false,
    });
    const done = ui.el('button', { class: 'mrb-btn mrb-btn-filled mrb-btn-sm', type: 'button', text: tt('Done', '好喇') });
    done.addEventListener('click', () => { inst.destroy(); host.textContent = ''; });
    host.append(done);
    trigger.setAttribute('aria-expanded', 'true');
  }

  function buildColourShapeSection(wrap, target, val, doCommit) {
    const sec = ui.el('details', { class: 'mrb-app-section' },
      ui.el('summary', { text: tt('Colour, shape & elevation', '顏色、形狀同陰影') }));
    const grid = ui.el('div', { class: 'mrb-app-grid' });
    const fieldRow = (lblTxt, ctrl) => ui.el('label', { class: 'mrb-app-row' }, ui.el('span', { text: lblTxt }), ctrl);
    const colourBtn = (lblTxt, prop) => {
      const trigger = ui.el('button', { class: 'mrb-btn mrb-btn-tonal mrb-btn-sm', type: 'button', text: tt('Pick…', '揀色…'), 'aria-label': lblTxt });
      trigger.addEventListener('click', () => {
        const host = ui.el('span', { class: 'mrb-app-colour-host' });
        trigger.after(host);
        const inst = mountColorPicker(host, {
          value: (val(prop) || '').startsWith('#') ? val(prop) : '#B3261E',
          onChange: (v) => { if (v !== RAINBOW) doCommit(prop, v); },
          allowSentinel: false,
        });
        const done = ui.el('button', { class: 'mrb-btn mrb-btn-filled mrb-btn-sm', type: 'button', text: tt('Done', '好喇') });
        done.addEventListener('click', () => { inst.destroy(); host.remove(); });
        host.append(done);
      });
      return fieldRow(lblTxt, trigger);
    };

    grid.append(colourBtn(tt('Outline colour', '外框顏色'), 'outline-color'));
    const owSel = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Outline width', '外框粗細') });
    for (const v of ['', '1px', '2px', '4px']) owSel.append(ui.el('option', { value: v, text: v || 'inherit' }));
    owSel.value = val('outline-width') || '';
    owSel.addEventListener('change', () => doCommit('outline-width', owSel.value));
    grid.append(fieldRow(tt('Outline width', '外框粗細'), owSel));

    grid.append(numRowPx(tt('Corner radius (px)', '圓角（px）'), 'border-radius', val, doCommit));

    /* shadow / glow composite builder */
    const shX = ui.el('input', { class: 'mrb-field-input', type: 'number', value: '0', 'aria-label': tt('Shadow X', '陰影X') });
    const shY = ui.el('input', { class: 'mrb-field-input', type: 'number', value: '2', 'aria-label': tt('Shadow Y', '陰影Y') });
    const shBlur = ui.el('input', { class: 'mrb-field-input', type: 'number', value: '6', 'aria-label': tt('Blur', '模糊') });
    const shSpread = ui.el('input', { class: 'mrb-field-input', type: 'number', value: '0', 'aria-label': tt('Spread', '擴散') });
    const glowBlur = ui.el('input', { class: 'mrb-field-input', type: 'number', value: '12', 'aria-label': tt('Glow blur', '光暈模糊') });
    const applySh = ui.el('button', { class: 'mrb-btn mrb-btn-filled mrb-btn-sm', type: 'button', text: tt('Apply shadow/glow', '套用陰影／光暈') });
    applySh.addEventListener('click', () => {
      const num = (inp) => {
        const n = parseFloat(inp.value);
        return Number.isFinite(n) ? Math.min(64, Math.max(-64, n)) : 0;
      };
      const x = num(shX), y = num(shY), bl = num(shBlur), sp = num(shSpread), gl = num(glowBlur);
      const shadow = `0px ${y}px ${bl}px ${sp}px rgba(0,0,0,0.35)`;
      const glow = gl > 0 ? `, 0 0 ${gl}px var(--mrb-primary)` : '';
      doCommit('box-shadow', shadow + glow);
    });
    const shRow = ui.el('div', { class: 'mrb-app-row mrb-app-row-wide mrb-app-shadowbuilder' },
      ui.el('span', { text: tt('Shadow / glow', '陰影／光暈') }),
      shX, shY, shBlur, shSpread, glowBlur, applySh);
    grid.append(shRow);

    sec.append(grid);
    wrap.append(sec);
    function numRowPx(lblTxt, prop, getVal, doIt) {
      const inp = ui.el('input', {
        class: 'mrb-field-input', type: 'number', min: '0', max: '64', step: '1',
        value: String(parseFloat(getVal(prop)) || 0), 'aria-label': lblTxt,
      });
      inp.addEventListener('change', () => {
        let n = parseFloat(inp.value);
        if (Number.isNaN(n)) n = 0;
        n = Math.min(64, Math.max(0, n));
        inp.value = String(n);
        doIt(prop, n === 0 ? '' : `${n}px`);
      });
      return fieldRow(lblTxt, inp);
    }
  }

  function fallbackAnchor(anchor, pnl, onClosed) {
    pnl.classList.add('mrb-app-editor-floating');
    document.body.append(pnl);
    const reposition = () => {
      const r = anchor.getBoundingClientRect();
      const pw = Math.min(pnl.offsetWidth || 340, window.innerWidth - 16);
      const ph = Math.min(pnl.offsetHeight || 420, window.innerHeight - 16);
      let x = r.right + 8;
      if (x + pw > window.innerWidth - 8) x = Math.max(8, r.left - pw - 8);
      let y = Math.min(Math.max(8, r.top), window.innerHeight - ph - 8);
      pnl.style.left = x + 'px';
      pnl.style.top = y + 'px';
      pnl.style.maxHeight = ph + 'px';
    };
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    const esc = (ev) => { if (ev.key === 'Escape') close(); };
    window.addEventListener('keydown', esc);
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('keydown', esc);
      pnl.remove();
      if (onClosed) onClosed();
    }
    const outside = (ev) => { if (!pnl.contains(ev.target) && ev.target !== anchor) close(); };
    setTimeout(() => document.addEventListener('pointerdown', outside), 0);
    const origRemove = close;
    close = () => { document.removeEventListener('pointerdown', outside); origRemove(); };
    return close;
  }
}

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

const BUILTIN_PRESETS = [
  { id: 'default', name: 'Default', values: { 'appearance.theme': 'dark', 'appearance.accentSeed': '#B3261E', 'appearance.density': 'comfortable', 'appearance.highContrast': false } },
  { id: 'high-contrast', name: 'High-contrast', values: { 'appearance.theme': 'dark', 'appearance.accentSeed': '#FFD54F', 'appearance.density': 'comfortable', 'appearance.highContrast': true } },
  { id: 'ocean', name: 'Ocean', values: { 'appearance.theme': 'dark', 'appearance.accentSeed': '#00707C', 'appearance.density': 'comfortable', 'appearance.highContrast': false } },
  { id: 'sunset', name: 'Sunset', values: { 'appearance.theme': 'light', 'appearance.accentSeed': '#E8590C', 'appearance.density': 'comfortable', 'appearance.highContrast': false } },
  { id: 'mono', name: 'Mono', values: { 'appearance.theme': 'light', 'appearance.accentSeed': '#5F6368', 'appearance.density': 'compact', 'appearance.highContrast': false } },
];

const USER_PRESETS_KEY = 'appearance.userPresets';

export function userPresets() {
  return store.get(USER_PRESETS_KEY, []);
}

export function applyPreset(id) {
  const user = userPresets();
  const preset = BUILTIN_PRESETS.find((p) => p.id === id) || user.find((p) => p.id === id);
  if (!preset) return false;
  for (const [path, value] of Object.entries(preset.values)) setSetting(path, value, `Applied preset ${preset.name}`);
  applyAppearance();
  return true;
}

export function saveCurrentAsPreset(name) {
  const clean = String(name || '').trim().slice(0, 40) || 'My theme';
  const preset = {
    id: 'user-' + Date.now().toString(36),
    name: clean,
    values: {
      'appearance.theme': getSetting('appearance.theme', 'dark'),
      'appearance.accentSeed': getSetting('appearance.accentSeed', '#B3261E'),
      'appearance.density': getSetting('appearance.density', 'comfortable'),
      'appearance.highContrast': !!getSetting('appearance.highContrast', false),
      'appearance.fontScale': getSetting('appearance.fontScale', 1),
      'appearance.baseWeight': getSetting('appearance.baseWeight', 400),
      'appearance.fontFamily': getSetting('appearance.fontFamily', ''),
    },
  };
  store.set(USER_PRESETS_KEY, [...userPresets(), preset]);
  recordChange('Saved appearance preset', { preset: clean });
  return preset;
}

const TOKEN_KEY_RE = /^--mrb-[a-z0-9-]+$/i;

export function exportTheme() {
  const vars = {};
  const rootStyle = getComputedStyle(document.documentElement);
  for (const name of Object.keys(buildTonalTokens('#B3261E', { dark: true, highContrast: false }))) {
    vars[name] = rootStyle.getPropertyValue(name).trim();
  }
  return {
    v: 1,
    kind: 'material-roblox-theme',
    exportedAt: new Date().toISOString(),
    settings: {
      'appearance.theme': getSetting('appearance.theme', 'dark'),
      'appearance.accentSeed': getSetting('appearance.accentSeed', '#B3261E'),
      'appearance.density': getSetting('appearance.density', 'comfortable'),
      'appearance.highContrast': !!getSetting('appearance.highContrast', false),
      'appearance.fontScale': getSetting('appearance.fontScale', 1),
      'appearance.baseWeight': getSetting('appearance.baseWeight', 400),
      'appearance.rainbowSpeedLevel': getSetting('appearance.rainbowSpeedLevel', 3),
    },
    vars,
  };
}

/** Validate + import a theme file. Throws Error with an actionable message. */
export function importTheme(data) {
  if (!data || typeof data !== 'object' || data.kind !== 'material-roblox-theme') {
    throw new Error(tt('Not a Material Roblox theme export.', '唔係 Material Roblox 主題檔。'));
  }
  if (data.v !== 1) throw new Error(tt('Unsupported theme version.', '主題版本不支援。'));
  const allowedPaths = new Set([
    'appearance.theme', 'appearance.accentSeed', 'appearance.density',
    'appearance.highContrast', 'appearance.fontScale', 'appearance.baseWeight',
    'appearance.rainbowSpeedLevel',
  ]);
  const s = data.settings && typeof data.settings === 'object' ? data.settings : {};
  const badKeys = Object.keys(s).filter((k) => !allowedPaths.has(k));
  if (badKeys.length) throw new Error(tt('Theme file carries unknown settings: ', '主題檔帶有不明的設定：') + badKeys.join(', '));
  const vars = data.vars && typeof data.vars === 'object' ? data.vars : {};
  const varKeys = Object.keys(vars);
  if (varKeys.length > 200) throw new Error(tt('Too many tokens in theme file.', '主題檔 token 太多。'));
  for (const [k, v] of Object.entries(vars)) {
    if (!TOKEN_KEY_RE.test(k)) throw new Error(tt('Bad token name: ', 'token 名稱不合法：') + k);
    if (typeof v !== 'string' || v.length > 64) throw new Error(tt('Bad token value for ', 'token 數值不合法：') + k);
  }
  for (const [k, v] of Object.entries(s)) setSetting(k, v, `Imported theme setting ${k}`);
  applyAppearance();
  recordChange('Imported theme', { file: true });
  return true;
}

function downloadJson(obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = ui.el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ------------------------------------------------------------------ */
/* App logo                                                            */
/* ------------------------------------------------------------------ */

const LOGO_TARGET_SIZES = [16, 24, 32, 48, 256];
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_DIMENSION = 8192;

function svgLogoDataUri(accent, bg) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`
    + `<rect width="64" height="64" rx="14" fill="${bg}"/>`
    + `<rect x="14" y="14" width="36" height="36" rx="9" fill="none" stroke="${accent}" stroke-width="6"/>`
    + `<circle cx="32" cy="32" r="7" fill="${accent}"/></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

export const LOGO_PRESETS = [
  { id: 'shipped', name: 'Shipped mark', uri: svgLogoDataUri('#B3261E', '#1C1B1F') },
  { id: 'alt-ocean', name: 'Ocean colorway', uri: svgLogoDataUri('#00707C', '#10262B') },
  { id: 'alt-sunset', name: 'Sunset colorway', uri: svgLogoDataUri('#E8590C', '#2B1710') },
  { id: 'alt-mono', name: 'Mono colorway', uri: svgLogoDataUri('#E3E2E0', '#202124') },
];

/* --- tiny IndexedDB wrapper (logo assets are data URLs, too big for localStorage) */
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('mrb-appearance', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('kv'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexeddb unavailable'));
  });
}
async function idbSet(key, val) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const rq = tx.objectStore('kv').get(key);
    rq.onsuccess = () => resolve(rq.result || null);
    rq.onerror = () => reject(rq.error);
  });
}

/** Render a processed bitmap into each display target as PNG data URLs. */
async function deriveTargets(bitmap, crop, fitMode, focal, bgMode, bgColour) {
  const out = {};
  const stage = document.createElement('canvas');
  stage.width = crop.w;
  stage.height = crop.h;
  const sctx = stage.getContext('2d');
  sctx.clearRect(0, 0, crop.w, crop.h);
  if (bgMode === 'colour') {
    sctx.fillStyle = bgColour;
    sctx.fillRect(0, 0, crop.w, crop.h); // flattens transparency — disclosed pre-run
  }
  const scaleFit = fitMode === 'fill'
    ? Math.max(crop.w / bitmap.width, crop.h / bitmap.height)
    : Math.min(crop.w / bitmap.width, crop.h / bitmap.height);
  const dw = bitmap.width * scaleFit;
  const dh = bitmap.height * scaleFit;
  const dx = (crop.w - dw) * focal.x;
  const dy = (crop.h - dh) * focal.y;
  sctx.drawImage(bitmap, dx, dy, dw, dh);
  for (const size of LOGO_TARGET_SIZES) {
    const cv = new OffscreenCanvas(size, size);
    const cctx = cv.getContext('2d');
    cctx.imageSmoothingQuality = 'high';
    cctx.clearRect(0, 0, size, size);
    cctx.drawImage(stage, 0, 0, size, size);
    const blob = await cv.convertToBlob({ type: 'image/png' });
    out[size] = await blobToDataUrl(blob);
  }
  return out;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error || new Error('readback failed'));
    fr.readAsDataURL(blob);
  });
}

/** Validate + process an uploaded image. Rejects BEFORE anything is applied. */
async function processLogoFile(file, opts) {
  if (!file) throw new Error(tt('No file selected.', '未揀檔案。'));
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(tt('Image is larger than 4 MB.', '圖片大過 4 MB。'));
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (_) {
    throw new Error(tt('That file does not decode as an image.', '呢個檔案解唔到做圖片。'));
  }
  try {
    if (bitmap.width > MAX_DIMENSION || bitmap.height > MAX_DIMENSION) {
      throw new Error(tt('Image is larger than 8192 px on a side.', '圖片任一邊超過 8192 px。'));
    }
    const crop = normalizeCrop(opts.crop, bitmap);
    const targets = await deriveTargets(
      bitmap, crop,
      opts.fit || 'contain',
      opts.focal || { x: 0.5, y: 0.5 },
      opts.bgMode || 'transparent',
      opts.bgColour || '#00000000',
    );
    return { targets, sourceW: bitmap.width, sourceH: bitmap.height };
  } finally {
    bitmap.close?.();
  }
}

function normalizeCrop(crop, bitmap) {
  let { x = 0, y = 0, w = bitmap.width, h = bitmap.height } = crop || {};
  w = Math.min(Math.max(1, Math.round(w)), bitmap.width);
  h = Math.min(Math.max(1, Math.round(h)), bitmap.height);
  x = Math.min(Math.max(0, Math.round(x)), bitmap.width - w);
  y = Math.min(Math.max(0, Math.round(y)), bitmap.height - h);
  return { x, y, w, h };
}

/** Apply stored logo targets to every presentational surface that exists. */
export async function applyStoredLogo() {
  const asset = await idbGet('customLogo');
  const pick = (size) => (asset && asset.targets && asset.targets[size]) || null;
  const results = { favicon: false, titlebar: false, about: false };

  const fav = document.querySelector('link[rel~="icon"]');
  const href256 = pick(256) || (asset && asset.uri) || null;
  if (fav && href256) { fav.href = href256; results.favicon = true; }

  const titlebarImg = document.querySelector('.mrb-titlebar img[data-mrb-logo-slot]');
  if (titlebarImg && pick(48)) { titlebarImg.src = pick(48); results.titlebar = true; }

  document.querySelectorAll('img[data-mrb-about-logo]').forEach((img) => {
    if (pick(256)) { img.src = pick(256); results.about = true; }
  });
  return { applied: !!asset, results, asset };
}

export async function resetLogo() {
  await idbSet('customLogo', null);
  const fav = document.querySelector('link[rel~="icon"]');
  if (fav) fav.href = LOGO_PRESETS[0].uri;
  document.querySelectorAll('.mrb-titlebar img[data-mrb-logo-slot]').forEach((img) => { img.src = LOGO_PRESETS[0].uri; });
  document.querySelectorAll('img[data-mrb-about-logo]').forEach((img) => { img.src = LOGO_PRESETS[0].uri; });
  recordChange('Reset app logo to shipped mark', {});
}

/* ------------------------------------------------------------------ */
/* Appearance tab                                                      */
/* ------------------------------------------------------------------ */

function registerTab() {
  if (!P.router || typeof P.router.registerTab !== 'function') return;
  P.router.registerTab({
    id: 'appearance',
    title: tt('Appearance', '外觀'),
    icon: '🎨',
    closable: true,
    group: 'settings',
    render(el) {
      el.append(buildAppearanceTab());
    },
  });
}

function buildAppearanceTab() {
  const wrap = ui.el('div', { class: 'mrb-appearance-tab' });

  /* ---- theme + seed + density ------------------------------------ */
  const card = ui.el('section', { class: 'mrb-card' }, ui.el('h2', { text: tt('Theme', '主題') }));
  const themeSel = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Theme', '主題') });
  for (const [v, en, yue] of [['system', 'System', '跟系統'], ['light', 'Light', '淺色'], ['dark', 'Dark', '深色']]) {
    themeSel.append(ui.el('option', { value: v, text: tt(en, yue) }));
  }
  themeSel.value = getSetting('appearance.theme', 'dark');
  themeSel.addEventListener('change', () => { setSetting('appearance.theme', themeSel.value); applyAppearance(); });

  const seedHost = ui.el('div', { class: 'mrb-seed-host' });
  mountColorPicker(seedHost, {
    value: getSetting('appearance.accentSeed', '#B3261E'),
    allowSentinel: true,
    onChange: (v) => {
      setSetting('appearance.accentSeed', v);
      applyAppearance();
    },
  });

  const densSel = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Density', '密度') });
  for (const [v, en, yue] of [['comfortable', 'Comfortable', '舒適'], ['compact', 'Compact', '緊湊']]) {
    densSel.append(ui.el('option', { value: v, text: tt(en, yue) }));
  }
  densSel.value = getSetting('appearance.density', 'comfortable');
  densSel.addEventListener('change', () => { setSetting('appearance.density', densSel.value); applyAppearance(); });

  const hcToggle = ui.el('input', { type: 'checkbox', class: 'mrb-switch-input' });
  hcToggle.checked = !!getSetting('appearance.highContrast', false);
  hcToggle.addEventListener('change', () => { setSetting('appearance.highContrast', hcToggle.checked); applyAppearance(); });

  /* live preview swatch card */
  const previewCard = ui.el('div', { class: 'mrb-card mrb-appearance-livepreview' },
    ui.el('strong', { text: tt('Live preview', '即時預覽') }),
    ui.el('div', { class: 'mrb-appearance-previewrow' },
      ui.el('button', { class: 'mrb-btn mrb-btn-filled', type: 'button', text: tt('Filled', '實心') }),
      ui.el('button', { class: 'mrb-btn mrb-btn-tonal', type: 'button', text: tt('Tonal', '色調') }),
      ui.el('button', { class: 'mrb-btn mrb-btn-outlined', type: 'button', text: tt('Outlined', '外框') }),
      ui.el('span', { class: 'mrb-chip', text: tt('Chip', '章') }),
      ui.el('span', { class: 'mrb-badge', text: tt('Badge', '徽章') })),
    ui.el('div', { class: 'mrb-progress' }, ui.el('div', { class: 'mrb-progress-bar', style: 'width:62%' })));

  card.append(
    ui.el('div', { class: 'mrb-field' }, ui.el('label', { text: tt('Theme', '主題') }), themeSel),
    ui.el('div', { class: 'mrb-field' }, ui.el('label', { text: tt('Accent seed', '強調色種子') }), seedHost),
    ui.el('div', { class: 'mrb-field' }, ui.el('label', { text: tt('Density', '密度') }), densSel),
    ui.el('label', { class: 'mrb-field mrb-field-check' }, hcToggle, ui.el('span', { text: tt('High-contrast boost', '高對比加強') })),
    previewCard,
  );
  wrap.append(card);

  /* ---- typography -------------------------------------------------- */
  const typoCard = ui.el('section', { class: 'mrb-card' }, ui.el('h2', { text: tt('Typography', '字體排印') }));
  const fontSel = ui.el('select', { class: 'mrb-select', 'aria-label': tt('UI font', '介面字體') });
  fontSel.append(ui.el('option', { value: '__default__', text: tt('Default stack', '預設字族') }));
  const browseOpt = ui.el('option', { value: '__browse__', text: tt('Browse installed fonts…', '瀏覽已安裝字體…') });
  fontSel.append(browseOpt);
  const current = getSetting('appearance.fontFamily', '');
  if (current && current !== '__default__') fontSel.append(ui.el('option', { value: current, text: current }));
  fontSel.value = current || '__default__';
  fontSel.addEventListener('change', async () => {
    if (fontSel.value === '__browse__') {
      const names = await listInstalledFonts();
      if (!names) {
        ui.toast?.({
          title: tt('Font list unavailable', '攞唔到字體清單'),
          body: tt('The platform did not grant access to installed fonts; the shipped stack stays in use.', '平台未授權讀取已安裝字體；繼續用內置字族。'),
          tone: 'warn', timeoutMs: 6000,
        });
      } else {
        fontSel.textContent = '';
        fontSel.append(ui.el('option', { value: '__default__', text: tt('Default stack', '預設字族') }));
        for (const n of names) fontSel.append(ui.el('option', { value: n, text: n }));
        fontSel.value = current || '__default__';
        ui.toast?.({
          title: tt('Installed fonts loaded', '已載入已安裝字體'),
          body: `${names.length} ${tt('families available.', '個字族可用。')}`,
          tone: 'ok', timeoutMs: 4000,
        });
      }
      return;
    }
    setSetting('appearance.fontFamily', fontSel.value === '__default__' ? '' : fontSel.value);
    applyAppearance();
    rebuildPreviewCard();
  });

  const scaleSlider = ui.el('input', {
    type: 'range', class: 'mrb-slider', min: '85', max: '130', step: '5',
    value: String(Math.round((Number(getSetting('appearance.fontScale', 1)) || 1) * 100)),
    'aria-label': tt('Font size scale percent', '字體縮放百分比'),
  });
  const scaleOut = ui.el('output', { text: scaleSlider.value + '%' });
  scaleSlider.addEventListener('input', () => { scaleOut.textContent = scaleSlider.value + '%'; });
  scaleSlider.addEventListener('change', () => {
    setSetting('appearance.fontScale', Number(scaleSlider.value) / 100);
    applyAppearance();
  });

  const weightSel = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Base weight', '基準字重') });
  for (const w of ['300', '400', '500', '600', '700']) weightSel.append(ui.el('option', { value: w, text: w }));
  weightSel.value = String(getSetting('appearance.baseWeight', 400));
  weightSel.addEventListener('change', () => { setSetting('appearance.baseWeight', weightSel.value); applyAppearance(); });

  const rbLevel = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Rainbow speed', '彩虹速度') });
  for (let lv = 1; lv <= 5; lv++) rbLevel.append(ui.el('option', { value: String(lv), text: `Level ${lv} (${RAINBOW_SPEED_MAP[lv]})` }));
  rbLevel.value = String(getSetting('appearance.rainbowSpeedLevel', 3));
  rbLevel.addEventListener('change', () => { setSetting('appearance.rainbowSpeedLevel', Number(rbLevel.value)); applyRainbowGlobals(); });

  typoCard.append(
    ui.el('div', { class: 'mrb-field' }, ui.el('label', { text: tt('UI font', '介面字體') }), fontSel),
    ui.el('div', { class: 'mrb-field' }, ui.el('label', { text: tt('Size scale', '縮放') }), scaleSlider, scaleOut),
    ui.el('div', { class: 'mrb-field' }, ui.el('label', { text: tt('Base weight', '基準字重') }), weightSel),
    ui.el('div', { class: 'mrb-field' }, ui.el('label', { text: tt('Animated rainbow speed', '彩虹速度') }), rbLevel,
      ui.el('p', { class: 'mrb-explain', text: tt('One global speed for every rainbow element; reduced-motion users see a single settled hue instead.', '全部彩虹元素共用一個速度；開咗減少動態就會停喺單一色相。') })),
  );
  wrap.append(typoCard);

  function rebuildPreviewCard() {
    const fresh = buildAppearanceTabPreviewOnly();
    previewCard.replaceWith(fresh);
  }

  /* ---- presets ------------------------------------------------------ */
  const presetCard = ui.el('section', { class: 'mrb-card' }, ui.el('h2', { text: tt('Presets', '主題預設') }));
  const presetRow = ui.el('div', { class: 'mrb-appearance-presetrow' });
  const rebuildPresets = () => {
    presetRow.textContent = '';
    for (const p of BUILTIN_PRESETS) {
      const b = ui.el('button', { class: 'mrb-btn mrb-btn-tonal mrb-btn-sm', type: 'button', text: p.name });
      b.addEventListener('click', () => { applyPreset(p.id); });
      presetRow.append(b);
    }
    for (const p of userPresets()) {
      const b = ui.el('button', { class: 'mrb-btn mrb-btn-outlined mrb-btn-sm', type: 'button', text: p.name + ' ✕' });
      b.title = tt('Apply. Hold Shift and click to delete.', '套用；㩒住 Shift 點一下即可刪除。');
      b.addEventListener('click', (ev) => {
        if (ev.shiftKey) {
          store.set(USER_PRESETS_KEY, userPresets().filter((x) => x.id !== p.id));
          recordChange('Deleted appearance preset', { preset: p.name });
          rebuildPresets();
        } else applyPreset(p.id);
      });
      presetRow.append(b);
    }
  };
  rebuildPresets();
  const saveBtn = ui.el('button', { class: 'mrb-btn mrb-btn-filled mrb-btn-sm', type: 'button', text: tt('Save current as…', '儲存目前設定…') });
  saveBtn.addEventListener('click', () => {
    const input = ui.el('input', { class: 'mrb-field-input', type: 'text', placeholder: tt('Preset name', '預設名稱'), maxlength: '40' });
    const closeM = ui.modal ? ui.modal({
      title: tt('Save current look', '儲存目前外觀'),
      build: (body) => body.append(input),
      actions: [
        { label: tt('Cancel', '取消'), onClick: () => closeM() },
        {
          label: tt('Save', '儲存'),
          onClick: () => {
            saveCurrentAsPreset(input.value);
            rebuildPresets();
            closeM();
          },
        },
      ],
    }) : null;
  });
  const exportBtn = ui.el('button', { class: 'mrb-btn mrb-btn-tonal mrb-btn-sm', type: 'button', text: tt('Export theme…', '匯出主題…') });
  exportBtn.addEventListener('click', () => {
    const dump = exportTheme();
    if (P.exporter && typeof P.exporter.exportData === 'function') {
      P.exporter.exportData({ name: 'material-roblox-theme', data: dump, formats: ['json'] })
        .catch(() => downloadJson(dump, 'material-roblox-theme.json'));
    } else {
      downloadJson(dump, 'material-roblox-theme.json');
    }
  });
  const importInput = ui.el('input', { type: 'file', accept: 'application/json,.json', class: 'mrb-visually-hidden' });
  const importBtn = ui.el('button', { class: 'mrb-btn mrb-btn-tonal mrb-btn-sm', type: 'button', text: tt('Import theme…', '匯入主題…') });
  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const f = importInput.files && importInput.files[0];
    importInput.value = '';
    if (!f) return;
    if (f.size > 256 * 1024) {
      ui.toast?.({ title: tt('Theme file too large', '主題檔太大'), body: tt('Maximum 256 KiB.', '上限 256 KiB。'), tone: 'error', timeoutMs: 6000 });
      return;
    }
    try {
      importTheme(JSON.parse(await f.text()));
      ui.toast?.({ title: tt('Theme imported', '主題已匯入'), tone: 'ok', timeoutMs: 4000 });
    } catch (err) {
      ui.toast?.({ title: tt('Import failed', '匯入失敗'), body: String(err.message || err), tone: 'error', timeoutMs: 8000 });
    }
  });
  const resetAllBtn = ui.el('button', { class: 'mrb-btn mrb-btn-danger mrb-btn-sm', type: 'button', text: tt('Reset all appearance…', '重設所有外觀…') });
  resetAllBtn.addEventListener('click', () => {
    if (ui.superConfirm) {
      ui.superConfirm({
        title: tt('Reset every appearance setting?', '重設所有外觀設定？'),
        detailHtml: tt(
          'This restores the shipped theme, seed, density, fonts and clears <strong>all</strong> per-element edits. Your documents are untouched.',
          '會還原出廠主題、種子、密度、字體，並清除<strong>全部</strong>逐元素修改。你的文件不受影響。',
        ),
        confirmLabel: tt('Reset appearance', '重設外觀'),
        onConfirm: () => {
          store.set(OVERRIDES_KEY, {});
          refreshOverrideStylesheet();
          for (const p of ['appearance.theme', 'appearance.accentSeed', 'appearance.density', 'appearance.highContrast', 'appearance.fontScale', 'appearance.baseWeight', 'appearance.fontFamily']) {
            if (P.settings && P.settings.reset) P.settings.reset(p);
            else store.remove(p);
          }
          applyAppearance();
          recordChange('Global appearance reset', {});
          ui.toast?.({ title: tt('Appearance reset', '外觀已重設'), tone: 'ok', timeoutMs: 4000 });
        },
      });
    }
  });
  presetCard.append(presetRow, ui.el('div', { class: 'mrb-appearance-presetactions' }, saveBtn, exportBtn, importBtn, importInput, resetAllBtn));
  wrap.append(presetCard);

  /* ---- app logo ----------------------------------------------------- */
  wrap.append(buildLogoCard());

  return wrap;
}

function buildAppearanceTabPreviewOnly() {
  /* lightweight stand-in so font changes re-render the preview row */
  return ui.el('div', { class: 'mrb-card mrb-appearance-livepreview' },
    ui.el('strong', { text: tt('Live preview', '即時預覽') }),
    ui.el('div', { class: 'mrb-appearance-previewrow' },
      ui.el('button', { class: 'mrb-btn mrb-btn-filled', type: 'button', text: tt('Filled', '實心') }),
      ui.el('button', { class: 'mrb-btn mrb-btn-tonal', type: 'button', text: tt('Tonal', '色調') }),
      ui.el('button', { class: 'mrb-btn mrb-btn-outlined', type: 'button', text: tt('Outlined', '外框') })));
}

function buildLogoCard() {
  const card = ui.el('section', { class: 'mrb-card' }, ui.el('h2', { text: tt('App logo', '應用程式標誌') }));

  card.append(ui.el('p', {
    class: 'mrb-explain',
    text: tt(
      'Presentation only: changing the logo never touches package identity, the app id, the update feed, or where your data lives.',
      '純屬外觀：換標誌絕不會改到套件身份、app id、更新來源或資料存放位置。',
    ),
  }));
  card.append(ui.el('p', {
    class: 'mrb-explain',
    text: tt(
      'Conversion notes: animated uploads use their first frame (animation is dropped), choosing a background colour flattens transparency, and vector uploads are rasterised.',
      '轉換注意：動態圖只取第一格（動畫會被被捨棄）、揀背景色會壓平透明、向量圖會點陣化。',
    ),
  }));

  const presetRow = ui.el('div', { class: 'mrb-appearance-logopresets' });
  for (const p of LOGO_PRESETS) {
    const b = ui.el('button', {
      class: 'mrb-btn mrb-btn-tonal mrb-btn-sm', type: 'button',
      'aria-label': tt('Use logo preset', '使用標誌預設') + ' ' + p.name,
    });
    const img = ui.el('img', { src: p.uri, alt: p.name, width: '24', height: '24' });
    b.append(img, document.createTextNode(' ' + p.name));
    b.addEventListener('click', async () => {
      await idbSet('customLogo', { targets: null, uri: p.uri, presetId: p.id });
      const fav = document.querySelector('link[rel~="icon"]');
      if (fav) fav.href = p.uri;
      document.querySelectorAll('.mrb-titlebar img[data-mrb-logo-slot]').forEach((im) => { im.src = p.uri; });
      document.querySelectorAll('img[data-mrb-about-logo]').forEach((im) => { im.src = p.uri; });
      recordChange('Applied logo preset', { preset: p.name });
      refreshStatus();
    });
    presetRow.append(b);
  }
  card.append(presetRow);

  /* upload + editor */
  const fileInput = ui.el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml', class: 'mrb-visually-hidden' });
  const uploadBtn = ui.el('button', { class: 'mrb-btn mrb-btn-filled mrb-btn-sm', type: 'button', text: tt('Upload custom image…', '上載自訂圖片…') });
  const editorHost = ui.el('div', { class: 'mrb-logo-editor' });
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    try {
      const bitmapProbe = await createImageBitmap(f);
      const crop = { x: 0, y: 0, w: bitmapProbe.width, h: bitmapProbe.height };
      bitmapProbe.close?.();
      openLogoEditor(f, crop);
    } catch (err) {
      ui.toast?.({
        title: tt('Could not use that image', '用唔到呢張圖'),
        body: String(err.message || err),
        tone: 'error', timeoutMs: 6000,
      });
    }
  });

  function openLogoEditor(file, crop) {
    editorHost.textContent = '';
    let fitMode = 'contain';
    let bgMode = 'transparent';
    let bgColour = '#000000';
    const focal = { x: 0.5, y: 0.5 };
    const cropVals = { ...crop };

    const cx = ui.el('input', { type: 'number', class: 'mrb-field-input', value: String(cropVals.x), 'aria-label': 'crop x' });
    const cy = ui.el('input', { type: 'number', class: 'mrb-field-input', value: String(cropVals.y), 'aria-label': 'crop y' });
    const cw = ui.el('input', { type: 'number', class: 'mrb-field-input', value: String(cropVals.w), 'aria-label': tt('Crop width', '裁切寬') });
    const ch = ui.el('input', { type: 'number', class: 'mrb-field-input', value: String(cropVals.h), 'aria-label': tt('Crop height', '裁切高') });
    const fitSel = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Fit', '填充方式') });
    fitSel.append(ui.el('option', { value: 'contain', text: tt('Contain (letterbox)', '包含（留白）') }));
    fitSel.append(ui.el('option', { value: 'fill', text: tt('Fill (cover)', '填滿（裁邊）') }));
    const fx = ui.el('input', { type: 'range', class: 'mrb-slider', min: '0', max: '100', value: '50', 'aria-label': tt('Focal point X', '焦點X') });
    const fy = ui.el('input', { type: 'range', class: 'mrb-slider', min: '0', max: '100', value: '50', 'aria-label': tt('Focal point Y', '焦點Y') });
    const bgSel = ui.el('select', { class: 'mrb-select', 'aria-label': tt('Background', '背景') });
    bgSel.append(ui.el('option', { value: 'transparent', text: tt('Transparent', '透明') }));
    bgSel.append(ui.el('option', { value: 'colour', text: tt('Solid colour', '純色') }));

    const safeArea = ui.el('div', { class: 'mrb-logo-safearea' }, ui.el('span', { text: tt('Safe area preview — the mark should stay inside the inner frame.', '安全區預覽 — 標誌應留在內框之內。') }));
    const targetRow = ui.el('div', { class: 'mrb-logo-targets' });
    const errLine = ui.el('p', { class: 'mrb-logo-error', role: 'alert' });
    const applyBtn = ui.el('button', { class: 'mrb-btn mrb-btn-filled', type: 'button', text: tt('Apply logo', '套用標誌') });

    const readNum = (inp, lo, hi, dflt) => {
      const n = parseInt(inp.value, 10);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
    };

    async function renderTargets() {
      cropVals.x = readNum(cx, 0, 8192, cropVals.x);
      cropVals.y = readNum(cy, 0, 8192, cropVals.y);
      cropVals.w = readNum(cw, 1, 8192, cropVals.w);
      cropVals.h = readNum(ch, 1, 8192, cropVals.h);
      focal.x = Number(fx.value) / 100;
      focal.y = Number(fy.value) / 100;
      targetRow.textContent = '';
      try {
        const { targets } = await processLogoFile(file, {
          crop: cropVals, fit: fitSel.value, focal, bgMode: bgSel.value, bgColour,
        });
        errLine.textContent = '';
        for (const size of LOGO_TARGET_SIZES) {
          targetRow.append(ui.el('figure', { class: 'mrb-logo-targetfig' },
            ui.el('img', { src: targets[size], alt: `${size}px ${tt('preview', '預覽')}`, width: String(Math.min(size, 48)), height: String(Math.min(size, 48)) }),
            ui.el('figcaption', { text: `${size}px` })));
        }
        applyBtn.disabled = false;
        applyBtn.dataset.ready = '1';
      } catch (err) {
        errLine.textContent = String(err.message || err);
        applyBtn.disabled = true;
      }
    }
    for (const inp of [cx, cy, cw, ch]) inp.addEventListener('change', renderTargets);
    fitSel.addEventListener('change', renderTargets);
    fx.addEventListener('change', renderTargets);
    fy.addEventListener('change', renderTargets);
    bgSel.addEventListener('change', renderTargets);

    applyBtn.disabled = true;
    applyBtn.addEventListener('click', async () => {
      if (!applyBtn.dataset.ready) return;
      try {
        const { targets } = await processLogoFile(file, {
          crop: cropVals, fit: fitSel.value, focal, bgMode: bgSel.value, bgColour,
        });
        await idbSet('customLogo', { targets, presetId: null, appliedAt: Date.now() });
        await applyStoredLogo();
        recordChange('Applied custom app logo', {});
        ui.toast?.({ title: tt('Logo applied', '標誌已套用'), tone: 'ok', timeoutMs: 4000 });
        refreshStatus();
      } catch (err) {
        /* invalid input rejected before anything was applied — previous logo intact */
        ui.toast?.({ title: tt('Not applied', '未有套用'), body: String(err.message || err), tone: 'error', timeoutMs: 6000 });
      }
    });

    const resetBtn = ui.el('button', { class: 'mrb-btn mrb-btn-danger mrb-btn-sm', type: 'button', text: tt('Reset to shipped mark', '還原出廠標誌') });
    resetBtn.addEventListener('click', async () => {
      await resetLogo();
      refreshStatus();
    });

    editorHost.append(
      ui.el('div', { class: 'mrb-logo-grid' },
        ui.el('label', {}, ui.el('span', { text: 'X' }), cx),
        ui.el('label', {}, ui.el('span', { text: 'Y' }), cy),
        ui.el('label', {}, ui.el('span', { text: tt('Width', '寬') }), cw),
        ui.el('label', {}, ui.el('span', { text: tt('Height', '高') }), ch),
        ui.el('label', {}, ui.el('span', { text: tt('Fit', '填充') }), fitSel),
        ui.el('label', {}, ui.el('span', { text: tt('Background', '背景') }), bgSel),
        ui.el('label', {}, ui.el('span', { text: tt('Focal X', '焦點X') }), fx),
        ui.el('label', {}, ui.el('span', { text: tt('Focal Y', '焦點Y') }), fy)),
      safeArea, targetRow, errLine,
      ui.el('div', { class: 'mrb-appearance-presetactions' }, applyBtn, resetBtn),
    );
    renderTargets();
  }

  const statusLine = ui.el('p', { class: 'mrb-explain', 'aria-live': 'polite' });
  async function refreshStatus() {
    const { applied, results } = await applyStoredLogo();
    const bits = [];
    bits.push(applied ? tt('Custom logo active.', '正在使用自訂標誌。') : tt('Using the shipped mark.', '正在使用出廠標誌。'));
    bits.push((results.favicon ? '✓' : '—') + ' favicon');
    bits.push((results.titlebar ? '✓' : '—') + tt(' title bar (present only after the shell mounts it)', ' 標題列（待殼層掛載後生效）'));
    bits.push((results.about ? '✓' : '—') + tt(' About', ' 關於頁'));
    statusLine.textContent = bits.join(' · ');
  }

  card.append(uploadBtn, fileInput, editorHost, statusLine);
  refreshStatus();
  return card;
}

/* ------------------------------------------------------------------ */
/* Settings definitions                                                */
/* ------------------------------------------------------------------ */

function registerSettingDefs() {
  if (!P.settings || typeof P.settings.register !== 'function') return;
  P.settings.register([
    {
      key: 'appearance.theme', type: 'select', def: 'dark', group: 'Appearance',
      label: { en: 'Theme', yue: '主題' },
      explain: { en: 'Light, dark, or follow the operating system. Applies immediately.', yue: '淺色、深色或跟隨系統；即刻生效。' },
      options: [
        { value: 'system', label: { en: 'System', yue: '跟系統' } },
        { value: 'light', label: { en: 'Light', yue: '淺色' } },
        { value: 'dark', label: { en: 'Dark', yue: '深色' } },
      ],
    },
    {
      key: 'appearance.accentSeed', type: 'color', def: '#B3261E', group: 'Appearance',
      label: { en: 'Accent seed colour', yue: '強調色種子' },
      explain: { en: 'Drives the whole tonal palette. The animated-rainbow choice stores the sentinel marker instead of a colour.', yue: '成個色調都由佢生成；揀「動態彩虹」會儲起 sentinel 標記而非顏色。' },
    },
    {
      key: 'appearance.density', type: 'select', def: 'comfortable', group: 'Appearance',
      label: { en: 'Density', yue: '密度' },
      explain: { en: 'Comfortable spacing or compact spacing for dense workflows.', yue: '舒適間距或緊湊間距。' },
      options: [
        { value: 'comfortable', label: { en: 'Comfortable', yue: '舒適' } },
        { value: 'compact', label: { en: 'Compact', yue: '緊湊' } },
      ],
    },
    {
      key: 'appearance.fontScale', type: 'slider', def: 1, group: 'Appearance', min: 0.85, max: 1.3, step: 0.05,
      label: { en: 'Font size scale', yue: '字體縮放' },
      explain: { en: 'Scales the entire interface between 85% and 130%.', yue: '整個介面由 85% 至 130% 縮放。' },
    },
    {
      key: 'appearance.rainbowSpeedLevel', type: 'slider', def: 3, group: 'Appearance', min: 1, max: 5, step: 1,
      label: { en: 'Rainbow speed level', yue: '彩虹速度級數' },
      explain: { en: 'One global duration for every rainbow element: level 1 = 120s, 2 = 60s, 3 = 30s, 4 = 15s, 5 = 8s. Reduced motion shows one settled hue instead.', yue: '彩虹元素共用同一時長：1=120秒、2=60秒、3=30秒、4=15秒、5=8秒；減少動態時會停喺單一色相。' },
    },
  ]);
}

/* ------------------------------------------------------------------ */
/* Global wiring                                                       */
/* ------------------------------------------------------------------ */

function wireGlobalEvents() {
  /* Contract event: any lane may dispatch {detail:{el, direct}} to open the editor. */
  window.addEventListener('mrb-edit-element-appearance', (ev) => {
    const el = ev.detail && ev.detail.el;
    if (el instanceof HTMLElement) editElement(el, { direct: !!(ev.detail && ev.detail.direct) });
  });

  /* Shift+right-click opens the editor directly when the modifier survives. */
  document.addEventListener('contextmenu', (ev) => {
    if (!ev.shiftKey) return;
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.closest('.mrb-menu, .mrb-dialog')) return; // menus keep their own management menu
    ev.preventDefault();
    editElement(t, { direct: true });
  }, true);

  /* System theme follows the OS while mode = system (the renderer-side half of
     nativeTheme sync: main drives chrome, we drive tokens). */
  try {
    systemDarkWatcher = window.matchMedia('(prefers-color-scheme: dark)');
    systemDarkWatcher.addEventListener?.('change', () => {
      if (getSetting('appearance.theme', 'dark') === 'system') applyAppearance();
    });
  } catch (_) { /* very old engines: system theme resolves once at apply time */ }

  /* Settings changed elsewhere (palette rows, Settings surface) re-apply. */
  if (P.settings && typeof P.settings.onChange === 'function') {
    P.settings.onChange(() => applyAppearance());
  }

  /* Store-level changes (fallback persistence path) also re-apply. */
  if (typeof store.onChange === 'function') {
    store.onChange('appearance.theme', () => applyAppearance());
  }
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

/** @returns {Promise<void>} */
export async function init() {
  ensureToolsStyles();
  P = await getPeers();

  try { applyAppearance(); } catch (err) { console.warn('[appearance] initial apply failed', err); }

  try { registerSettingDefs(); } catch (err) { console.warn('[appearance] settings registration skipped', err); }
  try { registerTab(); } catch (err) { console.warn('[appearance] tab registration skipped', err); }
  try {
    if (P.palette && typeof P.palette.register === 'function') {
      P.palette.register({ id: 'appearance.open', title: tt('Open Appearance settings', '開啟外觀設定'), group: tt('Appearance', '外觀'), action: () => { if (P.router) P.router.navigate('appearance'); } });
      P.palette.register({
        id: 'appearance.editFocused', title: tt('Edit appearance of focused element', '編輯目前焦點元素外觀'), group: tt('Appearance', '外觀'),
        action: () => {
          const el = /** @type {HTMLElement|null} */ (document.activeElement);
          editElement(el instanceof HTMLElement ? el : document.body, {});
        },
      });
      P.palette.register({ id: 'appearance.resetAll', title: tt('Reset all appearance', '重設所有外觀'), group: tt('Appearance', '外觀'), teleport: 'appearance' });
    }
  } catch (_) { /* palette optional */ }

  try { wireGlobalEvents(); } catch (err) { console.warn('[appearance] wiring failed', err); }
  try { refreshOverrideStylesheet(); startRestampObserver(); } catch (_) { /* overrides degrade alone */ }
  try { applyStoredLogo(); } catch (_) { /* logo restore degrades alone */ }
}
