# Changelog

All notable changes to Material Roblox are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/), with per-build
tags of the form `v{semver}-build.{run-number}` published by the release
workflow. Every released version also carries a once-per-project dim-sum code
name from the public photo catalog.

## [Unreleased]

Nothing yet — changes land here as they are made and move down on release.

## [1.0.0] - 2026-08-22

The first shipped feature set, published as per-build releases
`v1.0.0-build.7` and `v1.0.0-build.8` (non-draft, verified downloadable
Squirrel installers).

### Added

- **Roblox explorer surfaces** — users, friends, groups, games, marketplace,
  inventory, compare, session manager; economy + presence behind an opt-in
  session; bulk actions and export on every list; honest handling of private
  inventories and of everything that needs authentication.
- **Interface** — dockable browser-style tab strip with pinning, groups,
  discovery searches, and bulk close; `Ctrl+Shift+F` command palette with
  rich rows and teleport; anchored regex builder on every search field,
  dropdown, and context menu; non-blocking notifications with a reviewable
  centre; Git-backed local version history; in-app changelog viewer.
- **Appearance** — Material Design 3 throughout; light/dark/system themes,
  density, accent seed via the infinite colour picker with translator and
  animated rainbow; word-processor-depth typography; per-element appearance
  editing; app-logo presets with bounded local conversion.
- **Safety** — OS-vault session storage; two-key super confirmation for
  destructive actions; per-element toy locks with self-service recovery;
  unlock ladder that clears waiting without ever clearing credentials;
  Support Tickets recovery desk; built-in RFC 6238 authenticator with QR
  pairing.
- **Personalization** — English / playful Cantonese / bilingual modes with
  per-language funny-level sliders; School mode; personal vocabulary upload;
  opt-in narrator with per-language voice pickers; five ADHD accommodations;
  dim sum surprise from the public photo catalog; scheduled settings with
  external sources.
- **Platform** — local file converter with a categorized adapter catalog;
  Ollama suite manager with evidence-backed hardware-fit verdicts;
  Chrome-style auto-updater over an unsigned feed; CI-counted line
  statistics; status reporting; Open Graph embed graphic.
- **Site & repo** — static landing/docs site (tabbed, themed, bilingual);
  feature documentation set; release and Pages workflows; line counter;
  social-preview generator with byte-identity assertion; static auditor
  scripts for renderer imports and workflow structure.

### Known gaps at release

- No automated test suites and no built-artifact screenshot evidence — a
  deliberate decision during the ultra-speed delivery pass, tracked unticked
  in ROADMAP Phase 2.
- Installer is unsigned by permanent policy; SmartScreen warns on first run.

[Unreleased]: https://github.com/Ding-Ding-Projects/material-roblox/compare/HEAD
[1.0.0]: https://github.com/Ding-Ding-Projects/material-roblox/releases/tag/v1.0.0-build.8
