#!/usr/bin/env node
/**
 * Rasterize the brand mark and assemble a true multi-resolution .ico.
 *
 * The geometry here is the SAME math as assets/logo.svg (gradient tile,
 * three rounded bars, accent dot) - one source of truth, drawn twice.
 *
 * Outputs (build/icons/):
 *   icon-16.png ... icon-256.png, icon.png (512), icon.ico
 *     - ico entries: 16/32/48 as 32-bit BMP-with-alpha (double-height header
 *       plus AND mask) and 256 as an embedded PNG entry, per the ICONDIR spec.
 *
 * Every output is verified: exists, non-empty, and the largest PNG decodes.
 * Requires devDependencies: pngjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(scriptDir, '..', 'build', 'icons');

/* ------------------------- Geometry (matches logo.svg) -------------------- */

const CANVAS = 512;
const TILE = { x: 32, y: 32, size: 448, radius: 96 };
// Rounded bars of varying width forming the stylized M silhouette.
const BARS = [
  { x: 112, y: 152, w: 224, h: 48, r: 24 },
  { x: 176, y: 232, w: 176, h: 48, r: 24 },
  { x: 112, y: 312, w: 120, h: 48, r: 24 },
];
const DOT = { cx: 388, cy: 132, r: 26 };

const GRADIENT_FROM = [0x8c, 0x1d, 0x18];
const GRADIENT_TO = [0xff, 0x79, 0x61];
const BAR_COLOR = [255, 255, 255];
const DOT_COLOR = [0xff, 0xc5, 0x3d];

function insideRoundedRect(px, py, rect) {
  const halfW = rect.w / 2;
  const halfH = rect.h / 2;
  const centerX = rect.x + halfW;
  const centerY = rect.y + halfH;
  const innerR = rect.r;
  const qx = Math.max(Math.abs(px - centerX) - (halfW - innerR), 0);
  const qy = Math.max(Math.abs(py - centerY) - (halfH - innerR), 0);
  return Math.hypot(qx, qy) <= innerR;
}

function insideTile(px, py) {
  return insideRoundedRect(px, py, {
    x: TILE.x,
    y: TILE.y,
    w: TILE.size,
    h: TILE.size,
    r: TILE.radius,
  });
}

function gradientAt(px, py) {
  const t = Math.min(1, Math.max(0, (px + py) / (CANVAS * 2)));
  return [
    Math.round(GRADIENT_FROM[0] + (GRADIENT_TO[0] - GRADIENT_FROM[0]) * t),
    Math.round(GRADIENT_FROM[1] + (GRADIENT_TO[1] - GRADIENT_FROM[1]) * t),
    Math.round(GRADIENT_FROM[2] + (GRADIENT_TO[2] - GRADIENT_FROM[2]) * t),
  ];
}

/** Sample shape membership at canvas coordinates; returns [r,g,b,a]. */
function sample(px, py) {
  if (!insideTile(px, py)) {
    return [0, 0, 0, 0];
  }
  if (Math.hypot(px - DOT.cx, py - DOT.cy) <= DOT.r) {
    return [DOT_COLOR[0], DOT_COLOR[1], DOT_COLOR[2], 255];
  }
  for (const bar of BARS) {
    if (insideRoundedRect(px, py, bar)) {
      return [BAR_COLOR[0], BAR_COLOR[1], BAR_COLOR[2], 255];
    }
  }
  const [r, g, b] = gradientAt(px, py);
  return [r, g, b, 255];
}

function render(size) {
  const png = new PNG({ width: size, height: size });
  const scale = CANVAS / size;
  const SUBSAMPLES = [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
  ];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let rAccum = 0;
      let gAccum = 0;
      let bAccum = 0;
      let aAccum = 0;
      for (const [sx, sy] of SUBSAMPLES) {
        const canvasX = (x + sx) * scale;
        const canvasY = (y + sy) * scale;
        const [r, g, b, a] = sample(canvasX, canvasY);
        rAccum += r;
        gAccum += g;
        bAccum += b;
        aAccum += a;
      }
      const count = SUBSAMPLES.length;
      const index = (y * size + x) * 4;
      png.data[index] = Math.round(rAccum / count);
      png.data[index + 1] = Math.round(gAccum / count);
      png.data[index + 2] = Math.round(bAccum / count);
      png.data[index + 3] = Math.round(aAccum / count);
    }
  }
  return png;
}

/* ------------------------------- ICO builder ------------------------------ */

