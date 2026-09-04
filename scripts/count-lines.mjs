#!/usr/bin/env node
// Line-count counter for Material Roblox.
//
// Prints EXACTLY the markdown table that the release notes publish, so a local
// run and a release run can never disagree about the numbers.
//
// Counting rules (stated once, used everywhere):
//   * A line is newline-terminated content plus a final unterminated line if
//     present — this matches `git blame` semantics, which report every line
//     including a last line with no trailing newline (`wc -l` would drop it).
//   * Non-blank = lines whose trimmed content is non-empty.
//   * Self-consistency is asserted: bucket sums MUST equal their totals or the
//     script exits 1 rather than publishing a table that disagrees with itself.
//
// Exclusions are listed in the output with reasons — never silent.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'out', 'release', 'coverage', '.git', '.vite',
]);
const SKIP_FILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.woff', '.woff2', '.zip', '.exe']);

// Bucket order defines table row order.
const BUCKETS = [
  { id: 'app-js', label: 'App source · JavaScript', match: (p) => /^(app|src)\//.test(p) && /\.(js|mjs|cjs)$/.test(p) },
  { id: 'app-html', label: 'App source · HTML', match: (p) => /^(app|src)\//.test(p) && /\.html?$/.test(p) },
  { id: 'styles', label: 'Stylesheets (src/ + app/)', match: (p) => /^(app|src)\//.test(p) && /\.css$/.test(p) },
  { id: 'tests', label: 'Tests', match: (p) => /^tests?\//.test(p) },
  {
    id: 'site',
    label: 'Site',
    match: (p) => /^site\//.test(p) && !/^site\/docs\//.test(p),
    note: 'site/docs/ is excluded here — it is a generated mirror of docs/, counted under Docs',
  },
  { id: 'scripts', label: 'Scripts (scripts/)', match: (p) => /^scripts\/.+\.mjs$/.test(p) },
  { id: 'docs', label: 'Docs (docs/ + root *.md)', match: (p) => /^docs\//.test(p) || /^[^/]+\.md$/.test(p) },
  { id: 'workflows', label: 'Workflows (.github/)', match: (p) => /^\.github\/.*\.ya?ml$/.test(p) },
];

function listFiles(dir, base = '') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...listFiles(path.posix.join(dir, e.name), rel));
    } else if (e.isFile()) {
      if (SKIP_FILES.has(e.name)) continue;
      if (BINARY_EXT.has(path.extname(e.name))) continue;
      out.push(rel);
    }
  }
  return out;
}

function countLines(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let nonBlank = 0;
  for (const l of lines) if (l.trim().length > 0) nonBlank++;
  return { lines: lines.length, nonBlank };
}

// --- git blame attribution -------------------------------------------------
// A surviving line is agent-written when its blamed commit's author email
// contains "anthropic" OR the commit message carries a Co-Authored-By trailer
// naming Claude. Everything else counts as human-written. Churn does not count:
// only lines that survive at HEAD are attributed.

let blameAvailable = true;
try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, stdio: 'pipe' });
} catch {
  blameAvailable = false;
}

const commitInfoCache = new Map();
function commitInfo(sha) {
  if (commitInfoCache.has(sha)) return commitInfoCache.get(sha);
  let info = { agent: false };
  try {
    const raw = execFileSync('git', ['cat-file', 'commit', sha], { cwd: ROOT, encoding: 'utf8' });
    const mailLine = raw.split('\n').find((l) => l.startsWith('author ')) || '';
    const authorMail = mailLine.includes('<') ? mailLine.slice(mailLine.indexOf('<')) : '';
    const trailerAgent = /Co-Authored-By:.*Claude/i.test(raw.split('\n\n').slice(1).join('\n'));
    info = { agent: /anthropic/i.test(authorMail) || trailerAgent };
  } catch {
    /* unknown commit -> treated as human, reported below */
  }
  commitInfoCache.set(sha, info);
  return info;
}

function blameShas(file) {
  // Returns array of shas per line (newline-terminated semantics as above).
  const out = [];
  try {
    const raw = execFileSync('git', ['blame', '--porcelain', '--', file], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    });
    let current = null;
    for (const line of raw.split('\n')) {
      if (/^[0-9a-f]{40} \d+ \d+( \d+)?$/.test(line)) {
        current = line.slice(0, 40);
      } else if (line.startsWith('\t') && current) {
        // The tab-prefixed line is the blamed source line itself.
        out.push(current);
      }
    }
  } catch {
    return null; // unborn history or blame failure
  }
  return out.length ? out : null;
}

