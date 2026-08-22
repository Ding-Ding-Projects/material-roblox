'use strict';

/**
 * Compact self-contained QR encoder.
 *
 * Scope (deliberate, documented): byte mode, versions 1-10, error-correction
 * level M, automatic mask selection via the four standard penalty rules,
 * Reed-Solomon ECC over GF(256). That comfortably covers otpauth:// pairing
 * URIs for this app while keeping the whole engine dependency-free.
 *
 * Rendering rules honored by `encodeToCanvas`:
 *  - The quiet zone is ALWAYS preserved at 4 modules or more (never cropped).
 *  - Default colors stay high-contrast black-on-white and are deliberately
 *    NOT theme-tinted; authenticator scanners depend on that contrast.
 */

// ---------------------------------------------------------------------------
// GF(256) arithmetic (primitive polynomial 0x11D)
// ---------------------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  return a !== 0 && b !== 0 ? EXP[LOG[a] + LOG[b]] : 0;
}

/** Coefficients of the Reed-Solomon generator polynomial x^0..x^(degree). */
function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly;
}

/** RS ECC codewords for `degree` check symbols over `data`. */
function rsComputeEcc(data, degree) {
  // Generator polynomial is stored with the CONSTANT term at index 0; the
  // implicit leading monomial's contribution is what `factor` already
  // extracts, so only indices 0..degree-1 fold back into the remainder.
  const gen = rsGeneratorPoly(degree);
  const result = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[degree - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < degree; i++) result[i] ^= gfMul(gen[i], factor);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Version tables for byte mode @ EC level M
// ---------------------------------------------------------------------------

/** Block groups per version: [blockCount, totalCodewordsPerBlock, dataCodewordsPerBlock]. */
const BLOCKS_M = [
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
const EC_PER_BLOCK_M = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
/** Remainder bits appended after the final codeword, indexed by version - 1. */
const REMAINDER_BITS = [0, 7, 7, 7, 7, 7, 7, 0, 0, 0];
/** Alignment pattern center coordinates, indexed by version - 1. */
const ALIGNMENT_CENTERS = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 52],
];

function dataSizeCodewords(version) {
  return BLOCKS_M[version - 1].reduce((sum, [, , data]) => sum + data, 0);
}

function maxBytesForVersion(version) {
  const countBits = version <= 9 ? 8 : 16; // byte-mode character count indicator
  return Math.floor((dataSizeCodewords(version) * 8 - 4 - countBits) / 8);
}

// ---------------------------------------------------------------------------
// Encoding pipeline
// ---------------------------------------------------------------------------

function segmentBitBuffer(bytes, version) {
  /** @type {number[]} */
  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4); // byte mode indicator
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  const capacityBits = dataSizeCodewords(version) * 8;
  // Terminator: up to 4 zero bits.
  push(0, Math.min(4, capacityBits - bits.length));
  // Pad to a byte boundary.
  while (bits.length % 8 !== 0) bits.push(0);
  // Pad codewords alternate 0xEC / 0x11.
  const pads = [0xEC, 0x11];
  let p = 0;
  while (bits.length < capacityBits) push(pads[p++ % 2], 8);

  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
    out[i] = v;
  }
  return out;
}

function addEccAndInterleave(data, version) {
  const groups = BLOCKS_M[version - 1];
  const ecLen = EC_PER_BLOCK_M[version - 1];
  /** @type {Uint8Array[]} */
  const blocks = [];
  /** @type {Uint8Array[]} */
  const eccs = [];
  let offset = 0;
  for (const [count, , dataLen] of groups) {
    for (let b = 0; b < count; b++) {
      const block = data.slice(offset, offset + dataLen);
      offset += dataLen;
      blocks.push(block);
      eccs.push(Uint8Array.from(rsComputeEcc(Array.from(block), ecLen)));
    }
  }
  const maxData = Math.max(...blocks.map((b) => b.length));
  /** @type {number[]} */
  const interleaved = [];
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) if (i < block.length) interleaved.push(block[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const e of eccs) interleaved.push(e[i]);
  }
  // Remainder bits trail as zeros implicitly (matrix starts empty).
  return Uint8Array.from(interleaved);
}

// ---------------------------------------------------------------------------
// Matrix construction
// ---------------------------------------------------------------------------

function makeMatrices(size) {
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  return { modules, isFunction };
}

