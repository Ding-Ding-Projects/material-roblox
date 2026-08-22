# Changelog viewer

## What it is

An in-app viewer covering **every** released version, not just the newest —
reachable from Help → Changelog. Each entry carries its version, release date,
categorized changes, a dim-sum code name where one was assigned, and the
commit that made each change.

## How to use it

- **Date filter**: an advanced calendar with month/year jump, range selection,
  and named presets (last 7/30/90 days, year to date). Typed dates are accepted
  in your locale's format and plain ISO; invalid or partial input is reported
  inline without discarding what you typed, and typing and the calendar stay in
  step.
- **Text search**: plain-text default with the full anchored regex builder;
  regex is an explicit opt-in. Search and date filter compose rather than
  override.
- **Export/copy**: the current filtered view exports to Markdown or plain text,
  stating the exported range, and copies to the clipboard.
- Every entry links the full commit SHA to this repository; short clickable
  references resolve against the forge so links work for the build you have.

## Configuration

The changelog data is generated at build time from git tags and commit logs by
`scripts/build-changelog.mjs`; entries cannot be invented in the UI. A version
with no recorded changes says so.

## Failure modes

- A referenced commit that does not exist fails the changelog build rather than
  shipping a dead link.
- An entry whose commit genuinely cannot be identified says so plainly instead
  of guessing at a neighbour.

## Security considerations

Changelog content is factual and never includes secrets or private build
metadata.

## Verification status

Implemented (viewer + generator). The first tagged release will populate real
entries; until then the viewer shows its honest empty state.

## Suggested articles

- [Search & regex builder](search-and-regex-builder.md)
- [Line counts & estimates](../platform/line-counts-and-estimates.md)
- [Auto-updater](../platform/auto-updater.md)
