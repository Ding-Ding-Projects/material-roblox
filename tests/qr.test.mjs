/**
 * Tests for src/js/core/qr.js — the self-contained QR encoder.
 *
 * Scope of this suite:
 *  - Version selection against the published byte-mode capacity table (level M).
 *  - Determinism: encoding the same payload twice is byte-identical.
 *  - Function patterns drawn exactly as specified: finder + separators,
 *    timing, alignment, dark module.
 *  - Format information: valid BCH(15,5), both copies agree, EC level = M,
 *    mask id in range and consistent with the format bits.
 *  - Version information (versions 7+): valid BCH(18,6), both copies agree.
 *  - Reed-Solomon block structure: codewords are re-read from the matrix by an
 *    independent spec-based placement walk, de-interleaved with independently
 *    transcribed block tables, and every block must pass a full syndrome check
 *    over GF(256) (all syndromes zero for every block).
 *
 * The QR specification tables below are transcribed from ISO/IEC 18004
 * (byte mode, error correction level M). They deliberately duplicate values
 * also present in the module under test: the test asserts the implementation
 * agrees with the standard, which is only meaningful if the standard's own
 * numbers appear here too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../src/js/core/qr.js';

/* ---------------------------------------------------------------------------
 * Spec tables (ISO/IEC 18004): byte mode @ EC level M
 * ------------------------------------------------------------------------ */

/** [blockCount, totalCodewordsPerBlock, dataCodewordsPerBlock] groups per version. */
const SPEC_BLOCKS_M = [
  [[1, 26, 16]],
  [[1, 44, 28]],
  [[1, 70, 44]],
  [[2, 50, 32]],
  [[2, 67, 43]],
  [[4, 43, 27]],
  [[4, 49, 31]],
  [[2, 60, 38], [2, 61, 39]],
  [[3, 58, 36], [2, 59, 37]],
  [[4, 69, 43], [1, 70, 44]],
];
/** EC codewords per block, indexed by version - 1. */
const SPEC_EC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
/** Alignment pattern center coordinates, indexed by version - 1. */
const SPEC_ALIGNMENT_CENTERS = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 52],
];
/** Published byte-mode capacities at level M (bytes), indexed by version - 1. */
const SPEC_CAPACITY_BYTES = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

/* ---------------------------------------------------------------------------
 * Independent GF(256) arithmetic (primitive polynomial 0x11D)
 * ------------------------------------------------------------------------ */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
function gfMul(a, b) {
  return a !== 0 && b !== 0 ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0;
}

/** True when the received codeword (data || ecc) is a valid RS codeword. */
function syndromesAllZero(codeword, ecDegree) {
  for (let j = 0; j < ecDegree; j++) {
    const alphaJ = GF_EXP[j % 255]; // alpha = 2
    let s = 0;
    for (const b of codeword) s = gfMul(s, alphaJ) ^ b;
    if (s !== 0) return false;
  }
  return true;
}

/* ---------------------------------------------------------------------------
 * Spec-based function-module map (which cells carry structure, not data)
 * ------------------------------------------------------------------------ */

function buildFunctionMap(size, version) {
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  /** Cells covered by an alignment pattern (their content is pattern, not timing). */
  const alignmentCells = new Set();
  const mark = (r, c) => {
    if (r >= 0 && r < size && c >= 0 && c < size) fn[r][c] = true;
  };
  // Finder patterns plus their one-module light separators (8x8 boxes).
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) mark(r0 + dr, c0 + dc);
    }
  }
  // Timing row/column between the finders.
  for (let i = 8; i < size - 8; i++) {
    mark(6, i);
    mark(i, 6);
  }
  // Alignment patterns, skipping the three that would overlap finders.
  const centers = SPEC_ALIGNMENT_CENTERS[version - 1];
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < centers.length; j++) {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === centers.length - 1) ||
        (i === centers.length - 1 && j === 0);
      if (corner) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          mark(centers[i] + dr, centers[j] + dc);
          alignmentCells.add(`${centers[i] + dr},${centers[j] + dc}`);
        }
      }
    }
  }
  // Format information areas and the dark module.
  for (let k = 0; k <= 5; k++) {
    mark(8, k);
    mark(k, 8);
  }
  mark(8, 7);
  mark(8, 8);
  mark(7, 8);
  for (let k = 0; k < 8; k++) mark(size - 1 - k, 8);
  for (let k = 8; k < 15; k++) mark(8, size - 15 + k);
  mark(size - 8, 8);
  // Version information areas (versions 7+).
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      mark(a, b);
      mark(b, a);
    }
  }
  return { fn, alignmentCells };
}