/** Position probe: 7x7 dark ring / light ring / dark core, plus its 1-module light separator. */
function positionProbePattern(m, r, c) {
  for (let dr = -1; dr <= 7; dr++) {
    const rr = r + dr;
    if (rr < 0 || rr >= m.size) continue;
    for (let dc = -1; dc <= 7; dc++) {
      const cc = c + dc;
      if (cc < 0 || cc >= m.size) continue;
      m.isFunction[rr][cc] = true;
      if (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6) {
        const distFromCenter = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        m.modules[rr][cc] = distFromCenter !== 2; // dark edge + dark core, light middle ring
      } else {
        m.modules[rr][cc] = false; // separator stays light
      }
    }
  }
}

function alignmentPattern(m, r, c) {
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      m.modules[r + dr][c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
      m.isFunction[r + dr][c + dc] = true;
    }
  }
}

function timingPatterns(m) {
  for (let i = 8; i < m.size - 8; i++) {
    if (!m.isFunction[6][i]) {
      m.modules[6][i] = i % 2 === 0;
      m.isFunction[6][i] = true;
    }
    if (!m.isFunction[i][6]) {
      m.modules[i][6] = i % 2 === 0;
      m.isFunction[i][6] = true;
    }
  }
}

function drawFunctionPatterns(m, version) {
  const size = m.size;
  positionProbePattern(m, 0, 0);
  positionProbePattern(m, 0, size - 7);
  positionProbePattern(m, size - 7, 0);
  timingPatterns(m);
  const centers = ALIGNMENT_CENTERS[version - 1];
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < centers.length; j++) {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === centers.length - 1) ||
        (i === centers.length - 1 && j === 0);
      if (!corner) alignmentPattern(m, centers[i], centers[j]);
    }
  }
  // Reserve format information areas (filled after mask selection).
  reserveFormatAreas(m);
  if (version >= 7) reserveVersionAreas(m);
}

function reserveFormatAreas(m) {
  const size = m.size;
  const mark = (r, c) => {
    m.isFunction[r][c] = true;
    m.modules[r][c] = false;
  };
  // Around the top-left finder.
  for (let i = 0; i <= 5; i++) mark(8, i);
  mark(8, 7);
  mark(8, 8);
  mark(7, 8);
  for (let i = 0; i <= 5; i++) mark(i, 8);
  // Second copy split across the other two corners.
  for (let i = 0; i < 8; i++) mark(size - 1 - i, 8);
  for (let i = 8; i < 15; i++) mark(8, size - 15 + i);
  // Dark module.
  m.modules[size - 8][8] = true;
  m.isFunction[size - 8][8] = true;
}

function reserveVersionAreas(m) {
  const size = m.size;
  for (let i = 0; i < 18; i++) {
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    m.isFunction[a][b] = true;
    m.modules[a][b] = false;
    m.isFunction[b][a] = true;
    m.modules[b][a] = false;
  }
}

function drawCodewords(m, data) {
  let i = 0;
  const totalBits = data.length * 8;
  for (let right = m.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let vert = 0; vert < m.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? m.size - 1 - vert : vert;
        if (!m.isFunction[y][x] && i < totalBits) {
          m.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
}

function maskBit(mask, r, c) {
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

function applyMask(source, mask) {
  const size = source.modules.length;
  const modules = source.modules.map((row) => row.slice());
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!source.isFunction[r][c] && maskBit(mask, r, c)) modules[r][c] = !modules[r][c];
    }
  }
  return modules;
}

/** Standard four penalty rules; lower is better. */
function penaltyScore(modules) {
  const size = modules.length;
  let result = 0;

  // Rule 1: five or more same-colored modules in a row/column.
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i < size; i++) {
      let runColor = axis === 0 ? modules[i][0] : modules[0][i]; // first cell of THIS line
      let runLen = 1;
      for (let j = 1; j < size; j++) {
        const cell = axis === 0 ? modules[i][j] : modules[j][i];
        if (cell === runColor) {
          runLen++;
          if (runLen === 5) result += 3;
          else if (runLen > 5) result++;
        } else {
          runColor = cell;
          runLen = 1;
        }
      }
    }
  }

  // Rule 2: every 2x2 block of one color.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) result += 3;
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 pattern with four light modules beside it.
  const PATTERNS = [
    [true, false, true, true, true, false, true, false, false, false, false],
    [false, false, false, false, true, false, true, true, true, false, true],
  ];
  const lineAt = (axis, i, j) => (axis === 0 ? modules[i][j] : modules[j][i]);
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i < size; i++) {
      for (let j = 0; j + PATTERNS[0].length <= size; j++) {
        for (let p = 0; p < PATTERNS.length; p++) {
          const pat = PATTERNS[p];
          let ok = true;
          for (let k = 0; k < pat.length; k++) {
            if (lineAt(axis, i, j + k) !== pat[k]) {
              ok = false;
              break;
            }
          }
          if (ok) result += 40;
        }
      }
    }
  }

  // Rule 4: deviation from 50% dark modules.
  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += Math.max(0, k) * 10;
  return result;
}

