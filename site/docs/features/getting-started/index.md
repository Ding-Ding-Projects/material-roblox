# Getting started

Material Roblox is a Material Design 3 desktop explorer for the public Roblox
platform APIs. It runs on Windows 10+ (x64), installs through a genuine
Squirrel.Windows installer, and keeps every network request inside an
allowlisted main-process boundary.

## Install

1. Open the [latest release](https://github.com/Ding-Ding-Projects/material-roblox/releases/latest)
   and download `MaterialRobloxSetup.exe`.
2. Run it. Windows SmartScreen may show an unknown-publisher warning because
   the installer is unsigned **by permanent project policy** — choose
   *More info* → *Run anyway* if you trust the build.
3. Launch Material Roblox from the Start menu. Updates arrive automatically
   through Chrome-style background checks against this repository's Releases.

There is no portable ZIP build. There is no account, no telemetry, and no
signing certificate anywhere in this project.

## First five minutes

| Step | Where | Why |
| --- | --- | --- |
| Skim the Home tab | Home | Overview of every surface with links into each one |
| Look up a user | Users tab | Public profile data, avatar renders, created/updated dates |
| Try bulk export | any list | Select rows, then Export — JSON, CSV, Markdown, and more |
| Open Settings | Settings tab | Theme, accent colour, language modes, funny levels |
| Connect a session (optional) | Session tab | Unlocks economy/presence surfaces; cookie stays in the OS vault |

Nothing requires sign-in except the surfaces that genuinely need
authentication (economy, presence). Those explain what connecting unlocks
instead of showing a fake empty state.

## Where to go next

- [Interface overview](../interface/tabs.md) — how the tab strip works
- [Session handling](../safety/session-cookie-handling.md) — what connecting stores and clears
- [Auto-updater](../platform/auto-updater.md) — how updates are delivered

## Verification status

Documentation describes the implemented feature set. Automated tests and
built-artifact captures were deliberately skipped during the ultra-speed
delivery pass; see ROADMAP.md Phase 2 for the tracked follow-up work.
