/**
 * Safe regular-expression construction for Roblox-lane client-side filters.
 *
 * Surfaces that filter already-fetched result arrays locally accept a regex
 * mode from their search bar. User-supplied patterns must never throw past
 * the handler or hang the renderer, so every construction goes through here:
 *
 * - pattern length is capped (200 chars);
 * - flags are restricted to the case/language-friendly subset [imsu]
 *   (deliberately excluding `g`, whose stateful `lastIndex` makes `.test()`
 *   results order-dependent, and `y`/`d`/`u`/`v` extras that filters never need);
 * - construction is wrapped so an invalid pattern returns an error code
 *   instead of throwing.
 *
 * Engine: the platform's own JavaScript RegExp, as documented in the
 * contract's regex-builder section. JavaScript offers no per-match timeout,
 * so the length cap plus the flag restriction are the practical bound; the
 * surfaces display the error inline and keep their previous results.
 */

/** Longest accepted pattern, in characters. */
export const MAX_PATTERN_LENGTH = 200;

/** Flags a surface filter may carry. */
const ALLOWED_FLAGS = /^[imsu]+$/;

/**
 * Error codes returned instead of a compiled RegExp.
 * @typedef {'empty'|'too-long'|'bad-flags'|'invalid'} SafeRegexError
 */

/**
 * Compile a pattern safely.
 *
 * @param {string} pattern user-supplied pattern
 * @param {string} [flags] requested flags, e.g. 'im'
 * @returns {{re: RegExp}|{error: SafeRegexError}} the compiled RegExp on
 *   success, otherwise a stable error code the caller renders inline.
 */
export function makeSafeRegex(pattern, flags = '') {
  const p = typeof pattern === 'string' ? pattern : String(pattern ?? '');
  const f = typeof flags === 'string' ? flags : '';

  if (!p.trim()) return { error: 'empty' };
  if (p.length > MAX_PATTERN_LENGTH) return { error: 'too-long' };
  if (f && !ALLOWED_FLAGS.test(f)) return { error: 'bad-flags' };

  try {
    return { re: new RegExp(p, f) };
  } catch {
    /* SyntaxError and friends become a code, never a throw past the handler */
    return { error: 'invalid' };
  }
}

/**
 * Build a row predicate for a surface's client-side filter.
 *
 * Plain mode is a case-insensitive substring match; regex mode compiles
 * through {@link makeSafeRegex}. An empty query always matches everything.
 *
 * @template T
 * @param {string} query trimmed user input ('' disables filtering)
 * @param {{mode?: 'plain'|'regex', flags?: string}} [opts] search-bar context
 * @param {(row: T) => Array<string|number>} fields extracts the values a row
 *   is matched against
 * @returns {{ok: true, test: (row: T) => boolean}|{ok: false, error: SafeRegexError}}
 */
export function rowMatcher(query, opts, fields) {
  const q = String(query ?? '').trim();
  if (!q) return { ok: true, test: () => true };

  const mode = opts && opts.mode === 'regex' ? 'regex' : 'plain';

  if (mode === 'regex') {
    const built = makeSafeRegex(q, (opts && opts.flags) || '');
    if (built.error) return { ok: false, error: built.error };
    const re = built.re;
    return {
      ok: true,
      test: (row) => fields(row).some((v) => re.test(String(v ?? ''))),
    };
  }

  const needle = q.toLowerCase();
  return {
    ok: true,
    test: (row) => fields(row).some((v) => String(v ?? '').toLowerCase().includes(needle)),
  };
}

/**
 * Localized inline copy for an error code from {@link makeSafeRegex}.
 * Facts stay exact at every funny level; only the voice around them varies.
 *
 * @param {SafeRegexError} code
 * @param {(key: string, en: string, yue: string) => string} tr the lane's
 *   localized-copy helper (peers.js)
 * @returns {string}
 */
export function regexErrorMessage(code, tr) {
  if (code === 'too-long') {
    return tr('roblox.regex.tooLong',
      'Pattern exceeds the 200-character limit.',
      '模式超過 200 字上限。');
  }
  if (code === 'bad-flags') {
    return tr('roblox.regex.badFlags',
      'Only the i m s u flags are supported here.',
      '呢度只支援 i m s u 四個旗標。');
  }
  return tr('roblox.regex.invalid',
    'That pattern is not valid JavaScript regular-expression syntax.',
    '呢個模式唔係有效嘅 JavaScript 正則語法。');
}
