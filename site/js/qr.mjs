// Self-contained QR encoder: byte mode, versions 1-7, ECC level M, best-mask
// selection by penalty scoring, rendered onto a canvas. No network and no
// third-party service — an otpauth secret never leaves this page's memory.

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
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenPoly(deg) {
  let poly = [1]; // ascending powers
  for (let i = 0; i < deg; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gmul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGenPoly(ecLen); // gen[0] is x^0 coefficient after reversal below
  // Standard LFSR division with descending-order generator:
  const g = [...gen].reverse();
  const rem = new Uint8Array(ecLen);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    if (factor) for (let i = 0; i < ecLen; i++) rem[i] ^= gmul(g[i + 1], factor);
  }
  return [...rem];
}

// ECC level M block structure: version -> list of [blockCount, totalCw, dataCw]
const BLOCKS_M = {
  1: [[1, 26, 16]], 2: [[1, 44, 28]], 3: [[1, 70, 44]],
  4: [[2, 50, 32]], 5: [[2, 67, 43]], 6: [[4, 43, 27]], 7: [[4, 49, 31]],
};
const ALIGN_CENTERS = { 1: [], 2: [18], 3: [22], 4: [26], 5: [30], 6: [34], 7: [38] };

function capacityBytes(version) {
  let totalData = 0;
  for (const [, , dataCw] of BLOCKS_M[version]) totalData += dataCw * BLOCKS_M[version].filter((b) => b[2] === dataCw).length;
  // The line above double-counts when two block groups share a size; compute plainly:
  totalData = 0;
  for (const [count, , dataCw] of BLOCKS_M[version]) totalData += count * dataCw;
  return totalData - 2; // mode(4b)+length(8b) overhead rounded down to bytes
}

function baseMatrix(version) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));

  function finder(r0, c0) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r; const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        m[rr][cc] = 0; // separators default light
      }
    }
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        m[r0 + r][c0 + c] = ring !== 2 ? 1 : 0; // dark outer ring, light middle, dark core
      }
    }
  }
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  for (const a of ALIGN_CENTERS[version]) {
    const ar = size - 7; // alignment row anchor used by versions 2-6 pattern tables
    void ar;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const ring = Math.max(Math.abs(dr), Math.abs(dc));
        m[a][a] ??= null;
        m[a + dr][a + dc] = ring === 1 ? 0 : 1;
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    m[6][i] = i % 2 === 0 ? 1 : 0;
    m[i][6] = i % 2 === 0 ? 1 : 0;
  }
  m[size - 8][8] = 1; // dark module

  return { m, size };
}

function maskBit(maskId, r, c) {
  switch (maskId % 8) {
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

function placeDataBits(m, size, codewords, maskId) {
  const bits = [];
  for (const b of codewords) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  let bi = 0;
  let col = size - 1;
  let upward = true;
  while (col > 0 && bi < bits.length) {
    if (col === 6) col--; // skip timing column
    for (let step = 0; step < size && bi < bits.length; step++) {
      const row = upward ? size - 1 - step : step;
      for (const c of [col, col - 1]) {
        if (m[row]?.[c] !== null) continue;
        const bit = bi < bits.length ? bits[bi++] : 0;
        m[row][c] = maskBit(maskId, row, c) ? bit ^ 1 : bit;
      }
    }
    upward = !upward;
    col -= 2;
  }
}

function drawFormat(m, size, maskId) {
  // ECC level M -> format data bits 00.
  const data = (0b00 << 3) | maskId;
  let rem = data << 10;
  const gen = 0b10100110111;
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= gen << (i - 10);
  const fmt = ((data << 10) | rem) ^ 0b101010000010010;
  const bits = [];
  for (let i = 14; i >= 0; i--) bits.push((fmt >> i) & 1);
  const put = (r, c, v) => { m[r][c] = v; };
  for (let i = 0; i < 15; i++) {
    if (i < 6) put(i, 8, bits[i]);
    else if (i === 6) put(7, 8, bits[i]);
    else if (i === 7) put(8, 8, bits[i]);
    else if (i === 8) put(8, 7, bits[i]);
    else put(8, 14 - i, bits[i]);
    if (i < 8) put(8, size - 1 - i, bits[14 - i]);
    else put(size - 15 + i, 8, bits[14 - i]);
  }
}

function penalty(m, size) {
  let p = 0;
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i < size; i++) {
      let run = 1;
      let prev = null;
      for (let j = 0; j < size; j++) {
        const v = axis === 0 ? m[i][j] : m[j][i];
        if (v === prev && v !== null) {
          run++;
          if (run === 5) p += 3; else if (run > 5) p += 1;
        } else { run = 1; prev = v; }
      }
    }
  }
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matchAt = (get) => {
    for (let i = 0; i < size; i++) {
      for (let j = 0; j <= size - 11; j++) {
        let a = true; let b = true;
        for (let k = 0; k < 11; k++) {
          if (get(i, j + k) !== pat1[k]) a = false;
          if (get(i, j + k) !== pat2[k]) b = false;
          if (!a && !b) break;
        }
        if (a || b) p += 40;
      }
    }
  };
  matchAt((i, j) => m[i][j]);
  matchAt((i, j) => m[j][i]);
  let dark = 0;
  for (const row of m) for (const v of row) if (v === 1) dark++;
  const pct = (dark * 100) / (size * size);
  p += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return p;
}

export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];
  const version = Object.keys(BLOCKS_M).map(Number).sort((a, b) => a - b)
    .find((v) => capacityBytes(v) >= bytes.length);
  if (!version) throw new Error('payload exceeds embedded encoder capacity');

  const cap = capacityBytes(version) + 2;
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);                       // byte mode
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, cap * 8 - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  const pads = [0xec, 0x11];
  let pi = 0;
  while (bits.length < cap * 8) push(pads[pi++ % 2], 8);

  const dataCodewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k];
    dataCodewords.push(b);
  }

  const groups = [];
  const ecAll = [];
  let offset = 0;
  for (const [count, totalCw, dataCw] of BLOCKS_M[version]) {
    for (let n = 0; n < count; n++) {
      const d = dataCodewords.slice(offset, offset + dataCw);
      offset += dataCw;
      groups.push(d);
      ecAll.push(rsEncode(d, totalCw - dataCw));
    }
  }
  const interleaved = [];
  const maxD = Math.max(...groups.map((g) => g.length));
  for (let i = 0; i < maxD; i++) for (const g of groups) if (i < g.length) interleaved.push(g[i]);
  const maxE = Math.max(...ecAll.map((e) => e.length));
  for (let i = 0; i < maxE; i++) for (const e of ecAll) if (i < e.length) interleaved.push(e[i]);

  let best = null;
  let bestP = Infinity;
  for (let maskId = 0; maskId < 8; maskId++) {
    const { m, size } = baseMatrix(version);
    placeDataBits(m, size, interleaved, maskId);
    drawFormat(m, size, maskId);
    const p = penalty(m, size);
    if (p < bestP) { bestP = p; best = m; }
  }
  return best;
}

export function drawQr(canvas, text, scale = 6, quiet = 4) {
  const m = qrMatrix(text);
  const size = m.length;
  canvas.width = canvas.height = (size + quiet * 2) * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111111';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (m[r][c] === 1) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
}
