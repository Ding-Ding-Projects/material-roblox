# Notifications

## What it is

Informational, success, progress, and non-decision error messages appear as
**non-blocking toasts** anchored in a screen corner — never as modal dialogs
that halt the app. Toasts auto-dismiss on a sensible timeout (errors and
warnings persist until dismissed), stack without overlapping, and can carry a
title, body, actions, and links.

Modal dialogs are reserved strictly for decisions: confirmations, unsaved-work
prompts, destructive-action gates, credential and consent steps.

## How to use it

- Every dismissed toast stays reviewable in the **notification centre**
  (bell icon in the title bar, or `Ctrl+Shift+F` → "notification centre").
- The centre is a real list with the full bulk-action contract: multi-select
  with click, shift-range, and keyboard; select-all that states plainly whether
  it means *this page* or *every match*; inverse selection; bulk dismiss and
  bulk delete (delete passes the destructive super-confirmation); bulk export
  that honours the active filter rather than dumping everything.
- The centre's search bar carries the anchored regex builder like every other
  search surface.

## Configuration

| Setting | Default | Notes |
| --- | --- | --- |
| Corner | Bottom-right | Fixed for stacking predictability |
| Auto-dismiss | ~5 s info / sticky errors | Errors persist until dismissed |
| History cap | 200 entries | Oldest pruned automatically |

## Failure modes

- A failed background operation always raises a toast with a recovery action —
  failures are never hidden behind a spinner.
- If the centre fails to open, toasts remain visible; state is not lost.

## Security considerations

Notification text never includes secrets: session cookies, tokens, and vault
contents are excluded from toast bodies and from the history log by
construction, not by redaction after the fact.

## Verification status

Implemented in code. Centre bulk-action tests and captures are ROADMAP Phase 2.

## Suggested articles

- [Bulk actions](bulk-actions.md)
- [Exports](exports.md)
- [Local history](local-history.md)