/** 32-bit BMP-with-alpha entry: BITMAPINFOHEADER with doubled height + mask. */
function bmpEntry(png) {
  const { width, height, data } = png;
  const pixelBytes = width * height * 4;
  const pixels = Buffer.alloc(pixelBytes);
  // Rows stored bottom-up; RGBA input becomes BGRA output.
  for (let row = 0; row < height; row += 1) {
    const srcY = height - 1 - row;
    for (let col = 0; col < width; col += 1) {
      const srcIndex = (srcY * width + col) * 4;
      const dstIndex = (row * width + col) * 4;
      pixels[dstIndex] = data[srcIndex + 2]; // B
      pixels[dstIndex + 1] = data[srcIndex + 1]; // G
      pixels[dstIndex + 2] = data[srcIndex]; // R
      pixels[dstIndex + 3] = data[srcIndex + 3]; // A
    }
  }

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(width, 4); // biWidth
  header.writeInt32LE(height * 2, 8); // biHeight: XOR + AND masks
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  header.writeUInt32LE(pixelBytes, 20); // biSizeImage
  // Remaining fields stay zero.

  // All-opaque alpha means the AND mask is all zeros. Rows pad to 32 bits.
  const maskRowBytes = Math.ceil(width / 32) * 4;
  const mask = Buffer.alloc(maskRowBytes * height);

  return Buffer.concat([header, pixels, mask]);
}

function buildIco(entries) {
  // entries: [{size, png | rawPng}]
  const imageCount = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(imageCount, 4);

  let offset = 6 + imageCount * 16;
  const directoryChunks = [];
  const imageChunks = [];
  for (const entry of entries) {
    const image = entry.rawPng ? entry.rawPng : bmpEntry(entry.png);
    const dirEntry = Buffer.alloc(16);
    dirEntry.writeUInt8(entry.size >= 256 ? 0 : entry.size, 0); // width (0 = 256)
    dirEntry.writeUInt8(entry.size >= 256 ? 0 : entry.size, 1); // height
    dirEntry.writeUInt8(0, 2); // palette count
    dirEntry.writeUInt8(0, 3); // reserved
    dirEntry.writeUInt16LE(1, 4); // planes
    dirEntry.writeUInt16LE(32, 6); // bit count
    dirEntry.writeUInt32LE(image.length, 8);
    dirEntry.writeUInt32LE(offset, 12);
    offset += image.length;
    directoryChunks.push(dirEntry);
    imageChunks.push(image);
  }

  return Buffer.concat([header, ...directoryChunks, ...imageChunks]);
}

/* ---------------------------------- Main ---------------------------------- */

function main() {
  console.log('[gen-icons] Rendering brand mark...');
  fs.mkdirSync(outDir, { recursive: true });

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  /** @type {Map<number, import('pngjs').PNG>} */
  const rendered = new Map();

  for (const size of sizes) {
    const png = render(size);
    const file = path.join(outDir, 'icon-' + size + '.png');
    fs.writeFileSync(file, PNG.sync.write(png));
    rendered.set(size, png);
  }

  const masterPng = render(512);
  const masterFile = path.join(outDir, 'icon.png');
  fs.writeFileSync(masterFile, PNG.sync.write(masterPng));

  const icoEntries = [16, 32, 48].map((size) => ({ size, png: rendered.get(size) }));
  const png256 = fs.readFileSync(path.join(outDir, 'icon-256.png'));
  icoEntries.push({ size: 256, rawPng: png256 });
  const icoPath = path.join(outDir, 'icon.ico');
  fs.writeFileSync(icoPath, buildIco(icoEntries));

  // Verify every artifact honestly: existence, non-empty, decode round-trip.
  const rows = [];
  for (const size of sizes) {
    const file = path.join(outDir, 'icon-' + size + '.png');
    const stat = fs.statSync(file);
    PNG.sync.read(fs.readFileSync(file)); // throws when undecodable
    rows.push({ file: path.basename(file), bytes: stat.size, ok: stat.size > 0 });
  }
  const masterStat = fs.statSync(masterFile);
  PNG.sync.read(fs.readFileSync(masterFile));
  rows.push({ file: path.basename(masterFile), bytes: masterStat.size, ok: masterStat.size > 0 });

  const icoStat = fs.statSync(icoPath);
  rows.push({ file: path.basename(icoPath), bytes: icoStat.size, ok: icoStat.size > 1000 });

  console.table(rows);

  const failed = rows.filter((row) => !row.ok);
  if (failed.length > 0) {
    console.error('[gen-icons] Verification FAILED for:', failed.map((row) => row.file).join(', '));
    process.exit(1);
  }
  console.log('[gen-icons] All outputs verified.');
}

main();
