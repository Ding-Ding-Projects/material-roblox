#!/usr/bin/env node
// Computes release extras for the release workflow and writes shell-export
// style lines to a GITHUB_ENV file given as argv[2]:
//
//   TAG=v1.0.0-build.42
//   CODE_NAME=Classic Har Gow · 蝦餃
//   PHOTO_URL=https://...
//   META_WARNINGS=<semicolon-joined notes, may be empty>
//
// Behaviour contract:
//   * The tag is always produced: v{package.json version}-build.{run number}.
//   * A dim-sum code name is decoration with a purpose — it must NEVER block
//     or delay a release. If the public catalog is unreachable, has no unused
//     dish, or the candidate photo fails its HEAD check, we fall through to
//     the next candidate and finally to version-only shipping with warnings.
//   * Each dish name is used once per project: prior release bodies are
//     scanned for "Code name:" lines and those dishes are skipped forever.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2];
const REPO = process.env.GITHUB_REPOSITORY || 'Ding-Ding-Projects/material-roblox';
const CATALOG_URL = 'https://raw.githubusercontent.com/Ding-Ding-Projects/dim-sum-photos/main/catalog/index.json';

const warnings = [];
function warn(msg) {
  warnings.push(msg);
  console.error(`[release-meta] warning: ${msg}`);
}

function pkgVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    warn('package.json unreadable; falling back to 0.0.0');
    return '0.0.0';
  }
}

async function fetchCatalog() {
  const res = await fetch(CATALOG_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
  const json = await res.json();
  // Defensive shape handling: accept {dishes:[...]} or a bare array.
  const list = Array.isArray(json) ? json : json.dishes || json.items || [];
  // Photos live as release ASSETS named after image.path's basename, split
  // across the catalog-v1* releases. Build every candidate URL; the HEAD
  // check below decides which one actually serves bytes.
  const PHOTO_TAGS = ['catalog-v1', 'catalog-v1-part-002', 'catalog-v1-part-003'];
  const out = [];
  for (const d of list) {
    const en = d?.name?.en;
    const zh = d?.name?.zhHant || d?.name?.zh || '';
    const relPath = typeof d?.image?.path === 'string' ? d.image.path : '';
    const base = relPath ? relPath.split('/').pop() : '';
    if (!en || !base) continue;
    out.push({
      en,
      zh,
      photo: PHOTO_TAGS.map((tag) =>
        `https://github.com/Ding-Ding-Projects/dim-sum-photos/releases/download/${tag}/${encodeURIComponent(base)}`),
    });
  }
  out.sort((a, b) => a.en.localeCompare(b.en, 'en'));
  return out;
}

function priorCodeNames() {
  const used = new Set();
  const run = (args, useStdout = true) => {
    try {
      return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      warn(`gh ${args[0]} failed: ${String(e.message).split('\n')[0]}`);
      return '';
    }
  };
  const scanBodies = (text) => {
    for (const m of text.matchAll(/^\s*Code name:\s*(.+)$/gim)) {
      // Keep only the dish part before any separator commentary.
      used.add(m[1].trim());
    }
  };
  // gh's `release list` rejects a `body` field on some CLI versions; the
  // REST API path is stable and returns bodies directly.
  scanBodies(run(['api', `repos/${REPO}/releases`, '--paginate', '--jq', '.[].body']));
  return used;
}

async function headOk(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  const version = pkgVersion();
  const runNumber = process.env.GITHUB_RUN_NUMBER || '0';
  const tag = `v${version}-build.${runNumber}`;

  let codeName = '';
  let photoUrl = '';

  try {
    const dishes = await fetchCatalog();
    if (!dishes.length) warn('catalog resolved but contains no dishes with published photos');
    else {
      const used = priorCodeNames();
      const normalize = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
      const usedNorm = new Set([...used].map(normalize));
      for (const d of dishes) {
        const label = d.zh ? `${d.en} · ${d.zh}` : d.en;
        const candidates = [label, d.en].map(normalize);
        if (candidates.some((c) => usedNorm.has(c))) continue;
        let live = null;
        for (const candidateUrl of d.photo) {
          if (await headOk(candidateUrl)) { live = candidateUrl; break; }
        }
        if (live) {
          codeName = label;
          photoUrl = live;
          break;
        }
        warn(`candidate "${d.en}" photo not reachable (HEAD failed); trying next`);
      }
      if (!codeName) warn('no unused dish with a reachable published photo — shipping version-only code name');
    }
  } catch (e) {
    warn(`dim-sum catalog unavailable (${String(e.message || e)}) — shipping version-only code name`);
  }

  const lines = [
    `TAG=${tag}`,
    `CODE_NAME=${codeName}`,
    `PHOTO_URL=${photoUrl}`,
    `META_WARNINGS=${warnings.join('; ').replace(/\r?\n/g, ' ')}`,
  ];
  const body = lines.join('\n') + '\n';
  if (OUT && OUT !== '-') fs.appendFileSync(OUT, body);
  else process.stdout.write(body);
  console.log(`[release-meta] tag=${tag} codeName=${codeName || '(none)'}`);
}

main();
