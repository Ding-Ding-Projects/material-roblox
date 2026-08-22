# Contributing

Thanks for looking at Material Roblox. This document covers how to set up,
what the expectations are, and the few rules that are not negotiable.

## Development setup

```bat
git clone https://github.com/Ding-Ding-Projects/material-roblox.git
cd material-roblox
npm install
npm start
```

`build.bat` does the same with dependency bootstrapping included. There is no
global toolchain requirement beyond Node 20; everything else installs into
user-scoped locations.

## Contract-first rule

[`docs/dev/CONTRACT.md`](docs/dev/CONTRACT.md) is the single source of truth
for module boundaries, IPC channels, core-module exports, bootstrap order, and
CSS/i18n conventions. If your change makes code and contract disagree, fix one
of them in the same commit — silent drift is the bug that costs the next person
an afternoon.

## Pull request expectations

- One logical change per PR; state what changed and why in plain English.
- Run the checks your change affects **before opening** (the project's local
  test scripts when they exist). CI runs no tests by standing decision — your
  local run is the only check that happens before humans see it.
- Include built-artifact evidence for user-visible changes: a capture of the
  real build, or an honest statement of why none exists yet.
- Update docs in the same change: the affected article under `docs/features/`,
  `ROADMAP.md` checkboxes, and `CHANGELOG.md` under `[Unreleased]`.
- Accessibility and clipping regressions block merge: keyboard path, focus
  visibility, both themes' contrast, narrow widths.

## Commit format

Bilingual — concise factual English subject; body adds a playful Hong
Kong-style Cantonese line saying the same thing. Humour targets the old code,
never people. Every commit ends with exactly:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

with author/committer identity `Claude Fable 5 <noreply@anthropic.com>` so
attribution stays one name across the repository.

## Non-negotiables

- **No code signing.** Permanent policy: no certificates, no signer services.
  Installers ship unsigned with prominent disclosure.
- **No telemetry, analytics, or CDN assets.** All network access goes through
  the allowlisted main-process boundary; all assets are local.
- **Squirrel.Windows is the only supported Windows installer route.**
- **Secrets never enter the repository** — not in code, config, issues, or
  screenshots. Session cookies and TOTP seeds belong to the OS credential vault
  at runtime, nowhere else ever.
- **Ordinary English everywhere.** No private conversational vocabulary in any
  committed file.

## Where to start

Good first contributions: ROADMAP Phase 2 verification work (tests, captures,
a11y audit), documentation improvements, and accessibility fixes found by use.
Open an issue before large refactors so lanes don't collide.
