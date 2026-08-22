#!/usr/bin/env node
// Generates social-preview.png (1280x640) for Open Graph / Discord embeds.
//
// Zero-dependency: draws everything procedurally and encodes the PNG with
// Node's built-in zlib, so this runs on a bare checkout without `npm ci`.
//
// Outputs TWO byte-identical copies:
//   ./social-preview.png            (repository root, master for manual upload)
//   ./site/social-preview.png       (served copy referenced by og:image)
// and exits non-zero if the two copies ever differ.
//
// Usage: node scripts/gen-social-preview.mjs [--out-root DIR] [--out-site DIR]

import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const OUT_ROOT = path.resolve(ROOT, argValue('--out-root', '.'));
const OUT_SITE = path.resolve(ROOT, argValue('--out-site', 'site'));

const W = 1280;
const H = 640;
const SS = 2; // supersample factor for anti-aliasing
const SW = W * SS;
const SH = H * SS;

// ---------------------------------------------------------------------------
// Vector helpers — everything is rendered through one distance accumulator so
// edges come out smooth at any scale.
// ---------------------------------------------------------------------------

function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 === 0 ? 0 : (wx * vx + wy * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const dx = wx - t * vx;
  const dy = wy - t * vy;
  return Math.hypot(dx, dy);
}

function roundedRectDist(x, y, rx, ry, rw, rh, rad) {
  const qx = Math.abs(x - (rx + rw / 2)) - (rw / 2 - rad);
  const qy = Math.abs(y - (ry + rh / 2)) - (rh / 2 - rad);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - rad;
}

// ---------------------------------------------------------------------------
// Monoline glyph set. Coordinates: baseline at y=0, y grows downward,
// cap height 700 units upward (-700). Strokes are polylines, `c` entries are
// stroked circles [cx, cy, r], `d` entries are filled discs [cx, cy, r].
// ---------------------------------------------------------------------------

const GLYPHS = {
  ' ': { adv: 300 },
  A: { adv: 640, s: [[[40, 0], [320, -700], [600, 0]], [[160, -240], [480, -240]]] },
  b: { adv: 600, s: [[[122, -720], [122, 0]]], c: [[303, -355, 168]] },
  D: { adv: 720, s: [[[60, 0], [60, -700], [330, -700], [505, -535], [505, -165], [330, 0], [60, 0]]] },
  e: { adv: 560, s: [[[68, -350], [398, -350]]], c: [[233, -352, 172]] },
  f: { adv: 400, s: [[[332, -560], [256, -652], [166, -608], [166, -468], [166, 0]], [[56, -520], [296, -520]]] },
  g: { adv: 600, c: [[245, -350, 172]], s: [[[417, -522], [417, 82], [328, 158], [212, 136]]] },
  i: { adv: 270, s: [[[135, 0], [135, -520]]], d: [[135, -662, 54]] },
  I: { adv: 300, s: [[[150, 0], [150, -700]]] },
  l: { adv: 280, s: [[[140, -720], [140, 0]]] },
  M: { adv: 880, s: [[[40, 0], [40, -700], [440, -255], [840, -700], [840, 0]]] },
  n: { adv: 610, s: [[[126, 0], [126, -520], [126, -362], [212, -486], [332, -486], [394, -368], [394, 0]]] },
  o: { adv: 600, c: [[300, -352, 172]] },
  p: { adv: 600, s: [[[122, 0], [122, -680]]], c: [[296, -368, 174]] },
  P: { adv: 640, s: [[[60, 0], [60, -700], [350, -700], [468, -622], [468, -472], [350, -398], [60, -398]]] },
  r: { adv: 430, s: [[[132, 0], [132, -520], [132, -378], [228, -468], [348, -424]]] },
  R: { adv: 690, s: [[[60, 0], [60, -700], [352, -700], [476, -628], [476, -478], [358, -404], [60, -404]], [[358, -404], [566, 0]]] },
  s: { adv: 520, s: [[[422, -552], [344, -646], [204, -656], [96, -568], [132, -458], [330, -274], [386, -148], [284, -38], [146, -44], [76, -134]]] },
  t: { adv: 420, s: [[[192, -640], [192, -72], [276, 0], [372, -46]], [[86, -540], [322, -540]]] },
  v: { adv: 570, s: [[[56, -520], [285, 0], [514, -520]]] },
  x: { adv: 570, s: [[[62, -520], [508, 0]], [[508, -520], [62, 0]]] },
  3: { adv: 570, s: [[[98, -606], [188, -694], [330, -660], [350, -528], [246, -436], [356, -330], [336, -134], [182, -40], [72, -150]]] },
};

