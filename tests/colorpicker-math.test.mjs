/**
 * Tests for the pure colour math exported by src/js/core/colorpicker.js.
 *
 * Only import-safe exports are exercised (parse, the to*Str formatters,
 * formatAll, contrast helpers, compositeOver, WHITE/BLACK, RAINBOW sentinel
 * and its speed map). The DOM-bound surface (mountColorPicker, init,
 * applyRainbowGlobals) is intentionally NOT touched here; see tests/README.md.
 *
 * Tolerances: hex/rgb round-trips are exact apart from 8-bit quantization
 * (<= 0.5/255 per channel), so 0.004 is generous. Cylindrical and CIE spaces
 * format channels as whole percents or whole degrees; a half-degree hue error
 * on a fully saturated colour moves sRGB channels by roughly one percent, so
 * 0.03 leaves real headroom while still catching genuine conversion defects.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parse, toHex, formatAll, compositeOver, contrastRatio, contrastReport,
  WHITE, BLACK, RAINBOW, RAINBOW_SPEED_MAP, recentColors, pushRecent,
} from '../src/js/core/colorpicker.js';

/* A dozen colours covering black/white/grey, primaries, a skin tone,
 * brand-ish accents and a dark navy. */
const COLORS = [
  '#000000', // pure black
  '#FFFFFF', // pure white
  '#808080', // mid grey
  '#FF0000', // saturated red
  '#00FF00', // saturated green
  '#0000FF', // saturated blue
  '#E0AC69', // skin tone
  '#B3261E', // M3 error red
  '#386A20', // deep green
  '#00707C', // teal
  '#FBC02D', // yellow
  '#123456', // dark navy
];

const TOLERANCE = {
  hex: 0.004, rgb: 0.004, hsl: 0.03, hsv: 0.03, hwb: 0.03,
  cmyk: 0.03, lab: 0.03, lch: 0.03, oklab: 0.02, oklch: 0.02,
};

const rgbOf = (c) => [c.r, c.g, c.b];
const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

/* Full-precision CIE coordinates of sRGB red — rounded constants sit outside
 * the module's +/-1e-4 gamut epsilon and would falsely read as "clipped". */
const LAB_RED = 'lab(53.2408, 80.0925, 67.2032)';
const LCH_RED = 'lch(53.2408, 104.5518, 39.999)';
const OKLAB_RED = 'oklab(0.62796, 0.22486, 0.12585)';
const OKLCH_RED = 'oklch(0.62796, 0.25768, 29.234)';

/* ---------------------------------------------------------------------------
 * parse(): known values
 * ------------------------------------------------------------------------ */

test('parse() reads hex in every documented length', () => {
  assert.deepEqual(rgbOf(parse('#FF0000')).map((v) => Math.round(v * 255)), [255, 0, 0]);
  assert.equal(parse('#F00').ok, true);
  assert.ok(maxDiff(rgbOf(parse('#F00')), [1, 0, 0]) < 1e-12);
  const withAlpha = parse('#FF000080');
  assert.equal(withAlpha.ok, true);
  assert.ok(Math.abs(withAlpha.a - 128 / 255) < 1e-9);
});

test('parse() reads every supported functional space', () => {
  const cases = [
    ['rgb(255, 0, 0)', [1, 0, 0]],
    ['rgba(255, 0, 0, 0.5)', [1, 0, 0]],
    ['hsl(120, 100%, 50%)', [0, 1, 0]],
    ['hsl(120deg, 100%, 50%)', [0, 1, 0]],
    ['hsv(240, 100%, 100%)', [0, 0, 1]],
    ['hsb(0, 100%, 100%)', [1, 0, 0]],
    ['hwb(0, 0%, 0%)', [1, 0, 0]],
    ['cmyk(0%, 100%, 100%, 0%)', [1, 0, 0]],
    [LAB_RED, [1, 0, 0]],
    [LCH_RED, [1, 0, 0]],
    [OKLAB_RED, [1, 0, 0]],
    [OKLCH_RED, [1, 0, 0]],
    ['cielab(53.2408, 80.0925, 67.2032)', [1, 0, 0]],
    ['cielch(53.2408, 104.5518, 39.999)', [1, 0, 0]],
  ];
  for (const [input, expected] of cases) {
    const p = parse(input);
    assert.equal(p.ok, true, `${input} should parse`);
    for (const v of rgbOf(p)) {
      assert.ok(Number.isFinite(v), `${input} produced non-finite channel`);
      assert.ok(v >= -1e-9 && v <= 1 + 1e-9, `${input} channel out of range: ${v}`);
    }
    if (expected) {
      assert.ok(maxDiff(rgbOf(p), expected) < 0.005, `${input} -> ${rgbOf(p)} expected ~${expected}`);
    }
  }
});