/* ---------------------------------------------------------------------------
 * Codeword extraction: mirror the spec zigzag placement rule.
 * The final matrix carries MASKED data modules, so the mask declared by the
 * format information is removed from every non-function module before the
 * codeword bits are interpreted.
 * ------------------------------------------------------------------------ */

/** The eight standard mask predicates, transcribed from the spec. */
function specMaskBit(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

function readCodewordStream(modules, size, version) {
  const { fn } = buildFunctionMap(size, version);
  // Decode the applied mask from the (unmasked-by-definition) format info.
  const maskId = checkFormatInfo(modules, size);
  const expectedBytes = SPEC_BLOCKS_M[version - 1].reduce(
    (n, [count, total]) => n + count * total, 0,
  );
  const bits = [];
  outer:
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column pair shifts to (5,4)
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x]) {
          const dark = specMaskBit(maskId, y, x)
            ? !modules[y][x]
            : modules[y][x];
          bits.push(dark ? 1 : 0);
          if (bits.length === expectedBytes * 8) break outer;
        }
      }
    }
  }
  assert.equal(
    bits.length,
    expectedBytes * 8,
    `expected ${expectedBytes} data+ecc codeword bytes for version ${version}, found ${bits.length / 8}`,
  );
  const out = new Uint8Array(expectedBytes);
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
    out[i] = v;
  }
  return out;
}

/** Invert the block interleave using the spec block tables. */
function deinterleave(stream, version) {
  const groups = SPEC_BLOCKS_M[version - 1];
  const ecLen = SPEC_EC_PER_BLOCK[version - 1];
  const blocks = [];
  for (const [count, , dataLen] of groups) {
    for (let b = 0; b < count; b++) blocks.push({ data: new Array(dataLen), ecc: new Array(ecLen) });
  }
  let idx = 0;
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) b.data[i] = stream[idx++];
  }
  for (let i = 0; i < ecLen; i++) {
    for (const b of blocks) b.ecc[i] = stream[idx++];
  }
  assert.equal(idx, stream.length, 'de-interleave consumed the whole stream');
  return { blocks, ecLen };
}

/* ---------------------------------------------------------------------------
 * Format & version information checks
 * ------------------------------------------------------------------------ */

function bch15Remainder(bits15) {
  let v = bits15;
  for (let i = 14; i >= 10; i--) {
    if ((v >>> i) & 1) v ^= 0x537 << (i - 10);
  }
  return v & 0x3ff;
}

/** Reads both format-info copies and validates them against the spec. */
function checkFormatInfo(modules, size) {
  const readCopy1 = () => {
    let v = 0;
    const put = (i, r, c) => { if (modules[r][c]) v |= 1 << i; };
    for (let i = 0; i <= 5; i++) put(i, 8, i);
    put(6, 8, 7);
    put(7, 8, 8);
    put(8, 7, 8);
    for (let i = 9; i < 15; i++) put(i, 14 - i, 8);
    return v;
  };
  const readCopy2 = () => {
    let v = 0;
    const put = (i, r, c) => { if (modules[r][c]) v |= 1 << i; };
    for (let i = 0; i < 8; i++) put(i, size - 1 - i, 8);
    for (let i = 8; i < 15; i++) put(i, 8, size - 15 + i);
    return v;
  };
  const c1 = readCopy1();
  const c2 = readCopy2();
  assert.equal(c1, c2, 'both format information copies must be identical');
  const recovered = c1 ^ 0x5412; // remove the standard XOR mask
  assert.equal(bch15Remainder(recovered), 0, 'format info must be a valid BCH(15,5) codeword');
  const ecBits = recovered >>> 13; // two-bit EC level indicator
  assert.equal(ecBits, 0b00, 'format info must declare error correction level M (00)');
  const maskId = (recovered >>> 10) & 0b111;
  assert.ok(maskId >= 0 && maskId <= 7, 'decoded mask id must be in 0..7');
  // Recompute the expected remainder for the decoded (level, mask) pair.
  const data5 = (0 << 3) | maskId;
  let rem = data5;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  assert.equal((data5 << 10) | rem, recovered, 'format bits must encode exactly level M + chosen mask');
  return maskId;
}

