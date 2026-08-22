# Auto-updater

## What it is

Chrome-style automatic updates against this repository's GitHub Releases:
check on startup plus a bounded background schedule, download and validate in
the background without interrupting active work, then stage locally and show a
persistent non-blocking ready banner — the GitHub Desktop pattern.

## The ready banner

When an update is staged, a persistent banner shows:

- the exact new version and a link to its release notes,
- an explicit **unsigned-artifact warning** (permanent policy: no signing),
- **Restart to install update** and **Later** actions.

Restart and installation happen only when you choose them; unsaved-work
protection applies; focus returns to the surface you were on. An update
failure is never hidden behind a spinner or a guessed success — the failed
state is visible with a retry action.

## Integrity without signatures

Code signing is permanently prohibited, so the updater relies on transport
and content integrity instead: HTTPS feed metadata, package hash validation,
staging before swap, and rollback protection. It never claims authenticity or
signature verification, and neither do the release notes.

## Configuration

| Setting | Default |
| --- | --- |
| Check on startup | On |
| Background interval | Bounded (hours) |
| Manual "Check for updates" | Always available |

Update credentials (if a private feed ever needed one) would live only in the
OS credential store — never renderer code, release assets, or source history.

## Failure modes

Offline / invalid feed / corrupt asset / cancelled download / rollback each
have their own visible state. A partially downloaded update is discarded, not
resumed into a broken install; the previous version keeps running throughout.

## Verification status

Implemented against this repository's Releases API. Update-path state tests
are ROADMAP Phase 2 work.

## Suggested articles

- [Changelog viewer](../interface/changelog-viewer.md)
- [Line counts & estimates](line-counts-and-estimates.md)