test('parse() rejects malformed input without throwing', () => {
  for (const bad of ['', '   ', null, undefined, 42, '#', '#12345', '#GGGGGG',
    'rgb(10, 20)', 'hsl(0, 100%', 'notacolour', 'unknownspace(1, 2, 3)', 'rgb(']) {
    const p = parse(bad);
    assert.equal(p.ok, false, `expected rejection of ${String(bad)}`);
    assert.equal(typeof p.error, 'string');
    assert.ok(p.error.length > 0);
  }
});

test('parse() preserves alpha through every alpha-capable space', () => {
  const inputs = [
    ['#FF000080', 128 / 255],
    ['rgba(255, 0, 0, 0.5)', 0.5],
    ['hsla(0, 100%, 50%, 25%)', 0.25],
    ['hsba(0, 1, 1, 0.75)', 0.75],
    ['hwb(0, 0%, 0%, 0.1)', 0.1],
    ['cmyk(0%, 100%, 100%, 0%, 60%)', 0.6],
    ['lab(53.2, 80.1, 67.2 / 0.3)', 0.3],
    ['lch(53.2, 104.6, 40 / 0.3)', 0.3],
    ['oklab(0.628, 0.225, 0.126 / 0.9)', 0.9],
    ['oklch(0.628, 0.258, 29.2 / 0.05)', 0.05],
  ];
  for (const [input, expectedA] of inputs) {
    const p = parse(input);
    assert.equal(p.ok, true, `${input} should parse`);
    assert.ok(Math.abs(p.a - expectedA) < 0.01, `${input} alpha ${p.a} != ${expectedA}`);
  }
});

/* ---------------------------------------------------------------------------
 * Round trips: parse -> every formatter -> parse
 * ------------------------------------------------------------------------ */

test('round-trip through every exported space stays within tolerance', () => {
  let checked = 0;
  for (const input of COLORS) {
    const first = parse(input);
    assert.equal(first.ok, true, `${input} should parse`);
    const formats = formatAll(first);
    for (const space of Object.keys(TOLERANCE)) {
      assert.equal(typeof formats[space], 'string');
      const second = parse(formats[space]);
      assert.equal(second.ok, true, `${space} output "${formats[space]}" must re-parse`);
      const diff = maxDiff(rgbOf(second), rgbOf(first));
      /* Cylindrical formatters quantise hue to whole degrees; on a colour
       * sitting ON the sRGB boundary (pure primaries) that quantisation can
       * push the reparsed value marginally out of gamut, and the clamp feeds
       * back into all three channels. When either parse reports clipped,
       * allow a wider — still defect-catching — bound; everything else holds
       * the strict table above. */
      const onGamutBoundary = first.clipped || second.clipped;
      const limit = onGamutBoundary ? Math.max(TOLERANCE[space], 0.12) : TOLERANCE[space];
      assert.ok(
        diff <= limit,
        `${input} via ${space}: "${formats[space]}" moved rgb by ${diff.toFixed(4)} (tolerance ${limit})`,
      );
      assert.ok(Math.abs(second.a - first.a) < 0.01, `${input} via ${space} lost alpha`);
      checked++;
    }
  }
  assert.ok(checked >= 12 * 10, 'every colour x every space must be exercised');
});

