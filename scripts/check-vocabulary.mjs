#!/usr/bin/env node
// Vocabulary hash lock — the PUBLIC-REPOSITORY METHOD, not the value.
//
// WHAT THIS ENFORCES (honestly stated):
//   * Possession: whoever runs a build here either holds the canonical private
//     dictionary or is treated as an outsider.
//   * Currency: if they hold it, it must be the CURRENT version — the digest
//     must match the lock file that lives beside the private source, outside
//     every public repository.
//
// WHAT THIS CANNOT ENFORCE (also honestly stated): no build step can read
// anybody's conversation, so this proves nothing about whether private
// vocabulary was actually USED in prose. That duty stays with every author,
// checked per reply. This lock exists because a dictionary that grew while
// nobody noticed should fail loudly instead of drifting silently.
//
// Fail-open / fail-closed rule:
//   * No private source configured -> SKIP with a printed reason, exit 0.
//     Refusing a stranger a build of a public repository would be absurd.
//   * Private source present but lock missing/stale/mismatched -> FAIL CLOSED.
//     That state means something changed without being re-locked.
//
// Wiring (intended; not installed by this repository — see hooks/pre-push.sample):
//   * Call `node scripts/check-vocabulary.mjs` as the first step of
//     build.bat / build-installer.bat.
//   * Point core.hooksPath at a hooks directory whose `pre-push` invokes this
//     script, so pushes gate on the same check.
//
// Re-locking ritual (deliberate, never automatic):
//   node scripts/check-vocabulary.mjs --lock
// This writes the current digest to the lock file after someone has reviewed
// the dictionary change. A pinned value committed here would go stale and
// become a ritual instead of a check — which is exactly why the expected value
// lives NEXT TO the private source, in a file this repository never sees.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SOURCE_ENV = process.env.MRB_VOCABULARY_SOURCE;
const DEFAULT_SOURCE = path.join(os.homedir(), '.agent-global-memory', 'memory', 'vocabulary-dictionary.json');

const relock = process.argv.includes('--lock');

function resolveSource() {
  if (SOURCE_ENV && fs.existsSync(SOURCE_ENV)) return SOURCE_ENV;
  if (SOURCE_ENV) {
    console.error(`check-vocabulary: MRB_VOCABULARY_SOURCE points at a missing file (${SOURCE_ENV}); failing closed`);
    process.exit(1);
  }
  if (fs.existsSync(DEFAULT_SOURCE)) return DEFAULT_SOURCE;
  console.log('outsider build skipped: no private source configured');
  process.exit(0);
}

function lockPathFor(source) {
  const fromEnv = process.env.MRB_VOCABULARY_LOCK;
  if (fromEnv) return fromEnv;
  return path.join(path.dirname(source), 'vocabulary.lock');
}

function sha256Hex(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const source = resolveSource();
const actual = sha256Hex(source);
const lock = lockPathFor(source);

if (!fs.existsSync(lock)) {
  console.error(
    'check-vocabulary: FAIL (closed)\n' +
    `  private source found: ${source}\n` +
    `  but its lock file is missing: ${lock}\n` +
    '  If you have reviewed the current dictionary, re-lock deliberately:\n' +
    '    node scripts/check-vocabulary.mjs --lock\n' +
    '  Builds stay blocked until the lock exists and matches.',
  );
  process.exit(1);
}

if (relock) {
  fs.writeFileSync(lock, actual + '\n', 'utf8');
  console.log(`check-vocabulary: lock written (${lock}) for digest ${actual}`);
  console.log('Remember: re-locking is a reviewed decision, not a fix for a red build.');
  process.exit(0);
}

const expected = fs.readFileSync(lock, 'utf8').trim();
if (expected !== actual) {
  console.error(
    'check-vocabulary: FAIL (closed)\n' +
    `  expected digest: ${expected}\n` +
    `  actual digest:   ${actual}\n` +
    '  The private dictionary changed without being re-locked.\n' +
    '  Review the change first; then re-lock deliberately:\n' +
    '    node scripts/check-vocabulary.mjs --lock',
  );
  process.exit(1);
}

console.log(`check-vocabulary: OK (dictionary present and current; ${actual.slice(0, 12)}…)`);
