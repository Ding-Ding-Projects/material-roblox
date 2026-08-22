# Bulk actions

## What it is

Every list, table, grid, and collection in Material Roblox supports bulk
operations. Selecting one row and repeating an action forty times is the app
failing at its job.

## How to use it

- **Selection**: click, shift-click ranges, `Ctrl+A` for select-all (which
  states plainly whether it covers *this page* or *every match*), and inverse
  selection.
- **Actions**: export, delete, copy, move, retry — the whole set the surface
  offers singly, offered in bulk.
- **Search composition**: "select everything matching this query" is one step;
  the search bar's regex builder applies to selection exactly as to filtering.
- **Preview**: before anything runs you see the exact count and a reviewable
  preview, distinguishing "42 selected" from "42 will change" when some rows
  will be skipped.
- **Confirmation**: destructive or irreversible batches pass through the
  two-key super-confirmation gate; ordinary ones proceed with the preview only.
- **Progress**: long batches report progress, stay cancellable, and report
  partial results honestly — a batch where three items failed never claims
  whole-batch success.

## Configuration

Bulk behaviour is uniform across surfaces (result lists, notification centre,
history panel, converter queue); there is no per-surface opt-out that could
leave a list without it.

## Failure modes

- Skipped items are reported with reasons, never silently dropped.
- Undo goes through local version history where the underlying action is
  history-tracked; actions outside it say so plainly instead of faking undo.

## Security considerations

Bulk exports honour secret-exclusion rules: session cookies and vault contents
are excluded regardless of how many rows are selected.

## Verification status

Implemented in code. Keyboard-selection tests and captures are ROADMAP Phase 2.

## Suggested articles

- [Exports](exports.md)
- [Notifications](notifications.md)
- [Destructive super confirmation](../safety/destructive-super-confirmation.md)