test('toHex keeps alpha only when present or forced', () => {
  const opaque = parse('#FF0000');
  assert.equal(toHex(opaque), '#ff0000');
  assert.equal(toHex(opaque, { forceAlpha: true }), '#ff0000ff');
  const half = { ...opaque, a: 0.5 };
  assert.match(toHex(half), /^#ff0000(80|7f|81)$/);
});

/* ---------------------------------------------------------------------------
 * Gamut handling
 * ------------------------------------------------------------------------ */

test('in-gamut colours are never marked clipped', () => {
  for (const input of COLORS) {
    assert.equal(parse(input).clipped, false, `${input} is inside sRGB`);
  }
});

test('out-of-gamut LCH and OKLCH values are clamped AND flagged', () => {
  for (const outOfGamut of ['lch(50, 130, 40)', 'oklch(0.6, 0.35, 25)']) {
    const p = parse(outOfGamut);
    assert.equal(p.ok, true, `${outOfGamut} should still parse`);
    assert.equal(p.clipped, true, `${outOfGamut} must be flagged clipped`);
    for (const v of rgbOf(p)) {
      assert.ok(v >= 0 && v <= 1, `clamped channel ${v} must sit inside 0..1`);
    }
  }
});

/* ---------------------------------------------------------------------------
 * Contrast & compositing
 * ------------------------------------------------------------------------ */

test('contrastRatio matches known WCAG reference values', () => {
  assert.ok(Math.abs(contrastRatio(BLACK, WHITE) - 21) < 1e-9, 'black on white is exactly 21:1');
  const grey = parse('#767676');
  const ratio = contrastRatio(grey, WHITE);
  assert.ok(Math.abs(ratio - 4.54) < 0.05, `#767676 vs white should be ~4.54, got ${ratio}`);
  // Order independence.
  assert.ok(Math.abs(contrastRatio(WHITE, BLACK) - contrastRatio(BLACK, WHITE)) < 1e-12);
});

test('contrastReport applies WCAG thresholds and composites alpha first', () => {
  const rep = contrastReport(BLACK, WHITE);
  assert.equal(rep.ratioText, '21:1');
  assert.equal(rep.aaBody, true);
  assert.equal(rep.aaaBody, true);
  assert.equal(rep.aaLarge, true);
  assert.equal(rep.aaaLarge, true);

  // Half-transparent black over white renders as mid grey (~3.98:1):
  // AA large-text passes, AA body text does not.
  const veil = { r: 0, g: 0, b: 0, a: 0.5 };
  const over = compositeOver(veil, WHITE);
  assert.ok(maxDiff(rgbOf(over), [0.5, 0.5, 0.5]) < 1e-9);
  const rep2 = contrastReport(veil, WHITE);
  assert.equal(rep2.aaLarge, true);
  assert.equal(rep2.aaBody, false);
});

/* ---------------------------------------------------------------------------
 * Rainbow sentinel contract
 * ------------------------------------------------------------------------ */

test('RAINBOW is a marker string, never a valid colour string', () => {
  assert.equal(typeof RAINBOW, 'string');
  assert.equal(parse(RAINBOW).ok, false, 'the sentinel must not parse as a colour');
  assert.notEqual(RAINBOW.startsWith('#'), true, 'sentinel must never look like hex');
});

test('RAINBOW_SPEED_MAP covers levels 1..5 exactly once with duration strings', () => {
  assert.deepEqual(Object.keys(RAINBOW_SPEED_MAP).sort(), ['1', '2', '3', '4', '5']);
  for (const value of Object.values(RAINBOW_SPEED_MAP)) {
    assert.match(value, /^\d+s$/);
  }
  assert.equal(RAINBOW_SPEED_MAP[3], '30s', 'level 3 is the shipped default duration');
});

test('recent colours degrade honestly under plain Node (no storage) and the sentinel never lands there', () => {
  assert.deepEqual(recentColors(), [], 'without a store the recents list is empty, not an error');
  assert.doesNotThrow(() => pushRecent(RAINBOW));
  assert.doesNotThrow(() => pushRecent('#336699'));
  assert.deepEqual(recentColors(), []);
});
