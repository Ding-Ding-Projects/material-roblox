# Line counts & human-time estimates

## What it is

Every release states how many lines of code the project has at that release,
broken down honestly — and the README carries an estimate of how long a person
would have needed to write it by hand.

## How the count works

- **CI counts it, nobody else.** The release workflow runs
  `node scripts/count-lines.mjs` over the tagged commit and embeds the table in
  the release notes, so a hand-typed number can never drift from the tree.
- The counter is committed; anyone can reproduce the figure locally with the
  same command and get byte-identical output.
- **Breakdown, not one number**: app source split by language, styles, tests
  (an honest `0` row until they exist), site, scripts, docs, workflows — each
  with total and non-blank lines.
- **Exclusions are stated, not silent**: dependencies, build output, lockfiles,
  and binaries are listed with reasons. A count that quietly folded in a vendored
  library would misrepresent the project.
- Generated files are separated from hand-written ones wherever they could move
  the number.
- **Attribution by surviving line** via `git blame`: a line counts as
  agent-written when its blamed commit's author identity or a `Co-Authored-By`
  trailer names an automation identity. Deleted lines belong to nobody. The rule
  used is stated beside the numbers so they can be checked either way.
- **Self-consistency is asserted**: bucket sums must equal their totals or the
  counter exits non-zero instead of publishing a table that disagrees with
  itself (the classic cause being a trailing-newline mismatch against blame
  semantics).

## The README estimate

The estimate shows its method, not just a number: the counted lines × an assumed
rate, with any multiplier for genuinely harder parts stated on one checkable
line, labelled as an estimate in the same sentence, preferring a range over a
single figure. It derives from the same breakdown as the count — excluding
vendored trees and generated files exactly as the count does — and refreshes
with releases so two numbers on one page can never disagree.

It exists to give a reader a sense of scale. It is information, never a boast.

## Verification status

Counter implemented (`scripts/count-lines.mjs`). First real figures publish
with the first tagged release.

## Suggested articles

- [Changelog viewer](../interface/changelog-viewer.md)
- [Status reporting](status-reporting.md)
