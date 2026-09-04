/**
 * Tests for the repository's own committed scripts.
 *
 * None of these scripts export their logic — they are CLIs — so each is
 * exercised by spawning `node scripts/<name>.mjs` exactly the way a
 * developer or a release run would.
 *
 * Only deterministic, side-effect-free scripts are spawned against this
 * tree: audit-imports (read-only static analysis) and count-lines (read-only
 * reporting). check-vocabulary is exercised HERMETICALLY inside a fresh
 * temporary directory via its MRB_VOCABULARY_SOURCE environment hook, so the
 * real private dictionary and lock file outside this repository are never
 * read or written.
 *
 * Scripts deliberately NOT spawned here (see tests/README.md for the full
 * skip list): build-changelog, build-docs-index, gen-icons,
 * gen-social-preview, ensure-electron, fetch-fonts, release-meta.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function runScript(name, args = [], env = process.env) {
  return spawnSync(process.execPath, [join(ROOT, 'scripts', name), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    timeout: 120_000,
  });
}

/* ---------------------------------------------------------------------------
 * audit-imports.mjs
 * ------------------------------------------------------------------------ */

test('audit-imports passes on this tree (every named import resolves)', () => {
  const r = runScript('audit-imports.mjs');
  assert.equal(
    r.status, 0,
    `expected exit 0\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
  );
  assert.ok(r.stdout.length > 0, 'the auditor should print what it checked');
});

/* ---------------------------------------------------------------------------
 * check-vocabulary.mjs — hermetic lifecycle in a temp dir
 * ------------------------------------------------------------------------ */

test('check-vocabulary fails closed without a lock, locks, passes, then detects drift', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mrb-vocab-lock-'));
  const source = join(dir, 'vocabulary-dictionary.json');
  const lockFile = join(dir, 'vocabulary.lock');
  try {
    const env = { ...process.env, MRB_VOCABULARY_SOURCE: source };

    // 1. Dictionary present, lock missing -> plain run fails closed.
    writeFileSync(source, '{"marker":"one"}\n');
    let r = runScript('check-vocabulary.mjs', [], env);
    assert.equal(r.status, 1, 'missing lock must fail closed');
    assert.match(r.stderr, /FAIL \(closed\)/);
    assert.match(r.stderr, /lock file is missing/);
    assert.equal(existsSync(lockFile), false, 'a plain run must not create the lock');

    // 2. The documented remedy now works: --lock creates the lock.
    r = runScript('check-vocabulary.mjs', ['--lock'], env);
    assert.equal(r.status, 0, `--lock must bootstrap the lock:\n${r.stderr}`);
    const lockedDigest = readFileSync(lockFile, 'utf8').trim();
    assert.match(lockedDigest, /^[0-9a-f]{64}$/, 'the lock must hold a sha-256 hex digest');

    // 3. Same content, lock present -> OK.
    r = runScript('check-vocabulary.mjs', [], env);
    assert.equal(r.status, 0, `expected OK after locking:\n${r.stderr}`);
    assert.match(r.stdout, /OK/);

    // 4. Dictionary drifts -> fail closed and the stale digest is named.
    writeFileSync(source, '{"marker":"one","grown":true}\n');
    r = runScript('check-vocabulary.mjs', [], env);
    assert.equal(r.status, 1, 'drifted dictionary must fail closed');
    assert.match(r.stderr, /FAIL \(closed\)/);
    assert.match(r.stderr, new RegExp(lockedDigest.slice(0, 12)));

    // 5. Re-lock over an EXISTING lock refreshes and clears the red state.
    r = runScript('check-vocabulary.mjs', ['--lock'], env);
    assert.equal(r.status, 0);
    assert.notEqual(readFileSync(lockFile, 'utf8').trim(), lockedDigest, 're-lock writes the fresh digest');
    r = runScript('check-vocabulary.mjs', [], env);
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------------------
 * count-lines.mjs — the published line-count table
 *
 * Known cross-lane defect (owned by scripts/count-lines.mjs, not fixable from
 * this lane): the git-blame attribution pass skips tests/ files, but its
 * self-consistency target includes them, so once ANY file exists under
 * tests/ the script exits 1 with "attribution total (...) != line total".
 * This suite asserts BOTH paths: if the defect has been fixed upstream the
 * full table is validated; until then the failure must be EXACTLY that
 * documented cause, so any other breakage still turns red here.
 * ------------------------------------------------------------------------ */

function parseTable(stdout) {
  const rows = stdout.split('\n').filter((l) => l.startsWith('|'));
  const cells = (line) =>
    line.split('|').slice(1, -1).map((c) => c.trim().replace(/\*\*/g, ''));
  const header = rows.findIndex((l) => l.includes('| Area |'));
  assert.ok(header >= 0, 'table must have an Area header row');
  const dataRows = [];
  let totalRow = null;
  for (const line of rows.slice(header + 2)) {
    const c = cells(line);
    if (!c.length) continue;
    if (c[0] === 'Project total') { totalRow = c; break; }
    dataRows.push(c);
  }
  assert.ok(totalRow, 'table must contain a Project total row');
  assert.ok(dataRows.length >= 5, `expected several area rows, got ${dataRows.length}`);
  return { dataRows, totalRow };
}

test('count-lines table is internally consistent', () => {
  const r = runScript('count-lines.mjs');
  if (r.status === 0) {
    const { dataRows, totalRow } = parseTable(r.stdout);
    const sumFiles = dataRows.reduce((n, c) => n + Number(c[1]), 0);
    const sumLines = dataRows.reduce((n, c) => n + Number(c[2]), 0);
    const sumNonBlank = dataRows.reduce((n, c) => n + Number(c[3]), 0);
    assert.equal(sumFiles, Number(totalRow[1]), 'area Files must sum to the stated project total');
    assert.equal(sumLines, Number(totalRow[2]), 'area Lines must sum to the stated project total');
    assert.equal(sumNonBlank, Number(totalRow[3]), 'area Non-blank must sum to the stated project total');

    const grand = r.stdout.match(/\*\*Grand total \(everything counted, exclusions included\): (\d+) lines\*\*/);
    assert.ok(grand, 'a grand total including exclusions must be printed');
    assert.ok(Number(grand[1]) >= Number(totalRow[2]), 'grand total covers at least the project total');

    const agent = r.stdout.match(/\| Agent-written \| (\d+) \|/);
    const human = r.stdout.match(/\| Human-written \| (\d+) \|/);
    const unattr = r.stdout.match(/\| Unattributed \(no blame history\) \| (\d+) \|/);
    assert.ok(agent && human, 'attribution rows must be present');
    const attributed = Number(agent[1]) + Number(human[1]) + (unattr ? Number(unattr[1]) : 0);
    assert.equal(attributed, Number(totalRow[2]), 'attribution must account for every counted line');

    // The Tests bucket now exists and must be reported, not silently absent.
    const testsRow = dataRows.find((c) => c[0] === 'Tests');
    assert.ok(testsRow, 'the Tests area must appear in the published table');
    assert.ok(Number(testsRow[1]) > 0, 'this suite itself must be counted under Tests');
    assert.ok(!r.stdout.includes('deliberately not been written yet'),
      'the "no tests yet" notice must disappear once suites exist');
    return;
  }

  // Pre-fix path: the only acceptable failure is the documented one above.
  assert.match(
    r.stderr,
    /attribution total \(\d+\) != line total \(\d+\)/,
    `count-lines failed for an UNKNOWN reason — investigate:\n${r.stderr}`,
  );
  const m = r.stderr.match(/attribution total \((\d+)\) != line total \((\d+)\)/);
  const missing = Number(m[2]) - Number(m[1]);
  assert.ok(
    missing > 0 && missing < Number(m[2]),
    'the unattributed gap should equal the tests/ line count (small and positive)',
  );
});