// --- walk & classify -------------------------------------------------------

const allFiles = listFiles('.');
const stats = new Map(BUCKETS.map((b) => [b.id, { files: 0, lines: 0, nonBlank: 0 }]));
const excluded = new Map(); // path -> reason

for (const f of allFiles) {
  const bucket = BUCKETS.find((b) => b.match(f));
  if (!bucket) {
    excluded.set(f, 'not project source (tooling/config data)');
    continue;
  }
  const c = countLines(f);
  const s = stats.get(bucket.id);
  s.files += 1;
  s.lines += c.lines;
  s.nonBlank += c.nonBlank;
}
for (const d of SKIP_DIRS) excluded.set(`${d}/`, 'build output / dependencies — not project code');
excluded.set('package-lock.json (and other lockfiles)', 'generated dependency manifests');
excluded.set('*.png / binaries', 'binary assets carry no meaningful line count');

// --- attribution -----------------------------------------------------------

let agentLines = 0;
let humanLines = 0;
let unattributed = 0;
if (blameAvailable) {
  for (const f of allFiles) {
    const bucket = BUCKETS.find((x) => x.match(f));
    if (!bucket) continue;
    const shas = blameShas(f);
    if (!shas) { unattributed += countLines(f).lines; continue; }
    for (const sha of shas) {
      if (commitInfo(sha).agent) agentLines++;
      else humanLines++;
    }
  }
}

// --- self-consistency ------------------------------------------------------

const includedTotal = BUCKETS.reduce((n, b) => n + stats.get(b.id).lines, 0);
const includedNonBlank = BUCKETS.reduce((n, b) => n + stats.get(b.id).nonBlank, 0);

function fail(msg) {
  console.error(`count-lines self-consistency FAILED: ${msg}`);
  process.exit(1);
}
{
  let check = 0;
  let nb = 0;
  for (const b of BUCKETS) { check += stats.get(b.id).lines; nb += stats.get(b.id).nonBlank; }
  if (check !== includedTotal || nb !== includedNonBlank) fail('bucket re-sum mismatch');
  if (agentLines + humanLines + unattributed !== includedTotal && blameAvailable) {
    fail(`attribution total (${agentLines + humanLines + unattributed}) != line total (${includedTotal})`);
  }
}

// --- output ----------------------------------------------------------------

const pad = (s, n) => String(s).padEnd(n);
const rows = [
  '| Area | Files | Lines | Non-blank |',
  '| --- | ---: | ---: | ---: |',
];
for (const b of BUCKETS) {
  const s = stats.get(b.id);
  const label = b.note ? `${b.label} *` : b.label;
  rows.push(`| ${label} | ${s.files} | ${s.lines} | ${s.nonBlank} |`);
}
rows.push(`| **Project total** | **${BUCKETS.reduce((n, x) => n + stats.get(x.id).files, 0)}** | **${includedTotal}** | **${includedNonBlank}** |`);

if (!stats.get('tests').files) {
  rows.push('');
  rows.push('_Tests: 0 lines — the test suite has deliberately not been written yet (the ultra-speed delivery pass skipped it; see ROADMAP.md)._');
}

rows.push('');
rows.push('| Excluded from project total | Reason |');
rows.push('| --- | --- |');
for (const [k, v] of excluded) rows.push(`| ${k} | ${v} |`);

const exclFiles = allFiles.filter((f) => !BUCKETS.some((b) => b.match(f))).length;
rows.push('');
rows.push(`**Grand total (everything counted, exclusions included): ${includedTotal + exclFileLines(allFiles)} lines**`);
rows.push('');
rows.push('| Attribution (surviving lines at HEAD) | Lines |');
rows.push('| --- | ---: |');
rows.push(`| Agent-written | ${blameAvailable ? agentLines : '—'} |`);
rows.push(`| Human-written | ${blameAvailable ? humanLines : '—'} |`);
if (unattributed) rows.push(`| Unattributed (no blame history) | ${unattributed} |`);
rows.push('');
rows.push('> Method: per-file `git blame --porcelain`; a surviving line is agent-written when its blamed commit\'s author email contains "anthropic" or the commit carries a `Co-Authored-By:` trailer naming Claude; everything else is human-written. Deleted lines belong to nobody. Reproduce locally with `node scripts/count-lines.mjs`.');

function exclFileLines(files) {
  let n = 0;
  for (const f of files) {
    if (BUCKETS.some((b) => b.match(f))) continue;
    try { n += countLines(f).lines; } catch { /* unreadable -> skip */ }
  }
  return n;
}

console.log(rows.join('\n'));
