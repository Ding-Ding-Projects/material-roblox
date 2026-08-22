# Destructive super confirmation

## What it is

Every destructive action — deleting history revisions, bulk-deleting
notifications or chats, removing authenticator entries, clearing stored data —
passes through a deliberate, in-app confirmation gate built from the app's own
UI layer. No helper window, no external service.

## How it works

1. An **anchored dialog beside the destructive control** (a modal only when the
   layout genuinely cannot host one) names the exact action and affected data.
2. Two **independently operated key controls** must both be completed.
3. Only then does a **full-range confirmation slider** enable; moving it shows
   a dramatic but non-blocking progress animation and a distinct completion
   animation after authorization.
4. An always-visible **Emergency exit** cancels at any point; `Esc`/back works;
   focus returns to the originating control after cancel *or* completion.
5. The destructive action runs only after both keys **and** the slider.

## Design rules

- The safety facts stay unambiguous at every language mode and funny level:
  animation and playful copy may style the experience, but what will be
  deleted, changed, or made irreversible is stated in plain words every time.
- Keyboard-operable end to end, screen-reader named, visibly focused,
  reduced-motion aware, contrast-safe, usable at narrow widths and high scales.

## Failure modes

- Closing the dialog by any path other than completion performs nothing.
- A partially completed gate (one key, partial slider) leaves the target data
  untouched and says so in the dialog state.

## Security considerations

The gate is a speed bump for irreversible actions, not a security boundary —
it deliberately never claims cryptographic protection. True credential gates
use the OS vault; see [Toy locks](toy-locks.md) for the distinction in the
other direction.

## Verification status

Implemented in code. Gate-interaction tests (untouched → one key → two keys →
partial slider → full slider → cancel paths) are ROADMAP Phase 2 work.

## Suggested articles

- [Bulk actions](../interface/bulk-actions.md)
- [Toy locks](toy-locks.md)
- [Support tickets](support-tickets.md)