function checkVersionInfo(modules, size, version) {
  let v = 0;
  for (let i = 0; i < 18; i++) {
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    const first = modules[a][b];
    const second = modules[b][a];
    assert.equal(first, second, `version bit ${i} must match between the two copies`);
    if (first) v |= 1 << i;
  }
  const declared = v >>> 12;
  const rem12 = v & 0xfff;
  let r = declared;
  for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
  assert.equal(r, rem12, 'version info must be a valid BCH(18,6) codeword');
  assert.equal(declared, version);
}

/* ---------------------------------------------------------------------------
 * Structural pattern checks
 * ------------------------------------------------------------------------ */

function checkFinderPatterns(modules, size) {
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let dr = 0; dr <= 6; dr++) {
      for (let dc = 0; dc <= 6; dc++) {
        const dist = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        assert.equal(
          modules[r0 + dr][c0 + dc],
          dist !== 2,
          `finder cell (${r0 + dr},${c0 + dc}) must be ${dist !== 2 ? 'dark' : 'light'}`,
        );
      }
    }
    // Separator ring stays light (cells just outside the 7x7 finder).
    for (let d = -1; d <= 7; d++) {
      const rowAbove = r0 - 1 >= 0 ? modules[r0 - 1][c0 + d] : undefined;
      const rowBelow = r0 + 7 < size ? modules[r0 + 7][c0 + d] : undefined;
      const colLeft = c0 - 1 >= 0 ? modules[r0 + d][c0 - 1] : undefined;
      const colRight = c0 + 7 < size ? modules[r0 + d][c0 + 7] : undefined;
      for (const [cell, name] of [[rowAbove, 'above'], [rowBelow, 'below'], [colLeft, 'left'], [colRight, 'right']]) {
        if (cell !== undefined) {
          assert.equal(cell, false, `separator ${name} of finder at (${r0},${c0}) must stay light`);
        }
      }
    }
  }
}

function checkTimingPatterns(modules, size, alignmentCells) {
  for (let i = 8; i < size - 8; i++) {
    if (!alignmentCells.has(`6,${i}`)) {
      assert.equal(modules[6][i], i % 2 === 0, `timing row cell (6,${i}) must alternate`);
    }
    if (!alignmentCells.has(`${i},6`)) {
      assert.equal(modules[i][6], i % 2 === 0, `timing column cell (${i},6) must alternate`);
    }
  }
}

function checkAlignmentPattern(modules, r, c) {
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      assert.equal(
        modules[r + dr][c + dc],
        Math.max(Math.abs(dr), Math.abs(dc)) !== 1,
        `alignment cell (${r + dr},${c + dc}) wrong`,
      );
    }
  }
}

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */

function expectVersion(text, version) {
  const result = encode(text);
  assert.equal(result.version, version, `"${String(text).slice(0, 24)}..." should select version ${version}`);
  assert.equal(result.size, 17 + 4 * version);
  assert.equal(result.modules.length, result.size);
  for (const row of result.modules) assert.equal(row.length, result.size);
  checkFormatInfo(result.modules, result.size);
  if (version >= 7) checkVersionInfo(result.modules, result.size, version);
  return result;
}

/* ---------------------------------------------------------------------------
 * Version selection vs the published capacity table
 * ------------------------------------------------------------------------ */

test('empty and null input throws', () => {
  assert.throws(() => encode(''), /Nothing to encode/);
  assert.throws(() => encode(null), /Nothing to encode/); // null normalizes to ''
});

test('version selection follows the published byte-mode capacities at level M', () => {
  for (let v = 1; v <= 10; v++) {
    const fits = 'A'.repeat(SPEC_CAPACITY_BYTES[v - 1]);
    expectVersion(fits, v);
    if (v < 10) {
      const overflows = 'A'.repeat(SPEC_CAPACITY_BYTES[v - 1] + 1);
      expectVersion(overflows, v + 1);
    }
  }
});

test('one byte past the largest capacity is refused with an actionable message', () => {
  assert.throws(() => encode('A'.repeat(214)), /more than 213 bytes/);
});

test('short payloads select version 1', () => {
  expectVersion('A', 1);
  expectVersion('HELLO', 1);
  expectVersion('HELLO WORLD', 1);
});

test('a longer payload selects the matching larger version', () => {
  expectVersion('x'.repeat(150), 8); // 150 <= 152 but > 122
});