function measure(text, size) {
  const scale = size / 700;
  let w = 0;
  for (const ch of text) w += ((GLYPHS[ch] ? GLYPHS[ch].adv : 500) + 60) * scale;
  return w;
}

// Draws text as monoline strokes: min distance to segments/rings/discs -> coverage.
function drawText(buf, text, x, y, capPx, hwPx, r, g, b, alpha) {
  const scale = capPx / 700;
  const hw = Math.max(hwPx, 0.9);
  let pen = x;
  for (const ch of text) {
    const gl = GLYPHS[ch];
    if (!gl) { pen += 560 * scale; continue; }
    const adv = (gl.adv + 60) * scale;
    const segs = [];
    const rings = [];
    const discs = [];
    if (gl.s) for (const pl of gl.s) {
      const abs = pl.map((p) => [pen + p[0] * scale, y + p[1] * scale]);
      for (let i = 0; i < abs.length - 1; i++) segs.push([abs[i], abs[i + 1]]);
    }
    if (gl.c) for (const c of gl.c) rings.push([pen + c[0] * scale, y + c[1] * scale, c[2] * scale]);
    if (gl.d) for (const d of gl.d) discs.push([pen + d[0] * scale, y + d[1] * scale, d[2] * scale]);

    const pad = hw + 4;
    const ix0 = Math.max(0, Math.floor(pen - pad));
    const ix1 = Math.min(SW - 1, Math.ceil(pen + adv + pad));
    const iy0 = Math.max(0, Math.floor(y - 780 * scale - pad));
    const iy1 = Math.min(SH - 1, Math.ceil(y + 240 * scale + pad));
    const aa = 1.35 * SS;
    for (let py = iy0; py <= iy1; py++) {
      const fy = py + 0.5;
      for (let px = ix0; px <= ix1; px++) {
        const fx = px + 0.5;
        let d = Infinity;
        for (const sg of segs) {
          d = Math.min(d, segDist(fx, fy, sg[0][0], sg[0][1], sg[1][0], sg[1][1]));
          if (d < -1) break;
        }
        for (const rg of rings) {
          d = Math.min(d, Math.abs(Math.hypot(fx - rg[0], fy - rg[1]) - rg[2]));
        }
        let cov = Math.max(0, Math.min(1, (hw + aa / 2 - d) / aa));
        for (const dc of discs) {
          const dd = Math.hypot(fx - dc[0], fy - dc[1]);
          cov = Math.max(cov, Math.max(0, Math.min(1, (dc[2] + aa / 2 - dd) / aa)));
        }
        if (cov > 0) blend(buf, px, py, r, g, b, alpha * cov);
      }
    }
    pen += adv;
  }
  return pen;
}

function blend(buf, x, y, r, g, b, a) {
  const i = (y * SW + x) * 4;
  const ia = buf[i + 3] / 255;
  const na = a + ia * (1 - a);
  if (na <= 0) return;
  buf[i] = Math.round((r * a + buf[i] * ia * (1 - a)) / na);
  buf[i + 1] = Math.round((g * a + buf[i + 1] * ia * (1 - a)) / na);
  buf[i + 2] = Math.round((b * a + buf[i + 2] * ia * (1 - a)) / na);
  buf[i + 3] = Math.round(na * 255);
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }

