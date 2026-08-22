# FAQ

Answers to the questions that actually come up, kept factual.

## Is this affiliated with Roblox Corporation?

No. Material Roblox is an independent open-source explorer of publicly
documented platform APIs. It is not affiliated with, endorsed by, or
connected to Roblox Corporation.

## Why is the installer unsigned?

Permanent project policy: no certificates, no signing services, ever. The
trade-off is stated everywhere it matters — Windows SmartScreen will show an
unknown-publisher warning (choose *More info* → *Run anyway* if you trust the
build), and every release note says plainly that the artifacts are unsigned.
Nothing claims signature verification.

## Does it need a Roblox account?

Only for the economy and presence surfaces, which read authenticated data.
Everything else — users, friends, groups, games, marketplace, inventory,
compare — works with public data. Connecting a session is optional: the app
explains what connecting unlocks instead of faking an empty state, and you
can disconnect in one click.

## Where does my session cookie go when I connect?

Into the operating system's encrypted credential vault via Electron's
`safeStorage`. The renderer never sees its value; network calls that need it
happen in the main process. Disconnecting clears it. See the
[session cookie handling](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/safety/session-cookie-handling.md)
article.

## Where does my data go?

Nowhere. No telemetry, no analytics, no crash reporting. Network access is
allowlisted to Roblox API hosts and this repository's own Releases and Pages.

## How do updates work?

The app checks for updates on startup and on a bounded background schedule
against this repository's GitHub Releases. When one is ready you get a
non-blocking banner with the version, release notes, and an explicit
unsigned-artifact warning; installation happens only after you choose
*Restart to install update*. Failures are shown, never faked as success.
See [auto-updater](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/platform/auto-updater.md).

## Is there a portable ZIP build?

No, by decision. Squirrel.Windows is the only supported install route so
update integrity stays in one place. See
[ROADMAP · Deliberately not doing](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/ROADMAP.md).

## Which platforms are supported?

Windows 10+ x64. That is the active delivery target; there are no macOS or
Linux builds.

## Why do some settings look playful (funny levels, dim sum surprise)?

They are deliberate features, not bugs. Language modes (English / playful
Cantonese / bilingual) and two independent funny-level sliders style how copy
*sounds*, while facts — numbers, paths, error text, button outcomes — stay
exact at every level. The dim sum surprise is a small 10%-chance startup
delight drawn from a public photo catalog; it never blocks or interrupts.
School mode suppresses all of it with one switch if you would rather not see
any of it. See
[language modes & funny levels](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/personalization/language-modes-funny-levels.md)
and
[dim sum surprise](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/personalization/dim-sum-surprise.md).

## Are the locks real security?

No, and the app says so wherever they appear. Element locks, School mode's
unlock credential, and the unlock ladder are user-experience speed bumps — a
fun self-imposed wait, not encryption or access control. Recovery from any of
them is self-service (the app names the exact application-data folder), and
the [Support Tickets](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/safety/support-tickets.md)
desk plays along with the joke while opening that folder for you. Real secret
storage (session cookie, TOTP seeds) *is* handled seriously, in the OS vault.

## Do my authenticator secrets ever leave the machine?

No. TOTP secrets live in the OS credential vault under stable per-entry keys;
codes are computed locally; there is no account, cloud sync, or telemetry.
Ordinary exports omit secrets and say so. See
[two-factor authenticator](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/features/safety/two-factor-authenticator.md).

## What about private inventories?

Reported honestly as inaccessible. The app respects Roblox visibility rules
and never scrapes around them. See
[API coverage](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/docs/api-coverage.md).

## Are there tests? Can I trust the build without them?

Honest answer: automated test suites were deliberately skipped during the
ultra-speed delivery pass that produced the first implementation, and that
debt is tracked unticked in
[ROADMAP Phase 2](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/ROADMAP.md).
What exists today: static auditor scripts over renderer imports and workflow
structure, the packaging verification step in CI that asserts the installer
exists, is complete, and reports `NotSigned`, plus the line-count and social
preview assertions. Treat the suite gap as known, not hidden.

## How big is the project?

At release `v1.0.0-build.7`: 47,593 project lines (42,620 non-blank) across
152 files, counted by CI and published in every release with exclusions and
attribution stated. The README carries a clearly-labelled estimate of roughly
341 person-hours (~2.1 person-months) to have built by hand — arithmetic on
those counted lines, not a measurement.

## How do I report a problem?

Open an issue on
[the repository](https://github.com/Ding-Ding-Projects/material-roblox/issues).
Include what you did, what you expected, what happened, and your Windows
version. Please never paste session cookies, TOTP codes, or other credentials
into an issue.

## License

[MIT](https://github.com/Ding-Ding-Projects/material-roblox/blob/main/LICENSE) —
© 2026 Ding-Ding-Projects and contributors.