test('UTF-8 byte mode handles control bytes and high bytes', () => {
  // NUL, SOH, DEL, U+00FF twice (2 UTF-8 bytes each), then ASCII.
  const payload = '\u0000A\u007f\u00ff\u00ffabc';
  const utf8Length = new TextEncoder().encode(payload).length;
  assert.ok(utf8Length <= SPEC_CAPACITY_BYTES[0], `fixture must fit version 1 (got ${utf8Length} bytes)`);
  const result = expectVersion(payload, 1);
  // Re-encoding must be stable for binary-ish input too.
  assert.deepEqual(encode(payload).modules, result.modules);
});

/* ---------------------------------------------------------------------------
 * Determinism
 * ------------------------------------------------------------------------ */

test('re-encoding any payload is byte-identical', () => {
  const payloads = [
    'A',
    'HELLO',
    'otpauth://totp/Material%20Roblox:swiftie@example.com?secret=JBSWY3DPEHPK3PXP&issuer=MaterialRoblox',
    '\u0000\u0001\u007f\u00ffabc',
    'x'.repeat(150),
    'A'.repeat(213),
  ];
  for (const p of payloads) {
    const a = JSON.stringify(encode(p));
    const b = JSON.stringify(encode(p));
    assert.equal(a, b, `encoding "${String(p).slice(0, 32)}" must be deterministic`);
  }
});

/* ---------------------------------------------------------------------------
 * Structure: function patterns
 * ------------------------------------------------------------------------ */

test('finder patterns, separators, timing and dark module match the spec shapes', () => {
  for (const version of [1, 4, 7, 10]) {
    // Exactly-full payload forces precisely this version (proven by the
    // capacity-boundary test above).
    const { modules, size, version: actualVersion } =
      encode('A'.repeat(SPEC_CAPACITY_BYTES[version - 1]));
    assert.equal(actualVersion, version);
    checkFinderPatterns(modules, size);
    const { alignmentCells } = buildFunctionMap(size, version);
    checkTimingPatterns(modules, size, alignmentCells);
    assert.equal(modules[size - 8][8], true, 'dark module must be dark');
  }
});

test('alignment patterns sit at the spec centers with the spec shape', () => {
  for (const version of [2, 6, 7, 10]) {
    const { modules, size, version: actualVersion } =
      encode('A'.repeat(SPEC_CAPACITY_BYTES[version - 1]));
    assert.equal(actualVersion, version);
    const centers = SPEC_ALIGNMENT_CENTERS[version - 1];
    let drawn = 0;
    for (let i = 0; i < centers.length; i++) {
      for (let j = 0; j < centers.length; j++) {
        const corner =
          (i === 0 && j === 0) ||
          (i === 0 && j === centers.length - 1) ||
          (i === centers.length - 1 && j === 0);
        if (!corner) {
          checkAlignmentPattern(modules, centers[i], centers[j]);
          drawn++;
        }
      }
    }
    assert.ok(drawn > 0, `version ${version} should draw at least one alignment pattern`);
  }
});

test('every tested symbol carries valid format info declaring level M and a real mask', () => {
  for (const version of [1, 2, 5, 8, 10]) {
    const { modules, size, version: actualVersion } =
      encode('A'.repeat(SPEC_CAPACITY_BYTES[version - 1]));
    assert.equal(actualVersion, version);
    const maskId = checkFormatInfo(modules, size);
    assert.ok(Number.isInteger(maskId));
  }
});

/* ---------------------------------------------------------------------------
 * Reed-Solomon block structure: full syndrome verification
 * ------------------------------------------------------------------------ */

test('codewords re-read from the matrix form valid RS blocks per the spec tables', () => {
  // Covers: single-block (v1/v3), multi-block equal lengths (v6),
  // two unequal groups (v8), and a version>=7 symbol (v10).
  // The payload is exactly one byte short of the appended marker byte, so the
  // total lands exactly on this version's capacity and cannot select another.
  for (const version of [1, 3, 6, 8, 10]) {
    const capacity = SPEC_CAPACITY_BYTES[version - 1];
    const text = 'A'.repeat(capacity - 1) + String.fromCharCode(0x41 + version);
    const { modules, size, version: actualVersion } = encode(text);
    assert.equal(actualVersion, version, `payload must select version ${version}`);
    const stream = readCodewordStream(modules, size, version);
    const { blocks, ecLen } = deinterleave(stream, version);
    for (let b = 0; b < blocks.length; b++) {
      const codeword = [...blocks[b].data, ...blocks[b].ecc];
      assert.ok(
        syndromesAllZero(codeword, ecLen),
        `version ${version} block ${b} failed the Reed-Solomon syndrome check`,
      );
    }
  }
});
