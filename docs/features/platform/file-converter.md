# File converter

## What it is

A local file-conversion surface with a categorized, searchable adapter catalog
— Documents/PDF, Images, Audio, Video, Archives, Structured Data/Spreadsheets,
Code/Text, Binary Encodings — never one flat target dropdown.

## How to use it

1. Pick or drop source files (guided picker, honest empty state).
2. Type detection runs on bounded byte inspection, not the extension alone.
3. Choose a target from compatible adapters; incompatible formats stay
   **visible but disabled** with the exact missing dependency — capability gaps
   are never hidden and no format pretends to be convertible when it is not.
4. Review disclosures before lossy or metadata-changing conversions: exactly
   what can change or be omitted (transparency, layers, colour profile,
   animation, fonts, metadata, line endings, encoding, fields, precision).
5. Convert: atomic writes to an approved destination, per-file outcomes that
   distinguish converted / skipped / cancelled / failed, progress and
   cancellation throughout.

## The queue

No artificial total-file cap, and it never loads every path or byte into
memory: paged discovery plus a persistent resumable record, bounded-concurrency
chunks with constant-memory backpressure, pause/resume/cancel, preflight of
destination storage capacity, crash/restart recovery, and resume only where
durable state and input/output validation permit it. Per-file size bounds remain
mandatory — "unlimited queue" never authorizes collecting everything in memory.

## Bundling rule

An enabled adapter works **offline**: every dependency is bundled inside the
installed app. PATH discovery, a developer-machine tool, a network service, or
an unbundled optional dependency must never make a format look enabled.
Conversion runs in a least-privileged sandboxed process with allowlisted
arguments, no ambient network, and bounded bytes/time/pixels/recursion;
produced output is validated by signature/parse/round-trip before being offered.

## Failure modes

Unknown, unsupported, encrypted-without-supplied-access, or limit-exceeding
sources stay untouched with the exact boundary reported — never guessed,
truncated, mislabeled, or corrupt output. Overwriting requires destructive
super-confirmation.

## Security considerations

Sources are never modified; temporary output is removed on validation failure
without leaking paths or content into diagnostics.

## Verification status

Implemented for the bundled offline adapters listed above. Queue stress tests
are ROADMAP Phase 2 work; 7z archive-adapter bundling is tracked there too.

## Suggested articles

- [Exports](../interface/exports.md)
- [Destructive super confirmation](../safety/destructive-super-confirmation.md)
