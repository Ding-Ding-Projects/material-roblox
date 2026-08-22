# Status reporting

## What it is

Honest, current state about the project's own health — published on the site's
Status tab and generated from real workflow data, never hand-typed optimism.

## How it works

The Pages workflow writes `site/status.json` on every deploy. Today that file
carries a placeholder with an empty run list and the site renders exactly what
that means:

> No published workflow runs recorded yet — statuses appear after the first
> release run.

Once release runs exist, the same surface lists them with their real verdicts.
A status page is evidence, not a summary of intent: a check that has not run is
shown as unrun (never passed), a release that has not shipped is shown as not
shipped, and anything in flight is labelled in flight.

## Principles

- **Live means visibly current**: last-updated timestamp or heartbeat beside
  the data, emoji-bearing states (`🏃 running`, `⏳ waiting`, `❌ failed`,
  `✅ verified`) that add scanability but never upgrade an unverified state.
- **The Actions tab stays one click away** for the authoritative record; this
  surface summarizes rather than re-interprets it.
- **Empty states are honest**: "no results" is stated as such instead of
  rendering blank space that reads like loading.

## Failure modes

If `status.json` fails to load (offline visit, stale cache), the Status tab
says so explicitly and links to the repository's Actions tab rather than showing
stale data as if it were current.

## Security considerations

Status data contains no secrets: run identifiers, verdicts, and timestamps only.

## Verification status

Placeholder shipping now by design; populated after the first release run.

## Suggested articles

- [Auto-updater](auto-updater.md)
- [Embed graphic](embed-graphic.md)
