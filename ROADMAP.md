# Roadmap

Status legend: `[x]` shipped and verified · `[~]` implemented, verification
pending (named below) · `[ ]` not started · `~~struck~~` deliberately dropped,
with the reason kept so a decision never reads as an oversight.

## Phase 1 — Core application (implemented)

- [x] Electron 33 shell: frameless Material title bar, single-instance lock,
      strict CSP, generic validated IPC bridge
- [x] Roblox surfaces: users, friends, groups, games, marketplace, inventory,
      compare, session manager; economy + presence behind session auth
- [x] Core UX: dockable tab strip with pin/groups/discovery searches/bulk close;
      command palette (`Ctrl+Shift+F`) with rich rows and teleport; anchored
      regex builder on every search field/dropdown/context menu; non-blocking
      notification centre with bulk actions; Git-backed local history with date
      + action filters; exporter (JSON/JSONL/YAML/TOML/XML/CSV/TSV/MD/HTML/
      SQL/ZIP); changelog viewer
- [x] Appearance: M3 tokens light+dark, density, accent seed, infinite colour
      picker with translator and animated-rainbow sentinel, word-depth
      typography editor, per-element appearance editing, app-logo presets with
      bounded local conversion
- [x] Delight & safety: OS-vault session storage; destructive super
      confirmation (two keys + slider); toy locks with per-element credentials;
      unlock ladder (budgeted, clears waiting only); Support Tickets desk;
      RFC 6238 authenticator with in-process QR pairing; opt-in narrator with
      per-language voice pickers; five ADHD accommodations; dim sum surprise
      from the public photo catalog; personal vocabulary upload; scheduled
      settings with external sources; file converter with sandboxed offline
      adapters; Ollama suite manager; Chrome-style auto-updater over an
      unsigned feed
- [x] Site & repo: static landing/docs site (tabbed, themed, bilingual),
      feature documentation set, release + Pages workflows, line counter,
      social-preview generator with byte-identity assertion

## Phase 1.5 — Post-release hardening (2026-08-22, in flight)

Four parallel lanes opened immediately after the first releases
(`v1.0.0-build.7`, `v1.0.0-build.8`). Everything here is unticked on purpose:
a row moves to `[x]` only when its lane's work is merged and its evidence
exists, never because the lane started.

- [ ] **Tests lane** — automated unit + interaction suites for the Phase 1
      modules, wired so their verdicts are reported (never gating CI, per the
      standing no-gate decision)
- [ ] **Captures lane** — real built-artifact screenshot evidence for every
      user-facing surface; nothing fake published meanwhile
- [ ] **Polish fixes lane** — the fix batch from the post-release adversarial
      review, verified against the built app
- [ ] **Wiki/docs lane** — `docs/wiki/` five-page mirror authored in-repo;
      remains unticked until the wiki is initialized in the web UI and the
      pages are actually copied up (the wiki remote 404s until the first
      page exists — see `docs/wiki/README.md`)

## Phase 2 — Verification debt (deliberate, named)

The ultra-speed delivery pass shipped Phase 1 without tests or captures. That
was a decision, recorded here rather than hidden; these items are the payback.

- [~] Automated test suites (unit + interaction) for all Phase 1 modules —
      *not yet run by design during the ultra-speed pass*
- [~] Real built-artifact screenshot evidence for every user-facing surface —
      *captures pending; nothing fake is published meanwhile*
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
until the evidence exists.
