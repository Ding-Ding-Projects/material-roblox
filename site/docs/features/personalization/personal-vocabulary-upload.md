# Personal vocabulary upload

## What it is

A visible local personal-vocabulary JSON upload control on every user-facing
surface — present even before any file exists, and never delegated to a
sibling app. It lets you apply your own word-replacement list to rendered copy.

## How to use it

1. **Settings → Personal vocabulary** (or search "vocabulary").
2. Choose a JSON file through the semantic picker.
3. The complete byte payload validates before anything displays or caches;
   a rejected file applies nothing partially and your previous state stays.
4. Clear/reset purges the cache immediately and restores shipped wording.

## The schema contract

One documented, versioned, bounded contract across every surface:

| Bound | Limit |
| --- | --- |
| File size | ≤ 256 KiB |
| Schema version | `version: 1` only |
| Entries | ≤ 5000 replacements |
| Nesting depth | ≤ 4 |
| Key/value lengths | Bounded; string-only replacement fields |

Malformed JSON, duplicate keys, unknown versions, unsafe object keys,
unexpected fields, and out-of-range values are all rejected with the specific
reason named.

## Privacy guarantees

All handling is **local-only**: parsing, validation, replacement, and caching
make no network request and touch only private application data. Actual terms,
mappings, cached content, source filenames, and user-specific evidence never
enter exports, history snapshots, logs, telemetry, crash reports, prompts, or
public records. Exports and history views state that this data was omitted.

Revalidation happens before every load; a missing, corrupt, stale, or
unsupported cache fails closed to original shipped wording.

Approved replacements apply at the private user-facing text boundary —
including accessible names — while commands, URLs, identifiers, code, file
paths, and factual external records pass through verbatim.

## Failure modes

- Invalid file → inline error naming the violated bound; nothing changes.
- Cache corruption at startup → fail closed to shipped wording plus a
  notification.

## Verification status

Implemented in code. Bounds/fuzz tests are ROADMAP Phase 2 work.

## Suggested articles

- [Language modes & funny levels](language-modes-funny-levels.md)
- [School mode](school-mode.md)
