/**
 * Tests for the personal-vocabulary validator.
 *
 * The mission brief asked whether src/js/core/i18n.js exposes a pure
 * validator. It does not directly: i18n.loadVocabularyFile delegates the
 * fail-closed validation to src/js/core/vocabulary.js, whose
 * validateVocabularyText() IS pure and import-safe under plain Node. This
 * suite tests that validator directly — no DOM, no localStorage, no network.
 * The DOM-bound application path (applyText, init) is out of scope here; see
 * tests/README.md.
 *
 * Contract under test (documented at the top of vocabulary.js):
 *   - hard size limit 256 KiB
 *   - strict JSON with duplicate keys rejected at ANY depth
 *   - schemaVersion "v1" only; unknown top-level fields rejected
 *   - entries must be a plain string->string map, <= 5000 entries,
 *     keys 1..200 chars, values <= 2000 chars
 *   - unsafe keys (__proto__, constructor, prototype) rejected
 *   - success returns { ok: true, count }
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateVocabularyText } from '../src/js/core/vocabulary.js';

const wrap = (entriesJson) =>
  `{"schemaVersion":"v1","entries":{${entriesJson}}}`;

const expectOk = (text, count) => {
  const result = validateVocabularyText(text);
  assert.deepEqual(result, { ok: true, count });
  return result;
};

const expectFail = (text, messagePart) => {
  const result = validateVocabularyText(text);
  assert.equal(result.ok, false, `expected rejection of: ${String(text).slice(0, 80)}`);
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0);
  if (messagePart) {
    assert.ok(
      result.error.toLowerCase().includes(messagePart.toLowerCase()),
      `error "${result.error}" should mention "${messagePart}"`,
    );
  }
  return result;
};

/* ---------------------------------------------------------------------------
 * Acceptance
 * ------------------------------------------------------------------------ */

test('a minimal valid file is accepted with its entry count', () => {
  expectOk(wrap('"hello":"你好"'), 1);
  expectOk('{"schemaVersion":"v1","entries":{}}', 0);
  expectOk(wrap('"a":"1","b":"2","c":"3"'), 3);
});

test('unicode escapes and non-ASCII values are accepted', () => {
  expectOk(wrap('"k":"\\u00e9中文"'), 1);
});

test('boundaries are inclusive: exactly 200-char keys and 2000-char values pass', () => {
  const key = 'k'.repeat(200);
  const value = 'v'.repeat(2000);
  expectOk(wrap(`"${key}":"${value}"`), 1);
  expectOk(wrap(`"k":"${'v'.repeat(2000)}"`), 1);
});

test('exactly 5000 entries pass', () => {
  const entries = Array.from({ length: 5000 }, (_, i) => `"key${i}":"v"`).join(',');
  expectOk(wrap(entries), 5000);
});

/* ---------------------------------------------------------------------------
 * Rejection: structure and schema
 * ------------------------------------------------------------------------ */

test('empty and non-string input is rejected', () => {
  expectFail('');
  expectFail(null);
  expectFail(undefined);
  expectFail(42);
});

test('malformed JSON is rejected', () => {
  expectFail('{');
  expectFail('{"schemaVersion":"v1",}');
  expectFail('not json at all');
  expectFail(wrap('"k":"unterminated'));
});

test('duplicate keys at any depth are rejected with the key named', () => {
  expectFail(
    '{"schemaVersion":"v1","schemaVersion":"v1","entries":{}}',
    'more than once',
  );
  expectFail(wrap('"k":"1","k":"2"'), 'more than once');
  expectFail('{"schemaVersion":"v1","entries":{"a":{"x":1,"x":2}}}', 'more than once');
});

test('bad escape sequences and raw control characters are rejected', () => {
  expectFail(wrap('"k":"bad \\q escape"'), 'escape');
  expectFail('{"schemaVersion":"v1","entries":{"k":"line\nbreak"}}', 'control');
});

test('trailing content after the JSON document is rejected', () => {
  expectFail('{"schemaVersion":"v1","entries":{}} trailing');
});

test('the top level must be an object with only known fields', () => {
  expectFail('[]', 'object');
  expectFail('"just a string"', 'object');
  expectFail('{"schemaVersion":"v2","entries":{}}', 'v1');
  expectFail('{"schemaVersion":"v1","entries":{},"extra":true}', 'extra');
  expectFail('{"entries":{}}', 'v1');
  expectFail('{"schemaVersion":"v1"}', 'entries');
  expectFail('{"schemaVersion":"v1","entries":[]}', 'map');
  expectFail('{"schemaVersion":"v1","entries":"nope"}', 'map');
});

/* ---------------------------------------------------------------------------
 * Rejection: entries bounds
 * ------------------------------------------------------------------------ */

test('non-string entry values are rejected', () => {
  expectFail(wrap('"k":42'), 'string');
  expectFail(wrap('"k":null'), 'string');
  expectFail(wrap('"k":{"nested":"object"}'), 'string');
  expectFail(wrap('"k":["array"]'), 'string');
});

test('oversized keys and values are rejected', () => {
  expectFail(wrap(`"":"value"`), '1 and 200');
  expectFail(wrap(`"${'k'.repeat(201)}":"v"`), '1 and 200');
  expectFail(wrap(`"k":"${'v'.repeat(2001)}"`), '2000');
});

test('more than 5000 entries are rejected', () => {
  const entries = Array.from({ length: 5001 }, (_, i) => `"key${i}":"v"`).join(',');
  expectFail(wrap(entries), '5000');
});

test('reserved unsafe key names are rejected', () => {
  // Built as raw text so no JS object literal can interfere with __proto__.
  expectFail(wrap('"__proto__":"evil"'), 'reserved');
  expectFail(wrap('"constructor":"evil"'), 'reserved');
  expectFail(wrap('"prototype":"evil"'), 'reserved');
});

/* ---------------------------------------------------------------------------
 * Size limit
 * ------------------------------------------------------------------------ */

test('a file over 256 KiB is rejected with the size named', () => {
  const bigValue = 'v'.repeat(300 * 1024);
  const result = validateVocabularyText(wrap(`"k":"${bigValue}"`));
  assert.equal(result.ok, false);
  assert.match(result.error, /256 KiB/);
});

/* ---------------------------------------------------------------------------
 * Purity: the validator must not mutate its input or reach for the world
 * ------------------------------------------------------------------------ */

test('validation is repeatable and side-effect free on the same input', () => {
  const text = wrap('"hello":"你好"');
  const first = validateVocabularyText(text);
  const second = validateVocabularyText(text);
  assert.deepEqual(first, second);
  assert.equal(text, wrap('"hello":"你好"'), 'input string must be unchanged');
});