function formatInfoBits(mask) {
  const data = (0 << 3) | mask; // EC level M has format bits 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormatBits(modules, mask) {
  const size = modules.length;
  const bits = formatInfoBits(mask);
  const bit = (i) => ((bits >>> i) & 1) !== 0;
  const put = (r, c, v) => {
    modules[r][c] = v;
  };
  // First copy around the top-left finder.
  for (let i = 0; i <= 5; i++) put(8, i, bit(i));
  put(8, 7, bit(6));
  put(8, 8, bit(7));
  put(7, 8, bit(8));
  for (let i = 9; i < 15; i++) put(14 - i, 8, bit(i));
  // Second copy along the other two corners.
  for (let i = 0; i < 8; i++) put(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) put(8, size - 15 + i, bit(i));
}

function drawVersionBits(modules, version) {
  const size = modules.length;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const v = ((bits >>> i) & 1) !== 0;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    modules[a][b] = v;
    modules[b][a] = v;
  }
}

/**
 * Encode UTF-8 text into QR matrices.
 * @returns {{size:number, version:number, modules:boolean[][]}}
 */
export function encode(text) {
  const str = String(text == null ? '' : text);
  if (str.length === 0) throw new Error('Nothing to encode — provide the pairing URI text.');
  const bytes = new TextEncoder().encode(str);

  let version = 0;
  for (let v = 1; v <= 10; v++) {
    if (bytes.length <= maxBytesForVersion(v)) {
      version = v;
      break;
    }
  }
  if (!version) {
    throw new Error(`That text needs more than ${maxBytesForVersion(10)} bytes — shorten it (versions 1-10 only).`);
  }

  const dataCw = segmentBitBuffer(bytes, version);
  const allCw = addEccAndInterleave(dataCw, version);

  const size = 17 + 4 * version;
  const m = makeMatrices(size);
  m.size = size;
  drawFunctionPatterns(m, version);
  drawCodewords(m, allCw);

  // Choose the mask with the lowest penalty score.
  let bestMask = 0;
  let bestScore = Infinity;
  let bestModules = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMask(m, mask);
    const score = penaltyScore(candidate);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      bestModules = candidate;
    }
  }

  m.modules = bestModules;
  drawFormatBits(m.modules, bestMask);
  if (version >= 7) drawVersionBits(m.modules, version);

  return { size, version, modules: m.modules };
}

/**
 * Draw an encoded symbol onto a canvas element.
 * @param {HTMLCanvasElement} canvasEl
 * @param {string} text
 * @param {{scale?:number, quietZone?:number, dark?:string, light?:string}} [opts]
 */
export function encodeToCanvas(canvasEl, text, opts = {}) {
  const scale = Math.max(2, Math.min(16, Math.floor(Number(opts.scale) || 6)));
  const quietZone = Math.max(4, Math.floor(Number(opts.quietZone) || 4)); // strict minimum 4
  const dark = typeof opts.dark === 'string' ? opts.dark : '#000000';
  const light = typeof opts.light === 'string' ? opts.light : '#ffffff';

  const { size, version, modules } = encode(text);
  const dim = (size + quietZone * 2) * scale;
  canvasEl.width = dim;
  canvasEl.height = dim;

  const ctx = canvasEl.getContext('2d');
  if (!ctx) throw new Error('Canvas rendering is unavailable.');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, dim, dim);
  ctx.fillStyle = dark;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) {
        ctx.fillRect(
          (quietZone + c) * scale,
          (quietZone + r) * scale,
          scale,
          scale
        );
      }
    }
  }
  // Scanners and screen readers both need honest metadata on the canvas.
  try { canvasEl.setAttribute('role', 'img'); } catch { /* live element only */ }
  return { size, version, pixelSize: dim };
}

export async function init() {
  // Self-test: encode a known vector and sanity-check the output shape.
  // Warn only — a failed probe must never take the app down.
  try {
    const result = encode('HELLO WORLD');
    const sane =
      Number.isInteger(result.size) &&
      result.size >= 21 &&
      result.size <= 57 &&
      result.size % 2 === 1 &&
      Array.isArray(result.modules) &&
      result.modules.length === result.size &&
      result.modules.every((row) => row.length === result.size);
    if (!sane) {
      console.warn('[qr] self-test produced an unexpected shape', {
        size: result.size,
        version: result.version,
      });
    }
  } catch (err) {
    console.warn('[qr] self-test failed:', err instanceof Error ? err.message : String(err));
  }
}
