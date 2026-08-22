/**
 * colorpicker.js — infinite colour picker + colour translator (Lane E).
 *
 * Public surface (docs/dev/CONTRACT.md §6):
 *  - Continuous picking: saturation/value square + hue strip + alpha strip over a
 *    checkerboard; eyedropper via the EyeDropper API (button hidden when absent).
 *  - Numeric entry in every space, synchronised bidirectionally: HEX (#RGB/#RRGGBB/
 *    #RRGGBBAA), RGB/A, HSL/A, HSV/HSB/A, HWB, CMYK, CIELAB, LCH, OKLab, OKLCH.
 *    Full conversion math: sRGB <-> linear <-> XYZ(D65) <-> Lab <-> LCH,
 *    OKLab/OKLCH matrices, HSV/HSL/HWB/CMYK direct. Alpha survives every path.
 *  - Gamut: inputs that fall outside sRGB are CLAMPED for display with a visible
 *    "clipped" chip; the unclamped original is retained on the parsed object.
 *  - Translator panel: current colour in every space at once, per-space copy
 *    buttons, active-space identification, WCAG contrast readout vs white /
 *    black / custom foreground with AA/AAA pass-fail chips.
 *  - Swatch grid + recents (persisted, max 12) + preset palettes are layered
 *    conveniences; the continuous picker stays the primary control.
 *  - RAINBOW SENTINEL: `RAINBOW` is exported and may be *chosen* in the picker
 *    when `allowSentinel` is set. The sentinel string is a marker consumed by
 *    the stylesheet, never a colour value: it must never enter swatch or recent
 *    arrays (see pushRecent — filtered and asserted by comment here and by the
 *    guard tests that own the invariant).
 *
 * Rainbow rendering is stylesheet-driven (features/tools.css):
 *  - One global duration custom property `--mrb-rainbow-duration` is published
 *    once from settings (`appearance.rainbowSpeedLevel`, 1..5, default 3) using
 *    the single RAINBOW_SPEED_MAP below. Code and documentation cite this one
 *    map; no per-element duration is ever set.
 *  - Elements carrying the sentinel get the `mrb-rainbow` class. The animation
 *    rotates a registered `<angle>` custom property feeding `conic-gradient(from …)`
 *    so the hue walks THROUGH the wheel continuously. (Technique note: a
 *    background-position pan over a tiled hue ramp was the alternative; the
 *    angle rotation was chosen because it cannot develop a seam at the tile
 *    boundary and interpolates hue circularly by construction.)
 *  - Under prefers-reduced-motion the animation stops and the element settles
 *    on ONE fixed hue (--mrb-rainbow-hue) with a 200 ms crossfade — slowed-down
 *    motion is not offered, per the accommodation contract — and the element
 *    explains itself on hover/focus ("reduced motion: rainbow paused").
 */

import { store } from './store.js';
import { ui } from './ui.js';
import { i18n } from './i18n.js';

/* ------------------------------------------------------------------ */
/* Sentinel + speed map                                                */
/* ------------------------------------------------------------------ */

/** Marker value meaning "animated rainbow", never a real colour string. */
export const RAINBOW = '__rainbow__';

/**
 * Single source of truth for rainbow speed. Level -> animation duration.
 * Cited by the Appearance settings definition, the docs article, and the
 * stylesheet default. Never duplicate these numbers elsewhere.
 */
export const RAINBOW_SPEED_MAP = Object.freeze({
  1: '120s',
  2: '60s',
  3: '30s',
  4: '15s',
  5: '8s',
});

/* ------------------------------------------------------------------ */
/* Colour math                                                         */
/* ------------------------------------------------------------------ */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const round = (v, p = 2) => {
  const f = Math.pow(10, p);
  return Math.round(v * f) / f;
};

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
}

/* linear sRGB -> XYZ (D65) and back */
const M_RGB_XYZ = [
  [0.4123907992659595, 0.357584339383878, 0.1804807884018343],
  [0.2126390058715103, 0.715168678767756, 0.07219231536073371],
  [0.0193308187155918, 0.11919477979462599, 0.9505321522496607],
];
const M_XYZ_RGB = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
];
const WHITE_D65 = { x: 0.95047, y: 1.0, z: 1.08883 };

