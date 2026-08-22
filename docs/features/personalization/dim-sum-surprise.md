# Dim sum surprise

## What it is

A small delight: a **10% chance at startup** of showing one randomly chosen
dim sum dish — its name and a picture. Not a feature you manage; it just shows
up occasionally, then leaves.

## How it behaves

- The dish is named in both languages (for example "Shrimp dumpling · 蝦餃"),
  honouring the active language mode; the per-language funny level styles the
  surrounding copy while the dish's actual name stays correct.
- Presented as a **non-blocking, auto-dismissing** card that never gates
  startup, never steals focus, and never delays the app becoming usable.
- It does not appear during first run, an error path, an update flow, or any
  moment where you are mid-task.
- Images are bundled local assets — no network fetch, no third-party CDN, no
  tracking — each with meaningful alt text so screen-reader users get the same
  delight.
- Reduced motion and quiet/do-not-disturb settings are respected.

## It cannot be opted out of

There is no setting that disables the surprise; any existing off switch was
removed with stored preferences migrated forward so old profiles simply rejoin
the draw. The politeness rules above (never gating, never stealing focus,
never interrupting) are what keep an un-optable surprise welcome.

The draw is a fresh random per launch — never more frequent than stated, never
twice in one launch. Under School mode the entire capability behaves as if it
is not installed: no card, no controls, no references anywhere on any surface.

## Where the pictures come from

Dish metadata resolves from the public catalog at
`Ding-Ding-Projects/dim-sum-photos` (`catalog/index.json`); photos come only
from that repository's published release assets. Consumer repositories never
generate or vendor their own dim-sum photos.

## Verification status

Implemented in code with cached catalog resolution. Draw-frequency behaviour is
deterministic to test; automated tests are ROADMAP Phase 2 work.

## Suggested articles

- [School mode](school-mode.md)
- [Line counts & estimates](../platform/line-counts-and-estimates.md) (release code names use the same catalog)
