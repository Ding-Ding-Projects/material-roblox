#!/usr/bin/env node
// Builds site/changelog.json from git tags and the commits between them.
//
// Output shape:
// {
//   "generatedAt": "<ISO>",
//   "source": "git tags",
//   "repo": "https://github.com/Ding-Ding-Projects/material-roblox",
//   "versions": [
//     { "version":"1.0.0-build.7", "tag":"v1.0.0-build.7", "date":"...",
//       "dish":"Classic Har Gow · 蝦餃"?,
//       "commits":[{ "sha":"...", "subject":"...", "date":"..." }] }
//   ]
// }
//
// The dish name is picked up from an annotated tag message line starting
// with "Code name:" when present (the release workflow annotates nothing by
// default; release notes live on GitHub Releases, so this stays best-effort).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'site', 'changelog.json');
const REPO_URL = 'https://github.com/Ding-Ding-Projects/material-roblox';

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function versionKey(tag) {
  const m = tag.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-build\.(\d+))?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? Number(m[4]) : -1];
}

let versions = [];
try {
  const raw = git(['tag', '--list']).split('\n').map((t) => t.trim()).filter(Boolean);
  const tags = raw
    .map((tag) => ({ tag, key: versionKey(tag) }))
    .filter((t) => t.key)
    .sort((a, b) => {
      for (let i = 0; i < 4; i++) if (a.key[i] !== b.key[i]) return b.key[i] - a.key[i];
      return b.tag.localeCompare(a.tag);
    });

  for (let i = 0; i < tags.length; i++) {
    const { tag } = tags[i];
    const prev = i + 1 < tags.length ? tags[i + 1].tag : null;
    const range = prev ? `${prev}..${tag}` : tag;
    let date = '';
    try {
      date = git(['log', '-1', '--format=%cI', tag]).trim();
    } catch { /* keep empty */ }

    // Annotated tag message may carry the code name.
    let dish;
    try {
      const msg = git(['tag', '-l', '--format=%(contents)', tag]);
      const m = msg.match(/^\s*Code name:\s*(.+)$/m);
      if (m) dish = m[1].trim();
    } catch { /* lightweight tag */ }

    let commits = [];
    try {
      const log = git(['log', range, '--format=%H%x09%s%x09%aI', '--no-merges']);
      commits = log.split('\n').filter(Boolean).map((line) => {
        const [sha, subject, d] = line.split('\t');
        return { sha, subject, date: d };
      });
    } catch { /* unreachable range */ }

    versions.push({ version: tag.replace(/^v/, ''), tag, date, ...(dish ? { dish } : {}), commits });
  }
} catch (e) {
  console.error(`[build-changelog] git unavailable or unborn history (${String(e.message).split('\n')[0]}); writing empty changelog`);
}

const out = {
  generatedAt: new Date().toISOString(),
  source: 'scripts/build-changelog.mjs over git tags',
  repo: REPO_URL,
  versions,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`changelog.json written with ${versions.length} tagged version(s)`);
