#!/usr/bin/env node
// OPTIONAL font vendoring tool — NOT run by CI and NOT required.
//
// The site ships with system font stacks and works fully offline. Running
// this script additionally vendors Roboto Flex + Noto Sans HK into
// site/assets/fonts/ so the site can use them when present (styles.css loads
// fonts.css only if you add the <link>; the fallback stays graceful either way).
//
// What this does that a naive fetch does not:
//   * Sends a MODERN BROWSER User-Agent so Google Fonts answers with the full
//     woff2 @font-face set — every weight, style, and unicode-range subset.
//     A plain fetch gets one legacy file and silently drops whole scripts.
//   * Downloads EVERY file the CSS references, preserving each block's
//     font-weight / font-style / unicode-range exactly, rewriting only src.
//   * Records SHA-256 per downloaded file in MANIFEST.json.
//   * Fails loudly naming the URL and HTTP status on any miss — a partial
//     font set must never look like a complete one.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'site', 'assets', 'fonts');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CSS_URL =
  'https://fonts.googleapis.com/css2' +
  '?family=Roboto+Flex:opsz,wght@8..144,100..1000' +
  '&family=Noto+Sans+HK:wght@100..900' +
  '&display=swap';

async function fail(url, status) {
  console.error(`fetch-fonts FAILED\n  url: ${url}\n  status: ${status || 'network error'}\nRefusing to ship a partial font set.`);
  process.exit(1);
}

const cssRes = await fetch(CSS_URL, { headers: { 'User-Agent': UA } });
if (!cssRes.ok) await fail(CSS_URL, cssRes.status);
const css = await cssRes.text();

fs.mkdirSync(OUT, { recursive: true });

// Split into @font-face blocks and download every url(...) reference.
const blocks = css.match(/\/\*[^*]+\*\/\s*@font-face\s*\{[\s\S]*?\}/g) ||
  css.match(/@font-face\s*\{[\s\S]*?\}/g) || [];
if (!blocks.length) await fail(CSS_URL, 'no @font-face blocks in response');

const manifestFiles = [];
let index = 0;
const outCss = [];

for (const block of blocks) {
  const urlMatch = block.match(/url\((https:[^)]+)\)/);
  if (!urlMatch) { outCss.push(block); continue; }
  const remote = urlMatch[1];
  const res = await fetch(remote, { headers: { 'User-Agent': UA } });
  if (!res.ok) await fail(remote, res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = path.extname(new URL(remote).pathname) || '.woff2';
  const family = (block.match(/font-family:\s*'([^']+)'/) || [, 'font'])[1].replace(/\s+/g, '');
  const weight = (block.match(/font-weight:\s*([^;]+);/) || [, 'normal'])[1].trim().replace(/\s+/g, '-');
  const sha = createHash('sha256').update(buf).digest('hex');
  const name = `${family}-${weight}-${index}${ext}`;
  fs.writeFileSync(path.join(OUT, name), buf);
  manifestFiles.push({ file: name, sha256: sha, bytes: buf.length, sourceUrl: remote });
  // Rewrite ONLY src; keep font-weight/style/stretch/unicode-range verbatim.
  outCss.push(block.replace(/src:\s*url\([^)]+\)\s*format\('woff2'\);?/,
    `src: url('./${name}') format('woff2');`));
  index++;
}

fs.writeFileSync(path.join(OUT, 'fonts.css'), `/* Vendored by scripts/fetch-fonts.mjs — ${index} files. Do not edit by hand. */\n` + outCss.join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify({
  fetchedAt: new Date().toISOString(),
  cssSource: CSS_URL,
  userAgentSent: UA,
  files: manifestFiles,
}, null, 2) + '\n');

console.log(`Vendored ${index} font files + fonts.css + MANIFEST.json into site/assets/fonts/`);
console.log('This is an optional enhancement; the site falls back to system stacks without it.');
