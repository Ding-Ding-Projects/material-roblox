# Search & regex builder

## What it is

Every search field in Material Roblox — list searches, tab discovery, settings
search, docs search, changelog search, notification history, dropdown filters,
context-menu filters — carries the same contract:

- **Plain text is the default.** Regex is an explicit opt-in per field.
- **A full regex builder is anchored directly beside the field** — an affordance
  in or next to the input opens a popover attached to that specific field.
  It never sends you to a distant page or a detached dialog.
- Each field owns its own query, pattern, flags, validation, and mode. Two
  fields never share hidden state; the builder applies to the field you opened
  it from and nothing else.

## How to use it

The guided builder covers literals, character classes, anchors, groups,
alternation, quantifiers, plus a raw pattern editor, flags (`gimsuy`), sample
text with live matches and capture-group highlighting, and copy/export.

The engine is **JavaScript `RegExp`** (V8), and the UI says so — including its
escaping rules — so a pattern built here behaves identically everywhere it is
used.

Dropdowns and context menus get filter fields too, with their own builder
affordance, regardless of length: a four-item menu grows to fourteen without
anyone revisiting the decision, so consistency is the feature. Filtering
changes what items are visible, never what any item does; destructive entries
are not hidden while their shortcuts stay live.

## Configuration

| Behaviour | Default | Change |
| --- | --- | --- |
| Match mode | Plain text | Per-field regex toggle (persisted) |
| Builder position | Anchored popover | Progressive disclosure at narrow widths |

## Failure modes

- Invalid patterns report inline with position info; the underlying search
  keeps running on the last valid query rather than going blank.
- Zero-width matches are handled safely during evaluation so the UI cannot
  hang on patterns like `(a*)*`.
- Pattern and sample sizes are bounded; catastrophic-backtracking-prone
  evaluation runs against a bounded sample with a time guard.

## Security considerations

Patterns and sample text are evaluated locally and are never transmitted or
persisted beyond your own preference storage.

## Verification status

Implemented in code. Builder interaction tests and captures are ROADMAP Phase 2.

## Suggested articles

- [Command palette](command-palette.md)
- [Bulk actions](bulk-actions.md)
- [Changelog viewer](changelog-viewer.md)
