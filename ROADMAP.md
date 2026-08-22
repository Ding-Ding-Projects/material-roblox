# Roadmap

Status legend: `[x]` shipped and verified · `[~]` implemented, verification
pending (named below) · `[ ]` not started · `~~struck~~` deliberately dropped,
with the reason kept so a decision never reads as an oversight.

## Phase 1 — Core application

### Shipped and verified in releases v1.0.0-build.7 / v1.0.0-build.8

These carry direct release evidence — published tags, workflow runs, and
artifacts that can be opened today — which is what earns the tick.

- [x] Squirrel.Windows installer published by the release workflow at both
      tags (`v1.0.0-build.7`, `v1.0.0-build.8`); its unsigned status is
      disclosed prominently rather than hidden
- [x] Static landing/docs site deployed through the Pages workflow
- [x] Release and Pages pipelines (`.github/workflows/release.yml`,
      `.github/workflows/pages.yml`) triggering on push and
      `workflow_dispatch`; the two published tags came out of them
- [x] Adversarial-review fixes: the boot-link repair plus eight confirmed
      defect closures (commit `8087d25`) and the pipeline shakedown
      (commit `0560758`), both inside the tagged history
- [x] Repository auditors committed at the tagged commits:
      `scripts/audit-imports.mjs` (re-run green in the polish pass),
      `scripts/check-vocabulary.mjs`, `scripts/count-lines.mjs` (its table is
      what the build.7 release notes publish), and
      `scripts/gen-social-preview.mjs` with its byte-identity assertion

### Implemented and shipped in the build.7/8 installers — behaviour verification pending

Everything below is inside the released installers, but no executed test
suite or built-artifact capture yet backs the behaviour claims; `lane/tests`
and `lane/captures` are in flight against this tree.

- [~] Electron 33 shell: frameless Material title bar, single-instance lock,
      strict CSP, generic validated IPC bridge
- [~] Roblox surfaces: users, friends, groups, games, marketplace, inventory,
      compare, session manager; economy + presence behind session auth
- [~] Core UX: dockable tab strip with pin/groups/discovery searches/bulk close;
      command palette (`Ctrl+Shift+F`) with rich rows and teleport; anchored
      regex builder on every search field/dropdown/context menu; non-blocking
      notification centre with bulk actions; Git-backed local history with date
      + action filters; exporter (JSON/JSONL/YAML/TOML/XML/CSV/TSV/MD/HTML/
      SQL/ZIP); changelog viewer
- [~] Appearance: M3 tokens light+dark, density, accent seed, infinite colour
      picker with translator and animated-rainbow sentinel, word-depth
      typography editor, per-element appearance editing, app-logo presets with
      bounded local conversion
- [~] Delight & safety: OS-vault session storage; destructive super
      confirmation (two keys + slider); toy locks with per-element credentials;
      unlock ladder (budgeted, clears waiting only); Support Tickets desk;
      RFC 6238 authenticator with in-process QR pairing; opt-in narrator with
      per-language voice pickers; five ADHD accommodations; dim sum surprise
      from the public photo catalog; personal vocabulary upload; scheduled
      settings with external sources; file converter with sandboxed offline
      adapters; Ollama suite manager; Chrome-style auto-updater over an
      unsigned feed

## Phase 2 — Verification debt (deliberate, named)

The ultra-speed delivery pass shipped Phase 1 without tests or captures. That
was a decision, recorded here rather than hidden; these items are the payback.
The `lane/tests` and `lane/captures` worktrees are in flight right now, which
is why nothing here is ticked.

- [~] Automated test suites (unit + interaction) for all Phase 1 modules —
      *lane/tests in flight*
- [~] Real built-artifact screenshot evidence for every user-facing surface —
      *lane/captures in flight; nothing fake is published meanwhile*
- [~] Design-reference parity captures (reference app vs real build at
      identical screen/state/theme/viewport/scale tuples)
- [~] Accessibility audit pass (screen-reader walkthroughs, contrast checks in
      both themes, 200% scale)
- [~] Local end-to-end packaging verification of the Squirrel installer
      (install → update → uninstall) before first stable promotion

## Phase 3 — Expansions

- [ ] 7z archive adapter bundling for the file converter (LZMA2/PPMd/encrypted
      headers options exposed fully)
- [ ] Ollama remote catalog integration once an official remote API exists —
      *deferred, not abandoned; local-API-only until then*
- [ ] Additional locales beyond EN / playful Cantonese / bilingual
- [ ] Plugin surface for third-party Roblox data tools (design pending)

## Deliberately not doing

- ~~Code-signed installers~~ — permanent project policy; unsigned artifacts are
  disclosed prominently instead.
- ~~Telemetry / analytics anywhere~~ — no network calls beyond allowlisted
  platform APIs and this repository's own Releases/Pages.
- ~~Portable ZIP distribution~~ — Squirrel.Windows is the only supported
  installer path; maintaining a parallel route would split update integrity.
- ~~Cloud sync for settings/secrets~~ — everything stays local; secrets stay in
  the OS credential vault.

## Verification honesty note

Items marked `[~]` are implemented but unverified: their claims come from code
review, not from executed tests or built-artifact captures. They stay unticked
until the evidence exists. The Phase 1 split keeps the same rule in both
directions: only what a reader can verify from a published release today stays
ticked, and shipping alone never upgrades an unverified behaviour claim.