function matMul(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function xyzToLab(xyz) {
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(xyz[0] / WHITE_D65.x);
  const fy = f(xyz[1] / WHITE_D65.y);
  const fz = f(xyz[2] / WHITE_D65.z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function labToXyz(lab) {
  const fi = (t) => (t > 6 / 29 ? t * t * t : (108 / 841) * (t - 4 / 29));
  const fy = (lab[0] + 16) / 116;
  const fx = fy + lab[1] / 500;
  const fz = fy - lab[2] / 200;
  return [fi(fx) * WHITE_D65.x, fi(fy) * WHITE_D65.y, fi(fz) * WHITE_D65.z];
}
function labToLch(lab) {
  const c = Math.sqrt(lab[1] * lab[1] + lab[2] * lab[2]);
  let h = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [lab[0], c, h];
}
function lchToLab(lch) {
  const rad = (lch[2] * Math.PI) / 180;
  return [lch[0], lch[1] * Math.cos(rad), lch[1] * Math.sin(rad)];
}

/* OKLab (Björn Ottosson's reference matrices) */
function linRgbToOklab(rgb) {
  const l = 0.4122214708 * rgb[0] + 0.5363325363 * rgb[1] + 0.0514459929 * rgb[2];
  const m = 0.2119034982 * rgb[0] + 0.6806995451 * rgb[1] + 0.1073969566 * rgb[2];
  const s = 0.0883024619 * rgb[0] + 0.2817188376 * rgb[1] + 0.6299787005 * rgb[2];
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}
function oklabToLinRgb(lab) {
  const l_ = lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2];
  const m_ = lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2];
  const s_ = lab[0] - 0.0894841775 * lab[1] - 1.291485548 * lab[2];
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
function oklabToOkLch(lab) {
  const c = Math.sqrt(lab[1] * lab[1] + lab[2] * lab[2]);
  let h = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [lab[0], c, h];
}
function okLchToOklab(lch) {
  const rad = (lch[2] * Math.PI) / 180;
  return [lch[0], lch[1] * Math.cos(rad), lch[1] * Math.sin(rad)];
}

/* Direct cylindrical spaces. Input/output rgb is 0..1 floats. */
function rgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = mx === 0 ? 0 : d / mx;
  return [h, s, mx];
}
function hsvToRgb(h, s, v) {
  const hh = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = v - c;
  let rr = 0, gg = 0, bb = 0;
  if (hh < 60) [rr, gg, bb] = [c, x, 0];
  else if (hh < 120) [rr, gg, bb] = [x, c, 0];
  else if (hh < 180) [rr, gg, bb] = [0, c, x];
  else if (hh < 240) [rr, gg, bb] = [0, x, c];
  else if (hh < 300) [rr, gg, bb] = [x, 0, c];
  else [rr, gg, bb] = [c, 0, x];
  return [rr + m, gg + m, bb + m];
}
function rgbToHsl(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (mx === r) h = (((g - b) / d) % 6) * 60;
    else if (mx === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
    if (h < 0) h += 360;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  return hsvToRgb(h, l === 0 || l === 1 ? 0 : c / (1 - Math.abs(2 * l - 1)), l);
}
function rgbToHwb(r, g, b) {
  const [h] = rgbToHsv(r, g, b);
  const w = Math.min(r, g, b);
  const bl = 1 - Math.max(r, g, b);
  return [h, w, bl];
}
function hwbToRgb(h, w, b) {
  if (w + b >= 1) {
    const grey = w / (w + b);
    return [grey, grey, grey];
  }
  const [r0, g0, b0] = hsvToRgb(h, 1, 1);
  const f = (v) => v * (1 - w - b) + w;
  return [f(r0), f(g0), f(b0)];
}
function rgbToCmyk(r, g, b) {
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return [0, 0, 0, 1];
  return [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k];
}
function cmykToRgb(c, m, y, k) {
  return [
    1 - Math.min(1, c * (1 - k) + k),
    1 - Math.min(1, m * (1 - k) + k),
    1 - Math.min(1, y * (1 - k) + k),
  ];
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

const NUM_RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?%?|deg/g;

function numbers(str) {
  const out = [];
  let m;
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(str))) {
    let tok = m[0];
    const pct = tok.endsWith('%');
    const deg = tok.endsWith('deg');
    tok = tok.replace(/%|deg/g, '');
    out.push({ v: parseFloat(tok), pct, deg });
  }
  return out;
}

const ALPHA_OF = {
  hex: true, rgb: true, rgba: true, hsl: true, hsla: true,
  hsv: true, hsba: true, hsb: true, hwb: true, cmyk: true,
  lab: true, lch: true, oklab: true, oklch: true,
};

/**
 * Parse a colour string in any supported space.
 * @returns {{ok:true, r:number,g:number,b:number,a:number, clipped:boolean,
 *            space:string}|{ok:false, error:string}}
 *   r/g/b/a are floats 0..1 (a in 0..1). `clipped` marks out-of-sRGB gamut
 *   input that was clamped for display; callers keep the original text.
 */
export function parse(input) {
  if (typeof input !== 'string') return { ok: false, error: 'not a colour string' };
  const s = input.trim().toLowerCase();
  if (!s) return { ok: false, error: 'empty' };

  /* HEX */
  if (s.startsWith('#')) {
    const hx = s.slice(1);
    if (!/^[0-9a-f]{3,8}$/.test(hx)) return { ok: false, error: 'bad hex' };
    let r, g, b, a = 1;
    if (hx.length === 3 || hx.length === 4) {
      r = parseInt(hx[0] + hx[0], 16) / 255;
      g = parseInt(hx[1] + hx[1], 16) / 255;
      b = parseInt(hx[2] + hx[2], 16) / 255;
      if (hx.length === 4) a = parseInt(hx[3] + hx[3], 16) / 255;
    } else if (hx.length === 6 || hx.length === 8) {
      r = parseInt(hx.slice(0, 2), 16) / 255;
      g = parseInt(hx.slice(2, 4), 16) / 255;
      b = parseInt(hx.slice(4, 6), 16) / 255;
      if (hx.length === 8) a = parseInt(hx.slice(6, 8), 16) / 255;
    } else {
      return { ok: false, error: 'hex must be 3, 4, 6 or 8 digits' };
    }
    return fin(r, g, b, a, 'hex');
  }

  const m = /^([a-z]+)\s*\(/.exec(s);
  const closeOk = s.endsWith(')');
  const name = m ? m[1] : null;
  if (name && !closeOk) return { ok: false, error: 'missing closing bracket' };
  const ns = name ? numbers(s.slice(name.length + 1, -1)) : [];

  switch (name) {
    case 'rgb': case 'rgba': {
      if (ns.length < 3) return bad('rgb needs 3 channels');
      const p = (i, sc) => (ns[i].pct ? ns[i].v / 100 : ns[i].v / sc);
      const a = alphaFrom(ns, 3);
      return fin(p(0, 255), p(1, 255), p(2, 255), a, name);
    }
    case 'hsl': case 'hsla': {
      if (ns.length < 3) return bad('hsl needs 3 channels');
      const a = alphaFrom(ns, 3);
      const [r, g, b] = hslToRgb(ns[0].v, clampPct(ns[1]), clampPct(ns[2]));
      return fin(r, g, b, a, name);
    }
    case 'hsv': case 'hsb': case 'hsba': {
      if (ns.length < 3) return bad('hsv/hsb needs 3 channels');
      const a = alphaFrom(ns, 3);
      const [r, g, b] = hsvToRgb(ns[0].v, clampPct(ns[1]), clampPct(ns[2]));
      return fin(r, g, b, a, name);
    }
    case 'hwb': {
      if (ns.length < 3) return bad('hwb needs 3 channels');
      const a = alphaFrom(ns, 3);
      const [r, g, b] = hwbToRgb(ns[0].v, clampPct(ns[1]), clampPct(ns[2]));
      return fin(r, g, b, a, name);
    }
    case 'cmyk': {
      if (ns.length < 4) return bad('cmyk needs 4 channels');
      const a = alphaFrom(ns, 4);
      const [r, g, b] = cmykToRgb(clampPct(ns[0]), clampPct(ns[1]), clampPct(ns[2]), clampPct(ns[3]));
      return fin(r, g, b, a, name);
    }
    case 'lab': case 'cielab': {
      if (ns.length < 3) return bad('lab needs L a b');
      const a = alphaFrom(ns, 3);
      const xyz = labToXyz([ns[0].v, ns[1].v, ns[2].v]);
      const lin = matMul(M_XYZ_RGB, xyz);
      return fin(lin[0], lin[1], lin[2], a, 'lab');
    }
    case 'lch': case 'cielch': {
      if (ns.length < 3) return bad('lch needs L C H');
      const a = alphaFrom(ns, 3);
      const xyz = labToXyz(lchToLab([ns[0].v, ns[1].v, ns[2].v]));
      const lin = matMul(M_XYZ_RGB, xyz);
      return fin(lin[0], lin[1], lin[2], a, 'lch');
    }
    case 'oklab': {
      if (ns.length < 3) return bad('oklab needs L a b');
      const a = alphaFrom(ns, 3);
      const lin = oklabToLinRgb([ns[0].v, ns[1].v, ns[2].v]);
      return fin(lin[0], lin[1], lin[2], a, 'oklab');
    }
    case 'oklch': {
      if (ns.length < 3) return bad('oklch needs L C H');
      const a = alphaFrom(ns, 3);
      const lin = oklabToLinRgb(okLchToOklab([ns[0].v, ns[1].v, ns[2].v]));
      return fin(lin[0], lin[1], lin[2], a, 'oklch');
    }
    default:
      return bad(`unknown colour space "${name || s}"`);
  }

  function clampPct(n) {
    return n.pct ? clamp01(n.v / 100) : clamp01(n.v);
  }
  function alphaFrom(ns, idx) {
    if (ns.length > idx) {
      const n = ns[idx];
      return n.pct ? clamp01(n.v / 100) : clamp01(n.v);
    }
    return 1;
  }
  function bad(msg) {
    return { ok: false, error: msg };
  }
}

/** Shared finisher: linearise, convert, detect gamut clipping. */
function fin(lr, lg, lb, a, space) {
  const lin = [lr, lg, lb];
  const xyz = matMul(M_RGB_XYZ, lin);
  const lab = xyzToLab(xyz);
  const inGamut = lr >= -1e-4 && lg >= -1e-4 && lb >= -1e-4 && lr <= 1.0001 && lg <= 1.0001 && lb <= 1.0001;
  const r = clamp01(linearToSrgb(lr));
  const g = clamp01(linearToSrgb(lg));
  const b = clamp01(linearToSrgb(lb));
  return { ok: true, r, g, b, a: clamp01(a), clipped: !inGamut, space };
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const to255 = (v) => Math.round(clamp01(v) * 255);

export function toHex(c, { forceAlpha = false } = {}) {
  const hx = (n) => to255(n).toString(16).padStart(2, '0');
  const base = `#${hx(c.r)}${hx(c.g)}${hx(c.b)}`;
  const showA = forceAlpha || c.a < 1;
  return showA ? base + hx(c.a) : base;
}

export function toRgbStr(c) {
  const p = (v) => Math.round(clamp01(v) * 255);
  return c.a < 1
    ? `rgba(${p(c.r)}, ${p(c.g)}, ${p(c.b)}, ${round(c.a, 3)})`
    : `rgb(${p(c.r)}, ${p(c.g)}, ${p(c.b)})`;
}

export function toHslStr(c) {
  const [h, s, l] = rgbToHsl(c.r, c.g, c.b);
  return c.a < 1
    ? `hsla(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%, ${round(c.a, 3)})`
    : `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}

export function toHsvStr(c) {
  const [h, s, v] = rgbToHsv(c.r, c.g, c.b);
  const core = `${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(v * 100)}%`;
  return c.a < 1 ? `hsba(${core}, ${round(c.a, 3)})` : `hsv(${core})`;
}

export function toHwbStr(c) {
  const [h, w, bl] = rgbToHwb(c.r, c.g, c.b);
  const core = `${Math.round(h)}, ${Math.round(w * 100)}%, ${Math.round(bl * 100)}%`;
  return c.a < 1 ? `hwb(${core}, ${round(c.a, 3)})` : `hwb(${core})`;
}

export function toCmykStr(c) {
  const [cy, m, y, k] = rgbToCmyk(c.r, c.g, c.b);
  const pc = (v) => Math.round(v * 100);
  const core = `${pc(cy)}%, ${pc(m)}%, ${pc(y)}%, ${pc(k)}%`;
  return c.a < 1 ? `cmyk(${core}, ${round(c.a, 3)})` : `cmyk(${core})`;
}

export function toLabStr(c) {
  const lin = [srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b)];
  const lab = xyzToLab(matMul(M_RGB_XYZ, lin));
  const core = `${round(lab[0], 1)}, ${round(lab[1], 1)}, ${round(lab[2], 1)}`;
  return c.a < 1 ? `lab(${core} / ${round(c.a, 3)})` : `lab(${core})`;
}

export function toLchStr(c) {
  const lin = [srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b)];
  const lch = labToLch(xyzToLab(matMul(M_RGB_XYZ, lin)));
  const core = `${round(lch[0], 1)}, ${round(lch[1], 1)}, ${Math.round(lch[2])}`;
  return c.a < 1 ? `lch(${core} / ${round(c.a, 3)})` : `lch(${core})`;
}

export function toOklabStr(c) {
  const lin = [srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b)];
  const lab = linRgbToOklab(lin);
  const core = `${round(lab[0], 3)}, ${round(lab[1], 3)}, ${round(lab[2], 3)}`;
  return c.a < 1 ? `oklab(${core} / ${round(c.a, 3)})` : `oklab(${core})`;
}

export function toOklchStr(c) {
  const lin = [srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b)];
  const lch = oklabToOkLch(linRgbToOklab(lin));
  const core = `${round(lch[0], 3)}, ${round(lch[1], 3)}, ${Math.round(lch[2])}`;
  return c.a < 1 ? `oklch(${core} / ${round(c.a, 3)})` : `oklch(${core})`;
}

/** Every space at once — the translator panel renders exactly this map. */
export function formatAll(c) {
  return {
    hex: toHex(c, { forceAlpha: true }),
    rgb: toRgbStr(c),
    hsl: toHslStr(c),
    hsv: toHsvStr(c),
    hwb: toHwbStr(c),
    cmyk: toCmykStr(c),
    lab: toLabStr(c),
    lch: toLchStr(c),
    oklab: toOklabStr(c),
    oklch: toOklchStr(c),
  };
}

/* ------------------------------------------------------------------ */
/* Contrast                                                            */
/* ------------------------------------------------------------------ */

function relLuminance(c) {
  return (
    0.2126 * srgbToLinear(c.r) +
    0.7152 * srgbToLinear(c.g) +
    0.0722 * srgbToLinear(c.b)
  );
}

/** Composite `fg` over opaque `bg` (both {r,g,b,a}); returns composited rgb. */
export function compositeOver(fg, bg) {
  const a = clamp01(fg.a);
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

export function contrastRatio(c1, c2) {
  const l1 = relLuminance(c1);
  const l2 = relLuminance(c2);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Full accessibility readout for a foreground colour against a background.
 * Large-text thresholds per WCAG 2.1: AA 3.0 / AAA 4.5; body text AA 4.5 /
 * AAA 7.0. Alpha is composited over the background before measuring so the
 * number reflects what is actually rendered.
 */
export function contrastReport(fg, bg) {
  const effFg = compositeOver(fg, bg);
  const ratio = contrastRatio(effFg, bg);
  return {
    ratio,
    ratioText: round(ratio, 2) + ':1',
    aaBody: ratio >= 4.5,
    aaaBody: ratio >= 7,
    aaLarge: ratio >= 3,
    aaaLarge: ratio >= 4.5,
  };
}

export const WHITE = { r: 1, g: 1, b: 1, a: 1 };
export const BLACK = { r: 0, g: 0, b: 0, a: 1 };

/* ------------------------------------------------------------------ */
/* Recents                                                             */
/* ------------------------------------------------------------------ */

const RECENT_KEY = 'colorRecent';
const RECENT_MAX = 12;

/** Persisted recent colours, newest first, hex strings, max 12. */
export function recentColors() {
  return store.get(RECENT_KEY, []);
}

/**
 * Record a colour as recently used. The RAINBOW sentinel is a marker, not a
 * colour — it must never enter this list. The filter below is deliberate and
 * duplicated by the completeness guard; do not "simplify" it away.
 */
export function pushRecent(value) {
  if (value === RAINBOW) return; // sentinel never becomes a swatch/recent entry
  const p = parse(value);
  if (!p.ok) return;
  const hex = toHex(p, { forceAlpha: true });
  const next = [hex, ...recentColors().filter((h) => h !== hex)].slice(0, RECENT_MAX);
  store.set(RECENT_KEY, next);
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

const PRESET_PALETTES = [
  { name: 'Baseline', colors: ['#B3261E', '#386A20', '#7D5260', '#6750A4', '#00707C', '#4A4459'] },
  { name: 'Grays', colors: ['#000000', '#444746', '#74796D', '#C4C7C5', '#E3E2E0', '#FFFFFF'] },
  { name: 'Signal', colors: ['#D32F2F', '#F57C00', '#FBC02D', '#388E3C', '#1976D2', '#7B1FA2'] },
];

const SPACES = [
  ['hex', () => 'HEX'],
  ['rgb', () => 'RGB(A)'],
  ['hsl', () => 'HSL(A)'],
  ['hsv', () => 'HSV/HSB'],
  ['hwb', () => 'HWB'],
  ['cmyk', () => 'CMYK'],
  ['lab', () => 'CIELAB'],
  ['lch', () => 'LCH'],
  ['oklab', () => 'OKLab'],
  ['oklch', () => 'OKLCH'],
];

const fmtOf = {
  hex: (c) => toHex(c, { forceAlpha: true }),
  rgb: toRgbStr,
  hsl: toHslStr,
  hsv: toHsvStr,
  hwb: toHwbStr,
  cmyk: toCmykStr,
  lab: toLabStr,
  lch: toLchStr,
  oklab: toOklabStr,
  oklch: toOklchStr,
};

function tt(en, yue) {
  try {
    if (i18n.schoolActive()) return en;
    const mode = i18n.lang();
    if (mode === 'yue' && yue) return yue;
    if (mode === 'bi' && yue) return `${en} · ${yue}`;
  } catch (_) { /* i18n degraded — English is always correct */ }
  return en;
}

/**
 * Mount a full picker into `container`.
 * @param {HTMLElement} container
 * @param {{value?:string, onChange?:(value:string)=>void, allowSentinel?:boolean}} opts
 * @returns {{set:(v:string)=>void, get:()=>string, destroy:()=>void}}
 */
export function mountColorPicker(container, opts = {}) {
  const state = {
    c: parse(opts.value && opts.value !== RAINBOW ? opts.value : '#B3261E'),
    isRainbow: opts.value === RAINBOW,
    activeSpace: 'hex',
    suppress: null, // space whose field the user is typing in
  };
  if (!state.c.ok) state.c = parse('#B3261E');

  const root = ui.el('div', { class: 'mrb-cpk', role: 'group', 'aria-label': tt('Colour picker', '顏色選擇器') });

  /* --- preview + eyedropper + rainbow ------------------------------- */
  const previewWrap = ui.el('div', { class: 'mrb-cpk-preview-row' });
  const preview = ui.el('div', {
    class: 'mrb-cpk-preview',
    role: 'img',
    'aria-label': tt('Current colour preview', '目前顏色預覽'),
  });
  const clippedChip = ui.el('span', {
    class: 'mrb-chip mrb-cpk-clipped',
    hidden: true,
    title: tt(
      'Input was outside the sRGB gamut and has been clamped for display; your original value is kept in the field.',
      '輸入超出 sRGB 色域，已收窄顯示；原值仍保留在欄位。',
    ),
    text: tt('clipped', '已收窄'),
  });
  const rainbowChip = ui.el('span', {
    class: 'mrb-chip mrb-cpk-rainbow-chip',
    hidden: !state.isRainbow,
    text: tt('Animated rainbow', '動態彩虹'),
  });
  previewWrap.append(preview, clippedChip, rainbowChip);

  const actionsRow = ui.el('div', { class: 'mrb-cpk-actions' });
  const hasEyeDropper = typeof window !== 'undefined' && 'EyeDropper' in window;
  const dropperBtn = ui.el('button', {
    class: 'mrb-btn mrb-btn-tonal mrb-btn-sm',
    type: 'button',
    hidden: !hasEyeDropper,
    title: tt('Pick a colour from the screen', '從畫面揀色'),
    text: hasEyeDropper ? '🎯 ' + tt('Eyedropper', '揀色器') : '',
  });
  if (hasEyeDropper) {
    dropperBtn.addEventListener('click', async () => {
      try {
        const ed = new window.EyeDropper();
        const res = await ed.open();
        if (res && res.sRGBHex) applyParsed(parse(res.sRGBHex), 'eyedropper');
      } catch (_) { /* user dismissed the eyedropper — nothing to do */ }
    });
  }
  if (opts.allowSentinel) {
    const rbBtn = ui.el('button', {
      class: 'mrb-btn mrb-btn-tonal mrb-btn-sm mrb-cpk-rainbow-btn',
      type: 'button',
      'aria-pressed': String(state.isRainbow),
      text: '🌈 ' + tt('Animated rainbow', '動態彩虹'),
    });
    rbBtn.addEventListener('click', () => {
      state.isRainbow = !state.isRainbow;
      rbBtn.setAttribute('aria-pressed', String(state.isRainbow));
      rainbowChip.hidden = !state.isRainbow;
      preview.classList.toggle('mrb-rainbow', state.isRainbow);
      preview.title = state.isRainbow ? tt('Animated rainbow (stylesheet-driven)', '動態彩虹（由樣式表驅動）') : '';
      emit(state.isRainbow ? RAINBOW : currentHex());
    });
    actionsRow.append(rbBtn);
  }
  actionsRow.append(dropperBtn);
  previewWrap.append(actionsRow);

  /* --- canvases ------------------------------------------------------ */
  const svCanvas = ui.el('canvas', { class: 'mrb-cpk-sv', width: 232, height: 168, 'aria-label': tt('Saturation and brightness square', '飽和度與明度方塊') });
  const hueCanvas = ui.el('canvas', { class: 'mrb-cpk-strip', width: 232, height: 18, 'aria-label': tt('Hue slider', '色相滑桿') });
  const alphaCanvas = ui.el('canvas', { class: 'mrb-cpk-strip mrb-cpk-alpha', width: 232, height: 18, 'aria-label': tt('Opacity slider', '透明度滑桿') });

  /* --- numeric entry grid ------------------------------------------- */
  const inputs = {};
  const grid = ui.el('div', { class: 'mrb-cpk-grid' });
  for (const [space] of SPACES) {
    const lbl = ui.el('label', { class: 'mrb-cpk-cell' },
      ui.el('span', { class: 'mrb-cpk-cell-label', text: fmtLabel(space) }));
    const inp = ui.el('input', {
      class: 'mrb-field-input mrb-cpk-input',
      type: 'text',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': tt(fmtLabel(space) + ' value', fmtLabel(space) + ' 數值'),
    });
    inp.addEventListener('focus', () => { state.suppress = space; });
    inp.addEventListener('blur', () => { if (state.suppress === space) state.suppress = null; });
    inp.addEventListener('change', () => {
      const p = parse(inp.value);
      if (p.ok) {
        applyParsed(p, space);
        pushRecent(toHex(p, { forceAlpha: true }));
      } else {
        /* invalid entry: restore the field to the current value, never half-apply */
        inp.value = state.lastFormats[space] || '';
        ui.toast?.({
          title: tt('Could not read that colour', '睇唔明呢個顏色'),
          body: p.error || '',
          tone: 'warn',
          timeoutMs: 4000,
        });
      }
    });
    inputs[space] = inp;
    lbl.append(inp);
    grid.append(lbl);
  }

  /* --- translator rows with copy ------------------------------------ */
  const transTitle = ui.el('div', { class: 'mrb-cpk-subtitle', text: tt('Translator — the same colour in every space', '轉換器 — 同一顏色喺所有空間') });
  const activeChip = ui.el('span', { class: 'mrb-chip', text: '' });
  const transGrid = ui.el('div', { class: 'mrb-cpk-trans' });
  const transRows = {};
  for (const [space] of SPACES) {
    const val = ui.el('code', { class: 'mrb-cpk-trans-val', text: '' });
    const btn = ui.el('button', {
      class: 'mrb-btn mrb-btn-text mrb-btn-sm',
      type: 'button',
      'aria-label': tt(`Copy ${fmtLabel(space)} value`, `複製 ${fmtLabel(space)} 數值`),
      text: '⧉',
    });
    btn.addEventListener('click', () => { ui.copyText(val.textContent || ''); });
    const row = ui.el('div', { class: 'mrb-cpk-trans-row' },
      ui.el('span', { class: 'mrb-cpk-trans-name', text: fmtLabel(space) }),
      val, btn);
    transRows[space] = val;
    transGrid.append(row);
  }

  /* --- contrast ------------------------------------------------------ */
  const contrastBox = ui.el('div', { class: 'mrb-cpk-contrast' });
  let customFg = parse('#111111');
  const fgInput = ui.el('input', {
    class: 'mrb-field-input mrb-cpk-fg-input',
    type: 'text',
    value: '#111111',
    'aria-label': tt('Custom foreground for contrast check', '對比檢查用自訂前景色'),
  });
  fgInput.addEventListener('change', () => {
    const p = parse(fgInput.value);
    if (p.ok) customFg = p;
    render();
  });
  contrastBox.append(
    ui.el('div', { class: 'mrb-cpk-subtitle', text: tt('Contrast', '對比度') }),
    ui.el('div', { class: 'mrb-cpk-contrast-controls' },
      ui.el('label', {}, ui.el('span', { text: tt('Foreground', '前景') }), fgInput)),
  );

  /* --- swatches + recents ------------------------------------------- */
  const swatchTitle = ui.el('div', { class: 'mrb-cpk-subtitle', text: tt('Palettes', '色板') });
  const swatchRow = ui.el('div', { class: 'mrb-cpk-swatches' });
  for (const pal of PRESET_PALETTES) {
    const grp = ui.el('div', { class: 'mrb-cpk-pal', role: 'group', 'aria-label': pal.name },
      ui.el('span', { class: 'mrb-cpk-pal-name', text: pal.name }));
    for (const hexv of pal.colors) {
      grp.append(swatchBtn(hexv));
    }
    swatchRow.append(grp);
  }
  const recentTitle = ui.el('div', { class: 'mrb-cpk-subtitle', text: tt('Recent', '最近用過') });
  const recentRow = ui.el('div', { class: 'mrb-cpk-swatches' });

  function swatchBtn(hexv) {
    const b = ui.el('button', {
      class: 'mrb-cpk-swatch',
      type: 'button',
      style: `background:${hexv}`,
      title: hexv,
      'aria-label': tt('Use colour', '使用顏色') + ' ' + hexv,
    });
    b.addEventListener('click', () => applyParsed(parse(hexv), 'swatch'));
    return b;
  }

  root.append(
    previewWrap,
    svCanvas, hueCanvas, alphaCanvas,
    grid,
    transTitle, activeChip, transGrid,
    contrastBox,
    swatchTitle, swatchRow,
    recentTitle, recentRow,
  );
  container.append(root);

  /* --- interaction --------------------------------------------------- */
  bindDrag(svCanvas, (x, y) => {
    const [h] = rgbToHsv(state.c.r, state.c.g, state.c.b);
    const s = x / svCanvas.width;
    const v = 1 - y / svCanvas.height;
    const [r, g, b] = hsvToRgb(h, clamp01(s), clamp01(v));
    applyRaw(r, g, b, state.c.a);
  });
  bindDrag(hueCanvas, (x) => {
    const [, s, v] = rgbToHsv(state.c.r, state.c.g, state.c.b);
    const h = (x / hueCanvas.width) * 360;
    const [r, g, b] = hsvToRgb(h, s === 0 ? 1 : s, v);
    applyRaw(r, g, b, state.c.a);
  });
  bindDrag(alphaCanvas, (x) => {
    applyRaw(state.c.r, state.c.g, state.c.b, clamp01(x / alphaCanvas.width));
  });

  /* keyboard operation for the three picking surfaces */
  for (const [cv, kind] of [[svCanvas, 'sv'], [hueCanvas, 'hue'], [alphaCanvas, 'alpha']]) {
    cv.tabIndex = 0;
    cv.addEventListener('keydown', (ev) => {
      const stepBig = ev.shiftKey ? 0.1 : 0.02;
      let handled = true;
      const [h, s, v] = rgbToHsv(state.c.r, state.c.g, state.c.b);
      if (kind === 'sv' && ev.key === 'ArrowRight') applyRaw(...hsvToRgb(h, clamp01(s + stepBig), v), state.c.a);
      else if (kind === 'sv' && ev.key === 'ArrowLeft') applyRaw(...hsvToRgb(h, clamp01(s - stepBig), v), state.c.a);
      else if (kind === 'sv' && ev.key === 'ArrowDown') applyRaw(...hsvToRgb(h, s, clamp01(v - stepBig)), state.c.a);
      else if (kind === 'sv' && ev.key === 'ArrowUp') applyRaw(...hsvToRgb(h, s, clamp01(v + stepBig)), state.c.a);
      else if (kind === 'hue' && (ev.key === 'ArrowRight' || ev.key === 'ArrowUp')) applyRaw(...hsvToRgb((h + (ev.shiftKey ? 10 : 2)) % 360, s, v), state.c.a);
      else if (kind === 'hue' && (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown')) applyRaw(...hsvToRgb((h - (ev.shiftKey ? 10 : 2) + 360) % 360, s, v), state.c.a);
      else if (kind === 'alpha' && ev.key === 'ArrowRight') applyRaw(state.c.r, state.c.g, state.c.b, clamp01(state.c.a + stepBig));
      else if (kind === 'alpha' && ev.key === 'ArrowLeft') applyRaw(state.c.r, state.c.g, state.c.b, clamp01(state.c.a - stepBig));
      else handled = false;
      if (handled) ev.preventDefault();
    });
  }

  function bindDrag(cv, fn) {
    let dragging = false;
    const pos = (ev) => {
      const r = cv.getBoundingClientRect();
      const px = cv.width / r.width;
      const py = cv.height / r.height;
      const x = clamp01((ev.clientX - r.left) / r.width) * cv.width * px;
      const y = clamp01((ev.clientY - r.top) / r.height) * cv.height * py;
      return [x / (px || 1), y / (py || 1)];
    };
    cv.addEventListener('pointerdown', (ev) => {
      dragging = true;
      cv.setPointerCapture(ev.pointerId);
      const [x, y] = pos(ev);
      fn(x, y);
    });
    cv.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      const [x, y] = pos(ev);
      fn(x, y);
    });
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      pushRecent(currentHex());
    };
    cv.addEventListener('pointerup', stop);
    cv.addEventListener('pointercancel', stop);
  }

  function applyRaw(r, g, b, a) {
    applyParsed({ ok: true, r: clamp01(r), g: clamp01(g), b: clamp01(b), a: clamp01(a), clipped: false, space: 'picker' }, 'picker');
  }

  function applyParsed(p, fromSpace) {
    if (!p || !p.ok) return;
    state.c = p;
    state.activeSpace = p.space || fromSpace || 'hex';
    render();
    emit(currentHex());
  }

  function currentHex() {
    return toHex(state.c, { forceAlpha: true });
  }

  function emit(value) {
    if (typeof opts.onChange === 'function') {
      try { opts.onChange(value); } catch (_) { /* consumer error must not break the picker */ }
    }
  }

  state.lastFormats = {};

  function render() {
    const c = state.c;
    const [h, s, v] = rgbToHsv(c.r, c.g, c.b);

    /* preview */
    preview.classList.toggle('mrb-rainbow', state.isRainbow);
    if (!state.isRainbow) preview.style.background = toHex(c, { forceAlpha: true });
    clippedChip.hidden = !c.clipped;

    /* canvases */
    paintSV(svCanvas, h);
    paintStrip(hueCanvas, null);
    paintStrip(alphaCanvas, c);

    /* markers */
    drawMarkerSV(svCanvas, s, v);
    drawMarkerStrip(hueCanvas, h / 360);
    drawMarkerStrip(alphaCanvas, c.a);

    /* fields */
    state.lastFormats = {};
    const all = formatAll(c);
    for (const [space] of SPACES) {
      const txt = all[space];
      state.lastFormats[space] = txt;
      if (inputs[space] !== document.activeElement && state.suppress !== space) {
        inputs[space].value = txt;
      }
      transRows[space].textContent = txt;
    }
    activeChip.textContent = tt('Active space', '現用空間') + ': ' + (state.activeSpace || 'hex').toUpperCase();

    /* contrast */
    renderContrast();

    /* recents */
    recentRow.textContent = '';
    const rec = recentColors();
    if (!rec.length) {
      recentRow.append(ui.el('span', { class: 'mrb-cpk-empty', text: tt('Nothing yet — pick a colour and it lands here.', '仲未有 — 揀個色就會出現。') }));
    } else {
      for (const hexv of rec) recentRow.append(swatchBtn(hexv));
    }
  }

  function renderContrast() {
    const targets = [
      [tt('on white', '白底上'), WHITE],
      [tt('on black', '黑底上'), BLACK],
      [tt('on custom', '自訂底上'), customFg],
    ];
    contrastBox.querySelectorAll('.mrb-cpk-contrast-row').forEach((n) => n.remove());
    for (const [label, bg] of targets) {
      const rep = contrastReport(state.c, bg);
      const chip = (pass, textv) => ui.el('span', {
        class: 'mrb-chip ' + (pass ? 'mrb-chip-pass' : 'mrb-chip-fail'),
        text: textv,
      });
      contrastBox.append(ui.el('div', { class: 'mrb-cpk-contrast-row' },
        ui.el('span', { class: 'mrb-cpk-contrast-label', text: label }),
        ui.el('strong', { text: rep.ratioText }),
        chip(rep.aaBody, 'AA' + (rep.aaBody ? ' ✓' : ' ✗')),
        chip(rep.aaaBody, 'AAA' + (rep.aaaBody ? ' ✓' : ' ✗')),
      ));
    }
  }

  /* initial paint */
  render();

  return {
    set(v) {
      if (v === RAINBOW) {
        state.isRainbow = true;
        rainbowChip.hidden = false;
        preview.classList.add('mrb-rainbow');
        emit(RAINBOW);
        return;
      }
      const p = parse(v);
      if (p.ok) {
        if (state.isRainbow) {
          state.isRainbow = false;
          rainbowChip.hidden = true;
        }
        applyParsed(p, 'external');
      }
    },
    get: () => (state.isRainbow ? RAINBOW : currentHex()),
    destroy() {
      root.remove();
    },
  };
}

/* --- canvas painting ------------------------------------------------ */

let checkerPatternCache = null;
function checkerPattern(ctx) {
  if (checkerPatternCache) return checkerPatternCache;
  const t = document.createElement('canvas');
  t.width = 12;
  t.height = 12;
  const tc = t.getContext('2d');
  tc.fillStyle = '#ffffff';
  tc.fillRect(0, 0, 12, 12);
  tc.fillStyle = '#c9cbcd';
  tc.fillRect(0, 0, 6, 6);
  tc.fillRect(6, 6, 6, 6);
  checkerPatternCache = ctx.createPattern(t, 'repeat');
  return checkerPatternCache;
}

function paintSV(cv, hue) {
  const ctx = cv.getContext('2d');
  const [r, g, b] = hsvToRgb(hue, 1, 1);
  const base = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, cv.width, cv.height);
  let grd = ctx.createLinearGradient(0, 0, cv.width, 0);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, cv.width, cv.height);
  grd = ctx.createLinearGradient(0, 0, 0, cv.height);
  grd.addColorStop(0, 'rgba(0,0,0,0)');
  grd.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, cv.width, cv.height);
}

function paintStrip(cv, colorCtx) {
  const ctx = cv.getContext('2d');
  if (!colorCtx) {
    const grd = ctx.createLinearGradient(0, 0, cv.width, 0);
    for (let i = 0; i <= 6; i++) {
      const [r, g, b] = hsvToRgb((i / 6) * 360, 1, 1);
      grd.addColorStop(i / 6, `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`);
    }
    ctx.fillStyle = grd;
  } else {
    const pat = checkerPattern(ctx);
    ctx.fillStyle = pat || '#ffffff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const grd = ctx.createLinearGradient(0, 0, cv.width, 0);
    const col = toRgbStr(colorCtx).replace(/rgba?\(|\)/g, '');
    const parts = col.split(',');
    grd.addColorStop(0, `rgba(${parts[0]},${parts[1]},${parts[2]},0)`);
    grd.addColorStop(1, `rgba(${parts[0]},${parts[1]},${parts[2]},1)`);
    ctx.fillStyle = grd;
  }
  ctx.fillRect(0, 0, cv.width, cv.height);
}

function drawMarkerSV(cv, s, v) {
  const ctx = cv.getContext('2d');
  const x = s * cv.width;
  const y = (1 - v) * cv.height;
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.beginPath();
  ctx.arc(x, y, 7.5, 0, Math.PI * 2);
  ctx.stroke();
}

function drawMarkerStrip(cv, frac) {
  const ctx = cv.getContext('2d');
  const x = clamp01(frac) * cv.width;
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffffff';
  ctx.strokeRect(x - 3, 1, 6, cv.height - 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.strokeRect(x - 4.5, 0.5, 9, cv.height - 1);
}

function fmtLabel(space) {
  const labels = {
    hex: 'HEX', rgb: 'RGB(A)', hsl: 'HSL(A)', hsv: 'HSV/HSB', hwb: 'HWB',
    cmyk: 'CMYK', lab: 'CIELAB', lch: 'LCH', oklab: 'OKLab', oklch: 'OKLCH',
  };
  return labels[space] || space.toUpperCase();
}

/* ------------------------------------------------------------------ */
/* Rainbow globals                                                     */
/* ------------------------------------------------------------------ */

/**
 * Publish the ONE global rainbow duration from settings.
 * Reads `appearance.rainbowSpeedLevel` (1..5, default 3) through the settings
 * peer when present and falls back to the raw store key otherwise, then sets
 * `--mrb-rainbow-duration` on the document root. Called at init and whenever
 * the setting changes.
 */
export function applyRainbowGlobals() {
  let level = 3;
  try {
    const raw = store.get('appearance.rainbowSpeedLevel', 3);
    level = Number(raw) || 3;
  } catch (_) { /* store degraded — shipped default stands */ }
  if (!(level in RAINBOW_SPEED_MAP)) level = 3;
  const dur = RAINBOW_SPEED_MAP[level];
  document.documentElement.style.setProperty('--mrb-rainbow-duration', dur);
  document.documentElement.setAttribute('data-mrb-rainbow-level', String(level));
}

/**
 * Turn the sentinel presentation on/off for an element. This is the ONLY way
 * the rainbow look is applied — there is no inline-colour rainbow anywhere.
 */
export function setRainbow(el, on) {
  if (!el) return;
  el.classList.toggle('mrb-rainbow', !!on);
  if (on) {
    el.setAttribute('data-mrb-rainbow', '');
    el.title = tt('Animated rainbow', '動態彩虹');
  } else {
    el.removeAttribute('data-mrb-rainbow');
  }
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

/**
 * Inject this lane's stylesheet exactly once, trying the documented URL first
 * and falling back across path variants so the module works from any mount
 * point. ui.injectCss dedups per URL; the load-error fallback chain here
 * covers the cases where Lane A serves the renderer from a different base.
 */
let toolsCssDone = false;
export function ensureToolsStyles() {
  if (toolsCssDone) return;
  const candidates = ['styles/features/tools.css', './styles/features/tools.css', '../styles/features/tools.css', '/styles/features/tools.css'];
  const tryNext = (i) => {
    if (i >= candidates.length) return; // CSS missing: features still work, unstyled
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = candidates[i];
    let settled = false;
    const fail = () => { if (!settled) { settled = true; link.remove(); tryNext(i + 1); } };
    link.addEventListener('error', fail);
    link.addEventListener('load', () => {
      if (!settled) {
        settled = true;
        toolsCssDone = true;
      }
    });
    document.head.append(link);
    // Some engines never fire error/load for same-origin CSS quirks — probe.
    setTimeout(() => {
      for (const sheet of document.styleSheets) {
        try {
          if ((sheet.href || '').endsWith('tools.css')) { toolsCssDone = true; return; }
        } catch (_) { /* cross-origin sheet — ignore */ }
      }
      if (!settled && !link.sheet) fail();
    }, 1200);
  };
  tryNext(0);
}

/** @returns {Promise<void>} */
export async function init() {
  ensureToolsStyles();
  applyRainbowGlobals();
  try {
    const { settings } = await import('./settings.js');
    if (settings && typeof settings.onChange === 'function') {
      settings.onChange(() => applyRainbowGlobals());
    }
  } catch (_) {
    /* settings peer unavailable this boot — shipped default duration stands */
  }
}
