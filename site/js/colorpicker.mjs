// Infinite colour picker: continuous SV field + hue + alpha, numeric entry in
// hex/RGB/HSL/HSV with a bidirectional translator, contrast readout, recent
// colours, and the animated rainbow sentinel. Reduced motion settles on one hue.

import { el } from './ui.mjs';
import { store } from './store.mjs';

/* ---------------- colour space conversions ---------------- */

export function hexToRgb(hex) {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const rgbToHex = ([r, g, b]) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

function rgbToHsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b); const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, mx === 0 ? 0 : d / mx, mx];
}
function hsvToRgb([h, s, v]) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const seg = Math.floor(h / 60) % 6;
  const t = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
  return [(t[0] + m) * 255, (t[1] + m) * 255, (t[2] + m) * 255];
}
function rgbToHsl(rgb) {
  const [h, s, v] = rgbToHsv(rgb);
  const l = v * (1 - s / 2);
  const sv = l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l);
  return [h, sv * 100, l * 100];
}

export function translate(colorStr) {
  // Returns {hex, rgb, hsl, hsv} or null.
  const s = colorStr.trim().toLowerCase();
  try {
    if (s.startsWith('#') || /^[0-9a-f]{6}$/i.test(s)) {
      const rgb = hexToRgb(s);
      return rgb ? { hex: rgbToHex(rgb), rgb, hsl: rgbToHsl(rgb), hsv: rgbToHsv(rgb) } : null;
    }
    const fn = s.match(/^(rgba?|hsla?)\(([^)]+)\)$/);
    if (!fn) return null;
    const parts = fn[2].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (fn[1].startsWith('rgb')) {
      const rgb = parts.slice(0, 3).map((v) => (parts.some((p) => p > 1 && p <= 255) ? v : v * 255));
      return { hex: rgbToHex(rgb), rgb, hsl: rgbToHsl(rgb), hsv: rgbToHsv(rgb) };
    }
    const [h, sat, li] = parts;
    // HSL -> RGB via HSV
    const lN = li / 100 > 1 ? li / 100 / 100 : li / 100;
    const sN = (sat > 1 ? sat / 100 : sat);
    const c = (1 - Math.abs(2 * lN - 1)) * sN;
    const hp = h / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const m = lN - c / 2;
    const seg = Math.floor(hp) % 6;
    const t = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
    const rgb = [(t[0] + m) * 255, (t[1] + m) * 255, (t[2] + m) * 255];
    return { hex: rgbToHex(rgb), rgb, hsl: [h, sN * 100, lN * 100], hsv: rgbToHsv(rgb) };
  } catch {
    return null;
  }
}

const relLum = ([r, g, b]) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
export function contrast(a, b) {
  const l1 = relLum(a); const l2 = relLum(b);
  return ((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05));
}

/* ---------------- picker widget ---------------- */

const RECENT_MAX = 8;

