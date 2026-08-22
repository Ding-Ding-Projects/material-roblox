#!/usr/bin/env node
// Builds the documentation index for the site AND copies the feature docs
// into site/docs/ so the static site can render them without any build step
// at request time.
//
//  * Scans docs/features/**/*.md (category READMEs included, marked as
//    category indexes) plus docs/api-coverage.md.
//  * Extracts a title (first `# ` heading) and summary (first non-empty
//    paragraph after it, plain-text only).
//  * Copies each file to site/docs/<same relative path>, preserving the tree
//    so article-to-article relative links keep working unchanged.
//  * Rewrites any relative link that escapes the copied tree (e.g. toward the
//    repository root or another top-level folder) into an absolute GitHub URL,
//    so nothing on the served site dead-ends.
//  * Emits site/docs-index.json with categories in a stable order.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'docs');
const DEST = path.join(ROOT, 'site', 'docs');
const REPO_BLOB = 'https://github.com/Ding-Ding-Projects/material-roblox/blob/main';

const CATEGORY_ORDER = [
  'getting-started',
  'interface',
  'appearance',
  'safety',
  'personalization',
  'platform',
];

function walk(dir, base = '') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

function parseArticle(text) {
  const lines = text.split(/\r?\n/);
  let title = '';
  let summary = '';
  let afterHeading = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!title && /^#\s+/.test(line)) {
      title = line.replace(/^#\s+/, '').trim();
      afterHeading = true;
      continue;
    }
    if (afterHeading && !summary) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith('|') || /^(---|```)/.test(t)) {
        if (/^---/.test(t)) break;
        continue;
      }
      summary = t
        .replace(/[*_`>]/g, '')
        .replace(/\[(.+?)\]\(.+?\)/g, '$1')
        .slice(0, 220);
      break;
    }
  }
  return { title, summary };
}

function rewriteLinks(md, fromDirRel) {
  // Rewrite markdown links whose target resolves outside the copied tree into
  // absolute GitHub blob URLs. Links staying inside docs/ keep their relative
  // form (the copy preserves the directory structure, so they still resolve).
  return md.replace(/\]\((?!https?:|mailto:|#|\/)([^)\s]+)([^)]*)\)/g, (full, href) => {
    const clean = decodeURIComponent(href.split('#')[0]);
    if (!clean) return full;
    const resolved = path.posix.normalize(path.posix.join(fromDirRel, clean));
    if (resolved.startsWith('docs/')) return full; // stays inside the served tree
    if (/^\.\./.test(resolved)) return full; // abnormal traversal — leave untouched
    return `](${REPO_BLOB}/${resolved})`;
  });
}

function ensureInside(base, target) {
  const rel = path.relative(base, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const files = walk(SRC).sort();
if (!files.length) console.error('[build-docs-index] warning: no markdown found under docs/ — the site will show an empty article index');

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });

const categories = new Map();
for (const rel of files) {
  const srcPath = path.join(SRC, rel);
  const destPath = path.join(DEST, rel);
  if (!ensureInside(DEST, destPath)) throw new Error(`refusing unsafe copy target: ${rel}`);
  const text = fs.readFileSync(srcPath, 'utf8');
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const fromDir = path.posix.dirname(rel) === '.' ? 'docs' : path.posix.join('docs', path.posix.dirname(rel));
  fs.writeFileSync(destPath, rewriteLinks(text, fromDir));

  const isCategoryIndex = path.basename(rel) === 'README.md';
  const category = path.dirname(rel) === '.' ? 'reference' : path.dirname(rel);
  if (!categories.has(category)) categories.set(category, []);
  const { title, summary } = parseArticle(text);
  categories.get(category).push({
    id: rel.replace(/\.md$/, '').replace(/\//g, '__'),
    path: rel.replace(/\\/g, '/'),
    title: title || rel,
    summary,
    kind: isCategoryIndex ? 'index' : 'article',
  });
}

const ordered = [...categories.entries()].sort((a, b) => {
  const ia = CATEGORY_ORDER.indexOf(a[0]);
  const ib = CATEGORY_ORDER.indexOf(b[0]);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a[0].localeCompare(b[0]);
});

const index = {
  generatedAt: new Date().toISOString(),
  source: 'scripts/build-docs-index.mjs scanning docs/**/*',
  repoBlob: REPO_BLOB,
  categories: ordered.map(([id, articles]) => ({
    id,
    name: id === 'reference' ? 'Reference' : id.charAt(0).toUpperCase() + id.slice(1),
    articles,
  })),
};

fs.writeFileSync(path.join(ROOT, 'site', 'docs-index.json'), JSON.stringify(index, null, 2) + '\n');
console.log(`docs index written: ${ordered.length} categories, ${files.length} documents copied into site/docs/`);