function render() {
  const buf = Buffer.alloc(SW * SH * 4);

  // Diagonal gradient: deep red (top-left) -> coral (bottom-right).
  const c0 = hex('#6d0f1f');
  const c1 = hex('#ff7a59');
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      let t = (x / SW + y / SH) / 2;
      t = t * t * (3 - 2 * t); // smoothstep for a richer falloff
      const i = (y * SW + x) * 4;
      buf[i] = Math.round(c0[0] + (c1[0] - c0[0]) * t);
      buf[i + 1] = Math.round(c0[1] + (c1[1] - c0[1]) * t);
      buf[i + 2] = Math.round(c0[2] + (c1[2] - c0[2]) * t);
      buf[i + 3] = 255;
    }
  }

  // Soft decorative circles for depth (subtle, behind the mark).
  for (const [cx, cy, rad, col] of [
    [SW * 0.82, SH * 0.18, SW * 0.30, hex('#ffffff')],
    [SW * 0.12, SH * 0.88, SW * 0.26, hex('#3d0812')],
  ]) {
    const aa = 1.5 * SS;
    const ix0 = Math.max(0, Math.floor(cx - rad - aa));
    const ix1 = Math.min(SW - 1, Math.ceil(cx + rad + aa));
    const iy0 = Math.max(0, Math.floor(cy - rad - aa));
    const iy1 = Math.min(SH - 1, Math.ceil(cy + rad + aa));
    for (let py = iy0; py <= iy1; py++) {
      for (let px = ix0; px <= ix1; px++) {
        const d = Math.hypot(px + 0.5 - cx, py + 0.5 - cy);
        const cov = Math.max(0, Math.min(1, (rad + aa / 2 - d) / aa)) * 0.07;
        if (cov > 0) blend(buf, px, py, col[0], col[1], col[2], cov);
      }
    }
  }

  // Abstract rounded-bar "M" mark: tall / short / tall bars + yellow dot.
  const barW = 74 * SS;
  const gap = 40 * SS;
  const bottom = 372 * SS;
  const bars = [
    { x: 0, top: 128 },   // left stem
    { x: 1, top: 264 },   // valley
    { x: 2, top: 128 },   // right stem
  ];
  const totalW = bars.length * barW + (bars.length - 1) * gap;
  const mx0 = (SW - totalW) / 2;
  const aa = 1.5 * SS;
  for (const bar of bars) {
    const rx = mx0 + bar.x * (barW + gap);
    const ry = bar.top * SS;
    const rh = bottom - ry;
    const rad = barW / 2;
    const ix0 = Math.max(0, Math.floor(rx - aa));
    const ix1 = Math.min(SW - 1, Math.ceil(rx + barW + aa));
    const iy0 = Math.max(0, Math.floor(ry - aa));
    const iy1 = Math.min(SH - 1, Math.ceil(bottom + aa));
    for (let py = iy0; py <= iy1; py++) {
      for (let px = ix0; px <= ix1; px++) {
        const d = roundedRectDist(px + 0.5, py + 0.5, rx, ry, barW, rh, rad);
        const cov = Math.max(0, Math.min(1, (aa / 2 - d) / aa));
        if (cov > 0) blend(buf, px, py, 255, 255, 255, cov);
      }
    }
  }
  // Yellow dot riding the top-right of the mark.
  {
    const cx = mx0 + totalW + 26 * SS;
    const cy = 118 * SS;
    const rad = 30 * SS;
    const ix0 = Math.max(0, Math.floor(cx - rad - aa));
    const ix1 = Math.min(SW - 1, Math.ceil(cx + rad + aa));
    const iy0 = Math.max(0, Math.floor(cy - rad - aa));
    const iy1 = Math.min(SH - 1, Math.ceil(cy + rad + aa));
    for (let py = iy0; py <= iy1; py++) {
      for (let px = ix0; px <= ix1; px++) {
        const d = Math.hypot(px + 0.5 - cx, py + 0.5 - cy);
        const cov = Math.max(0, Math.min(1, (rad + aa / 2 - d) / aa));
        if (cov > 0) blend(buf, px, py, 255, 213, 79, cov);
      }
    }
  }

  // Wordmark + subtitle, centred.
  const wordmark = 'Material Roblox';
  const wmCap = 118 * SS;
  const wmWidth = measure(wordmark, wmCap);
  drawTextProper(buf, wordmark, (SW - wmWidth) / 2, 512 * SS, wmCap, 13.5 * SS, 255, 255, 255, 1);

  const subtitle = 'Material Design 3 explorer for Roblox APIs';
  const subCap = 40 * SS;
  const subWidth = measure(subtitle, subCap);
  drawTextProper(buf, subtitle, (SW - subWidth) / 2, 582 * SS, subCap, 4.6 * SS, 255, 232, 222, 0.92);

  // Corner badge: rounded pill + org name + yellow dot.
  const badgeText = 'Ding-Ding-Projects';
  const bCap = 26 * SS;
  const bw = measure(badgeText, bCap);
  const padX = 22 * SS;
  const pillW = bw + padX * 2 + 34 * SS;
  const pillH = 52 * SS;
  const pxr = SW - pillW - 36 * SS;
  const pyr = H * SS - pillH - 32 * SS;
  {
    // Pill outline.
    const ix0 = Math.max(0, Math.floor(pxr - aa));
    const ix1 = Math.min(SW - 1, Math.ceil(pxr + pillW + aa));
    const iy0 = Math.max(0, Math.floor(pyr - aa));
    const iy1 = Math.min(SH - 1, Math.ceil(pyr + pillH + aa));
    for (let py = iy0; py <= iy1; py++) {
      for (let px = ix0; px <= ix1; px++) {
        const d = Math.abs(roundedRectDist(px + 0.5, py + 0.5, pxr, pyr, pillW, pillH, pillH / 2));
        const cov = Math.max(0, Math.min(1, (2 * SS + aa / 2 - d) / aa)) * 0.85;
        if (cov > 0) blend(buf, px, py, 255, 255, 255, cov);
      }
    }
    // Dot + label.
    const dcx = pxr + padX + 12 * SS;
    const dcy = pyr + pillH / 2;
    for (let py = Math.max(0, Math.floor(dcy - 14 * SS)); py <= Math.min(SH - 1, Math.ceil(dcy + 14 * SS)); py++) {
      for (let px2 = Math.max(0, Math.floor(dcx - 14 * SS)); px2 <= Math.min(SW - 1, Math.ceil(dcx + 14 * SS)); px2++) {
        const d = Math.hypot(px2 + 0.5 - dcx, py + 0.5 - dcy);
        const cov = Math.max(0, Math.min(1, (12 * SS + aa / 2 - d) / aa));
        if (cov > 0) blend(buf, px2, py, 255, 213, 79, cov);
      }
    }
    drawTextProper(buf, badgeText, pxr + padX + 34 * SS, pyr + pillH / 2 + bCap * 0.36, bCap, 3.1 * SS, 255, 255, 255, 0.95);
  }

  // Downsample SS×SS -> final RGBA.
  const out = Buffer.alloc(W * H * 4);
  const inv = 1 / (SS * SS);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * SW + (x * SS + sx)) * 4;
          const al = buf[i + 3] / 255;
          r += buf[i] * al; g += buf[i + 1] * al; b += buf[i + 2] * al; a += al;
        }
      }
      const o = (y * W + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round(Math.min(1, a * inv) * 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PNG encoding (colour type 6, 8-bit, filter 0)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const png = encodePng(render(), W, H);
fs.mkdirSync(OUT_SITE, { recursive: true });
const rootPath = path.join(OUT_ROOT, 'social-preview.png');
const sitePath = path.join(OUT_SITE, 'social-preview.png');
fs.writeFileSync(rootPath, png);
fs.writeFileSync(sitePath, png);

const a = fs.readFileSync(rootPath);
const b = fs.readFileSync(sitePath);
if (!a.equals(b)) {
  console.error('social-preview copies differ — refusing to finish');
  process.exit(1);
}
console.log(`social-preview.png written (${png.length} bytes):\n  ${rootPath}\n  ${sitePath}\nCopies verified byte-identical.`);