export function createPicker({ value = '#e05a47', onInput } = {}) {
  const state = { hex: value, alpha: 1, rainbow: false };

  const svCanvas = el('canvas', { width: 240, height: 160, style: 'width:100%;border-radius:10px;display:block;touch-action:none', 'aria-label': 'Saturation and brightness field' });
  const hue = el('input', { type: 'range', class: 'slider', min: 0, max: 360, value: 350, 'aria-label': 'Hue' });
  const alpha = el('input', { type: 'range', class: 'slider', min: 0, max: 100, value: 100, 'aria-label': 'Alpha' });
  const hexIn = el('input', { type: 'text', value: value, 'aria-label': 'Hex value' });
  const rgbIn = el('input', { type: 'text', 'aria-label': 'RGB value' });
  const hslIn = el('input', { type: 'text', 'aria-label': 'HSL value' });
  const hsvIn = el('input', { type: 'text', 'aria-label': 'HSV value' });
  const swatch = el('div', { style: 'height:44px;border-radius:12px;border:1px solid var(--mrb-outline-variant)', role: 'img' });
  const contrastOut = el('span', { class: 'applied-note' });
  const recentRow = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px' });

  function drawSV() {
    const ctx = svCanvas.getContext('2d');
    const w = svCanvas.width; const h = svCanvas.height;
    const [hr, hg, hb] = hsvToRgb([Number(hue.value), 1, 1]);
    const base = ctx.createLinearGradient(0, 0, w, 0);
    base.addColorStop(0, '#fff');
    base.addColorStop(1, `rgb(${hr | 0},${hg | 0},${hb | 0})`);
    ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
    const sh = ctx.createLinearGradient(0, 0, 0, h);
    sh.addColorStop(0, 'rgba(0,0,0,0)');
    sh.addColorStop(1, '#000');
    ctx.fillStyle = sh; ctx.fillRect(0, 0, w, h);
  }

  function commit(from) {
    if (from !== 'hex') hexIn.value = state.hex;
    const rgb = hexToRgb(state.hex) ?? [0, 0, 0];
    swatch.style.background = `${state.hex}${Math.round(state.alpha * 255).toString(16).padStart(2, '0')}`;
    swatch.setAttribute('aria-label', `Current colour ${state.hex}`);
    if (from !== 'rgb') rgbIn.value = `rgb(${rgb.map(Math.round).join(', ')})`;
    if (from !== 'hsl') { const [h, s, l] = rgbToHsl(rgb); hslIn.value = `hsl(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(l)}%)`; }
    if (from !== 'hsv') { const [h, s, v] = rgbToHsv(rgb); hsvIn.value = `hsv(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(v * 100)}%)`; }
    const bg = document.documentElement.classList.contains('x') ? [255, 255, 255] : [16, 16, 20];
    const cr = contrast(rgb, getComputedStyle(document.body).color.startsWith('#') ? [16, 16, 20] : bg);
    contrastOut.textContent = `Contrast vs page text: ${cr.toFixed(2)}:1${cr < 4.5 ? ' — below AA against this background' : ''}`;
    pushRecent(state.hex);
    renderRecent();
    onInput?.({ ...state });
  }

  function pickFromCanvas(e) {
    const rect = svCanvas.getBoundingClientRect();
    const x = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    const y = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1);
    const [h0, , ] = rgbToHsv(hexToRgb(state.hex) ?? [0, 0, 0]);
    const hh = Number(hue.value) || h0;
    const rgb = hsvToRgb([hh, x, 1 - y]);
    state.hex = rgbToHex(rgb);
    commit();
  }
  let dragging = false;
  svCanvas.addEventListener('pointerdown', (e) => { dragging = true; svCanvas.setPointerCapture(e.pointerId); pickFromCanvas(e); });
  svCanvas.addEventListener('pointermove', (e) => dragging && pickFromCanvas(e));
  svCanvas.addEventListener('pointerup', () => { dragging = false; });
  hue.addEventListener('input', () => { drawSV(); const [h0] = rgbToHsv(hexToRgb(state.hex) ?? [0, 0, 0]); void h0; const rgb = hsvToRgb([Number(hue.value), 0.75, 0.9]); state.hex = rgbToHex(rgb); commit(); });

  hexIn.addEventListener('change', () => { const t = translate(hexIn.value); if (t) { state.hex = t.hex; hue.value = String(Math.round(t.hsv[0])); drawSV(); commit(); } else hexIn.value = state.hex; });
  for (const [inp, kind] of [[rgbIn, 'rgb'], [hslIn, 'hsl'], [hsvIn, 'hsv']]) {
    inp.addEventListener('change', () => {
      const t = translate(inp.value);
      if (t) { state.hex = t.hex; hue.value = String(Math.round(t.hsv[0])); drawSV(); commit(kind); }
      else inp.value = '';
    });
  }
  alpha.addEventListener('input', () => { state.alpha = Number(alpha.value) / 100; commit(); });

  const rainbowBtn = el('button', { class: 'chip clickable', title: 'Animated rainbow accent (reduced motion settles on one hue)' }, '🌈 Rainbow');
  rainbowBtn.addEventListener('click', () => { state.rainbow = !state.rainbow; rainbowBtn.setAttribute('aria-pressed', String(state.rainbow)); onInput?.({ ...state }); });

  function pushRecent(hex) {
    const list = store.get('recent.colors', []);
    const next = [hex, ...list.filter((h) => h !== hex)].slice(0, RECENT_MAX);
    store.set('recent.colors', next);
  }
  function renderRecent() {
    recentRow.replaceChildren(
      ...(store.get('recent.colors', [])).map((hex) => el('button', {
        class: 'snippet', style: `background:${hex};border-style:solid`, 'aria-label': `Use recent colour ${hex}`,
        onclick: () => { state.hex = hex; hue.value = String(Math.round(rgbToHsv(hexToRgb(hex))[0])); drawSV(); commit(); },
      })),
    );
  }

  drawSV();
  commit('init');
  renderRecent();

  const root = el('div', {},
    swatch,
    el('div', { style: 'margin-top:8px' }, svCanvas),
    el('label', { class: 'applied-note' }, 'Hue'), hue,
    el('label', { class: 'applied-note' }, 'Alpha'), alpha,
    gridRow([['HEX', hexIn], ['RGB', rgbIn]]),
    gridRow([['HSL', hslIn], ['HSV', hsvIn]]),
    el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px' }, rainbowBtn, contrastOut),
    el('div', { class: 'applied-note', style: 'margin-top:6px' }, 'Recent'), recentRow,
  );
  root._state = state;
  return root;
}

function gridRow(pairs) {
  return el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px' },
    pairs.map(([lab, inp]) => el('div', {}, el('label', { class: 'applied-note' }, lab), inp)));
}
